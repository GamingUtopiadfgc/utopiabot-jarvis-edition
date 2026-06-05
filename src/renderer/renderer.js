'use strict';

// ===================================================================
// Element refs
// ===================================================================
const $ = (id) => document.getElementById(id);
const transcript = $('transcript');
const input = $('input');
const composer = $('composer');
const micBtn = $('mic-btn');
const reactorState = $('reactor-state');
const ttsToggle = $('tts-toggle');
const autoListenToggle = $('autolisten-toggle');

// Conversation history sent to the brain each turn (Anthropic message shape).
const history = [];
let busy = false;

// Live settings cache (from the Settings window).
let appSettings = null;
let greeted = false;

// ===================================================================
// Window controls
// ===================================================================
$('min-btn').onclick = () => window.jarvis.minimize();
$('max-btn').onclick = () => window.jarvis.toggleMaximize();
$('close-btn').onclick = () => window.jarvis.close();
$('settings-btn').onclick = () => window.jarvis.openSettings();

// ===================================================================
// Settings: apply appearance, voice, and neural prefs
// ===================================================================
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
  if (window.Reactor?.setAccent) window.Reactor.setAccent(t.hex, t.rgb);
}

function applyAppSettings(s) {
  appSettings = s;
  applyTheme(s.appearance.theme);
  document.body.style.zoom = s.appearance.fontScale || 1;
  window.__waveform = s.appearance.waveform;
  window.__particles = s.appearance.particles;
  ttsToggle.checked = s.voice.speakResponses;
  autoListenToggle.checked = s.voice.autoListen;
}

// ===================================================================
// Model selector — Claude + any local Ollama models
// ===================================================================
const modelSelect = $('model-select');
const modelRefresh = $('model-refresh');
let currentProvider = 'claude';
let currentModel = '';

function applySelection() {
  const [provider, ...rest] = modelSelect.value.split('::');
  currentProvider = provider || 'claude';
  currentModel = rest.join('::');
  $('stat-provider').textContent =
    currentProvider === 'ollama' ? 'OLLAMA · LOCAL' : 'ANTHROPIC';
  $('stat-model').textContent = currentModel.replace('claude-', '') || '—';
  const ok = Boolean(currentModel);
  $('stat-brain').textContent = ok ? 'ONLINE' : 'OFFLINE';
  $('stat-brain').style.color = ok ? 'var(--cyan)' : 'var(--danger)';
}

// Pick a sensible default model when nothing is saved: prefer the largest
// Ollama model that's <= 14B (fits typical GPUs), else the smallest available,
// else the first usable option (e.g. Claude). Avoids defaulting to a 32B that
// would OOM on a 16GB card.
function chooseSafeDefault(opts) {
  const usable = opts.filter((o) => o.value && !o.disabled);
  const ollama = usable.filter((o) => o.value.startsWith('ollama::'));
  if (ollama.length) {
    const sized = ollama.map((o) => {
      const m = o.value.slice(7).match(/(\d+(?:\.\d+)?)\s*b\b/i);
      return { o, size: m ? parseFloat(m[1]) : Infinity };
    });
    const fits = sized.filter((s) => s.size <= 14).sort((a, b) => b.size - a.size);
    if (fits.length) return fits[0].o;
    sized.sort((a, b) => a.size - b.size);
    return sized[0].o;
  }
  return usable[0];
}

async function populateModels() {
  modelRefresh.classList.add('spin');
  let data;
  try {
    data = await window.jarvis.listModels();
  } catch {
    data = { claude: { configured: false }, ollama: { available: false, models: [] } };
  }
  modelRefresh.classList.remove('spin');

  const prev = modelSelect.value;
  modelSelect.innerHTML = '';

  // --- Claude ---
  const cModel = data.claude?.model || 'claude-opus-4-8';
  const cg = document.createElement('optgroup');
  cg.label = 'CLAUDE';
  const cOpt = document.createElement('option');
  cOpt.value = `claude::${cModel}`;
  cOpt.textContent = data.claude?.configured
    ? `JARVIS · ${cModel.replace('claude-', '')}`
    : 'Claude (no API key)';
  cOpt.disabled = !data.claude?.configured;
  cg.appendChild(cOpt);
  modelSelect.appendChild(cg);

  // --- Ollama ---
  const og = document.createElement('optgroup');
  og.label = data.ollama?.available ? 'OLLAMA · LOCAL' : 'OLLAMA · OFFLINE';
  const models = data.ollama?.models || [];
  if (data.ollama?.available && models.length) {
    for (const m of models) {
      const o = document.createElement('option');
      o.value = `ollama::${m}`;
      o.textContent = m;
      og.appendChild(o);
    }
  } else {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = data.ollama?.available ? 'no models pulled' : 'server not running';
    o.disabled = true;
    og.appendChild(o);
  }
  modelSelect.appendChild(og);

  // Prefer the saved settings model, then prior choice, then a safe default.
  const desired = appSettings
    ? `${appSettings.neural.provider}::${appSettings.neural.model}`
    : '';
  const opts = [...modelSelect.querySelectorAll('option')];
  const pick =
    opts.find((o) => o.value === desired && !o.disabled) ||
    opts.find((o) => o.value === prev && !o.disabled) ||
    chooseSafeDefault(opts);
  if (pick) {
    modelSelect.value = pick.value;
    applySelection();
  } else {
    currentModel = '';
    $('stat-provider').textContent = '—';
    $('stat-brain').textContent = 'NO BRAIN';
    $('stat-brain').style.color = 'var(--danger)';
  }
}

// Persist the HUD's model choice so it survives restarts and syncs to Settings.
function onUserPickedModel() {
  applySelection();
  if (appSettings) {
    window.jarvis.saveSettings({
      neural: { provider: currentProvider, model: currentModel },
    });
  }
}

modelSelect.addEventListener('change', onUserPickedModel);
modelRefresh.addEventListener('click', () => populateModels());

// Persist HUD voice toggles back to settings.
ttsToggle.addEventListener('change', () => {
  if (appSettings) window.jarvis.saveSettings({ voice: { speakResponses: ttsToggle.checked } });
});
autoListenToggle.addEventListener('change', () => {
  if (appSettings) window.jarvis.saveSettings({ voice: { autoListen: autoListenToggle.checked } });
});

// Load settings, then build the model list (which prefers the saved model).
window.jarvis.getSettings().then((s) => {
  applyAppSettings(s);
  populateModels().then(() => {
    if (s.voice.startupGreeting && !greeted) {
      greeted = true;
      speak('Systems online. Good to see you, sir.', true);
    }
  });
});

// Re-apply when settings change in the Settings window.
window.jarvis.onSettingsChanged((s) => {
  applyAppSettings(s);
  const desired = `${s.neural.provider}::${s.neural.model}`;
  const opt = [...modelSelect.options].find((o) => o.value === desired && !o.disabled);
  if (opt) {
    modelSelect.value = desired;
    applySelection();
  } else {
    populateModels();
  }
});

// React to the auto-started Ollama server: refresh models when it's ready.
window.jarvis.onOllamaStatus(({ state }) => {
  if (state === 'starting') {
    $('stat-provider').textContent = 'STARTING OLLAMA…';
  } else if (state === 'ready') {
    populateModels();
  }
});

// Auto-update notifications.
window.jarvis.onUpdateStatus(({ state, version, message }) => {
  if (state === 'available') {
    addMessage('JARVIS', `A new version (v${version}) is available, sir — downloading it now.`);
  } else if (state === 'downloaded') {
    const el = addMessage(
      'JARVIS',
      `Update v${version} is ready. I'll apply it next time you restart me, or:`
    );
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = 'Restart & update now';
    btn.style.marginTop = '8px';
    btn.onclick = () => window.jarvis.installUpdate();
    el.appendChild(document.createElement('br'));
    el.appendChild(btn);
    transcript.scrollTop = transcript.scrollHeight;
  } else if (state === 'error') {
    console.warn('Update check failed:', message);
  }
});

function tickClock() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString([], { hour12: false });
  $('clock-date').textContent = now
    .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
}
setInterval(tickClock, 1000);
tickClock();

// Faux diagnostics that drift for ambience.
function tickDiagnostics() {
  for (const id of ['cpu', 'mem', 'net', 'pwr']) {
    const base = id === 'pwr' ? 78 : 25;
    const val = base + Math.random() * 35;
    $('bar-' + id).style.width = Math.min(98, val) + '%';
  }
}
setInterval(tickDiagnostics, 1400);
tickDiagnostics();

// ===================================================================
// Reactor state helper
// ===================================================================
function setReactor(state, label) {
  window.Reactor.setState(state);
  reactorState.textContent = label || state.toUpperCase();
}

// ===================================================================
// Transcript rendering
// ===================================================================
function addMessage(who, text, cls = '') {
  const wrap = document.createElement('div');
  wrap.className =
    'msg ' + (who === 'JARVIS' ? 'msg-jarvis' : 'msg-user') + (cls ? ' ' + cls : '');
  wrap.innerHTML =
    `<div class="msg-who">${who}</div><div class="msg-text"></div>`;
  wrap.querySelector('.msg-text').textContent = text;
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
  return wrap.querySelector('.msg-text');
}

// ===================================================================
// Local command parser — handles simple intents without the LLM.
// Returns { name, args, reply? } or null.
// ===================================================================
function parseCommand(raw) {
  const text = raw.toLowerCase().trim();

  if (/\b(what(?:'s| is)? the )?time\b/.test(text) && !/timer/.test(text))
    return { name: 'time' };
  if (/\b(what(?:'s| is)? )?(the )?(today'?s? )?date\b/.test(text) || /what day is it/.test(text))
    return { name: 'date' };

  let m = text.match(/\bopen (?:the )?(?:website |site )?(youtube|google|github|gmail|maps|twitter|reddit|spotify|netflix|weather)\b/);
  if (m) return { name: 'open-site', args: { target: m[1] } };

  m = text.match(/\bopen (?:the )?(notepad|calculator|calc|paint|explorer|cmd|terminal|settings|camera)\b/);
  if (m) return { name: 'open-app', args: { target: m[1] } };

  m = text.match(/\b(?:google|search(?: for| the web for)?) (.+)/);
  if (m && /\b(search|google)\b/.test(text))
    return { name: 'search-web', args: { query: m[1] } };

  m = text.match(/\bopen (?:the )?(?:website |site )?([a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)\b/);
  if (m) return { name: 'open-url', args: { url: m[1] } };

  return null;
}

// ===================================================================
// Main: handle a user utterance
// ===================================================================
async function handleUtterance(text) {
  text = text.trim();
  if (!text || busy) return;
  addMessage('YOU', text);
  input.value = '';

  const cmd = parseCommand(text);
  if (cmd) {
    busy = true;
    setReactor('thinking', 'EXECUTING');
    const res = await window.jarvis.runCommand(cmd.name, cmd.args || {});
    busy = false;
    addMessage('JARVIS', res.message);
    speak(res.message);
    setReactor('standby');
    return;
  }

  await askBrain(text);
}

// ===================================================================
// Streaming chat with the Claude brain over IPC
// ===================================================================
function askBrain(text) {
  return new Promise((resolve) => {
    if (!currentModel) {
      addMessage(
        'JARVIS',
        'No brain is available, sir. Add an ANTHROPIC_API_KEY, or start Ollama and pull a model, then hit the rescan button.',
        'msg-error'
      );
      resolve();
      return;
    }
    busy = true;
    history.push({ role: 'user', content: text });
    setReactor('thinking', 'THINKING');

    const el = addMessage('JARVIS', '');
    el.classList.add('cursor');
    let full = '';

    const requestId = 'r' + Date.now() + Math.random().toString(36).slice(2);
    const unsubscribe = window.jarvis.onChatStream(requestId, (chunk) => {
      if (chunk.type === 'tool') {
        const label =
          chunk.name === 'read_file' ? 'READING FILE' : 'SCANNING FILES';
        setReactor('thinking', label);
      } else if (chunk.type === 'reset') {
        // A model wrote a tool call as text; clear it before the real answer.
        full = '';
        el.textContent = '';
      } else if (chunk.type === 'text') {
        full += chunk.text;
        el.textContent = full;
        transcript.scrollTop = transcript.scrollHeight;
      } else if (chunk.type === 'done') {
        el.classList.remove('cursor');
        const finalText = chunk.text || full;
        if (finalText.trim()) {
          history.push({ role: 'assistant', content: finalText });
          speak(finalText);
        }
        unsubscribe();
        busy = false;
        setReactor('standby');
        resolve();
      } else if (chunk.type === 'error') {
        el.classList.remove('cursor');
        el.parentElement.classList.add('msg-error');
        el.textContent = chunk.message;
        // Don't keep a failed turn in history.
        if (history[history.length - 1]?.role === 'user') history.pop();
        unsubscribe();
        busy = false;
        setReactor('standby');
        resolve();
      }
    });

    const options = appSettings
      ? {
          temperature: appSettings.neural.temperature,
          contextLength: appSettings.neural.contextLength,
          maxTokens: appSettings.neural.maxTokens,
          systemPrompt: appSettings.neural.systemPrompt,
        }
      : {};
    window.jarvis.sendChat(history, requestId, currentProvider, currentModel, options);
  });
}

// ===================================================================
// Text-to-speech (browser SpeechSynthesis)
// ===================================================================
let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  // Prefer a British male voice for the Jarvis feel; fall back gracefully.
  voice =
    voices.find((v) => /en-GB/i.test(v.lang) && /male|daniel|george/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /en[-_]/i.test(v.lang)) ||
    voices[0] ||
    null;
}
speechSynthesis.onvoiceschanged = pickVoice;
pickVoice();

// Resolve the voice chosen in Settings, falling back to the Jarvis default.
function chosenVoice() {
  const uri = appSettings?.voice.voiceURI;
  if (uri) {
    const match = speechSynthesis.getVoices().find((v) => v.voiceURI === uri);
    if (match) return match;
  }
  return voice;
}

function speak(text, force = false) {
  if ((!force && !ttsToggle.checked) || !text) {
    maybeAutoListen();
    return;
  }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = chosenVoice();
    if (v) u.voice = v;
    u.rate = 1.02;
    u.pitch = 0.95;
    u.onstart = () => {
      setReactor('speaking', 'SPEAKING');
      startSpeakingViz();
    };
    u.onend = () => {
      stopSpeakingViz();
      if (!busy) setReactor('standby');
      maybeAutoListen();
    };
    speechSynthesis.speak(u);
  } catch {
    maybeAutoListen();
  }
}

// ===================================================================
// Speech recognition (browser webkitSpeechRecognition)
// ===================================================================
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;

if (SR) {
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalText = '';
  recognition.onstart = () => {
    listening = true;
    micBtn.classList.add('listening');
    setReactor('listening', 'LISTENING');
    finalText = '';
    startMicViz();
  };
  recognition.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    input.value = finalText || interim;
  };
  recognition.onerror = (e) => {
    listening = false;
    micBtn.classList.remove('listening');
    stopMicViz();
    if (!busy) setReactor('standby');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addMessage('JARVIS', 'Microphone access was denied, sir. Check your system permissions.', 'msg-error');
    } else if (e.error === 'network') {
      addMessage('JARVIS', 'Voice recognition needs a network connection and is unavailable right now. You can still type to me.', 'msg-error');
    }
  };
  recognition.onend = () => {
    listening = false;
    micBtn.classList.remove('listening');
    stopMicViz();
    if (!busy) setReactor('standby');
    const said = input.value.trim();
    if (said) handleUtterance(said);
  };
} else {
  micBtn.title = 'Voice input not supported in this build';
  micBtn.style.opacity = '0.4';
}

function toggleListen() {
  if (!recognition || busy) return;
  if (listening) {
    recognition.stop();
  } else {
    try {
      speechSynthesis.cancel();
      recognition.start();
    } catch {
      /* start() throws if already started — ignore */
    }
  }
}
micBtn.onclick = toggleListen;

function maybeAutoListen() {
  if (autoListenToggle.checked && recognition && !busy && !listening) {
    setTimeout(() => {
      if (!busy && !listening) {
        try {
          recognition.start();
        } catch {
          /* ignore */
        }
      }
    }, 400);
  }
}

// ===================================================================
// Waveform visualizer
// ===================================================================
const viz = $('visualizer');
const vctx = viz.getContext('2d');
let analyser = null;
let micStream = null;
let vizMode = 'idle'; // 'idle' | 'mic' | 'speaking'
let speakingEnergy = 0;

function drawViz() {
  const w = viz.width;
  const h = viz.height;
  vctx.clearRect(0, 0, w, h);
  // Waveform animation can be disabled in Appearance settings.
  if (window.__waveform === false) {
    requestAnimationFrame(drawViz);
    return;
  }
  const accent =
    getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim() ||
    '#38e1ff';
  vctx.lineWidth = 2;
  vctx.strokeStyle = accent;
  vctx.shadowBlur = 10;
  vctx.shadowColor = accent;
  vctx.beginPath();

  let levelOut = 0;
  if (vizMode === 'mic' && analyser) {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const idx = Math.floor((i / w) * buf.length);
      const v = (buf[idx] - 128) / 128;
      sum += v * v;
      const y = h / 2 + v * (h / 2.4);
      i === 0 ? vctx.moveTo(i, y) : vctx.lineTo(i, y);
    }
    levelOut = Math.min(1, Math.sqrt(sum / w) * 3);
  } else {
    // Synthetic sine wave; amplitude follows speaking energy or idle hum.
    const amp =
      vizMode === 'speaking'
        ? 0.2 + speakingEnergy * 0.7
        : 0.06 + 0.04 * Math.sin(Date.now() / 600);
    const time = Date.now() / 120;
    for (let i = 0; i < w; i++) {
      const phase = (i / w) * Math.PI * 6 + time;
      const env = Math.sin((i / w) * Math.PI); // taper at the edges
      const v = Math.sin(phase) * amp * env;
      const y = h / 2 + v * (h / 2.2);
      i === 0 ? vctx.moveTo(i, y) : vctx.lineTo(i, y);
    }
    levelOut = vizMode === 'speaking' ? 0.2 + speakingEnergy * 0.6 : 0;
    if (vizMode === 'speaking') {
      // wander the speaking energy so the core feels alive
      speakingEnergy += (Math.random() - 0.5) * 0.3;
      speakingEnergy = Math.max(0, Math.min(1, speakingEnergy));
    }
  }
  vctx.stroke();
  window.Reactor.setLevel(levelOut);
  requestAnimationFrame(drawViz);
}
drawViz();

async function startMicViz() {
  try {
    const micId = appSettings?.voice.micId;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: micId ? { deviceId: { exact: micId } } : true,
    });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    vizMode = 'mic';
  } catch {
    vizMode = 'idle';
  }
}
function stopMicViz() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  analyser = null;
  if (vizMode === 'mic') vizMode = 'idle';
}
function startSpeakingViz() {
  speakingEnergy = 0.5;
  vizMode = 'speaking';
}
function stopSpeakingViz() {
  if (vizMode === 'speaking') vizMode = 'idle';
  window.Reactor.setLevel(0);
}

// ===================================================================
// Input wiring
// ===================================================================
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  handleUtterance(input.value);
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => handleUtterance(chip.dataset.say));
});

// Greet on first load via TTS once voices are ready.
window.addEventListener('load', () => {
  setReactor('standby');
});
