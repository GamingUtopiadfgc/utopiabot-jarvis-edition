'use strict';

const { shell } = require('electron');
const { exec } = require('child_process');

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

// Windows apps that can be launched via `start`.
const APPS = {
  notepad: 'notepad',
  calculator: 'calc',
  calc: 'calc',
  paint: 'mspaint',
  explorer: 'explorer',
  cmd: 'cmd',
  terminal: 'wt',
  settings: 'start ms-settings:',
  camera: 'start microsoft.windows.camera:',
};

function ok(message, data) {
  return { ok: true, message, ...(data ? { data } : {}) };
}
function fail(message) {
  return { ok: false, message };
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
      const time = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      return ok(`It's ${time}, sir.`, { time });
    }

    case 'date': {
      const date = new Date().toLocaleDateString([], {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
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
      const cmd = APPS[key];
      if (!cmd) return fail(`I don't know how to open "${args.target}".`);
      // `start "" <cmd>` detaches the launched app from this process on Windows.
      exec(cmd.startsWith('start') ? cmd : `start "" ${cmd}`);
      return ok(`Launching ${key}.`);
    }

    case 'search-web': {
      const q = String(args.query || '').trim();
      if (!q) return fail('Nothing to search for.');
      shell.openExternal(
        'https://www.google.com/search?q=' + encodeURIComponent(q)
      );
      return ok(`Searching for ${q}.`);
    }

    default:
      return fail(`Unknown command: ${name}`);
  }
}

module.exports = { runCommand, SITES, APPS };
