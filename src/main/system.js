'use strict';

const os = require('os');
const { exec } = require('child_process');

let prev = null;

function snapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  }
  return { idle, total };
}

// Instantaneous CPU% from the delta between calls.
function cpuPercent() {
  const s = snapshot();
  if (!prev) {
    prev = s;
    return 0;
  }
  const idle = s.idle - prev.idle;
  const total = s.total - prev.total;
  prev = s;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100)));
}

// Best-effort GPU% via nvidia-smi; null if unavailable (no NVIDIA / not on PATH).
function gpuPercent() {
  return new Promise((resolve) => {
    exec(
      'nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
      { timeout: 1500, windowsHide: true },
      (err, out) => {
        if (err) return resolve(null);
        const v = parseInt(String(out).trim().split('\n')[0], 10);
        resolve(Number.isNaN(v) ? null : v);
      }
    );
  });
}

async function getStats() {
  const totalGB = os.totalmem() / 1073741824;
  const freeGB = os.freemem() / 1073741824;
  return {
    cpu: cpuPercent(),
    ramUsedGB: +(totalGB - freeGB).toFixed(1),
    ramTotalGB: +totalGB.toFixed(1),
    gpu: await gpuPercent(),
  };
}

module.exports = { getStats };
