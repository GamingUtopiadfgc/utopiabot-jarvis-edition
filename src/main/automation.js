'use strict';

const { spawn } = require('child_process');

const AUTOMATION_TOOLS = [
  {
    name: 'run_powershell',
    description:
      "Execute a PowerShell command on the user's Windows PC and return its output. Use for system tasks the user asks for: opening or closing apps, managing files and windows, querying system info, or automation. The user may be asked to approve the command before it runs, so include a clear purpose.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The PowerShell command to run.' },
        purpose: {
          type: 'string',
          description: 'One short sentence: what this does and why.',
        },
      },
      required: ['command'],
    },
  },
];

function runPowerShell(command, ms = 30000) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      ps.kill();
      resolve('Command timed out after 30 seconds, sir.');
    }, ms);
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', (e) => {
      clearTimeout(timer);
      resolve('Failed to run command: ' + e.message);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      let r = (out || '') + (err ? `\n[stderr] ${err}` : '');
      if (!r.trim()) r = `(no output, exit code ${code})`;
      resolve(r.slice(0, 4000));
    });
  });
}

async function runAutomationTool(name, input, ctx = {}) {
  if (name !== 'run_powershell')
    return `Error: unknown automation tool "${name}".`;
  const cmd = String(input.command || '').trim();
  if (!cmd) return 'No command was given.';

  // Approval gate (decided by main from the security level / requireApproval).
  if (ctx.approve) {
    const ok = await ctx.approve(cmd, input.purpose);
    if (!ok) return 'The user denied that action, sir.';
  }
  return runPowerShell(cmd);
}

module.exports = { AUTOMATION_TOOLS, runAutomationTool };
