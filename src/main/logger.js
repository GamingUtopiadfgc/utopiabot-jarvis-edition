'use strict';

// Lightweight file logger. Intercepts console.log/warn/error so all existing
// calls are captured without any changes elsewhere. Rotates at 2 MB.
// Import this module once at the top of main.js before anything else.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
let _logPath = null;

function logPath() {
  if (_logPath) return _logPath;
  const dir = app.getPath('logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  _logPath = path.join(dir, 'jarvis.log');
  return _logPath;
}

function writeLine(level, args) {
  try {
    const p = logPath();
    // Rotate when the file exceeds MAX_BYTES.
    try {
      if (fs.statSync(p).size > MAX_BYTES) fs.renameSync(p, p + '.old');
    } catch { /* first run or stat failure — that's fine */ }
    const msg = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    fs.appendFileSync(p, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
  } catch { /* never crash because of logging */ }
}

// Wrap the three console methods so existing code needs no changes.
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...a) => { _log(...a);   writeLine('INFO',  a); };
console.warn  = (...a) => { _warn(...a);  writeLine('WARN',  a); };
console.error = (...a) => { _error(...a); writeLine('ERROR', a); };

// Expose the resolved path so the export IPC can read it.
function getLogPath() { return logPath(); }

module.exports = { getLogPath };
