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

// ---- Build channel gating ----
// VM / Danger Zone is a dangerous, dev-only feature — hide its nav entry unless
// this is a Nightly build (its panel is unreachable without the nav button).
if (!window.jarvis.dangerousFeatures) {
  document.querySelector('.nav-item[data-sec="vm"]')?.style.setProperty('display', 'none');
}
if (window.jarvis.channel === 'nightly') {
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = 'SETTINGS · NIGHTLY';
}

// ---- Section navigation ----
const navItems = [...document.querySelectorAll('.nav-item')];
const sections = [...document.querySelectorAll('.sec')];
let systemTimer = null;
let dangerZoneUnlocked = false; // confirmed once per settings session

function switchSection(sec) {
  const btn = navItems.find((b) => b.dataset.sec === sec);
  navItems.forEach((b) => b.classList.toggle('active', b.dataset.sec === sec));
  sections.forEach((s) => s.classList.toggle('active', s.dataset.sec === sec));
  if (sec === 'system') startSystemPolling();
  else stopSystemPolling();
}

function showDangerModal(onConfirm) {
  $('dz-modal').style.display = 'flex';
  // Replace buttons each time to avoid stacking listeners
  ['dz-modal-confirm', 'dz-modal-cancel'].forEach((id) => {
    const el = $(id);
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
  });
  $('dz-modal-confirm').addEventListener('click', () => {
    $('dz-modal').style.display = 'none';
    dangerZoneUnlocked = true;
    onConfirm();
  });
  $('dz-modal-cancel').addEventListener('click', () => {
    $('dz-modal').style.display = 'none';
    switchSection('general');
  });
}

navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    const sec = btn.dataset.sec;
    if (sec === 'vm' && window.jarvis.dangerousFeatures && !dangerZoneUnlocked) {
      // Show the warning modal — only switch if confirmed
      showDangerModal(() => switchSection('vm'));
      return;
    }
    switchSection(sec);
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
    // Device labels are hidden until the page has been granted mic access at
    // least once — prime a getUserMedia call, then release it immediately.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      /* permission denied — we'll still list devices without labels */
    }
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

// ---- Neural TTS (Piper / Coqui) ----
let ttsState = { piper: { installed: false, voices: [] }, coqui: { installed: false, models: [] } };

// Show only the picker panel for the selected engine.
function showEnginePanel(engine) {
  document.querySelectorAll('.tts-engine').forEach((el) => {
    el.style.display = el.dataset.engine === engine ? '' : 'none';
  });
}

function fillSelect(sel, items, current, emptyLabel) {
  sel.innerHTML = '';
  if (!items.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = emptyLabel;
    o.disabled = true;
    sel.appendChild(o);
    return;
  }
  for (const id of items) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id;
    sel.appendChild(o);
  }
  if (current && items.includes(current)) sel.value = current;
}

async function loadTtsState() {
  try {
    ttsState = await window.jarvis.ttsState();
  } catch {
    /* keep defaults */
  }
  fillSelect($('v-piperVoice'), ttsState.piper.voices, $('v-piperVoice').dataset.value,
    'Not installed — click Install');
  fillSelect($('v-coquiModel'), ttsState.coqui.models, $('v-coquiModel').dataset.value || '',
    'Not installed — click Install');
  $('v-piper-status').textContent = ttsState.piper.installed ? 'Installed.' : 'Not installed.';
  $('v-coqui-status').textContent = ttsState.coqui.installed ? 'Installed.' : 'Not installed.';
}

// Wire an engine's Install + Test buttons. Args are element ids.
function wireTtsEngine(engine, installId, testId, statusId, selectId) {
  $(installId).addEventListener('click', async () => {
    $(installId).disabled = true;
    $(statusId).textContent = 'Starting install…';
    const res = await window.jarvis.installTts(engine);
    $(installId).disabled = false;
    if (res?.ok) {
      $(statusId).textContent = 'Installed. Ready to use.';
      loadTtsState();
    } else {
      $(statusId).textContent = res?.error || 'Install failed.';
    }
  });
  $(testId).addEventListener('click', async () => {
    $(statusId).textContent = 'Synthesizing test…';
    const res = await window.jarvis.ttsSynth(engine, 'All systems online, sir.', $(selectId).value);
    if (res?.ok && res.dataUrl) {
      new Audio(res.dataUrl).play().catch(() => {});
      $(statusId).textContent = 'Playing test.';
    } else {
      $(statusId).textContent = res?.error || 'Test failed — is it installed?';
    }
  });
}

// Live install progress from the main process.
window.jarvis.onTtsInstallProgress?.(({ engine, status }) => {
  const el = $(engine === 'coqui' ? 'v-coqui-status' : 'v-piper-status');
  if (el && status) el.textContent = status;
});

wireTtsEngine('piper', 'v-piper-install', 'v-piper-test', 'v-piper-status', 'v-piperVoice');
wireTtsEngine('coqui', 'v-coqui-install', 'v-coqui-test', 'v-coqui-status', 'v-coquiModel');

// Swap the visible picker panel when the engine changes.
document.querySelectorAll('#v-engine input').forEach((r) =>
  r.addEventListener('change', (e) => showEnginePanel(e.target.value))
);

// ---- Local speech-to-text (Whisper) ----
let sttState = { installed: false, models: ['base.en'], defaultModel: 'base.en' };

function showSttPanel(engine) {
  document.querySelectorAll('.stt-engine').forEach((el) => {
    el.style.display = el.dataset.engine === engine ? '' : 'none';
  });
}

async function loadSttState() {
  try {
    sttState = await window.jarvis.sttState();
  } catch {
    /* keep defaults */
  }
  fillSelect(
    $('v-sttModel'),
    sttState.models,
    $('v-sttModel').dataset.value || sttState.defaultModel,
    'unavailable'
  );
  $('v-stt-status').textContent = sttState.installed ? 'Installed.' : 'Not installed.';
}

$('v-stt-install').addEventListener('click', async () => {
  $('v-stt-install').disabled = true;
  $('v-stt-status').textContent = 'Starting install…';
  const res = await window.jarvis.installStt($('v-sttModel').value);
  $('v-stt-install').disabled = false;
  if (res?.ok) {
    $('v-stt-status').textContent = 'Installed. Ready to use.';
    loadSttState();
  } else {
    $('v-stt-status').textContent = res?.error || 'Install failed.';
  }
});

// Test: record ~3s from the chosen mic and show what Whisper heard.
$('v-stt-test').addEventListener('click', async () => {
  if (!window.AudioCapture) return;
  const status = $('v-stt-status');
  const rec = new window.AudioCapture.Recorder();
  try {
    status.textContent = 'Listening… speak now (3s).';
    await rec.start($('v-micId').value || '');
    await new Promise((r) => setTimeout(r, 3000));
    status.textContent = 'Transcribing…';
    const audio = await rec.stop();
    const res = await window.jarvis.sttTranscribe(audio, $('v-sttModel').value);
    if (res?.ok)
      status.textContent = res.text ? `Heard: "${res.text}"` : 'Heard nothing — check your mic.';
    else status.textContent = res?.error || 'Transcription failed.';
  } catch (err) {
    status.textContent = err.message || 'Mic error.';
  }
});

window.jarvis.onSttInstallProgress?.(({ status }) => {
  if (status) $('v-stt-status').textContent = status;
});

document.querySelectorAll('#v-sttEngine input').forEach((r) =>
  r.addEventListener('change', (e) => showSttPanel(e.target.value))
);

// ---- VM / Danger Zone (SSH) ----

// Intercept the enable checkbox — require explicit confirmation first.
$('vm-enabled').addEventListener('change', (e) => {
  if (e.target.checked) {
    e.target.checked = false; // hold off until confirmed
    $('vm-perm-card').style.display = '';
    $('vm-perm-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});
$('vm-perm-allow').addEventListener('click', () => {
  $('vm-enabled').checked = true;
  $('vm-perm-card').style.display = 'none';
});
$('vm-perm-deny').addEventListener('click', () => {
  $('vm-enabled').checked = false;
  $('vm-perm-card').style.display = 'none';
});

// Auto-detect VMs on this machine.
$('vm-detect-btn').addEventListener('click', async () => {
  const btn = $('vm-detect-btn');
  const status = $('vm-detect-status');
  const results = $('vm-detect-results');
  btn.disabled = true;
  status.textContent = 'Scanning…';
  results.style.display = 'none';

  const data = await window.jarvis.detectVms().catch(() => null);
  btn.disabled = false;

  if (!data?.ok) {
    status.textContent = data?.message || 'Detection failed.';
    return;
  }

  let html = '';

  if (data.runningInVm) {
    html += `<div class="vm-detect-guest">
      <span class="vm-detect-check">✓</span>
      This machine is running inside a <strong>${data.vmPlatform}</strong> VM.
      You can target the host OS by entering its bridge IP below.
    </div>`;
  }

  if (data.hostedVms.length) {
    status.textContent = `Found ${data.hostedVms.length} running VM${data.hostedVms.length > 1 ? 's' : ''}.`;
    for (const vm of data.hostedVms) {
      const safeIp   = vm.ip.replace(/"/g, '');
      const safeName = vm.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html += `
        <div class="vm-detect-row">
          <div class="vm-detect-info">
            <div class="vm-detect-name">${safeName} <span class="soon">(${vm.hypervisor})</span></div>
            ${vm.ip   ? `<div class="vm-detect-ip">${safeIp}:${vm.port}</div>` : ''}
            ${vm.note ? `<div class="soon">${vm.note}</div>` : ''}
          </div>
          <button class="btn-mini vm-use-btn"
            data-ip="${safeIp}"
            data-port="${vm.port}"
            data-name="${safeName.replace(/"/g, '&quot;')}">Use</button>
        </div>`;
    }
  } else if (!data.runningInVm) {
    status.textContent = 'No running VMs detected. Enter connection details manually.';
  } else {
    status.textContent = '';
  }

  if (html) {
    results.innerHTML = html;
    results.style.display = '';
    results.querySelectorAll('.vm-use-btn').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.ip)   $('vm-host').value = b.dataset.ip;
        if (b.dataset.port) $('vm-port').value = b.dataset.port;
        status.textContent = `Settings populated from "${b.dataset.name}".`;
        results.style.display = 'none';
      });
    });
  }
});

// Show only the password or private-key field for the chosen auth method.
function showVmAuthPanel(method) {
  document.querySelectorAll('.vm-auth').forEach((el) => {
    el.style.display = el.dataset.auth === method ? '' : 'none';
  });
}

document.querySelectorAll('#vm-authMethod input').forEach((r) =>
  r.addEventListener('change', (e) => showVmAuthPanel(e.target.value))
);

$('vm-key-pick').addEventListener('click', async () => {
  const file = await window.jarvis.pickFile();
  if (file) $('vm-privateKeyPath').value = file;
});

$('vm-test').addEventListener('click', async () => {
  const status = $('vm-test-status');
  $('vm-test').disabled = true;
  status.textContent = 'Connecting to the VM…';
  try {
    const res = await window.jarvis.testVmConnection(collect().vm);
    status.textContent = res?.message || (res?.ok ? 'Connected.' : 'Connection failed.');
    status.style.color = res?.ok ? 'var(--cyan)' : 'var(--danger)';
  } catch (err) {
    status.textContent = err?.message || 'Connection failed.';
    status.style.color = 'var(--danger)';
  }
  $('vm-test').disabled = false;
});

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
    installedModelIds = models; // keep pull picker in sync
    if (models.length) models.forEach((m) => add(m, m));
    else add('', data.ollama?.available ? 'no models pulled' : 'server offline', true);
  }
  if (current) {
    const match = [...sel.options].find((o) => o.value === current);
    if (match) sel.value = current;
  }
}

// ---- Load settings into the form ----
let appSettings = null;
function populate(s) {
  appSettings = s;
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
  $('v-piperVoice').dataset.value = s.voice.piperVoice || '';
  $('v-coquiModel').dataset.value = s.voice.coquiModel || '';
  const sttEng = document.querySelector(`#v-sttEngine input[value="${s.voice.sttEngine}"]`);
  if (sttEng) sttEng.checked = true;
  $('v-sttModel').dataset.value = s.voice.sttModel || 'base.en';
  loadVoices();
  loadMics();
  loadTtsState();
  loadSttState();
  showEnginePanel(s.voice.engine);
  showSttPanel(s.voice.sttEngine);

  // Neural
  $('n-provider').value = s.neural.provider;
  $('n-model').dataset.value = s.neural.model;
  $('n-temperature').value = s.neural.temperature;
  $('n-temp-val').textContent = Number(s.neural.temperature).toFixed(2);
  $('n-contextLength').value = s.neural.contextLength;
  $('n-maxTokens').value = s.neural.maxTokens;
  $('n-systemPrompt').value = s.neural.systemPrompt;
  loadModels(s.neural.provider);
  togglePullField(s.neural.provider);

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

  // VM / Danger Zone
  $('vm-enabled').checked = s.vm.enabled;
  $('vm-host').value = s.vm.host;
  $('vm-port').value = s.vm.port;
  $('vm-username').value = s.vm.username;
  const vmAuth = document.querySelector(`#vm-authMethod input[value="${s.vm.authMethod}"]`);
  if (vmAuth) vmAuth.checked = true;
  $('vm-password').value = s.vm.password;
  $('vm-privateKeyPath').value = s.vm.privateKeyPath;
  $('vm-allowUnattended').checked = s.vm.allowUnattended;
  showVmAuthPanel(s.vm.authMethod);

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
  $('x-ollamaModelsPath').value = s.advanced.ollamaModelsPath;
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
      sttEngine: radio('v-sttEngine') || 'browser',
      sttModel: $('v-sttModel').value || 'base.en',
      voiceURI: $('v-voiceURI').value,
      micId: $('v-micId').value,
      piperVoice: $('v-piperVoice').value,
      coquiModel: $('v-coquiModel').value,
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
    vm: {
      enabled: $('vm-enabled').checked,
      host: $('vm-host').value.trim(),
      port: parseInt($('vm-port').value, 10) || 22,
      username: $('vm-username').value.trim(),
      authMethod: radio('vm-authMethod') || 'password',
      password: $('vm-password').value,
      privateKeyPath: $('vm-privateKeyPath').value.trim(),
      allowUnattended: $('vm-allowUnattended').checked,
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
      ollamaModelsPath: $('x-ollamaModelsPath').value.trim(),
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
document.querySelectorAll('#ap-theme input').forEach((r) =>
  r.addEventListener('change', (e) => applyTheme(e.target.value))
);
$('m-folder-pick').addEventListener('click', async () => {
  const dir = await window.jarvis.pickFolder();
  if (dir) $('m-folder').value = dir;
});
$('x-ollamaModelsPath-pick').addEventListener('click', async () => {
  const dir = await window.jarvis.pickFolder();
  if (dir) $('x-ollamaModelsPath').value = dir;
});
// ---- Check for Updates ----
$('x-check-updates').addEventListener('click', async () => {
  const status = $('x-update-status');
  $('x-check-updates').disabled = true;
  status.textContent = 'Checking for updates…';
  const res = await window.jarvis.checkUpdates();
  $('x-check-updates').disabled = false;
  // Packaged builds emit detailed state via onUpdateStatus below; in dev we
  // get an immediate answer here.
  if (res?.dev) status.textContent = 'Updates only apply to the installed app.';
});

// React to update lifecycle events (broadcast from the main process).
window.jarvis.onUpdateStatus(({ state, version, message }) => {
  const status = $('x-update-status');
  if (!status) return;
  const msg = {
    checking: 'Checking for updates…',
    none: "You're on the latest version, sir.",
    available: `Update v${version} found — downloading…`,
    downloaded: `Update v${version} ready. Restart to apply.`,
    error: `Update check failed: ${message || 'unknown error'}`,
    dev: 'Updates only apply to the installed app.',
  }[state];
  if (msg) status.textContent = msg;
});

$('x-ollamaModelsPath-scan').addEventListener('click', async () => {
  const status = $('x-ollamaModelsPath-status');
  status.textContent = 'Searching your drives for Ollama models…';
  try {
    const { stores } = await window.jarvis.scanOllamaModels();
    if (stores && stores.length) {
      const top = stores[0];
      $('x-ollamaModelsPath').value = top.path;
      status.textContent =
        `Found ${top.modelCount} model${top.modelCount === 1 ? '' : 's'} at ${top.path}. Save to apply.`;
    } else {
      status.textContent =
        'No Ollama model folders found — use Browse to set it manually.';
    }
  } catch {
    status.textContent = 'Search failed. Use Browse to set the folder manually.';
  }
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

// ---- Pull model — curated dropdown with install-status + dependency check ----
let isPulling = false;
let pullPickerSelected = null;
let pullPanelOpen = false;
let installedModelIds = [];

const CURATED_MODELS = [
  { id: 'llama3.2:1b',      label: 'Llama 3.2 1B',       size: '1.3 GB', desc: 'Ultra-fast, lowest memory footprint' },
  { id: 'llama3.2:3b',      label: 'Llama 3.2 3B',       size: '2.0 GB', desc: 'Fast — great for daily use' },
  { id: 'llama3.1:8b',      label: 'Llama 3.1 8B',       size: '4.7 GB', desc: 'Well-rounded general purpose' },
  { id: 'llama3.1:70b',     label: 'Llama 3.1 70B',      size: '40 GB',  desc: 'High capability — needs powerful GPU' },
  { id: 'mistral:latest',   label: 'Mistral 7B',          size: '4.1 GB', desc: 'Fast and smart — great all-rounder' },
  { id: 'gemma2:2b',        label: 'Gemma 2 2B',          size: '1.6 GB', desc: "Google's compact model" },
  { id: 'gemma2:9b',        label: 'Gemma 2 9B',          size: '5.5 GB', desc: "Google's balanced model" },
  { id: 'qwen2.5:3b',       label: 'Qwen 2.5 3B',         size: '1.9 GB', desc: 'Great at coding and multilingual' },
  { id: 'qwen2.5:7b',       label: 'Qwen 2.5 7B',         size: '4.4 GB', desc: 'Strong coder — Alibaba' },
  { id: 'codellama:7b',     label: 'Code Llama 7B',       size: '3.8 GB', desc: 'Meta — specialized for code' },
  { id: 'phi3.5',           label: 'Phi-3.5 Mini 3.8B',   size: '2.2 GB', desc: "Microsoft's efficient small model" },
  { id: 'deepseek-r1:1.5b', label: 'DeepSeek R1 1.5B',   size: '1.1 GB', desc: 'Tiny reasoning model' },
  { id: 'deepseek-r1:7b',   label: 'DeepSeek R1 7B',      size: '4.7 GB', desc: 'Reasoning with chain-of-thought' },
  { id: 'deepseek-r1:14b',  label: 'DeepSeek R1 14B',     size: '9.0 GB', desc: 'High-quality reasoning model' },
];

function togglePullField(provider) {
  $('n-pull-field').style.display = provider === 'ollama' ? '' : 'none';
}

function buildPullPanel() {
  const panel = $('n-pull-panel');
  panel.innerHTML = '';
  const inst = CURATED_MODELS.filter((m) => installedModelIds.includes(m.id));
  const avail = CURATED_MODELS.filter((m) => !installedModelIds.includes(m.id));

  if (inst.length) {
    const h = document.createElement('div');
    h.className = 'mpick-section-header';
    h.textContent = 'Installed';
    panel.appendChild(h);
    inst.forEach((m) => panel.appendChild(makePullItem(m, true)));
  }

  const h2 = document.createElement('div');
  h2.className = 'mpick-section-header';
  h2.textContent = inst.length ? 'Available to pull' : 'Popular models';
  panel.appendChild(h2);
  avail.forEach((m) => panel.appendChild(makePullItem(m, false)));
}

function makePullItem(m, installed) {
  const el = document.createElement('div');
  el.className = 'mpick-item' + (pullPickerSelected?.id === m.id ? ' selected' : '');
  el.innerHTML = `
    <span class="mpick-item-status ${installed ? 'mpick-item-status--ok' : 'mpick-item-status--pull'}">${installed ? '✓' : '⬇'}</span>
    <div class="mpick-item-info">
      <div class="mpick-item-name">${m.label}</div>
      <div class="mpick-item-desc">${m.desc}</div>
    </div>
    <span class="mpick-item-size">${m.size}</span>
  `;
  el.addEventListener('click', () => selectPullModel(m, installed));
  return el;
}

function selectPullModel(m, installed) {
  pullPickerSelected = { ...m, installed };
  closePullPanel();

  $('n-pull-label').textContent = m.label;
  $('n-pull-badge').textContent = installed ? 'INSTALLED' : m.size;
  $('n-pull-badge').className = `mpick-badge ${installed ? 'mpick-badge--ok' : 'mpick-badge--pull'}`;

  // Clear all sub-areas
  ['n-dep-status', 'n-dep-progress', 'n-pull-progress', 'n-pull-confirm', 'n-pull-already']
    .forEach((id) => { $( id).style.display = 'none'; });

  if (installed) {
    $('n-pull-already').textContent = `✓ ${m.label} is already installed and ready to use.`;
    $('n-pull-already').style.display = '';
  } else {
    $('n-pull-confirm').innerHTML = `
      <span>${m.label} <span class="soon">(${m.size})</span> is not installed.</span>
      <button id="n-pull-yes" class="btn-mini">Pull &amp; Install</button>
      <button id="n-pull-cancel-btn" class="btn-mini btn-ghost-mini">Cancel</button>
    `;
    $('n-pull-confirm').style.display = 'flex';
    $('n-pull-yes').addEventListener('click', startPull);
    $('n-pull-cancel-btn').addEventListener('click', cancelPull);
  }
}

function closePullPanel() {
  $('n-pull-panel').style.display = 'none';
  pullPanelOpen = false;
}

function cancelPull() {
  pullPickerSelected = null;
  $('n-pull-label').textContent = 'Choose a model to pull…';
  $('n-pull-badge').textContent = '';
  $('n-pull-badge').className = 'mpick-badge mpick-badge--none';
  $('n-pull-confirm').style.display = 'none';
  $('n-dep-status').style.display = 'none';
}

async function startPull() {
  if (isPulling || !pullPickerSelected) return;
  const model = pullPickerSelected.id;

  // Step 1 — check Ollama is available (dependency check)
  let ollamaOk = false;
  try {
    const data = await window.jarvis.listModels();
    ollamaOk = !!data.ollama?.available;
  } catch { /* assume offline */ }

  $('n-pull-confirm').style.display = 'none';

  if (!ollamaOk) {
    const dep = $('n-dep-status');
    dep.innerHTML = `
      <span style="color:var(--danger)">⚠ Ollama is not running or not installed.</span>
      <button id="n-dep-install-btn" class="btn-mini">Install Ollama</button>
      <button id="n-dep-retry-btn" class="btn-mini btn-ghost-mini">Retry</button>
    `;
    dep.style.display = 'flex';
    $('n-dep-install-btn').addEventListener('click', installOllama);
    $('n-dep-retry-btn').addEventListener('click', () => {
      dep.style.display = 'none';
      $('n-pull-confirm').style.display = 'flex';
    });
    return;
  }

  // Step 2 — pull the model
  isPulling = true;
  const yesBtn = $('n-pull-yes');
  if (yesBtn) yesBtn.disabled = true;
  $('n-pull-progress').textContent = `Pulling ${model}…`;
  $('n-pull-progress').style.display = '';
  await window.jarvis.pullModel(model);
}

async function installOllama() {
  $('n-dep-status').style.display = 'none';
  const prog = $('n-dep-progress');
  prog.style.display = '';
  prog.textContent = 'Starting Ollama installation…';
  const result = await window.jarvis.installOllama();
  if (result?.ok) {
    prog.textContent = 'Ollama installed and running. Click Pull & Install to continue.';
    $('n-pull-confirm').style.display = 'flex';
  } else {
    prog.textContent =
      'Automatic install did not complete — install Ollama manually from https://ollama.com/download';
  }
}

// Open/close the picker panel, refreshing the installed list on each open.
$('n-pull-trigger').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (pullPanelOpen) { closePullPanel(); return; }
  try {
    const data = await window.jarvis.listModels();
    installedModelIds = data.ollama?.models || [];
  } catch { installedModelIds = []; }
  buildPullPanel();
  $('n-pull-panel').style.display = '';
  pullPanelOpen = true;
});

document.addEventListener('click', (e) => {
  if (pullPanelOpen && !$('n-pull-wrap').contains(e.target)) closePullPanel();
});

$('n-provider').addEventListener('change', (e) => {
  $('n-model').dataset.value = '';
  loadModels(e.target.value);
  togglePullField(e.target.value);
});

$('n-refresh').addEventListener('click', () => {
  if (appSettings) loadModels(appSettings.neural.provider);
});

// Ollama install progress (broadcast from main process during installation)
window.jarvis.onInstallProgress?.(({ status }) => {
  const el = $('n-dep-progress');
  if (el && status) { el.style.display = ''; el.textContent = status; }
});

// Pull progress from main process
window.jarvis.onPullProgress?.(({ model, status }) => {
  $('n-pull-progress').style.display = '';
  $('n-pull-progress').textContent = status;

  if (/✓ .+ ready/.test(status) || /error|failed|not found/i.test(status)) {
    isPulling = false;
    const yesBtn = $('n-pull-yes');
    if (yesBtn) yesBtn.disabled = false;

    if (/✓ .+ ready/.test(status)) {
      // Refresh the model selector and rebuild the pull panel with new installed set
      window.jarvis.listModels().then((data) => {
        installedModelIds = data.ollama?.models || [];
        buildPullPanel();
        if (appSettings) loadModels(appSettings.neural.provider);
      }).catch(() => {});
      // Update the trigger to show INSTALLED badge
      if (pullPickerSelected?.id === model) {
        pullPickerSelected.installed = true;
        $('n-pull-badge').textContent = 'INSTALLED';
        $('n-pull-badge').className = 'mpick-badge mpick-badge--ok';
        $('n-pull-confirm').style.display = 'none';
        $('n-pull-already').textContent = `✓ ${pullPickerSelected.label} installed successfully.`;
        $('n-pull-already').style.display = '';
      }
    }
  }
});

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
