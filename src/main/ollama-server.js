'use strict';

const { exec, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Is a command available on PATH?
function commandExists(cmd) {
  return new Promise((resolve) => {
    const probe =
      process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    exec(probe, (err, stdout) => resolve(!err && String(stdout).trim().length > 0));
  });
}

// Open the Ollama server in a visible terminal window (per platform).
function launchTerminal(modelsPath) {
  const env = { ...process.env };
  if (modelsPath) {
    env.OLLAMA_MODELS = modelsPath;
  }

  if (process.platform === 'win32') {
    // `start` opens a new console; `cmd /k` keeps it open so logs stay visible.
    const cmd = modelsPath
      ? `start "Ollama Server" cmd /k "set OLLAMA_MODELS=${modelsPath.replace(/"/g, '""')}&& ollama serve"`
      : 'start "Ollama Server" cmd /k ollama serve';
    exec(cmd, { env }, () => {});
  } else if (process.platform === 'darwin') {
    const script = modelsPath
      ? `osascript -e 'tell application "Terminal" to do script "export OLLAMA_MODELS=${modelsPath.replace(/"/g, '\\\\"')}; ollama serve"'`
      : `osascript -e 'tell application "Terminal" to do script "ollama serve"'`;
    exec(script, { env }, () => {});
  } else {
    // Linux: try a few common terminals, else run detached in the background.
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole'];
    const baseCmd = modelsPath
      ? `OLLAMA_MODELS="${modelsPath.replace(/"/g, '\\"')}" ollama serve`
      : 'ollama serve';
    exec(
      `${term.find(() => true)} -e "${baseCmd}" || (` +
        term.map((t) => `${t} -e "${baseCmd}"`).join(' || ') +
        `)`,
      { env },
      (err) => {
        if (err) spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', env }).unref();
      }
    );
  }
}

/**
 * Ensure the Ollama server is running, launching it in a terminal if needed.
 * @param {() => Promise<boolean>} isReachable probe for a live server
 * @param {string} [modelsPath] optional custom models directory (sets OLLAMA_MODELS env var)
 * @returns {Promise<'already'|'starting'|'missing'|'disabled'>}
 */
async function ensureOllamaServer(isReachable, modelsPath) {
  if (process.env.JARVIS_NO_OLLAMA_AUTOSTART) return 'disabled';
  if (await isReachable()) return 'already';
  if (!(await commandExists('ollama'))) return 'missing';
  launchTerminal(modelsPath);
  return 'starting';
}

/** Poll until the server answers, or give up. */
async function waitUntilReachable(isReachable, { tries = 16, delayMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await isReachable()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// A valid Ollama models store holds both `manifests/` and `blobs/` subfolders.
// Returns the number of model manifests in it (0 if not a real store).
function modelStoreCount(dir) {
  try {
    if (!dir) return 0;
    const manifests = path.join(dir, 'manifests');
    const blobs = path.join(dir, 'blobs');
    if (!fs.statSync(manifests).isDirectory()) return 0;
    if (!fs.statSync(blobs).isDirectory()) return 0;
    // Count files a few levels under manifests/ (registry/library/<model>/<tag>).
    let count = 0;
    const walk = (p, depth) => {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else count++;
      }
    };
    walk(manifests, 0);
    return count;
  } catch {
    return 0; // missing dir, permission error, etc.
  }
}

/**
 * Scan likely locations for a valid Ollama models store.
 * @param {string} [configuredPath] the user's current ollamaModelsPath setting
 * @returns {Array<{path: string, modelCount: number}>} stores sorted by count desc
 */
function findOllamaModelStores(configuredPath) {
  const candidates = new Set();
  const add = (p) => { if (p) candidates.add(path.normalize(p)); };

  add(process.env.OLLAMA_MODELS);
  add(configuredPath);
  add(path.join(os.homedir(), '.ollama', 'models'));

  // Shallow checks on each fixed drive (Windows) for common store layouts.
  const driveRoots =
    process.platform === 'win32'
      ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`)
      : ['/'];
  for (const root of driveRoots) {
    try {
      if (!fs.existsSync(root)) continue;
    } catch {
      continue;
    }
    add(path.join(root, 'Ollama', 'models'));
    add(path.join(root, '.ollama', 'models'));
    add(path.join(root, 'models'));
  }

  const stores = [];
  for (const dir of candidates) {
    const modelCount = modelStoreCount(dir);
    if (modelCount > 0) stores.push({ path: dir, modelCount });
  }
  return stores.sort((a, b) => b.modelCount - a.modelCount);
}

// Stop any running Ollama server so it can be relaunched with a new models path.
function stopOllamaServer() {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? 'taskkill /F /IM ollama.exe'
        : 'pkill -f "ollama serve"';
    exec(cmd, () => resolve()); // ignore errors (e.g. nothing to kill)
  });
}

/**
 * Restart the Ollama server pointed at a (possibly new) models folder. Needed
 * because OLLAMA_MODELS only takes effect at launch, so a custom path can't be
 * applied to an already-running server without restarting it.
 * @param {() => Promise<boolean>} isReachable probe for a live server
 * @param {string} [modelsPath] custom models directory (sets OLLAMA_MODELS)
 * @returns {Promise<boolean>} true if the server is reachable afterwards
 */
async function restartOllamaServer(isReachable, modelsPath) {
  if (!(await commandExists('ollama'))) return false;
  await stopOllamaServer();
  // Give the OS a moment to release the port before relaunching.
  await new Promise((r) => setTimeout(r, 1000));
  launchTerminal(modelsPath);
  return waitUntilReachable(isReachable);
}

module.exports = {
  ensureOllamaServer,
  waitUntilReachable,
  findOllamaModelStores,
  restartOllamaServer,
};
