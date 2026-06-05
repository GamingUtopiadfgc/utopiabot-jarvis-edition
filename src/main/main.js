'use strict';

const path = require('path');
const fs = require('fs');
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
const { ensureOllamaServer, waitUntilReachable } = require('./ollama-server');
const { initAutoUpdates } = require('./updater');
const { runCommand } = require('./commands');
const settingsStore = require('./settings');
const { getStats } = require('./system');

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
    try {
      await brain.streamReply(messages, {
        model,
        options: options || {},
        onText: (text) => send({ type: 'text', text }),
        onDone: (full) => send({ type: 'done', text: full }),
        onError: (message) => send({ type: 'error', message }),
        onTool: (name) => send({ type: 'tool', name }),
        onReset: () => send({ type: 'reset' }),
      });
      return { ok: true };
    } catch (err) {
      send({ type: 'error', message: err.message || String(err) });
      return { ok: false, error: err.message };
    }
  }
);

// ---- IPC: settings ----
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_e, patch) => {
  settings = settingsStore.save(patch);
  applySideEffects(settings);
  mainWindow?.webContents.send('settings:changed', settings);
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

// Auto-start the local Ollama server (in a terminal) if it isn't running, then
// tell the renderer to refresh its model list once it's up.
async function bootOllamaServer() {
  if (!settings.general.launchOllama) return;
  const reachable = async () => (await brains.ollama.status()).available;
  const result = await ensureOllamaServer(reachable);
  const tell = (channel, payload) =>
    mainWindow && !mainWindow.isDestroyed() &&
    mainWindow.webContents.send(channel, payload);

  if (result === 'starting') {
    tell('ollama:status', { state: 'starting' });
    const up = await waitUntilReachable(reachable);
    tell('ollama:status', { state: up ? 'ready' : 'failed' });
  } else if (result === 'already') {
    tell('ollama:status', { state: 'ready' });
  }
  // 'missing' / 'disabled': stay quiet — the model dropdown shows it's offline.
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
      initAutoUpdates(() => mainWindow);
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
