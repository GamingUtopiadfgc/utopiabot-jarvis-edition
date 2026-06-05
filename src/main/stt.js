'use strict';

// Local speech-to-text via faster-whisper, installed into a Python venv under
// userData (mirrors the Coqui TTS approach). The renderer records mic audio,
// converts it to a 16 kHz mono WAV, and hands it here as base64; we shell out
// to a small Python helper that transcribes it and prints the text as JSON.
// The default voice input stays the browser recognizer — this is an opt-in,
// fully-local upgrade chosen in Settings.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { spawn } = require('child_process');

// English-focused models, smallest → largest (accuracy vs. speed/RAM).
const WHISPER_MODELS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'];
const DEFAULT_MODEL = 'base.en';

// ---- Paths (all under userData/stt) ----
const sttRoot = () => path.join(app.getPath('userData'), 'stt');
const venvDir = () => path.join(sttRoot(), 'whisper-venv');
const modelCacheDir = () => path.join(sttRoot(), 'models');
const inDir = () => path.join(sttRoot(), 'in');
const scriptPath = () => path.join(sttRoot(), 'transcribe.py');

function venvBin(name) {
  const sub = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(venvDir(), sub, name + ext);
}

// ---- Small process helpers ----

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
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}`))
    );
  });
}

// Spawn and capture full stdout (stderr forwarded to onProgress for download
// feedback). Resolves with the collected stdout string.
function runCapture(cmd, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => {
      const line = String(d).trim().split('\n').pop();
      if (line && onProgress) onProgress(line);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`transcribe exited ${code}`))
    );
  });
}

// Find a usable system Python 3 (same probe order as the Coqui installer).
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

// Python helper: `download <model> <cache>` warms the model cache;
// `transcribe <wav> <model> <cache> [lang]` prints {"text": "..."} as JSON.
const TRANSCRIBE_PY = `import sys, json
from faster_whisper import WhisperModel

def load(model, cache):
    return WhisperModel(model, device="cpu", compute_type="int8", download_root=cache or None)

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "download":
        load(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
        print(json.dumps({"ok": True}))
        return
    if mode == "transcribe":
        audio = sys.argv[2]
        model = sys.argv[3] if len(sys.argv) > 3 else "base.en"
        cache = sys.argv[4] if len(sys.argv) > 4 else None
        lang = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
        m = load(model, cache)
        segments, _info = m.transcribe(audio, beam_size=1, language=lang)
        text = "".join(seg.text for seg in segments).strip()
        print(json.dumps({"text": text}))
        return
    print(json.dumps({"error": "unknown mode"}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
`;

// ---- State ----
function getSttState() {
  const installed = fs.existsSync(venvBin('python')) && fs.existsSync(scriptPath());
  return { installed, models: WHISPER_MODELS, defaultModel: DEFAULT_MODEL };
}

// ---- Installer ----
async function install(onProgress, model) {
  const py = await findSystemPython();
  if (!py) return { ok: false, error: 'No Python 3 found. Install Python 3.11 first, then retry.' };

  await fs.promises.mkdir(sttRoot(), { recursive: true });

  onProgress?.('Creating Python environment…');
  await run(py.exe, [...py.prefix, '-m', 'venv', venvDir()], onProgress);

  const vpy = venvBin('python');
  onProgress?.('Upgrading pip…');
  await run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], onProgress);

  onProgress?.('Installing faster-whisper — this can take a few minutes…');
  await run(vpy, ['-m', 'pip', 'install', 'faster-whisper'], onProgress);

  // Write the transcription helper before warming the model cache.
  await fs.promises.writeFile(scriptPath(), TRANSCRIBE_PY, 'utf8');

  const chosen = WHISPER_MODELS.includes(model) ? model : DEFAULT_MODEL;
  onProgress?.(`Downloading speech model (${chosen})…`);
  await run(vpy, [scriptPath(), 'download', chosen, modelCacheDir()], onProgress);

  const ok = fs.existsSync(vpy) && fs.existsSync(scriptPath());
  onProgress?.(ok ? 'Whisper STT ready.' : 'Install finished but the venv is missing.');
  return { ok, error: ok ? undefined : 'faster-whisper venv not found after install.' };
}

// ---- Transcription ----
async function transcribe({ audioBase64, model, language } = {}) {
  const vpy = venvBin('python');
  if (!fs.existsSync(vpy) || !fs.existsSync(scriptPath()))
    return { ok: false, error: 'Whisper STT is not installed.' };
  if (!audioBase64) return { ok: false, error: 'No audio received.' };

  await fs.promises.mkdir(inDir(), { recursive: true });
  const wav = path.join(inDir(), `rec-${Date.now()}.wav`);
  await fs.promises.writeFile(wav, Buffer.from(audioBase64, 'base64'));

  try {
    const out = await runCapture(vpy, [
      scriptPath(),
      'transcribe',
      wav,
      model || DEFAULT_MODEL,
      modelCacheDir(),
      language || '',
    ]);
    // The helper prints one JSON object; take the last non-empty line.
    const line = out.trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(line);
    if (parsed.error) return { ok: false, error: parsed.error };
    return { ok: true, text: parsed.text || '' };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
}

module.exports = { getSttState, install, transcribe, WHISPER_MODELS, DEFAULT_MODEL };
