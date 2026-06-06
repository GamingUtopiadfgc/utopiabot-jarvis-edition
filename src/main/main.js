'use strict';

// Logger must be required first — it wraps console before anything else runs.
const { getLogPath } = require('./logger');

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
const { buildProfileBlock } = require('./persona');
const { testConnection: testVmConnection, detectVms } = require('./vm');
const { dangerousFeaturesEnabled } = require('./channel');
const { extractMemories } = require('./learner');
const tts = require('./tts');
const stt = require('./stt');

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

// In-chat code approval queue: jobId → resolve(boolean)
const pendingCodeApprovals = new Map();
// In-chat file-write approval queue: jobId → resolve(boolean)
const pendingFileApprovals = new Map();

// Send a code block to the renderer for in-chat review.
// Resolves to true (run) or false (deny).
function approveCodeInChat(jobId, code, language, purpose) {
  return new Promise((resolve) => {
    pendingCodeApprovals.set(jobId, resolve);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('codequeue:pending', { jobId, code, language, purpose });
    } else {
      pendingCodeApprovals.delete(jobId);
      resolve(false);
    }
  });
}

ipcMain.handle('codequeue:respond', (_e, { jobId, approved }) => {
  const resolve = pendingCodeApprovals.get(jobId);
  if (resolve) {
    pendingCodeApprovals.delete(jobId);
    resolve(!!approved);
  }
});

function approveFileWriteInChat(jobId, filePath, content, purpose) {
  return new Promise((resolve) => {
    pendingFileApprovals.set(jobId, resolve);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('filequeue:pending', { jobId, filePath, content, purpose });
    } else {
      pendingFileApprovals.delete(jobId);
      resolve(false);
    }
  });
}

ipcMain.handle('filequeue:respond', (_e, { jobId, approved }) => {
  const resolve = pendingFileApprovals.get(jobId);
  if (resolve) {
    pendingFileApprovals.delete(jobId);
    resolve(!!approved);
  }
});

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

// Return true only when the last user message explicitly asks about the bot's
// own source code, files, or internal implementation. Used to gate FILE_TOOLS
// so they are never offered for general-knowledge or conversational queries.
function wantsFileAccess(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : '';
  return /\b(source code|source file|read file|list file|your code|codebase|how (do|does) (you|it|this|jarvis) work(s| internally)?|show (me )?your (code|source|file|config|settings|persona|implementation)|\.js\b|\.json\b|package\.json|settings\.json|how (are|were) you (built|made|programmed|written))\b/i.test(text);
}

// Build the per-request tool context from current settings.
function buildToolContext(messages, { fileEditMode = false } = {}) {
  const fileEdit = fileEditMode && dangerousFeaturesEnabled;
  return {
    caps: {
      // File read: explicit code question OR file-edit mode is on.
      files: wantsFileAccess(messages) || fileEdit,
      // File write: only when the nightly file-edit toggle is active.
      fileWrite: fileEdit,
      powershell:
        settings.automation.powershell || settings.automation.desktopControl,
      scripting: settings.automation.scripting,
      // VM control is a dangerous feature — only honored in the Nightly build.
      vm: settings.vm.enabled && dangerousFeaturesEnabled,
      memory: settings.memory.longTerm,
    },
    approve: approveCommand,
    approveCode: approveCodeInChat,
    approveFileWrite: approveFileWriteInChat,
    vmConfig: settings.vm,
    vmUnattended: settings.vm.allowUnattended,
    memory: settings.memory.longTerm ? memory : null,
  };
}

// Auto-learn: in the background, extract durable facts from the latest turn and
// save them to long-term memory. Fire-and-forget — never blocks or breaks the
// reply. Gated by the caller (long-term memory + auto-learn both enabled).
async function learnFromTurn(brain, model, messages, full) {
  try {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (!userText) return;
    const turn = [
      { role: 'user', content: userText },
      { role: 'assistant', content: full },
    ];
    const facts = await extractMemories(
      brain,
      model,
      turn,
      memory.all().map((m) => m.text)
    );
    for (const f of facts) memory.add(f);
    if (settings.advanced.debugLogs && facts.length)
      console.log(`[auto-learn] saved ${facts.length} fact(s)`);
  } catch (err) {
    if (settings.advanced.debugLogs) console.error('[auto-learn] failed:', err);
  }
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
  async (event, { messages, requestId, provider, model, options, fileEditMode }) => {
    const send = (chunk) =>
      event.sender.send('chat:stream', { requestId, ...chunk });

    const brain = brains[provider] || brains.claude;

    // Shared completion handling for both the normal and auto-pull-retry paths:
    // stream the final text, optionally archive the transcript, and auto-learn.
    const handleDone = (full) => {
      send({ type: 'done', text: full });
      if (!full?.trim()) return;
      if (settings.memory.saveConversations) {
        memory.saveConversation([
          ...messages,
          { role: 'assistant', content: full },
        ]);
      }
      if (settings.memory.longTerm && settings.memory.autoSummarize) {
        learnFromTurn(brain, model, messages, full); // fire-and-forget
      }
    };

    // Tell the brain who it's helping (name, address, style) once onboarded.
    const opts = { ...(options || {}) };
    if (settings.profile?.onboarded) {
      const block = buildProfileBlock(settings.profile);
      if (block) opts.userProfile = block;
    }

    // Inject long-term memory relevant to the latest user turn.
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
        toolCtx: buildToolContext(messages, { fileEditMode }),
        onText: (text) => send({ type: 'text', text }),
        onDone: handleDone,
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
              toolCtx: buildToolContext(messages, { fileEditMode }),
              onText: (text) => send({ type: 'text', text }),
              onDone: handleDone,
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

// ---- IPC: first-run onboarding ----
// Persist the captured profile (marking onboarding done) and seed long-term
// memory with durable facts so JARVIS recalls them even outside the profile block.
ipcMain.handle('onboarding:complete', (_e, profile = {}) => {
  settings = settingsStore.save({ profile: { ...profile, onboarded: true } });
  try {
    const p = settings.profile;
    if (p.name) memory.add(`The user's name is ${p.name}.`);
    if (p.about && p.about.trim()) memory.add(`About the user: ${p.about.trim()}`);
    const addr =
      p.address === 'name' && p.name ? `their name, ${p.name}` : `"${p.address}"`;
    memory.add(`The user prefers to be addressed as ${addr}.`);
  } catch (err) {
    console.error('onboarding memory seed failed:', err);
  }
  applySideEffects(settings);
  mainWindow?.webContents.send('settings:changed', settings);
  return settings;
});

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

ipcMain.handle('logs:export', async () => {
  const { filePath, canceled } = await dialog.showSaveDialog(settingsWin || mainWindow, {
    title: 'Save Debug Log',
    defaultPath: `utopiabot-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    filters: [{ name: 'Log / Text', extensions: ['txt', 'log'] }],
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  try {
    const s = settingsStore.load();
    const { CHANNEL } = require('./channel');
    const pkg = require('../../package.json');
    const header = [
      'UtopiaBot JARVIS — Debug Log Export',
      `Generated : ${new Date().toISOString()}`,
      `Version   : ${pkg.version} (${CHANNEL})`,
      `Platform  : ${process.platform} ${process.arch}`,
      `Node      : ${process.version}`,
      `Electron  : ${process.versions.electron}`,
      '',
      '--- Settings snapshot ---',
      `provider    : ${s.neural.provider}`,
      `model       : ${s.neural.model || '(none)'}`,
      `tts engine  : ${s.voice.engine}`,
      `stt engine  : ${s.voice.sttEngine}`,
      `memory      : ${s.memory.longTerm}`,
      `vm enabled  : ${s.vm.enabled}`,
      `debug logs  : ${s.advanced.debugLogs}`,
      '',
      '--- Log ---',
      '',
    ].join('\n');

    let logContent = '(no log entries yet)';
    try { logContent = fs.readFileSync(getLogPath(), 'utf8'); } catch { /* not created yet */ }

    fs.writeFileSync(filePath, header + logContent, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('logs:report', async () => {
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const s = settingsStore.load();
  const { CHANNEL } = require('./channel');
  const pkg = require('../../package.json');

  let logContent = '(no log entries yet)';
  try { logContent = fs.readFileSync(getLogPath(), 'utf8'); } catch { /* not written yet */ }

  const versionBlock = [
    `**Version:** ${pkg.version} (${CHANNEL})`,
    `**Platform:** ${process.platform} ${process.arch}`,
    `**Node:** ${process.version}  |  **Electron:** ${process.versions.electron}`,
    '',
    '**Settings:**',
    `- Provider: \`${s.neural.provider}\`  Model: \`${s.neural.model || 'none'}\``,
    `- TTS: \`${s.voice.engine}\`  STT: \`${s.voice.sttEngine}\``,
    `- Memory: ${s.memory.longTerm}  |  VM: ${s.vm.enabled}`,
  ].join('\n');

  if (ghToken) {
    // 1. Create a secret Gist with the full log so nothing is truncated.
    let gistUrl = null;
    try {
      const gistRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'UtopiaBot-JARVIS',
        },
        body: JSON.stringify({
          description: `UtopiaBot JARVIS debug log — v${pkg.version} ${new Date().toISOString()}`,
          public: false,
          files: { 'jarvis.log': { content: logContent || '(empty)' } },
        }),
      });
      if (gistRes.ok) {
        const g = await gistRes.json();
        gistUrl = g.html_url;
      }
    } catch { /* gist failed — issue body will include a log tail instead */ }

    // 2. Create an Issue referencing the Gist (or embedding a tail if Gist failed).
    const body = [
      '<!-- Auto-generated by UtopiaBot JARVIS Settings → System → Report on GitHub -->',
      '## Environment',
      '',
      versionBlock,
      '',
      '## Description',
      '',
      '_Describe what you did, what you expected, and what happened instead._',
      '',
      '## Log',
      '',
      gistUrl
        ? `Full log: ${gistUrl}`
        : '```\n' + logContent.slice(-4000) + '\n```',
    ].join('\n');

    try {
      const issueRes = await fetch(
        'https://api.github.com/repos/GamingUtopiadfgc/utopiabot-jarvis-edition/issues',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ghToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'UtopiaBot-JARVIS',
          },
          body: JSON.stringify({
            title: `Bug report — v${pkg.version} (${new Date().toLocaleDateString()})`,
            body,
            labels: ['bug'],
          }),
        }
      );
      const issue = await issueRes.json();
      if (!issueRes.ok) return { ok: false, error: issue.message || `GitHub API error ${issueRes.status}` };
      shell.openExternal(issue.html_url);
      return { ok: true, url: issue.html_url };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  } else {
    // No token — open the issues/new page with version info pre-filled.
    // Log tail is embedded in the body (URL length limits us to ~2000 chars).
    const tail = logContent.slice(-1800);
    const body = encodeURIComponent(
      `## Environment\n\n${versionBlock}\n\n## Description\n\n_Describe what happened._\n\n## Log tail\n\n\`\`\`\n${tail}\n\`\`\``
    );
    const title = encodeURIComponent(`Bug report — v${pkg.version}`);
    shell.openExternal(
      `https://github.com/GamingUtopiadfgc/utopiabot-jarvis-edition/issues/new?title=${title}&body=${body}`
    );
    return { ok: true, opened: true };
  }
});

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(settingsWin || mainWindow, {
    properties: ['openDirectory'],
  });
  return res.canceled ? '' : res.filePaths[0];
});
ipcMain.handle('dialog:pickFile', async () => {
  const res = await dialog.showOpenDialog(settingsWin || mainWindow, {
    properties: ['openFile'],
  });
  return res.canceled ? '' : res.filePaths[0];
});

// ---- IPC: VM (Danger Zone) — test an SSH connection from entered settings ----
ipcMain.handle('vm:test', (_event, cfg) => {
  if (!dangerousFeaturesEnabled)
    return { ok: false, message: 'VM control is only available in the Nightly build, sir.' };
  return testVmConnection(cfg);
});

// ---- IPC: VM (Danger Zone) — auto-detect hypervisors + running VMs ----
ipcMain.handle('vm:detect', async () => {
  if (!dangerousFeaturesEnabled)
    return { ok: false, message: 'VM detection is only available in the Nightly build, sir.' };
  try {
    const data = await detectVms();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
});

// ---- IPC: local commands (open apps, time, search, etc.) ----
ipcMain.handle('command:run', async (_event, { name, args }) => {
  return runCommand(name, args, { dangerousFeatures: dangerousFeaturesEnabled });
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

// ---- IPC: local speech-to-text (faster-whisper) ----
ipcMain.handle('stt:state', () => stt.getSttState());

ipcMain.handle('stt:install', async (_event, { model } = {}) => {
  // Broadcast progress to every open window (install is driven from Settings).
  const report = (status) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('stt:install-progress', { status });
    }
  };
  try {
    return await stt.install(report, model);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('stt:transcribe', (_event, { audio, model, language } = {}) =>
  stt.transcribe({ audioBase64: audio, model, language })
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
