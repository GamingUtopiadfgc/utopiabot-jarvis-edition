'use strict';

// Executes user-approved scripts by writing them to a temp file and spawning
// the appropriate interpreter. Output is capped and cleaned up after.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TIMEOUT_MS = 60000; // 60 s — scripts may be slower than one-liners
const MAX_OUTPUT = 6000;

const EXT = {
  powershell: 'ps1',
  python:     'py',
  node:       'js',
  javascript: 'js',
  batch:      'bat',
};

const RUNNERS = {
  powershell: (f) => ({
    bin: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
  }),
  python: (f) => ({ bin: 'python', args: [f] }),
  node:   (f) => ({ bin: 'node',   args: [f] }),
  javascript: (f) => ({ bin: 'node', args: [f] }),
  batch: (f) => ({ bin: 'cmd.exe', args: ['/c', f] }),
};

function runScript(language, code, ms = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const lang = (language || 'powershell').toLowerCase();
    const runner = RUNNERS[lang];
    if (!runner) return resolve(`Unsupported language: ${language}.`);

    const ext  = EXT[lang] || 'txt';
    const file = path.join(os.tmpdir(), `jarvis_${Date.now()}.${ext}`);

    try {
      fs.writeFileSync(file, code, 'utf8');
    } catch (e) {
      return resolve(`Could not write temp script: ${e.message}`);
    }

    const { bin, args } = runner(file);
    const proc = spawn(bin, args, { windowsHide: true });

    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      proc.kill();
      cleanup();
      resolve('Script timed out after 60 seconds.');
    }, ms);

    const cleanup = () => {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    };

    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));

    proc.on('error', (e) => {
      clearTimeout(timer);
      cleanup();
      resolve(`Failed to start ${bin}: ${e.message}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      let result = out;
      if (err.trim()) result += (result ? '\n[stderr]\n' : '') + err;
      if (!result.trim()) result = `(no output, exit code ${code})`;
      resolve(result.slice(0, MAX_OUTPUT));
    });
  });
}

module.exports = { runScript };
