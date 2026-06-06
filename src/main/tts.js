'use strict';

// Local neural text-to-speech engines: Piper and Coqui. Both are installed into
// the app's userData folder and shell out to produce a WAV, which we hand back
// to the renderer as a base64 data URL to play. The default voice engine stays
// the browser's Windows TTS — these are opt-in upgrades chosen in Settings.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { spawn, exec } = require('child_process');

// Piper ships prebuilt binaries per platform from its GitHub releases.
const PIPER_RELEASE = '2023.11.14-2';
const PIPER_ASSETS = {
  win32: 'piper_windows_amd64.zip',
  linux: 'piper_linux_x86_64.tar.gz',
  darwin: process.arch === 'arm64' ? 'piper_macos_aarch64.tar.gz' : 'piper_macos_x64.tar.gz',
};

// Default Piper voice — a British male, fitting the JARVIS persona.
const DEFAULT_PIPER_VOICE = {
  id: 'en_GB-alan-medium',
  base: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx',
};

// A small curated set of English Coqui models the user can pick from.
const COQUI_MODELS = [
  'tts_models/en/ljspeech/tacotron2-DDC',
  'tts_models/en/ljspeech/glow-tts',
  'tts_models/en/vctk/vits',
  'tts_models/en/jenny/jenny',
];
const DEFAULT_COQUI_MODEL = COQUI_MODELS[0];

// ---- Paths (all under userData/tts) ----
const ttsRoot = () => path.join(app.getPath('userData'), 'tts');
const piperVoicesDir = () => path.join(ttsRoot(), 'voices');
const coquiVenvDir = () => path.join(ttsRoot(), 'coqui-venv');
const outDir = () => path.join(ttsRoot(), 'out');

function piperExe() {
  // The piper archive extracts a `piper/` folder containing the binary.
  const name = process.platform === 'win32' ? 'piper.exe' : 'piper';
  return path.join(ttsRoot(), 'piper', name);
}

function venvBin(name) {
  const sub = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(coquiVenvDir(), sub, name + ext);
}

// ---- Small helpers ----

// Stream a URL to disk, reporting percentage when the size is known.
async function download(url, dest, onProgress, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) — ${label || url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0;
  let lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!file.write(Buffer.from(value)))
        await new Promise((r) => file.once('drain', r));
      if (total && onProgress) {
        const pct = Math.round((received / total) * 100);
        if (pct !== lastPct) { lastPct = pct; onProgress(`${label}: ${pct}%`); }
      }
    }
  } finally {
    await new Promise((r) => file.end(r));
  }
}

// Extract a .zip / .tar.gz using the OS `tar` (Windows 10+/macOS/Linux all ship it).
function extractArchive(archive, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const gz = archive.endsWith('.tar.gz') || archive.endsWith('.tgz');
    const cmd = `tar -x${gz ? 'z' : ''}f "${archive}" -C "${destDir}"`;
    exec(cmd, (err) => (err ? reject(err) : resolve()));
  });
}

// Spawn a process, forwarding the last stdout/stderr line to onProgress.
function run(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const tail = (d) => {
      const line = String(d).trim().split('\n').pop();
      if (line && onProgress) onProgress(line);
    };
    child.stdout?.on('data', tail);
    child.stderr?.on('data', tail);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`))));
  });
}

// Find a usable system Python 3 to build the Coqui venv from.
function findSystemPython() {
  const candidates =
    process.platform === 'win32'
      ? [{ exe: 'py', prefix: ['-3.11'] }, { exe: 'py', prefix: ['-3'] }, { exe: 'python', prefix: [] }]
      : [{ exe: 'python3', prefix: [] }, { exe: 'python', prefix: [] }];
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(null);
      const c = candidates[i++];
      const probe = spawn(c.exe, [...c.prefix, '--version'], { windowsHide: true });
      probe.on('error', tryNext);
      probe.on('close', (code) => (code === 0 ? resolve(c) : tryNext()));
    };
    tryNext();
  });
}

// ---- Voice/model discovery ----
function listPiperVoices() {
  try {
    return fs.readdirSync(piperVoicesDir())
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => ({ id: f.replace(/\.onnx$/, ''), path: path.join(piperVoicesDir(), f) }));
  } catch {
    return [];
  }
}

function getTtsState() {
  const voices = listPiperVoices().map((v) => v.id);
  return {
    piper: { installed: fs.existsSync(piperExe()), voices },
    coqui: { installed: fs.existsSync(venvBin('tts')), models: COQUI_MODELS },
  };
}

// ---- Installers ----
async function installPiper(onProgress) {
  const asset = PIPER_ASSETS[process.platform];
  if (!asset) return { ok: false, error: 'Piper has no prebuilt binary for this platform.' };

  await fs.promises.mkdir(ttsRoot(), { recursive: true });
  const archive = path.join(ttsRoot(), asset);

  onProgress?.('Downloading Piper…');
  await download(
    `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${asset}`,
    archive, onProgress, 'Piper'
  );

  onProgress?.('Extracting Piper…');
  await extractArchive(archive, ttsRoot());
  fs.promises.unlink(archive).catch(() => {});

  onProgress?.('Downloading voice (en_GB-alan)…');
  await download(`${DEFAULT_PIPER_VOICE.base}?download=true`,
    path.join(piperVoicesDir(), `${DEFAULT_PIPER_VOICE.id}.onnx`), onProgress, 'Voice');
  await download(`${DEFAULT_PIPER_VOICE.base}.json?download=true`,
    path.join(piperVoicesDir(), `${DEFAULT_PIPER_VOICE.id}.onnx.json`), onProgress, 'Voice config');

  const ok = fs.existsSync(piperExe());
  onProgress?.(ok ? 'Piper ready.' : 'Piper install finished but the binary is missing.');
  return { ok, error: ok ? undefined : 'Piper binary not found after extraction.' };
}

async function installCoqui(onProgress) {
  const py = await findSystemPython();
  if (!py) return { ok: false, error: 'No Python 3 found. Install Python 3.11 first, then retry.' };

  await fs.promises.mkdir(ttsRoot(), { recursive: true });
  onProgress?.('Creating Python environment…');
  await run(py.exe, [...py.prefix, '-m', 'venv', coquiVenvDir()], onProgress);

  const vpy = venvBin('python');
  onProgress?.('Upgrading pip…');
  await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], onProgress);

  onProgress?.('Installing Coqui TTS — this pulls PyTorch and can take several minutes…');
  await run(vpy, ['-m', 'pip', 'install', 'coqui-tts'], onProgress);

  const ok = fs.existsSync(venvBin('tts'));
  onProgress?.(ok ? 'Coqui TTS ready.' : 'Install finished but the tts command is missing.');
  return { ok, error: ok ? undefined : 'Coqui `tts` command not found after install.' };
}

function install(engine, onProgress) {
  if (engine === 'piper') return installPiper(onProgress);
  if (engine === 'coqui') return installCoqui(onProgress);
  return Promise.resolve({ ok: false, error: `Unknown TTS engine: ${engine}` });
}

// ---- Synthesis ----
async function synthPiper(text, voiceId) {
  if (!fs.existsSync(piperExe())) throw new Error('Piper is not installed.');
  const voices = listPiperVoices();
  const v = voices.find((x) => x.id === voiceId) || voices[0];
  if (!v) throw new Error('No Piper voice installed.');

  await fs.promises.mkdir(outDir(), { recursive: true });
  const out = path.join(outDir(), `piper-${Date.now()}.wav`);
  await new Promise((resolve, reject) => {
    const p = spawn(piperExe(), ['-m', v.path, '-f', out], { windowsHide: true });
    const timer = setTimeout(() => { p.kill(); reject(new Error('Piper timed out (30s).')); }, 30000);
    p.on('error', (err) => { clearTimeout(timer); reject(err); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Piper exited ${code}`)); });
    p.stdin.write(text);
    p.stdin.end();
  });
  if (!fs.existsSync(out)) throw new Error('Piper finished but produced no audio file.');
  return out;
}

async function synthCoqui(text, modelName) {
  const ttsBin = venvBin('tts');
  if (!fs.existsSync(ttsBin)) throw new Error('Coqui TTS is not installed.');
  const model = modelName || DEFAULT_COQUI_MODEL;

  await fs.promises.mkdir(outDir(), { recursive: true });
  const out = path.join(outDir(), `coqui-${Date.now()}.wav`);
  // 3-minute timeout covers first-run model download + synthesis.
  await new Promise((resolve, reject) => {
    const p = spawn(ttsBin, ['--text', text, '--model_name', model, '--out_path', out], { windowsHide: true });
    const timer = setTimeout(() => { p.kill(); reject(new Error('Coqui TTS timed out (3 min). First-run model download can take several minutes — try again.')); }, 180000);
    p.on('error', (err) => { clearTimeout(timer); reject(err); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Coqui exited ${code}`)); });
  });
  if (!fs.existsSync(out)) throw new Error('Coqui finished but produced no audio file.');
  return out;
}

// Synthesize and return a playable data URL. Cleans up the temp WAV.
async function synth(engine, { text, voice } = {}) {
  if (!text || !String(text).trim()) return { ok: false, error: 'Nothing to speak.' };
  try {
    const wav = engine === 'coqui'
      ? await synthCoqui(text, voice)
      : await synthPiper(text, voice);
    const buf = await fs.promises.readFile(wav);
    fs.promises.unlink(wav).catch(() => {});
    return { ok: true, dataUrl: `data:audio/wav;base64,${buf.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = { getTtsState, install, synth, COQUI_MODELS, DEFAULT_PIPER_VOICE };
