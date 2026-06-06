'use strict';

// DANGER ZONE: run shell commands on a remote VM over SSH. Mirrors the shape of
// automation.js (run_powershell) so the tool registry and approval gate treat
// VM execution exactly like local PowerShell execution.
const fs = require('fs');
const { Client } = require('ssh2');

const VM_TOOLS = [
  {
    name: 'run_vm_command',
    description:
      "Execute a shell command on the user's connected remote VM over SSH and return its output. Use this when the user asks to run something ON THE VM (not the local PC) — for system tasks, file management, or automation on the remote machine. The user may be asked to approve the command before it runs, so include a clear purpose.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run on the VM.' },
        purpose: {
          type: 'string',
          description: 'One short sentence: what this does and why.',
        },
      },
      required: ['command'],
    },
  },
];

// Build the ssh2 connection config from saved VM settings. Throws a readable
// Error if required fields are missing or a key file can't be read.
function connectionConfig(cfg = {}) {
  const host = String(cfg.host || '').trim();
  const username = String(cfg.username || '').trim();
  if (!host) throw new Error('No VM host is set.');
  if (!username) throw new Error('No VM username is set.');

  const conn = {
    host,
    port: parseInt(cfg.port, 10) || 22,
    username,
    readyTimeout: 15000,
  };
  if (cfg.authMethod === 'key') {
    const keyPath = String(cfg.privateKeyPath || '').trim();
    if (!keyPath) throw new Error('Key authentication selected but no private key file is set.');
    try {
      conn.privateKey = fs.readFileSync(keyPath);
    } catch (err) {
      throw new Error(`Could not read private key: ${err.message}`);
    }
  } else {
    conn.password = String(cfg.password || '');
  }
  return conn;
}

// Open an SSH session, run one command, resolve a string (never rejects) —
// just like runPowerShell in automation.js. Output capped at 4000 chars.
function runSsh(cfg, command, ms = 30000) {
  return new Promise((resolve) => {
    let conn;
    try {
      conn = connectionConfig(cfg);
    } catch (err) {
      return resolve('VM error: ' + err.message);
    }

    const client = new Client();
    let settled = false;
    const done = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* already closed */
      }
      resolve(msg);
    };

    const timer = setTimeout(
      () => done('VM command timed out after 30 seconds, sir.'),
      ms
    );

    client
      .on('ready', () => {
        client.exec(command, (err, stream) => {
          if (err) return done('VM exec failed: ' + err.message);
          let out = '';
          let errOut = '';
          stream
            .on('data', (d) => (out += d))
            .on('close', (code) => {
              let r = (out || '') + (errOut ? `\n[stderr] ${errOut}` : '');
              if (!r.trim()) r = `(no output, exit code ${code ?? 0})`;
              done(r.slice(0, 4000));
            });
          stream.stderr.on('data', (d) => (errOut += d));
        });
      })
      .on('error', (err) => done('VM connection failed: ' + err.message))
      .connect(conn);
  });
}

// Connect and run a trivial command to validate the saved/entered settings.
// Returns { ok, message } for the Settings "Test Connection" button.
async function testConnection(cfg) {
  const probe = await runSsh(cfg, 'echo utopia_vm_ok', 15000);
  if (/utopia_vm_ok/.test(probe)) {
    return { ok: true, message: 'Connected to the VM successfully, sir.' };
  }
  return { ok: false, message: probe };
}

// Tool dispatch. ctx carries the approval gate, the VM config, and whether
// unattended VM commands are allowed (which bypasses the approval dialog).
async function runVmTool(name, input, ctx = {}) {
  if (name !== 'run_vm_command') return `Error: unknown VM tool "${name}".`;
  const cfg = ctx.vmConfig;
  if (!cfg || !cfg.enabled) return 'VM control is disabled in Settings, sir.';

  const cmd = String(input.command || '').trim();
  if (!cmd) return 'No command was given.';

  // Approval gate — skipped only when the user has opted into unattended VM commands.
  if (!ctx.vmUnattended && ctx.approve) {
    const ok = await ctx.approve(cmd, input.purpose ? `[VM] ${input.purpose}` : '[VM] command');
    if (!ok) return 'The user denied that action, sir.';
  }
  return runSsh(cfg, cmd);
}

// --------------------------------------------------------------------------
// VM auto-detection — scans for hypervisors and running VMs on this machine.
// Safe: each probe is fire-and-forget with a hard timeout; nothing throws.
// --------------------------------------------------------------------------
const { exec } = require('child_process');

function safeExec(cmd, ms = 6000) {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: ms, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim());
    });
    child.on('error', () => resolve(null));
  });
}

async function detectVms() {
  const result = { runningInVm: false, vmPlatform: null, hostedVms: [] };

  // ---- Is this machine itself a VM guest? ----
  const mfr = await safeExec(
    'powershell -NoProfile -Command "(Get-WmiObject Win32_ComputerSystem).Manufacturer"'
  );
  if (mfr) {
    const m = mfr.toLowerCase();
    if (m.includes('vmware'))
      { result.runningInVm = true; result.vmPlatform = 'VMware'; }
    else if (m.includes('innotek') || m.includes('virtualbox'))
      { result.runningInVm = true; result.vmPlatform = 'VirtualBox'; }
    else if (m.includes('qemu') || m.includes('bochs') || m.includes('kvm'))
      { result.runningInVm = true; result.vmPlatform = 'KVM/QEMU'; }
    else if (m.includes('microsoft')) {
      const model = await safeExec(
        'powershell -NoProfile -Command "(Get-WmiObject Win32_ComputerSystem).Model"'
      );
      if (model && model.toLowerCase().includes('virtual'))
        { result.runningInVm = true; result.vmPlatform = 'Hyper-V'; }
    }
  }

  // ---- VMware Workstation / Fusion hosted VMs ----
  const vmrunList = await safeExec('vmrun list', 8000);
  if (vmrunList) {
    const vmxPaths = vmrunList
      .split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l.toLowerCase().endsWith('.vmx'))
      .slice(0, 5);

    for (const vmx of vmxPaths) {
      const ip = await safeExec(`vmrun getGuestIPAddress "${vmx}" -wait`, 10000);
      result.hostedVms.push({
        name: require('path').basename(vmx, '.vmx'),
        ip: ip || '',
        port: 22,
        hypervisor: 'VMware',
        note: ip ? '' : 'VMware Tools may not be running — enter the IP manually',
      });
    }
  }

  // ---- Hyper-V hosted VMs ----
  const hvJson = await safeExec(
    "powershell -NoProfile -Command \"Get-VM | Where-Object {$_.State -eq 'Running'} | Select-Object Name | ConvertTo-Json -Compress\"",
    8000
  );
  if (hvJson) {
    try {
      const raw = JSON.parse(hvJson);
      const vms = Array.isArray(raw) ? raw : [raw];
      for (const vm of vms.slice(0, 5)) {
        const ipOut = await safeExec(
          `powershell -NoProfile -Command "(Get-VMNetworkAdapter -VMName '${vm.Name}').IPAddresses | Where-Object {$_ -notlike '*:*'} | Select-Object -First 1"`,
          5000
        );
        result.hostedVms.push({
          name: vm.Name,
          ip: (ipOut || '').replace(/['"]/g, '').trim(),
          port: 22,
          hypervisor: 'Hyper-V',
          note: ipOut ? '' : 'Enter IP manually or enable Hyper-V Guest Services',
        });
      }
    } catch { /* bad JSON */ }
  }

  // ---- VirtualBox hosted VMs ----
  const vboxList = await safeExec('VBoxManage list runningvms', 5000);
  if (vboxList) {
    const matches = [...vboxList.matchAll(/"([^"]+)"\s+\{([^}]+)\}/g)];
    for (const [, name, uuid] of matches.slice(0, 5)) {
      const ipOut = await safeExec(
        `VBoxManage guestproperty get "${uuid}" /VirtualBox/GuestInfo/Net/0/V4/IP`,
        5000
      );
      const ip = ipOut ? ipOut.replace('Value:', '').trim() : '';
      result.hostedVms.push({
        name,
        ip,
        port: 22,
        hypervisor: 'VirtualBox',
        note: ip ? '' : 'Enter IP manually (Guest Additions may not be installed)',
      });
    }
  }

  return result;
}

module.exports = { VM_TOOLS, runVmTool, testConnection, detectVms };
