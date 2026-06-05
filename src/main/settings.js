'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Full settings schema with defaults. New keys added here are auto-merged into
// existing users' saved files on load.
const DEFAULTS = {
  general: {
    startWithWindows: false,
    minimizeToTray: false,
    notifications: true,
    launchOllama: true,
  },
  voice: {
    engine: 'windows', // 'windows' | 'piper' | 'coqui'
    wakeWord: 'Hey Utopia',
    enableWakeWord: false,
    autoListen: false,
    speakResponses: true,
    startupGreeting: true,
    sttEngine: 'browser', // 'browser' | 'whisper' (local speech-to-text)
    sttModel: 'base.en', // chosen faster-whisper model id
    voiceURI: '', // chosen SpeechSynthesis voice (windows engine)
    micId: '', // chosen microphone deviceId
    piperVoice: '', // chosen Piper voice id (blank = first installed)
    coquiModel: '', // chosen Coqui model name (blank = default)
  },
  neural: {
    provider: 'ollama', // 'ollama' | 'claude'
    model: '',
    temperature: 0.7,
    contextLength: 8192,
    maxTokens: 4096,
    systemPrompt: '', // blank = use built-in JARVIS persona
  },
  memory: {
    longTerm: false,
    saveConversations: false,
    autoSummarize: false,
    folder: '',
    vectorDb: 'faiss', // 'faiss' | 'chromadb' (future)
  },
  automation: {
    desktopControl: false,
    powershell: false,
    browserControl: false,
    requireApproval: true,
    securityLevel: 'normal', // 'strict' | 'normal' | 'developer'
  },
  appearance: {
    theme: 'jarvis', // 'jarvis' | 'red' | 'emerald' | 'purple'
    fontScale: 1.0,
    waveform: true,
    particles: true,
  },
  advanced: {
    debugLogs: false,
    devConsole: false,
    apiServer: false, // future
    apiPort: 8000,
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModelsPath: '', // custom Ollama models folder (uses OLLAMA_MODELS env var)
    memoryApi: true,
  },
};

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Recursively merge `over` onto `base` (objects merged; primitives/arrays replaced).
function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over || {})) {
    if (isObj(out[k]) && isObj(over[k])) out[k] = deepMerge(out[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = deepMerge(structuredClone(DEFAULTS), raw);
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function persist(value) {
  cache = value;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(value, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
  return value;
}

// Accepts a partial patch or full object; returns the merged result.
function save(patch) {
  return persist(deepMerge(load(), patch || {}));
}

function reset() {
  return persist(structuredClone(DEFAULTS));
}

module.exports = { load, save, reset, DEFAULTS };
