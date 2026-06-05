'use strict';

/**
 * Arc-reactor canvas animation. Exposes window.Reactor with:
 *   - setState(state): 'standby' | 'listening' | 'thinking' | 'speaking'
 *   - setLevel(0..1):  audio level used to pulse the core (for speaking/listening)
 */
(function () {
  const canvas = document.getElementById('reactor');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;

  const PALETTE = {
    standby: { core: '#38e1ff', glow: 'rgba(56,225,255,', speed: 1 },
    listening: { core: '#ffcf6a', glow: 'rgba(255,207,106,', speed: 1.6 },
    thinking: { core: '#9b8cff', glow: 'rgba(155,140,255,', speed: 3.2 },
    speaking: { core: '#38ffd0', glow: 'rgba(56,255,208,', speed: 2.2 },
  };

  let state = 'standby';
  let level = 0; // smoothed audio level
  let targetLevel = 0;
  let t = 0;

  // Particles drifting outward from the core.
  const particles = Array.from({ length: 46 }, () => spawn());
  function spawn() {
    const a = Math.random() * Math.PI * 2;
    return {
      a,
      r: 40 + Math.random() * 20,
      speed: 0.2 + Math.random() * 0.6,
      size: 0.6 + Math.random() * 1.6,
      life: Math.random(),
    };
  }

  function ring(radius, width, segments, rot, color, alpha, gap) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.lineWidth = width;
    const seg = (Math.PI * 2) / segments;
    for (let i = 0; i < segments; i++) {
      ctx.beginPath();
      ctx.strokeStyle = color + alpha + ')';
      ctx.arc(0, 0, radius, i * seg, i * seg + seg * (1 - gap));
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    t += 1;
    const p = PALETTE[state] || PALETTE.standby;
    // ease the audio level toward its target
    level += (targetLevel - level) * 0.18;

    ctx.clearRect(0, 0, W, H);

    const idlePulse = 0.5 + 0.5 * Math.sin(t * 0.04 * p.speed);
    const pulse = Math.max(idlePulse * 0.5, level);

    // Outer glow halo
    const haloR = 150 + pulse * 26;
    const halo = ctx.createRadialGradient(cx, cy, 30, cx, cy, haloR);
    halo.addColorStop(0, p.glow + (0.35 + pulse * 0.3) + ')');
    halo.addColorStop(1, p.glow + '0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();

    // Concentric tech rings
    const base = t * 0.01 * p.speed;
    ring(140, 2, 3, base, p.glow, 0.5, 0.25);
    ring(122, 6, 24, -base * 1.4, p.glow, 0.28, 0.45);
    ring(104, 2, 1, base * 0.6, p.glow, 0.5, 0.2);
    ring(88, 10, 12, -base * 0.9, p.glow, 0.18, 0.4);
    ring(70, 3, 36, base * 2.2, p.glow, 0.35, 0.5);

    // Particles (can be disabled in Appearance settings)
    if (window.__particles !== false) particles.forEach((pt) => {
      pt.r += pt.speed * (0.6 + level);
      pt.life -= 0.006;
      if (pt.r > 130 || pt.life <= 0) Object.assign(pt, spawn(), { r: 44 });
      const x = cx + Math.cos(pt.a) * pt.r;
      const y = cy + Math.sin(pt.a) * pt.r;
      ctx.beginPath();
      ctx.fillStyle = p.glow + Math.max(0, pt.life) * 0.8 + ')';
      ctx.arc(x, y, pt.size, 0, Math.PI * 2);
      ctx.fill();
    });

    // Triangular reactor core (Iron Man Mark style)
    ctx.save();
    ctx.translate(cx, cy);
    const coreR = 38 + pulse * 8;
    const coreGrad = ctx.createRadialGradient(0, 0, 2, 0, 0, coreR);
    coreGrad.addColorStop(0, '#ffffff');
    coreGrad.addColorStop(0.4, p.core);
    coreGrad.addColorStop(1, p.glow + '0.1)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(0, 0, coreR, 0, Math.PI * 2);
    ctx.fill();

    // inner triangle outline that slowly counter-rotates
    ctx.rotate(-base * 1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(ang) * (coreR * 0.6);
      const y = Math.sin(ang) * (coreR * 0.6);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    requestAnimationFrame(draw);
  }
  draw();

  window.Reactor = {
    setState(s) {
      if (PALETTE[s]) state = s;
    },
    setLevel(v) {
      targetLevel = Math.max(0, Math.min(1, v));
    },
    // Recolor the standby (idle) palette to match the active theme accent.
    setAccent(hex, rgb) {
      PALETTE.standby.core = hex;
      PALETTE.standby.glow = `rgba(${rgb},`;
    },
  };
})();
