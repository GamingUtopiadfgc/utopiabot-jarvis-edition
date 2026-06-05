'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// A small, explicit, safe surface exposed to the renderer.
// The renderer can NOT touch Node directly — only these methods.
contextBridge.exposeInMainWorld('jarvis', {
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

  // Streaming chat. `onChunk` receives { type, text?, message? } for the
  // matching requestId. Returns an unsubscribe function.
  sendChat: (messages, requestId, provider, model) =>
    ipcRenderer.invoke('chat:send', { messages, requestId, provider, model }),

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

  // System + dialogs
  getSystemStats: () => ipcRenderer.invoke('system:stats'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
});
