'use strict';

const { shell } = require('electron');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

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

// Windows apps. Values are either:
//   { exe }   — launched via "start "" <exe>" (must be in PATH or full path)
//   { uri }   — opened via shell.openExternal
//   { find }  — array of glob-style search patterns; PowerShell locates the exe
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

  // ---- Game modding tools (searched across drives if not in PATH) ----
  cheatengine:   { find: ['cheatengine-x86_64.exe', 'cheatengine-i386.exe', 'cheatengine.exe'] },
  x64dbg:        { find: ['x64dbg.exe', 'x32dbg.exe'] },
  dnspy:         { find: ['dnSpy.exe', 'dnSpy-x86.exe'] },
  ilspy:         { find: ['ILSpy.exe'] },
  hxd:           { find: ['HxD.exe'] },
  'hex editor':  { find: ['HxD.exe', 'HexEditor.exe'] },
  vortex:        { find: ['Vortex.exe'] },
  mo2:           { find: ['ModOrganizer.exe'] },
  'mod organizer':{ find: ['ModOrganizer.exe'] },
  nexus:         { find: ['Nexus Mod Manager.exe', 'NexusModManager.exe'] },
  'cheat table': { find: ['cheatengine-x86_64.exe', 'cheatengine-i386.exe', 'cheatengine.exe'] },
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

// Search common drives + user profile for any of the given exe names,
// then launch the first one found. Returns the found path or throws.
async function findAndLaunch(exeNames) {
  const searchRoots = ['C:\\', 'D:\\', 'E:\\', process.env.USERPROFILE || ''].filter(Boolean);
  // Build a PS1 one-liner that searches without recursing into deep system trees.
  const patterns = exeNames.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
  const searchDirs = searchRoots
    .map((r) => `'${r.replace(/'/g, "''")}Program Files','${r.replace(/'/g, "''")}Program Files (x86)'`)
    .join(',');
  const psCmd = [
    `$names = @(${patterns});`,
    `$dirs  = @(${searchDirs});`,
    `$hit   = $null;`,
    `foreach ($d in $dirs) {`,
    `  if (!(Test-Path $d)) { continue }`,
    `  foreach ($n in $names) {`,
    `    $f = Get-ChildItem -Path $d -Filter $n -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1;`,
    `    if ($f) { $hit = $f.FullName; break }`,
    `  }`,
    `  if ($hit) { break }`,
    `}`,
    `if ($hit) { Write-Output $hit } else { exit 1 }`,
  ].join(' ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
    { timeout: 15000 }
  );
  const exePath = stdout.trim();
  if (!exePath) throw new Error('not found');
  await launchExe(exePath);
  return exePath;
}

/**
 * Run a named local command. Called from the renderer via IPC.
 * @param {string} name
 * @param {Record<string, any>} [args]
 */
async function runCommand(name, args = {}, ctx = {}) {
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

      // find-type entries (modding tools) require the Nightly build.
      if (entry.find) {
        if (!ctx.dangerousFeatures) {
          return fail(`${key} is only available in the Nightly build.`);
        }
        try {
          const found = await findAndLaunch(entry.find);
          return ok(`Launching ${key} from ${found}.`);
        } catch {
          return fail(
            `I couldn't find ${key} on this PC. Make sure it's installed and try again.`
          );
        }
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
