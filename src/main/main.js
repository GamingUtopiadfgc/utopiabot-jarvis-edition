'use strict';

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  session,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require('electron');

// Load ANTHROPIC_API_KEY from the first .env found. Real system environment
// variables always win (dotenv won't overwrite them). The candidates cover both
// dev (project root) and the installed app (beside the .exe, or in userData —
// %APPDATA%\UtopiaBot JARVIS\.env), since the packaged source has no .env.
for (const envPath of [
  path.join(__dirname, '..', '..', '.env'),
  path.join(path.dirname(app.getPath('exe')), '.env'),
  path.join(app.getPath('userData'), '.env'),
]) {
  try {
    if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
  } catch {
    /* ignore unreadable candidates */
  }
}

const { createBrain } = require('./claude');
const { createOllamaBrain } = require('./ollama');
const {
  ensureOllamaServer,
  waitUntilReachable,
  findOllamaModelStores,
  restartOllamaServer,
} = require('./ollama-server');
const { initAutoUpdates, checkForUpdates } = require('./updater');
const { runCommand } = require('./commands');
const settingsStore = require('./settings');
const { getStats } = require('./system');
const { createMemory } = require('./memory');
const tts = require('./tts');

const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let settingsWin = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;

// Live settings (persisted to userData/settings.json).
let settings = settingsStore.load();

// Brain providers. Ollama reads its host from settings so the Advanced → Ollama
// URL takes effect live. Both boot fine unconfigured.
const brains = {
  claude: createBrain(),
  ollama: createOllamaBrain(() => settings.advanced.ollamaUrl),
};

// Long-term memory store (folder from settings, default userData/memory).
const memory = createMemory(() => settings.memory.folder);

// Approve a privileged automation command per the security level / approval
// setting. Shows a blocking native dialog unless trusted.
async function approveCommand(cmd, purpose) {
  const level = settings.automation.securityLevel;
  if (level === 'developer') return true;
  const mustAsk = level === 'strict' || settings.automation.requireApproval;
  if (!mustAsk) return true;
  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'warning',
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'JARVIS wants to run a command',
    message: purpose || 'Allow JARVIS to run this PowerShell command?',
    detail: cmd,
  });
  return response === 1;
}

// Build the per-request tool context from current settings.
function buildToolContext() {
  return {
    caps: {
      powershell:
        settings.automation.powershell || settings.automation.desktopControl,
      memory: settings.memory.longTerm,
    },
    approve: approveCommand,
    memory: settings.memory.longTerm ? memory : null,
  };
}

// Resolve the app icon in both dev and packaged builds (bundled via extraResources).
function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', '..', 'build', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#03060d',
    frame: false,            // custom frameless HUD chrome
    titleBarStyle: 'hidden',
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs limited Node; renderer stays isolated
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev || settings.advanced.devConsole)
      mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Minimize-to-tray: closing hides instead of quitting (Quit via tray).
  mainWindow.on('close', (e) => {
    if (!isQuitting && settings.general.minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 800,
    height: 640,
    minWidth: 680,
    minHeight: 520,
    backgroundColor: '#03060d',
    frame: false,
    show: false,
    parent: mainWindow || undefined,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function setupTray(enabled) {
  if (enabled && !tray) {
    try {
      tray = new Tray(nativeImage.createFromPath(iconPath()));
      tray.setToolTip('UtopiaBot JARVIS');
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show UtopiaBot', click: () => mainWindow?.show() },
          { label: 'Settings', click: () => openSettings() },
          { type: 'separator' },
          { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
        ])
      );
      tray.on('click', () => mainWindow?.show());
    } catch (err) {
      console.error('Tray setup failed:', err);
    }
  } else if (!enabled && tray) {
    tray.destroy();
    tray = null;
  }
}

// Apply settings that have main-process side effects.
function applySideEffects(s) {
  try {
    app.setLoginItemSettings({ openAtLogin: s.general.startWithWindows });
  } catch (err) {
    console.error('setLoginItemSettings failed:', err);
  }
  setupTray(s.general.minimizeToTray);
}

// ---- IPC: window controls (frameless chrome) ----
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// ---- IPC: available models across every provider ----
// Returns Claude config + a live probe of the local Ollama server.
ipcMain.handle('models:list', async () => ({
  claude: brains.claude.status(),
  ollama: await brains.ollama.status(),
}));

// ---- IPC: streaming chat ----
// The renderer sends history + the chosen provider/model; we stream tokens back.
ipcMain.handle(
  'chat:send',
  async (event, { messages, requestId, provider, model, options }) => {
    const send = (chunk) =>
      event.sender.send('chat:stream', { requestId, ...chunk });

    const brain = brains[provider] || brains.claude;

    // Inject long-term memory relevant to the latest user turn.
    const opts = { ...(options || {}) };
    if (settings.memory.longTerm) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const q = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const ctxStr = memory.getContext(q);
      if (ctxStr) opts.memoryContext = ctxStr;
    }

    // Helper to send pull progress to renderer
    const sendPullProgress = (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ollama:pull-progress', { model, status });
      }
    };

    try {
      await brain.streamReply(messages, {
        model,
        options: opts,
        toolCtx: buildToolContext(),
        onText: (text) => send({ type: 'text', text }),
        onDone: (full) => {
          send({ type: 'done', text: full });
          if (settings.memory.saveConversations && full?.trim()) {
            memory.saveConversation([
              ...messages,
              { role: 'assistant', content: full },
            ]);
          }
        },
        onError: (message) => send({ type: 'error', message }),
        onTool: (name) => send({ type: 'tool', name }),
        onReset: () => send({ type: 'reset' }),
      });
      return { ok: true };
    } catch (err) {
      // Check if this is a "model not found" error and auto-pull if so
      const errorMsg = err.message || String(err);
      if (
        provider === 'ollama' &&
        /not found|no such model|try pulling|model .* not/i.test(errorMsg)
      ) {
        send({ type: 'error', message: `Model "${model}" not found. Auto-pulling…` });
        sendPullProgress(`Pulling ${model}…`);
        
        const pullResult = await brains.ollama.pullModel(model, sendPullProgress);
        
        if (pullResult.ok) {
          sendPullProgress(`✓ ${model} ready`);
          // Retry the chat with the now-available model
          try {
            await brain.streamReply(messages, {
              model,
              options: opts,
              toolCtx: buildToolContext(),
              onText: (text) => send({ type: 'text', text }),
              onDone: (full) => {
                send({ type: 'done', text: full });
                if (settings.memory.saveConversations && full?.trim()) {
                  memory.saveConversation([
                    ...messages,
                    { role: 'assistant', content: full },
                  ]);
                }
              },
              onError: (message) => send({ type: 'error', message }),
              onTool: (name) => send({ type: 'tool', name }),
              onReset: () => send({ type: 'reset' }),
            });
            return { ok: true };
          } catch (retryErr) {
            send({ type: 'error', message: retryErr.message || String(retryErr) });
            return { ok: false, error: retryErr.message };
          }
        } else {
          send({ type: 'error', message: pullResult.error || `Failed to pull ${model}` });
          return { ok: false, error: pullResult.error };
        }
      }
      
      send({ type: 'error', message: errorMsg });
      return { ok: false, error: errorMsg };
    }
  }
);

// ---- IPC: settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', async (_e, patch) => {
  const prevModelsPath = settings.advanced.ollamaModelsPath;
  settings = settingsStore.save(patch);
  applySideEffects(settings);
  mainWindow?.webContents.send('settings:changed', settings);

  // A new models folder only takes effect on a fresh server launch.
  if (
    settings.general.launchOllama &&
    settings.advanced.ollamaModelsPath !== prevModelsPath
  ) {
    const reachable = async () => (await brains.ollama.status()).available;
    const up = await restartOllamaServer(
      reachable,
      settings.advanced.ollamaModelsPath || null
    );
    mainWindow?.webContents.send('ollama:status', { state: up ? 'ready' : 'failed' });
  }
  return settings;
});
ipcMain.handle('settings:reset', () => {
  settings = settingsStore.reset();
  applySideEffects(settings);
  mainWindow?.webContents.send('settings:changed', settings);
  return settings;
});
ipcMain.handle('settings:open', () => openSettings());
ipcMain.handle('settings:close', () => settingsWin?.close());

// ---- IPC: pull an Ollama model ----
ipcMain.handle('ollama:pull', async (_event, { model, progressPort }) => {
  // If a progressPort is provided, we send progress updates via that channel.
  // Otherwise we just return the result.
  const result = await brains.ollama.pullModel(model, (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ollama:pull-progress', { model, status });
    }
  });
  return result;
});

// ---- IPC: scan the disk for Ollama model folders ----
ipcMain.handle('ollama:scan-models', () => ({
  stores: findOllamaModelStores(settings.advanced.ollamaModelsPath),
}));

// ---- IPC: point Ollama at a models folder and restart so it takes effect ----
ipcMain.handle('ollama:apply-models-path', async (_event, { path: modelsPath }) => {
  const dir = String(modelsPath || '').trim();
  settings = settingsStore.save({ advanced: { ollamaModelsPath: dir } });
  mainWindow?.webContents.send('settings:changed', settings);

  const reachable = async () => (await brains.ollama.status()).available;
  let up = await reachable();
  if (settings.general.launchOllama) {
    up = await restartOllamaServer(reachable, dir || null);
  }
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ollama:status', { state: up ? 'ready' : 'failed' });
  const probe = await brains.ollama.status();
  return { ok: up, models: probe.models };
});

// ---- IPC: auto-install Ollama (winget on Windows; brew/curl elsewhere) ----
ipcMain.handle('ollama:install', async () => {
  const report = (status) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('ollama:install-progress', { status });
  };

  let cmd;
  if (process.platform === 'win32') {
    cmd = 'winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements';
  } else if (process.platform === 'darwin') {
    cmd = 'brew install ollama';
  } else {
    cmd = 'curl -fsSL https://ollama.com/install.sh | sh';
  }

  report('Starting Ollama installation… this can take a few minutes.');
  const ok = await new Promise((resolve) => {
    const child = exec(cmd, { windowsHide: true });
    child.stdout?.on('data', (d) => report(String(d).trim().split('\n').pop() || ''));
    child.stderr?.on('data', (d) => report(String(d).trim().split('\n').pop() || ''));
    child.on('error', (err) => { report(`Install failed: ${err.message}`); resolve(false); });
    child.on('close', (code) => resolve(code === 0));
  });

  if (!ok) {
    report('Automatic install didn’t complete. You can install it manually from https://ollama.com/download');
    return { ok: false };
  }

  report('Ollama installed. Starting the server…');
  const reachable = async () => (await brains.ollama.status()).available;
  const modelsPath = settings.advanced.ollamaModelsPath || null;
  await ensureOllamaServer(reachable, modelsPath);
  const up = await waitUntilReachable(reachable);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ollama:status', { state: up ? 'ready' : 'failed' });
  report(up ? 'Ollama is online, sir.' : 'Installed, but the server didn’t start — try restarting the app.');
  return { ok: up };
});

// ---- IPC: system stats + folder picker ----
ipcMain.handle('system:stats', () => getStats());
ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(settingsWin || mainWindow, {
    properties: ['openDirectory'],
  });
  return res.canceled ? '' : res.filePaths[0];
});

// ---- IPC: local commands (open apps, time, search, etc.) ----
ipcMain.handle('command:run', async (_event, { name, args }) => {
  return runCommand(name, args);
});

// ---- IPC: neural TTS engines (Piper / Coqui) ----
ipcMain.handle('tts:state', () => tts.getTtsState());

ipcMain.handle('tts:install', async (_event, { engine }) => {
  // Broadcast progress to every open window (install is driven from Settings).
  const report = (status) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('tts:install-progress', { engine, status });
    }
  };
  try {
    return await tts.install(engine, report);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('tts:synth', (_event, { engine, text, voice }) =>
  tts.synth(engine, { text, voice })
);

// ---- IPC: manual "Check for Updates" (Settings → Advanced) ----
ipcMain.handle('update:check', async () => {
  // Updates only apply to the installed (packaged) app; electron-updater
  // errors in dev. Report that plainly instead of throwing.
  if (!app.isPackaged) {
    mainWindow?.webContents.send('update:status', { state: 'dev' });
    return { ok: false, dev: true };
  }
  try {
    await checkForUpdates();
    return { ok: true };
  } catch (err) {
    const message = err?.message || String(err);
    mainWindow?.webContents.send('update:status', { state: 'error', message });
    return { ok: false, error: message };
  }
});

// Auto-start the local Ollama server (in a terminal) if it isn't running, then
// tell the renderer to refresh its model list once it's up.
// Notify the renderer when the server is up but reports zero models — most
// likely it's reading a different folder than where the user's models live.
// Include any model stores we can discover on disk so the user can pick one.
async function warnIfNoModels() {
  const probe = await brains.ollama.status();
  if (!probe.available || probe.models.length > 0) return;
  const stores = findOllamaModelStores(settings.advanced.ollamaModelsPath);
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('ollama:no-models', { stores });
}

async function bootOllamaServer() {
  if (!settings.general.launchOllama) return;
  const reachable = async () => (await brains.ollama.status()).available;
  const modelsPath = settings.advanced.ollamaModelsPath || null;
  const result = await ensureOllamaServer(reachable, modelsPath);
  const tell = (channel, payload) =>
    mainWindow && !mainWindow.isDestroyed() &&
    mainWindow.webContents.send(channel, payload);

  if (result === 'starting') {
    tell('ollama:status', { state: 'starting' });
    const up = await waitUntilReachable(reachable);
    tell('ollama:status', { state: up ? 'ready' : 'failed' });
    if (up) await warnIfNoModels();
  } else if (result === 'already') {
    tell('ollama:status', { state: 'ready' });
    await warnIfNoModels();
  } else if (result === 'missing') {
    // Ollama isn't on PATH — offer to help install it.
    tell('ollama:not-installed', {});
  }
  // 'disabled': stay quiet — the model dropdown shows it's offline.
}

app.whenReady().then(() => {
  // Allow microphone access for voice input; deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'audioCapture');
  });

  createWindow();
  applySideEffects(settings);
  bootOllamaServer();

  // Auto-updates only make sense for the installed (packaged) app.
  if (app.isPackaged) {
    try {
      initAutoUpdates();
    } catch (err) {
      console.error('Auto-update init failed:', err);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
