'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CHANNEL, dangerousFeaturesEnabled } = require('./channel');

// A small, explicit, safe surface exposed to the renderer.
// The renderer can NOT touch Node directly — only these methods.
contextBridge.exposeInMainWorld('jarvis', {
  // Build channel (static, available immediately — no IPC round-trip needed).
  channel: CHANNEL,
  dangerousFeatures: dangerousFeaturesEnabled,

  // Window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Models across all providers: { claude: {...}, ollama: {...} }
  listModels: () => ipcRenderer.invoke('models:list'),

  // Ollama server lifecycle: { state: 'starting'|'ready'|'failed' }
  onOllamaStatus: (cb) =>
    ipcRenderer.on('ollama:status', (_e, payload) => cb(payload)),

  // Auto-update lifecycle: { state: 'available'|'downloaded'|'error', ... }
  onUpdateStatus: (cb) =>
    ipcRenderer.on('update:status', (_e, payload) => cb(payload)),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),

  // Streaming chat. `onChunk` receives { type, text?, message? } for the
  // matching requestId. Returns an unsubscribe function.
  sendChat: (messages, requestId, provider, model, extra = {}) =>
    ipcRenderer.invoke('chat:send', { messages, requestId, provider, model, ...extra }),

  onChatStream: (requestId, onChunk) => {
    const listener = (_event, payload) => {
      if (payload.requestId === requestId) onChunk(payload);
    };
    ipcRenderer.on('chat:stream', listener);
    return () => ipcRenderer.removeListener('chat:stream', listener);
  },

  // Ollama model pulling
  pullModel: (model) => ipcRenderer.invoke('ollama:pull', { model }),

  onPullProgress: (cb) =>
    ipcRenderer.on('ollama:pull-progress', (_e, payload) => cb(payload)),

  // Ollama models-folder discovery + setup
  scanOllamaModels: () => ipcRenderer.invoke('ollama:scan-models'),
  applyOllamaModelsPath: (path) =>
    ipcRenderer.invoke('ollama:apply-models-path', { path }),
  onOllamaNoModels: (cb) =>
    ipcRenderer.on('ollama:no-models', (_e, payload) => cb(payload)),

  // Ollama install (when it isn't on the system yet)
  onOllamaNotInstalled: (cb) =>
    ipcRenderer.on('ollama:not-installed', (_e, payload) => cb(payload)),
  installOllama: () => ipcRenderer.invoke('ollama:install'),
  onInstallProgress: (cb) =>
    ipcRenderer.on('ollama:install-progress', (_e, payload) => cb(payload)),

  // Local commands
  runCommand: (name, args) =>
    ipcRenderer.invoke('command:run', { name, args }),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
  onSettingsChanged: (cb) =>
    ipcRenderer.on('settings:changed', (_e, s) => cb(s)),

  // First-run onboarding: persist the captured user profile.
  completeOnboarding: (profile) =>
    ipcRenderer.invoke('onboarding:complete', profile),

  // Neural TTS engines (Piper / Coqui)
  ttsState: () => ipcRenderer.invoke('tts:state'),
  installTts: (engine) => ipcRenderer.invoke('tts:install', { engine }),
  onTtsInstallProgress: (cb) =>
    ipcRenderer.on('tts:install-progress', (_e, payload) => cb(payload)),
  ttsSynth: (engine, text, voice) =>
    ipcRenderer.invoke('tts:synth', { engine, text, voice }),

  // Local speech-to-text (faster-whisper)
  sttState: () => ipcRenderer.invoke('stt:state'),
  installStt: (model) => ipcRenderer.invoke('stt:install', { model }),
  onSttInstallProgress: (cb) =>
    ipcRenderer.on('stt:install-progress', (_e, payload) => cb(payload)),
  sttTranscribe: (audio, model, language) =>
    ipcRenderer.invoke('stt:transcribe', { audio, model, language }),

  // VM (Danger Zone) — test an SSH connection / auto-detect VMs
  testVmConnection: (cfg) => ipcRenderer.invoke('vm:test', cfg),
  detectVms: () => ipcRenderer.invoke('vm:detect'),

  // In-chat code approval queue
  onCodeApproval: (cb) =>
    ipcRenderer.on('codequeue:pending', (_e, payload) => cb(payload)),
  respondCodeApproval: (response) => ipcRenderer.invoke('codequeue:respond', response),

  // In-chat file-write approval queue (Nightly only)
  onFileWriteApproval: (cb) =>
    ipcRenderer.on('filequeue:pending', (_e, payload) => cb(payload)),
  respondFileWriteApproval: (response) => ipcRenderer.invoke('filequeue:respond', response),

  // System + dialogs
  getSystemStats: () => ipcRenderer.invoke('system:stats'),
  exportLogs: () => ipcRenderer.invoke('logs:export'),
  reportLogs: () => ipcRenderer.invoke('logs:report'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
});
