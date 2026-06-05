'use strict';

const { exec, spawn } = require('child_process');

// Is a command available on PATH?
function commandExists(cmd) {
  return new Promise((resolve) => {
    const probe =
      process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    exec(probe, (err, stdout) => resolve(!err && String(stdout).trim().length > 0));
  });
}

// Open the Ollama server in a visible terminal window (per platform).
function launchTerminal() {
  if (process.platform === 'win32') {
    // `start` opens a new console; `cmd /k` keeps it open so logs stay visible.
    exec('start "Ollama Server" cmd /k ollama serve', () => {});
  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'tell application "Terminal" to do script "ollama serve"'`, () => {});
  } else {
    // Linux: try a few common terminals, else run detached in the background.
    const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole'];
    exec(
      `${term.find(() => true)} -e "ollama serve" || (` +
        term.map((t) => `${t} -e "ollama serve"`).join(' || ') +
        `)`,
      (err) => {
        if (err) spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
      }
    );
  }
}

/**
 * Ensure the Ollama server is running, launching it in a terminal if needed.
 * @param {() => Promise<boolean>} isReachable probe for a live server
 * @returns {Promise<'already'|'starting'|'missing'|'disabled'>}
 */
async function ensureOllamaServer(isReachable) {
  if (process.env.JARVIS_NO_OLLAMA_AUTOSTART) return 'disabled';
  if (await isReachable()) return 'already';
  if (!(await commandExists('ollama'))) return 'missing';
  launchTerminal();
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

module.exports = { ensureOllamaServer, waitUntilReachable };
