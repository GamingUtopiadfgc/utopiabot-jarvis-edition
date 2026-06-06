'use strict';

const { shell } = require('electron');
const { spawn } = require('child_process');

// Common sites the user can open by name.
const SITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  gmail: 'https://mail.google.com',
  maps: 'https://maps.google.com',
  twitter: 'https://x.com',
  reddit: 'https://www.reddit.com',
  spotify: 'https://open.spotify.com',
  netflix: 'https://www.netflix.com',
  weather: 'https://www.weather.com',
};

// Windows apps. Values are either an executable name (launched via
// "start "" <exe>") or a URI scheme (opened via shell.openExternal).
const APPS = {
  notepad:       { exe: 'notepad' },
  calculator:    { exe: 'calc' },
  calc:          { exe: 'calc' },
  paint:         { exe: 'mspaint' },
  explorer:      { exe: 'explorer' },
  cmd:           { exe: 'cmd' },
  terminal:      { exe: 'wt', fallback: 'cmd' },
  powershell:    { exe: 'powershell' },
  taskmgr:       { exe: 'taskmgr' },
  snipping:      { exe: 'SnippingTool' },
  wordpad:       { exe: 'wordpad' },
  regedit:       { exe: 'regedit' },
  devmgmt:       { exe: 'devmgmt.msc' },
  settings:      { uri: 'ms-settings:' },
  camera:        { uri: 'microsoft.windows.camera:' },
};

function ok(message, data) {
  return { ok: true, message, ...(data ? { data } : {}) };
}
function fail(message) {
  return { ok: false, message };
}

// Launch an exe via "start "" <exe>" so it detaches from the Electron process.
function launchExe(exe) {
  return new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/c', 'start', '', exe], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    child.on('error', reject);
    // Give it 400ms — if it hasn't crashed by then, consider it launched.
    setTimeout(resolve, 400);
  });
}

/**
 * Run a named local command. Called from the renderer via IPC.
 * @param {string} name
 * @param {Record<string, any>} [args]
 */
async function runCommand(name, args = {}) {
  switch (name) {
    case 'time': {
      const now = new Date();
      const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return ok(`It's ${time}.`, { time });
    }

    case 'date': {
      const date = new Date().toLocaleDateString([], {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
      return ok(`Today is ${date}.`, { date });
    }

    case 'open-site': {
      const key = String(args.target || '').toLowerCase().trim();
      const url = SITES[key];
      if (!url) return fail(`I don't have a site called "${args.target}".`);
      shell.openExternal(url);
      return ok(`Opening ${key}.`);
    }

    case 'open-url': {
      let url = String(args.url || '').trim();
      if (!url) return fail('No address given.');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      shell.openExternal(url);
      return ok(`Opening ${url}.`);
    }

    case 'open-app': {
      const key = String(args.target || '').toLowerCase().trim();
      const entry = APPS[key];
      if (!entry) return fail(`I don't know how to open "${args.target}".`);

      if (entry.uri) {
        shell.openExternal(entry.uri);
        return ok(`Opening ${key}.`);
      }

      try {
        await launchExe(entry.exe);
        return ok(`Opening ${key}.`);
      } catch (primaryErr) {
        if (entry.fallback) {
          try {
            await launchExe(entry.fallback);
            return ok(`Opening ${entry.fallback} — ${key} doesn't appear to be installed.`);
          } catch {
            // fall through to error
          }
        }
        return fail(`Couldn't open ${key}: ${primaryErr.message}`);
      }
    }

    case 'search-web': {
      const q = String(args.query || '').trim();
      if (!q) return fail('Nothing to search for.');
      shell.openExternal('https://www.google.com/search?q=' + encodeURIComponent(q));
      return ok(`Searching for ${q}.`);
    }

    default:
      return fail(`Unknown command: ${name}`);
  }
}

module.exports = { runCommand, SITES, APPS };
