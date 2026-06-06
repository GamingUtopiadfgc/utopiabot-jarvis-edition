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

// Mark the window when running the dangerous Nightly channel.
if (window.jarvis.channel === 'nightly') {
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = 'JARVIS · NIGHTLY';
}

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
    // First launch: get to know the user before anything else.
    if (!s.profile?.onboarded) {
      startOnboarding();
    } else {
      input.placeholder = `Speak or type a command, ${addressTerm(s.profile)}…`;
      if (s.voice.startupGreeting && !greeted) {
        greeted = true;
        speak(`Systems online. Good to see you, ${addressTerm(s.profile)}.`, true);
      }
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

  // Listen for pull progress from main process (for auto-pull during chat)
  let currentPullModel = null;
  window.jarvis.onPullProgress?.(({ model, status }) => {
    if (currentPullModel && model === currentPullModel) {
      setReactor('thinking', status);
    }
  });

  // Append a clickable action chip to a JARVIS message body.
  function addChip(bodyEl, label, onClick) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = label;
    btn.style.marginTop = '8px';
    btn.style.marginRight = '6px';
    btn.onclick = () => onClick(btn);
    bodyEl.appendChild(document.createElement('br'));
    bodyEl.appendChild(btn);
    transcript.scrollTop = transcript.scrollHeight;
    return btn;
  }

  // Point Ollama at a chosen models folder, then refresh the dropdown.
  async function useModelsFolder(dir, statusEl) {
    if (statusEl) statusEl.textContent = `Pointing Ollama at ${dir} and restarting it…`;
    const res = await window.jarvis.applyOllamaModelsPath(dir);
    await populateModels();
    if (statusEl) {
      const n = res?.models?.length || 0;
      statusEl.textContent = res?.ok && n
        ? `Found ${n} model${n === 1 ? '' : 's'}. You're all set, sir.`
        : `I set the folder, but still couldn't see any models there. Double-check the path, sir.`;
    }
  }

  // Ollama is up but reports zero models — likely the wrong models folder.
  window.jarvis.onOllamaNoModels?.(({ stores }) => {
    const body = addMessage(
      'JARVIS',
      "Ollama is running, sir, but it isn't finding any models — it's probably looking in the wrong folder. " +
        (stores?.length
          ? 'I found these model folders on your drives:'
          : "Point me at the folder where your models live and I'll sort it out.")
    );
    for (const s of stores || []) {
      addChip(body, `Use ${s.path} (${s.modelCount} models)`, () =>
        useModelsFolder(s.path, body)
      );
    }
    addChip(body, 'Choose folder…', async () => {
      const dir = await window.jarvis.pickFolder();
      if (dir) useModelsFolder(dir, body);
    });
  });

  // Ollama isn't installed — walk the user through getting it.
  window.jarvis.onOllamaNotInstalled?.(() => {
    const body = addMessage(
      'JARVIS',
      "I can't find Ollama on this system, sir. Do you have it installed?"
    );
    addChip(body, "Yes, it's installed", () => {
      addMessage(
        'JARVIS',
        'Then it may be running on a different address. Check the Ollama URL in Settings → Advanced, then hit the rescan button.'
      );
    });
    addChip(body, 'No', () => {
      const ask = addMessage(
        'JARVIS',
        'Would you like me to install Ollama for you? I can handle it automatically.'
      );
      addChip(ask, 'Yes, install it', (btn) => {
        btn.disabled = true;
        const log = addMessage('JARVIS', 'Installing Ollama, sir…');
        window.jarvis.onInstallProgress?.(({ status }) => {
          if (status) log.textContent = status;
        });
        window.jarvis.installOllama().then((res) => {
          if (res?.ok) populateModels();
        });
      });
      addChip(ask, 'No thanks', () => {
        addMessage(
          'JARVIS',
          "No problem — you can grab it from https://ollama.com/download whenever you're ready, then hit rescan."
        );
      });
    });
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

  // Websites — match before apps so "open youtube.com" goes to open-url
  let m = text.match(/\bopen (?:the )?(?:website |site )?(youtube|google|github|gmail|maps|twitter|reddit|spotify|netflix|weather)\b/);
  if (m) return { name: 'open-site', args: { target: m[1] } };

  // Apps — natural language: "open/launch/start/run/pull up <app>"
  const LAUNCH_VERB = /\b(open|launch|start|run|pull up|bring up|fire up|load|show)\b/;
  if (LAUNCH_VERB.test(text)) {
    // Ordered so longer phrases match before their substrings
    const APP_PHRASES = [
      ['command prompt', 'cmd'],
      ['command line',   'cmd'],
      ['dos prompt',     'cmd'],
      ['windows terminal','terminal'],
      ['file explorer',  'explorer'],
      ['task manager',   'taskmgr'],
      ['snipping tool',  'snipping'],
      ['device manager', 'devmgmt'],
      ['registry editor','regedit'],
      ['powershell',     'powershell'],
      ['terminal',       'terminal'],
      ['notepad',        'notepad'],
      ['calculator',     'calculator'],
      ['calc',           'calc'],
      ['paint',          'paint'],
      ['explorer',       'explorer'],
      ['taskmgr',        'taskmgr'],
      ['wordpad',        'wordpad'],
      ['regedit',        'regedit'],
      ['settings',       'settings'],
      ['camera',         'camera'],
      ['cmd',            'cmd'],
    ];
    for (const [phrase, key] of APP_PHRASES) {
      if (text.includes(phrase)) return { name: 'open-app', args: { target: key } };
    }
  }

  m = text.match(/\b(?:google|search(?: for| the web for)?) (.+)/);
  if (m && /\b(search|google)\b/.test(text))
    return { name: 'search-web', args: { query: m[1] } };

  m = text.match(/\bopen (?:the )?(?:website |site )?([a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?)\b/);
  if (m) return { name: 'open-url', args: { url: m[1] } };

  return null;
}

// ===================================================================
// Patch notes — shown on request ("what's new").
// ===================================================================
const PATCH_NOTES = [
  "Here's what's new, sir:",
  '',
  '• Ollama model finder — if I start up and Ollama reports no models, I now scan your drives and offer the right folder in one click.',
  "• Guided install — if Ollama isn't on the system, I can install it for you and explain each step.",
  '• Settings → Advanced — a new "Search" button locates your Ollama models folder automatically, and changing it restarts Ollama so it takes effect right away.',
].join('\n');

function showPatchNotes() {
  const el = addMessage('JARVIS', PATCH_NOTES);
  el.style.whiteSpace = 'pre-wrap'; // keep the bullet list on separate lines
  speak("Here are the latest patch notes, sir.");
}

// "What's new?" → offer the notes. A direct "patch notes" request shows them.
// Returns true if the utterance was handled here.
function maybeWhatsNew(text) {
  const t = text.toLowerCase();
  if (/\b(patch notes|change ?log|release notes)\b/.test(t)) {
    showPatchNotes();
    return true;
  }
  if (/\b(what(?:'s|s| is)?(?: the)? new(?: update)?|anything new|new update|what(?:'s|s| is)? changed)\b/.test(t)) {
    const body = addMessage(
      'JARVIS',
      "There have been a few updates, sir. Would you like to see the patch notes?"
    );
    addChip(body, 'Show patch notes', () => showPatchNotes());
    addChip(body, 'Not now', () => addMessage('JARVIS', 'Very good, sir.'));
    return true;
  }
  return false;
}

// ===================================================================
// First-run onboarding — a short scripted conversation so JARVIS can
// get to know the user. Runs right in the transcript; needs no brain.
// ===================================================================
let onboarding = null; // { step, answers } while active

const ONBOARD_STEPS = [
  { key: 'name', type: 'text', q: () => 'Before we begin — may I ask your name?' },
  {
    key: 'address',
    type: 'choice',
    q: (a) => `A pleasure${a.name ? ', ' + a.name : ''}. How would you like me to address you?`,
    options: [
      { label: 'Sir', value: 'sir' },
      { label: "Ma'am", value: "ma'am" },
      { label: 'By my name', value: 'name' },
    ],
  },
  {
    key: 'about',
    type: 'text',
    q: () => 'What should I know about you — your work, your interests, anything you care about?',
  },
  {
    key: 'responseStyle',
    type: 'choice',
    q: () => 'And how do you prefer your answers?',
    options: [
      { label: 'Short & to the point', value: 'concise' },
      { label: 'Balanced', value: 'balanced' },
      { label: 'Thorough & detailed', value: 'detailed' },
    ],
  },
];

// How to address the user, derived from a profile-shaped object.
function addressTerm(p) {
  if (!p) return 'sir';
  if (p.address === 'name' && p.name) return p.name;
  if (p.address === "ma'am") return "ma'am";
  return 'sir';
}

function startOnboarding() {
  onboarding = { step: 0, answers: {} };
  transcript.innerHTML = '';
  addMessage(
    'JARVIS',
    "Welcome. I'm JARVIS — your assistant. Let me ask a few quick questions so I can serve you better."
  );
  speak("Welcome. I'm JARVIS. Let me ask a few quick questions so I can serve you better.", true);
  setReactor('listening', 'GETTING ACQUAINTED');
  setTimeout(askOnboardingStep, 700);
}

function askOnboardingStep() {
  if (!onboarding) return;
  const step = ONBOARD_STEPS[onboarding.step];
  const text = typeof step.q === 'function' ? step.q(onboarding.answers) : step.q;
  const body = addMessage('JARVIS', text);
  speak(text, true);
  input.placeholder =
    step.type === 'choice' ? 'Pick one above, or type your answer…' : 'Type your answer…';
  if (step.type === 'choice') {
    for (const opt of step.options) {
      const btn = addChip(body, opt.label, () => {
        if (!onboarding) return;
        addMessage('YOU', opt.label);
        onboardingAnswer(opt.value);
      });
      btn.classList.add('onb-chip');
    }
  }
}

// Map a free-text reply to one of a choice step's option values.
function matchChoice(step, value) {
  const v = value.toLowerCase();
  const hit = step.options.find(
    (o) => o.value === v || o.label.toLowerCase() === v || v.includes(o.value)
  );
  if (hit) return hit.value;
  if (step.key === 'address') {
    if (/ma'?am|maam|miss|lady/.test(v)) return "ma'am";
    if (/\b(name|first name|call me)\b/.test(v)) return 'name';
    return 'sir';
  }
  if (step.key === 'responseStyle') {
    if (/short|concise|brief|quick|to the point/.test(v)) return 'concise';
    if (/detail|thorough|long|in.?depth|deep/.test(v)) return 'detailed';
    return 'balanced';
  }
  return step.options[0].value;
}

function onboardingAnswer(raw) {
  if (!onboarding) return;
  // Lock prior choice chips so they can't be re-clicked into a later step.
  document.querySelectorAll('.onb-chip').forEach((b) => (b.disabled = true));
  const step = ONBOARD_STEPS[onboarding.step];
  let value = String(raw || '').trim();
  if (!value) {
    askOnboardingStep();
    return;
  }
  onboarding.answers[step.key] = step.type === 'choice' ? matchChoice(step, value) : value;
  onboarding.step += 1;
  if (onboarding.step >= ONBOARD_STEPS.length) finishOnboarding();
  else setTimeout(askOnboardingStep, 350);
}

async function finishOnboarding() {
  const answers = onboarding.answers;
  onboarding = null;
  const profile = {
    name: answers.name || '',
    address: answers.address || 'sir',
    about: answers.about || '',
    responseStyle: answers.responseStyle || 'balanced',
  };
  try {
    const updated = await window.jarvis.completeOnboarding(profile);
    if (updated) appSettings = updated;
  } catch {
    /* even if the save hiccups, don't trap the user in onboarding */
  }
  greeted = true;
  const term = addressTerm(profile);
  input.placeholder = `Speak or type a command, ${term}…`;
  const msg = `Wonderful — I've got it, ${term}. Systems online. How can I help?`;
  addMessage('JARVIS', msg);
  speak(msg, true);
  setReactor('standby');
}

// ===================================================================
// Main: handle a user utterance
// ===================================================================
async function handleUtterance(text) {
  text = text.trim();
  if (!text || busy) return;
  addMessage('YOU', text);
  input.value = '';

  // During first-run onboarding, every reply is an answer to JARVIS's question.
  if (onboarding) {
    onboardingAnswer(text);
    return;
  }

  if (maybeWhatsNew(text)) {
    setReactor('standby');
    return;
  }

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
        const labels = {
          read_file: 'READING FILE',
          list_files: 'SCANNING FILES',
          run_powershell: 'RUNNING COMMAND',
          remember: 'SAVING MEMORY',
        };
        setReactor('thinking', labels[chunk.name] || 'WORKING');
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

// Audio element for neural (Piper/Coqui) playback; tracked so we can stop it.
let neuralAudio = null;

// Stop any in-flight speech (browser or neural) — used on barge-in / new turns.
function cancelSpeech() {
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  if (neuralAudio) {
    try { neuralAudio.pause(); } catch { /* ignore */ }
    neuralAudio = null;
  }
}

function speak(text, force = false) {
  if ((!force && !ttsToggle.checked) || !text) {
    maybeAutoListen();
    return;
  }
  const engine = appSettings?.voice.engine || 'windows';
  if (engine === 'piper' || engine === 'coqui') {
    speakNeural(engine, text);
  } else {
    speakBrowser(text);
  }
}

// Built-in browser SpeechSynthesis (Windows TTS) path.
function speakBrowser(text) {
  try {
    cancelSpeech();
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

// Local neural engines: synthesize a WAV in the main process, play it here.
// Falls back to the browser voice if synthesis fails (e.g. not installed yet).
async function speakNeural(engine, text) {
  try {
    cancelSpeech();
    const voice =
      engine === 'piper' ? appSettings?.voice.piperVoice : appSettings?.voice.coquiModel;
    const res = await window.jarvis.ttsSynth(engine, text, voice || '');
    if (!res?.ok || !res.dataUrl) throw new Error(res?.error || 'TTS failed');

    const audio = new Audio(res.dataUrl);
    neuralAudio = audio;
    audio.onplay = () => {
      setReactor('speaking', 'SPEAKING');
      startSpeakingViz();
    };
    audio.onended = () => {
      stopSpeakingViz();
      if (neuralAudio === audio) neuralAudio = null;
      if (!busy) setReactor('standby');
      maybeAutoListen();
    };
    audio.onerror = () => {
      stopSpeakingViz();
      if (neuralAudio === audio) neuralAudio = null;
      maybeAutoListen();
    };
    await audio.play();
  } catch {
    speakBrowser(text); // graceful fallback so the user still hears a reply
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
  // No browser recognizer — voice still works via local Whisper STT (Settings →
  // Voice → Speech Input → Whisper), so leave the mic button usable.
  micBtn.title = 'Browser voice input unavailable — switch to Whisper in Settings';
}

const useWhisper = () => appSettings?.voice.sttEngine === 'whisper';

function toggleListen() {
  if (busy) return;
  if (useWhisper()) {
    whisperListening ? stopWhisperListen() : startWhisperListen();
    return;
  }
  if (!recognition) return;
  if (listening) {
    recognition.stop();
  } else {
    try {
      cancelSpeech();
      recognition.start();
    } catch {
      /* start() throws if already started — ignore */
    }
  }
}
micBtn.onclick = toggleListen;

function maybeAutoListen() {
  if (!autoListenToggle.checked || busy) return;
  if (useWhisper()) {
    if (!whisperListening)
      setTimeout(() => {
        if (!busy && !whisperListening) startWhisperListen();
      }, 400);
    return;
  }
  if (recognition && !listening) {
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
// Whisper (local STT): record mic audio, auto-stop on silence, transcribe.
// ===================================================================
let whisperRec = null;
let whisperListening = false;
let vadTimer = null;

async function startWhisperListen() {
  if (whisperListening || busy) return;
  if (!window.AudioCapture) {
    addMessage('JARVIS', 'Audio capture is unavailable in this build, sir.', 'msg-error');
    return;
  }
  cancelSpeech();
  whisperRec = new window.AudioCapture.Recorder();
  try {
    const stream = await whisperRec.start(appSettings?.voice.micId || '');
    whisperListening = true;
    micBtn.classList.add('listening');
    setReactor('listening', 'LISTENING');
    attachViz(stream, false); // the recorder owns this stream
    startVad();
  } catch {
    whisperListening = false;
    whisperRec = null;
    micBtn.classList.remove('listening');
    if (!busy) setReactor('standby');
    addMessage('JARVIS', 'Microphone access was denied, sir. Check your system permissions.', 'msg-error');
  }
}

async function stopWhisperListen() {
  if (!whisperListening || !whisperRec) return;
  stopVad();
  whisperListening = false;
  micBtn.classList.remove('listening');
  let audio = '';
  try {
    audio = await whisperRec.stop();
  } catch {
    /* ignore — produces empty audio */
  }
  whisperRec = null;
  stopMicViz();

  if (!audio) {
    if (!busy) setReactor('standby');
    return;
  }
  setReactor('thinking', 'TRANSCRIBING');
  const res = await window.jarvis.sttTranscribe(
    audio,
    appSettings?.voice.sttModel || 'base.en'
  );
  if (res?.ok && res.text) {
    input.value = res.text;
    handleUtterance(res.text);
  } else {
    if (res && !res.ok)
      addMessage('JARVIS', res.error || 'I could not transcribe that, sir.', 'msg-error');
    if (!busy) setReactor('standby');
    maybeAutoListen();
  }
}

// Lightweight voice-activity endpointing: once speech is detected, stop after a
// short pause (or a hard cap) so the user doesn't have to click to finish.
function startVad() {
  let speechStarted = false;
  let lastLoud = Date.now();
  const started = Date.now();
  const buf = new Uint8Array(analyser ? analyser.fftSize : 512);
  vadTimer = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (rms > 0.03) {
      speechStarted = true;
      lastLoud = now;
    }
    const silentFor = now - lastLoud;
    const tooLong = now - started > 15000;
    if ((speechStarted && silentFor > 1200) || tooLong) {
      stopVad();
      stopWhisperListen();
    }
  }, 150);
}
function stopVad() {
  if (vadTimer) {
    clearInterval(vadTimer);
    vadTimer = null;
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

let micAudioCtx = null;
let micStreamOwned = true; // false when an external recorder owns the stream

async function openMic() {
  const micId = appSettings?.voice.micId;
  return navigator.mediaDevices.getUserMedia({
    audio: micId ? { deviceId: { exact: micId } } : true,
  });
}

// Drive the waveform from a live mic stream. If `owned` is false the caller
// (e.g. the Whisper recorder) is responsible for stopping the stream's tracks.
function attachViz(stream, owned = true) {
  micStream = stream;
  micStreamOwned = owned;
  micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = micAudioCtx.createMediaStreamSource(stream);
  analyser = micAudioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  vizMode = 'mic';
}

async function startMicViz() {
  try {
    attachViz(await openMic(), true);
  } catch {
    vizMode = 'idle';
  }
}
function stopMicViz() {
  if (micStream && micStreamOwned) {
    micStream.getTracks().forEach((t) => t.stop());
  }
  micStream = null;
  micStreamOwned = true;
  if (micAudioCtx) {
    micAudioCtx.close().catch(() => {});
    micAudioCtx = null;
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
