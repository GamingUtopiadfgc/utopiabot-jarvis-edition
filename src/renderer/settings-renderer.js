'use strict';

const $ = (id) => document.getElementById(id);

const THEMES = {
  jarvis: { hex: '#38e1ff', rgb: '56,225,255', dim: '#1a7d96' },
  red: { hex: '#ff4d5e', rgb: '255,77,94', dim: '#9c3742' },
  emerald: { hex: '#2ee6a6', rgb: '46,230,166', dim: '#1c8a64' },
  purple: { hex: '#b18cff', rgb: '177,140,255', dim: '#6f5aa6' },
};
function applyTheme(key) {
  const t = THEMES[key] || THEMES.jarvis;
  const r = document.documentElement.style;
  r.setProperty('--cyan', t.hex);
  r.setProperty('--cyan-dim', t.dim);
  r.setProperty('--cyan-glow', `rgba(${t.rgb},0.55)`);
}

// ---- Section navigation ----
const navItems = [...document.querySelectorAll('.nav-item')];
const sections = [...document.querySelectorAll('.sec')];
let systemTimer = null;
navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    const sec = btn.dataset.sec;
    navItems.forEach((b) => b.classList.toggle('active', b === btn));
    sections.forEach((s) => s.classList.toggle('active', s.dataset.sec === sec));
    if (sec === 'system') startSystemPolling();
    else stopSystemPolling();
  });
});

// ---- Populate dynamic lists ----
async function loadVoices() {
  const sel = $('v-voiceURI');
  const voices = speechSynthesis.getVoices();
  const current = sel.dataset.value || '';
  sel.innerHTML = '<option value="">System default</option>';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  if (current) sel.value = current;
}
speechSynthesis.onvoiceschanged = loadVoices;

async function loadMics() {
  const sel = $('v-micId');
  const current = sel.dataset.value || '';
  sel.innerHTML = '<option value="">Default Microphone</option>';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    devices
      .filter((d) => d.kind === 'audioinput')
      .forEach((d) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Microphone ${sel.length}`;
        sel.appendChild(o);
      });
  } catch {
    /* permissions may block labels — default option still works */
  }
  if (current) sel.value = current;
}

async function loadModels(provider) {
  const sel = $('n-model');
  const current = sel.dataset.value || '';
  sel.innerHTML = '';
  let data;
  try {
    data = await window.jarvis.listModels();
  } catch {
    data = {};
  }
  const add = (val, label, disabled) => {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    if (disabled) o.disabled = true;
    sel.appendChild(o);
  };
  if (provider === 'claude') {
    const m = data.claude?.model || 'claude-opus-4-8';
    add(m, data.claude?.configured ? m : `${m} (no API key)`, !data.claude?.configured);
  } else {
    const models = data.ollama?.models || [];
    if (models.length) models.forEach((m) => add(m, m));
    else add('', data.ollama?.available ? 'no models pulled' : 'server offline', true);
  }
  if (current) {
    const match = [...sel.options].find((o) => o.value === current);
    if (match) sel.value = current;
  }
}

// ---- Load settings into the form ----
function populate(s) {
  // General
  $('g-startWithWindows').checked = s.general.startWithWindows;
  $('g-minimizeToTray').checked = s.general.minimizeToTray;
  $('g-notifications').checked = s.general.notifications;
  $('g-launchOllama').checked = s.general.launchOllama;

  // Voice
  document.querySelector(`#v-engine input[value="${s.voice.engine}"]`)?.setAttribute('checked', '');
  const eng = document.querySelector(`#v-engine input[value="${s.voice.engine}"]`);
  if (eng) eng.checked = true;
  $('v-wakeWord').value = s.voice.wakeWord;
  $('v-enableWakeWord').checked = s.voice.enableWakeWord;
  $('v-autoListen').checked = s.voice.autoListen;
  $('v-speakResponses').checked = s.voice.speakResponses;
  $('v-startupGreeting').checked = s.voice.startupGreeting;
  $('v-voiceURI').dataset.value = s.voice.voiceURI;
  $('v-micId').dataset.value = s.voice.micId;
  loadVoices();
  loadMics();

  // Neural
  $('n-provider').value = s.neural.provider;
  $('n-model').dataset.value = s.neural.model;
  $('n-temperature').value = s.neural.temperature;
  $('n-temp-val').textContent = Number(s.neural.temperature).toFixed(2);
  $('n-contextLength').value = s.neural.contextLength;
  $('n-maxTokens').value = s.neural.maxTokens;
  $('n-systemPrompt').value = s.neural.systemPrompt;
  loadModels(s.neural.provider);

  // Memory
  $('m-longTerm').checked = s.memory.longTerm;
  $('m-saveConversations').checked = s.memory.saveConversations;
  $('m-autoSummarize').checked = s.memory.autoSummarize;
  $('m-folder').value = s.memory.folder;
  const vdb = document.querySelector(`#m-vectorDb input[value="${s.memory.vectorDb}"]`);
  if (vdb) vdb.checked = true;

  // Automation
  $('a-desktopControl').checked = s.automation.desktopControl;
  $('a-powershell').checked = s.automation.powershell;
  $('a-browserControl').checked = s.automation.browserControl;
  $('a-requireApproval').checked = s.automation.requireApproval;
  const sl = document.querySelector(`#a-securityLevel input[value="${s.automation.securityLevel}"]`);
  if (sl) sl.checked = true;

  // Appearance
  const th = document.querySelector(`#ap-theme input[value="${s.appearance.theme}"]`);
  if (th) th.checked = true;
  $('ap-fontScale').value = s.appearance.fontScale;
  $('ap-scale-val').textContent = Math.round(s.appearance.fontScale * 100) + '%';
  $('ap-waveform').checked = s.appearance.waveform;
  $('ap-particles').checked = s.appearance.particles;
  applyTheme(s.appearance.theme);

  // Advanced
  $('x-debugLogs').checked = s.advanced.debugLogs;
  $('x-devConsole').checked = s.advanced.devConsole;
  $('x-apiServer').checked = s.advanced.apiServer;
  $('x-apiPort').value = s.advanced.apiPort;
  $('x-ollamaUrl').value = s.advanced.ollamaUrl;
  $('x-memoryApi').checked = s.advanced.memoryApi;
}

// ---- Collect form into a settings object ----
function collect() {
  const radio = (name) =>
    document.querySelector(`input[name="${name}"]:checked`)?.value;
  return {
    general: {
      startWithWindows: $('g-startWithWindows').checked,
      minimizeToTray: $('g-minimizeToTray').checked,
      notifications: $('g-notifications').checked,
      launchOllama: $('g-launchOllama').checked,
    },
    voice: {
      engine: radio('v-engine') || 'windows',
      wakeWord: $('v-wakeWord').value.trim() || 'Hey Utopia',
      enableWakeWord: $('v-enableWakeWord').checked,
      autoListen: $('v-autoListen').checked,
      speakResponses: $('v-speakResponses').checked,
      startupGreeting: $('v-startupGreeting').checked,
      voiceURI: $('v-voiceURI').value,
      micId: $('v-micId').value,
    },
    neural: {
      provider: $('n-provider').value,
      model: $('n-model').value,
      temperature: parseFloat($('n-temperature').value),
      contextLength: parseInt($('n-contextLength').value, 10) || 8192,
      maxTokens: parseInt($('n-maxTokens').value, 10) || 4096,
      systemPrompt: $('n-systemPrompt').value,
    },
    memory: {
      longTerm: $('m-longTerm').checked,
      saveConversations: $('m-saveConversations').checked,
      autoSummarize: $('m-autoSummarize').checked,
      folder: $('m-folder').value.trim(),
      vectorDb: radio('m-vectorDb') || 'faiss',
    },
    automation: {
      desktopControl: $('a-desktopControl').checked,
      powershell: $('a-powershell').checked,
      browserControl: $('a-browserControl').checked,
      requireApproval: $('a-requireApproval').checked,
      securityLevel: radio('a-securityLevel') || 'normal',
    },
    appearance: {
      theme: radio('ap-theme') || 'jarvis',
      fontScale: parseFloat($('ap-fontScale').value),
      waveform: $('ap-waveform').checked,
      particles: $('ap-particles').checked,
    },
    advanced: {
      debugLogs: $('x-debugLogs').checked,
      devConsole: $('x-devConsole').checked,
      apiServer: $('x-apiServer').checked,
      apiPort: parseInt($('x-apiPort').value, 10) || 8000,
      ollamaUrl: $('x-ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
      memoryApi: $('x-memoryApi').checked,
    },
  };
}

// ---- Live previews ----
$('n-temperature').addEventListener('input', (e) => {
  $('n-temp-val').textContent = Number(e.target.value).toFixed(2);
});
$('ap-fontScale').addEventListener('input', (e) => {
  $('ap-scale-val').textContent = Math.round(e.target.value * 100) + '%';
});
$('n-provider').addEventListener('change', (e) => {
  $('n-model').dataset.value = '';
  loadModels(e.target.value);
});
document.querySelectorAll('#ap-theme input').forEach((r) =>
  r.addEventListener('change', (e) => applyTheme(e.target.value))
);
$('m-folder-pick').addEventListener('click', async () => {
  const dir = await window.jarvis.pickFolder();
  if (dir) $('m-folder').value = dir;
});

// ---- System tab live stats ----
async function refreshSystem() {
  try {
    const stats = await window.jarvis.getSystemStats();
    $('sys-cpu').textContent = stats.cpu + '%';
    $('sys-ram').textContent = `${stats.ramUsedGB} / ${stats.ramTotalGB} GB`;
    $('sys-gpu').textContent = stats.gpu == null ? 'N/A' : stats.gpu + '%';
  } catch {
    /* ignore */
  }
  try {
    const models = await window.jarvis.listModels();
    $('sys-ollama').textContent = models.ollama?.available ? 'ONLINE' : 'OFFLINE';
    $('sys-ollama').style.color = models.ollama?.available ? 'var(--cyan)' : 'var(--danger)';
  } catch {
    /* ignore */
  }
  $('sys-voice').textContent = 'speechSynthesis' in window ? 'ONLINE' : 'N/A';
  const s = collect();
  $('sys-memory').textContent = s.memory.longTerm ? 'ENABLED' : 'STANDBY';
}
function startSystemPolling() {
  refreshSystem();
  if (!systemTimer) systemTimer = setInterval(refreshSystem, 2000);
}
function stopSystemPolling() {
  if (systemTimer) {
    clearInterval(systemTimer);
    systemTimer = null;
  }
}

// ---- Buttons ----
$('s-save').addEventListener('click', async () => {
  await window.jarvis.saveSettings(collect());
  const note = $('save-note');
  note.textContent = 'Configuration saved.';
  setTimeout(() => (note.textContent = ''), 2500);
});
$('s-reset').addEventListener('click', async () => {
  const s = await window.jarvis.resetSettings();
  populate(s);
  $('save-note').textContent = 'Reset to defaults.';
  setTimeout(() => ($('save-note').textContent = ''), 2500);
});
$('s-close').addEventListener('click', () => window.jarvis.closeSettings());
$('s-close-x').addEventListener('click', () => window.jarvis.closeSettings());

// ---- Init ----
window.jarvis.getSettings().then(populate);
