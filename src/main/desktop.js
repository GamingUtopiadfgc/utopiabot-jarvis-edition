'use strict';

// Desktop control module — mouse, keyboard, screenshot, window management.
// Uses PowerShell + Windows .NET APIs (no extra dependencies).
// Nightly / dangerousFeatures only — caller must gate on that flag.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

function ps(script, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true });
    const timer = setTimeout(() => { proc.kill(); resolve('[timeout]'); }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => { clearTimeout(timer); resolve(`[error] ${e.message}`); });
    proc.on('close', () => {
      clearTimeout(timer);
      const result = (out || err).trim();
      resolve(result || '[no output]');
    });
  });
}

// ---- Tool specs ----

const DESKTOP_TOOLS = [
  {
    name: 'move_mouse',
    description: 'Move the mouse cursor to screen coordinates (x, y) without clicking.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Screen X coordinate.' },
        y: { type: 'number', description: 'Screen Y coordinate.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'click_mouse',
    description: 'Move to (x, y) and click. button: "left" (default), "right", or "double".',
    parameters: {
      type: 'object',
      properties: {
        x:      { type: 'number' },
        y:      { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'double'], description: 'Which button.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'scroll_mouse',
    description: 'Scroll the mouse wheel at (x, y). amount: positive = up/forward, negative = down/back.',
    parameters: {
      type: 'object',
      properties: {
        x:      { type: 'number' },
        y:      { type: 'number' },
        amount: { type: 'number', description: 'Scroll clicks — positive up, negative down.' },
      },
      required: ['x', 'y', 'amount'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the currently focused window. Special chars are escaped automatically.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'press_key',
    description: [
      'Press a key or key combination in the focused window.',
      'Examples: "Enter", "Escape", "F5", "Tab", "Delete", "Ctrl+C", "Ctrl+V",',
      '"Ctrl+Z", "Ctrl+A", "Alt+F4", "Ctrl+Shift+I", "Win+D", arrow keys, F1–F12.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or combo to press.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'get_windows',
    description: 'Return a list of all open window titles on the desktop.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'focus_window',
    description: 'Bring a window to the foreground by partial title match.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Partial window title to match.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'take_screenshot',
    description: [
      'Capture a screenshot of the primary screen and save it to a temp file.',
      'Returns the file path — the user can open it to verify the state.',
      'If OCR is available the text content is also returned.',
    ].join(' '),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_cursor_pos',
    description: 'Return the current mouse cursor position (x, y). Useful for measuring coordinates before clicking.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// ---- Implementations ----

async function moveMouse(x, y) {
  return ps(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x|0}, ${y|0})
    Write-Output "Mouse moved to ${x|0}, ${y|0}"
  `);
}

async function clickMouse(x, y, button = 'left') {
  const flags = {
    left:   { down: 0x0002, up: 0x0004 },
    right:  { down: 0x0008, up: 0x0010 },
    double: { down: 0x0002, up: 0x0004, dbl: true },
  }[button] || { down: 0x0002, up: 0x0004 };

  const clicks = flags.dbl
    ? `[Mouse]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(4,0,0,0,0);
       Start-Sleep -Milliseconds 80; [Mouse]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(4,0,0,0,0)`
    : `[Mouse]::mouse_event(${flags.down},0,0,0,0); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${flags.up},0,0,0,0)`;

  return ps(`
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
}
"@
    [Mouse]::SetCursorPos(${x|0}, ${y|0})
    Start-Sleep -Milliseconds 30
    ${clicks}
    Write-Output "${button} click at ${x|0}, ${y|0}"
  `);
}

async function scrollMouse(x, y, amount) {
  const delta = Math.round(amount) * 120;
  return ps(`
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class Mouse2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
}
"@
    [Mouse2]::SetCursorPos(${x|0}, ${y|0})
    [Mouse2]::mouse_event(0x0800, 0, 0, ${delta}, 0)
    Write-Output "Scrolled ${amount > 0 ? 'up' : 'down'} at ${x|0}, ${y|0}"
  `);
}

// Map human key names → SendKeys format
function toSendKeys(raw) {
  const lower = raw.toLowerCase().trim();
  const single = {
    enter: '{ENTER}', return: '{ENTER}',
    escape: '{ESC}', esc: '{ESC}',
    tab: '{TAB}',
    delete: '{DELETE}', del: '{DELETE}',
    backspace: '{BACKSPACE}', back: '{BACKSPACE}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    home: '{HOME}', end: '{END}',
    pageup: '{PGUP}', pgup: '{PGUP}',
    pagedown: '{PGDN}', pgdn: '{PGDN}',
    insert: '{INSERT}', ins: '{INSERT}',
    space: ' ',
    f1:'{F1}',f2:'{F2}',f3:'{F3}',f4:'{F4}',f5:'{F5}',f6:'{F6}',
    f7:'{F7}',f8:'{F8}',f9:'{F9}',f10:'{F10}',f11:'{F11}',f12:'{F12}',
  };
  if (single[lower]) return single[lower];

  // Combo: Ctrl+C → ^c, Alt+F4 → %{F4}, Shift+A → +A, Win+D → not in SendKeys
  return lower
    .replace(/ctrl\+/g, '^')
    .replace(/alt\+/g, '%')
    .replace(/shift\+/g, '+')
    .replace(/win\+/g, '') // Win key not supported by SendKeys
    .replace(/([a-z])/g, (m) => m) // keep lower
    .replace(/f(\d{1,2})/g, '{F$1}')
    .replace(/enter/g, '{ENTER}')
    .replace(/escape|esc/g, '{ESC}')
    .replace(/tab/g, '{TAB}')
    .replace(/delete|del/g, '{DELETE}')
    .replace(/backspace/g, '{BACKSPACE}');
}

async function typeText(text) {
  // Escape SendKeys special chars: + ^ % ~ { } [ ]
  const escaped = text.replace(/[+^%~{}[\]]/g, '{$&}');
  return ps(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('${escaped.replace(/'/g, "''")}')
    Write-Output "Typed ${text.length} characters"
  `);
}

async function pressKey(key) {
  const mapped = toSendKeys(key);
  return ps(`
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('${mapped.replace(/'/g, "''")}')
    Write-Output "Pressed: ${key}"
  `);
}

async function getWindows() {
  return ps(`
    Get-Process | Where-Object { $_.MainWindowTitle -ne '' } |
      Select-Object -ExpandProperty MainWindowTitle | Sort-Object -Unique |
      ForEach-Object { "  - $_" }
  `);
}

async function focusWindow(title) {
  return ps(`
    $wsh = New-Object -ComObject WScript.Shell
    $result = $wsh.AppActivate('${title.replace(/'/g, "''")}')
    if ($result) { Write-Output "Focused: ${title}" }
    else {
      $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title.replace(/'/g, "''")}*' } | Select-Object -First 1
      if ($proc) {
        $wsh.AppActivate($proc.Id) | Out-Null
        Write-Output "Focused: $($proc.MainWindowTitle)"
      } else { Write-Output "Window not found: ${title}" }
    }
  `);
}

async function takeScreenshot() {
  const file = path.join(os.tmpdir(), `jarvis_screen_${Date.now()}.png`);
  const result = await ps(`
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $bmp.Save('${file.replace(/\\/g, '\\\\')}')
    $bmp.Dispose()
    Write-Output "Saved: ${file.replace(/\\/g, '\\\\')} ($($bounds.Width)x$($bounds.Height))"
  `, 15000);
  return result;
}

async function getCursorPos() {
  return ps(`
    Add-Type -AssemblyName System.Windows.Forms
    $p = [System.Windows.Forms.Cursor]::Position
    Write-Output "Cursor is at X=$($p.X), Y=$($p.Y)"
  `);
}

// ---- Dispatcher ----

async function runDesktopTool(name, input = {}) {
  try {
    switch (name) {
      case 'move_mouse':    return await moveMouse(input.x, input.y);
      case 'click_mouse':   return await clickMouse(input.x, input.y, input.button);
      case 'scroll_mouse':  return await scrollMouse(input.x, input.y, input.amount);
      case 'type_text':     return await typeText(String(input.text ?? ''));
      case 'press_key':     return await pressKey(String(input.key ?? ''));
      case 'get_windows':   return await getWindows();
      case 'focus_window':  return await focusWindow(String(input.title ?? ''));
      case 'take_screenshot': return await takeScreenshot();
      case 'get_cursor_pos':  return await getCursorPos();
      default: return `Error: unknown desktop tool "${name}".`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

module.exports = { DESKTOP_TOOLS, runDesktopTool };
