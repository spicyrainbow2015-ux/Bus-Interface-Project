// The projector window: turns captured ink into glowing, moving particles.
// It receives points from the operator window over a BroadcastChannel.

const PREVIEW = new URLSearchParams(location.search).has('preview');
if (PREVIEW) document.body.classList.add('preview');
const CH = new BroadcastChannel('ink-projector-v1');
const ID = Math.random().toString(36).slice(2);
const STORE_KEY = 'inkProjector.output';

const canvas = document.getElementById('out');
const ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');

const S = { colorMode: 'ink', motion: 0.5, wisps: 0.3, glow: 0.6, trails: 0.55, brightness: 0.8, pulse: 0.4, fade: 3, size: '1', showFrame: false, outlineGlow: 0.45 };
let outline = null; // { cv, place } glowing building outline
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch {}

// ---------- Particles (structure of arrays for speed) ----------
const CAP = 220000;
const px = new Float32Array(CAP), py = new Float32Array(CAP);
const vx = new Float32Array(CAP), vy = new Float32Array(CAP);
const nx = new Float32Array(CAP), ny = new Float32Array(CAP); // home position, 0..1 on the paper
const cr = new Float32Array(CAP), cg = new Float32Array(CAP), cb = new Float32Array(CAP);
const al = new Float32Array(CAP), seed = new Float32Array(CAP);
const st = new Uint8Array(CAP); // 1 = on the drawing, 2 = released by Clear, 3 = wisp
const ALL = [px, py, vx, vy, nx, ny, cr, cg, cb, al, seed, st];
let count = 0;
let alive = 0;
let aspect = 1.4142;

function removeAt(i) {
  const last = --count;
  if (i !== last) for (const a of ALL) a[i] = a[last];
}

// Black or grey ink would vanish on a dark building, so it becomes warm white.
// Coloured ink keeps its hue at full brightness.
function inkColor(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 1 || (mx - mn) / mx < 0.28) return [1, 0.96, 0.89];
  let R = r / mx, G = g / mx, B = b / mx;
  const avg = (R + G + B) / 3;
  R = Math.min(1, Math.max(0, avg + (R - avg) * 1.35));
  G = Math.min(1, Math.max(0, avg + (G - avg) * 1.35));
  B = Math.min(1, Math.max(0, avg + (B - avg) * 1.35));
  return [R, G, B];
}

// Neon palette lookup
const NEON = new Float32Array(256 * 3);
for (let k = 0; k < 256; k++) {
  // hsl(k/256 turn, 100%, 60%)
  const h = k / 256, l = 0.6, a = 0.4;
  const conv = (n) => {
    const kk = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1));
  };
  NEON[k * 3] = conv(0); NEON[k * 3 + 1] = conv(8); NEON[k * 3 + 2] = conv(4);
}

// ---------- Layout ----------
let W = 0, H = 0, acc = null, img = null;
let layout = { ox: 0, oy: 0, w: 1, h: 1 };

function relayout() {
  const m = PREVIEW ? 0.06 : 0.05;
  const aw = W * (1 - 2 * m), ah = H * (1 - 2 * m);
  let w = aw, h = aw / aspect;
  if (h > ah) { h = ah; w = ah * aspect; }
  layout = { ox: (W - w) / 2, oy: (H - h) / 2, w, h };
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = window.innerWidth || 640, ch = window.innerHeight || 360;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const newW = Math.max(160, Math.min(1280, Math.round(cw * dpr * 0.6)));
  const newH = Math.max(90, Math.round(newW * ch / cw));
  if (W) {
    const sx = newW / W, sy = newH / H;
    for (let i = 0; i < count; i++) { px[i] *= sx; py[i] *= sy; }
  }
  W = newW; H = newH;
  off.width = W; off.height = H;
  acc = new Float32Array(W * H * 3);
  img = octx.createImageData(W, H);
  for (let j = 3; j < img.data.length; j += 4) img.data[j] = 255;
  relayout();
}
window.addEventListener('resize', resize);
resize();

// ---------- Adding and releasing ----------
function addPoints(arr, animate) {
  const { ox, oy, w, h } = layout;
  const unit = W / 1000;
  for (let k = 0; k + 4 < arr.length && count < CAP; k += 5) {
    const i = count++;
    nx[i] = arr[k]; ny[i] = arr[k + 1];
    const [r, g, b] = inkColor(arr[k + 2], arr[k + 3], arr[k + 4]);
    cr[i] = r; cg[i] = g; cb[i] = b;
    const hx = ox + nx[i] * w, hy = oy + ny[i] * h;
    if (animate) {
      // Start scattered nearby, then gather into the stroke
      const a = Math.random() * Math.PI * 2, d = (12 + Math.random() * 40) * unit;
      px[i] = hx + Math.cos(a) * d; py[i] = hy + Math.sin(a) * d;
      al[i] = 0;
    } else {
      px[i] = hx; py[i] = hy; al[i] = 1;
    }
    vx[i] = 0; vy[i] = 0;
    seed[i] = Math.random();
    st[i] = 1;
  }
}

function releaseAll() {
  const unit = W / 1000;
  for (let i = 0; i < count; i++) {
    if (st[i] !== 1) continue;
    st[i] = 2;
    vx[i] += (Math.random() - 0.5) * 50 * unit;
    vy[i] += (Math.random() - 0.7) * 40 * unit;
  }
}

// ---------- Simulation ----------
function flowX(x, y, t, inv) { return Math.sin(y * 0.012 * inv + t * 0.6 + Math.sin(x * 0.008 * inv - t * 0.3) * 1.5); }
function flowY(x, y, t, inv) { return Math.cos(x * 0.011 * inv - t * 0.5 + Math.cos(y * 0.009 * inv + t * 0.4) * 1.5); }

let emitAcc = 0;
function step(dt, t) {
  const { ox, oy, w: lw, h: lh } = layout;
  const unit = W / 1000, inv = 1 / unit;
  const mot = S.motion;
  const K = 70, damp = Math.exp(-10 * dt), driftDamp = Math.exp(-1.4 * dt);
  const fadeRate = dt / Math.max(0.2, S.fade);
  const amp = (0.4 + mot * 3.2) * unit;

  // Wisps: occasional particles peel off the drawing and drift away like smoke
  if (S.wisps > 0 && alive > 0) {
    emitAcc += S.wisps * S.wisps * (40 + alive * 0.04) * dt;
    while (emitAcc >= 1 && count < CAP) {
      emitAcc -= 1;
      let j = (Math.random() * count) | 0;
      if (st[j] !== 1) j = (Math.random() * count) | 0;
      if (st[j] !== 1) continue;
      const i = count++;
      for (const a of ALL) a[i] = a[j];
      st[i] = 3;
      al[i] = 0.75 * al[j];
      vx[i] = (Math.random() - 0.5) * 20 * unit;
      vy[i] = (Math.random() - 0.5) * 20 * unit;
    }
  } else emitAcc = 0;

  alive = 0;
  for (let i = 0; i < count; i++) {
    const s = st[i];
    if (s === 1) {
      alive++;
      const hx = ox + nx[i] * lw, hy = oy + ny[i] * lh;
      const ph = seed[i] * 6.2832;
      const tx = hx + (Math.sin(t * 1.7 + ph) * 0.6 + flowX(hx, hy, t, inv)) * amp;
      const ty = hy + (Math.cos(t * 1.3 + ph * 1.3) * 0.6 + flowY(hx, hy, t, inv)) * amp;
      vx[i] = (vx[i] + (tx - px[i]) * K * dt) * damp;
      vy[i] = (vy[i] + (ty - py[i]) * K * dt) * damp;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      if (al[i] < 1) al[i] = Math.min(1, al[i] + dt * (1.5 + seed[i] * 1.5));
    } else {
      const speed = (s === 3 ? 34 : 26) * unit * (0.5 + mot);
      const ax = flowX(px[i], py[i], t, inv) * speed * 3;
      const ay = flowY(px[i], py[i], t, inv) * speed * 3 - 14 * unit;
      vx[i] = (vx[i] + ax * dt) * driftDamp;
      vy[i] = (vy[i] + ay * dt) * driftDamp;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      al[i] -= s === 3 ? dt / 1.8 : fadeRate;
      if (al[i] <= 0) { removeAt(i); i--; }
    }
  }
}

// ---------- Rendering ----------
function render(t) {
  const trail = S.trails * 0.93;
  if (trail <= 0.001) acc.fill(0);
  else for (let k = 0; k < acc.length; k++) acc[k] *= trail;

  const bold = S.size === '2' || S.size === 2;
  const mode = S.colorMode;
  const tShift = (t * 30) | 0;
  // Glow pulse: a slow wave of light that travels across the drawing.
  const pulseAmp = S.pulse * 0.45, pulseT = t * 1.4;
  // Particles grow with the output so strokes stay solid at any window size.
  // (The operator captures ink at 480 px along the paper's long side.)
  const cell = Math.max(layout.w, layout.h) / 480;
  const R = Math.max(0.7, cell * 0.6) * (bold ? 1.6 : 1);
  const disc = R > 1.05;
  const Rc = Math.ceil(R), Rf = R + 0.5;
  const Wm = W - 1 - Rc, Hm = H - 1 - Rc;
  // Keep the light per area the same at any window size. In a small window (like the operator's
  // preview) many particles land on each pixel and add up, which made it look brighter and whiter
  // than the real projector window. Normalize by how much each particle covers.
  const energy = disc ? (Math.PI * Rf * Rf) / 3 : 1;
  const coverage = energy / (cell * cell);
  const norm = Math.min(1.5, 0.75 / coverage);
  const bright = S.brightness * 200 * (1 - trail * 0.6) * norm;

  for (let i = 0; i < count; i++) {
    let x = px[i], y = py[i];
    if (x < Rc || y < Rc || x >= Wm || y >= Hm) continue;
    if (disc) {
      let r, g, b;
      if (mode === 'white') { r = g = b = 1; }
      else if (mode === 'neon') {
        const k = (((nx[i] * 200 + ny[i] * 70) | 0) + tShift) & 255;
        r = NEON[k * 3]; g = NEON[k * 3 + 1]; b = NEON[k * 3 + 2];
      } else { r = cr[i]; g = cg[i]; b = cb[i]; }
      const I = al[i] * bright * (1 + pulseAmp * Math.sin(pulseT - (nx[i] * 5 + ny[i] * 3)));
      r *= I; g *= I; b *= I;
      const cx = Math.round(x), cy = Math.round(y);
      for (let oy = -Rc; oy <= Rc; oy++) {
        const dy = cy + oy - y;
        const row = (cy + oy) * W;
        for (let ox = -Rc; ox <= Rc; ox++) {
          const dx = cx + ox - x;
          const wgt = 1 - Math.sqrt(dx * dx + dy * dy) / Rf;
          if (wgt <= 0) continue;
          const o = (row + cx + ox) * 3;
          acc[o] += r * wgt; acc[o + 1] += g * wgt; acc[o + 2] += b * wgt;
        }
      }
      continue;
    }
    let r, g, b;
    if (mode === 'white') { r = g = b = 1; }
    else if (mode === 'neon') {
      const k = (((nx[i] * 200 + ny[i] * 70) | 0) + tShift) & 255;
      r = NEON[k * 3]; g = NEON[k * 3 + 1]; b = NEON[k * 3 + 2];
    } else { r = cr[i]; g = cg[i]; b = cb[i]; }
    const I = al[i] * bright * (1 + pulseAmp * Math.sin(pulseT - (nx[i] * 5 + ny[i] * 3)));
    r *= I; g *= I; b *= I;

    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const o = (y0 * W + x0) * 3, o2 = o + W * 3;
    acc[o] += r * w00; acc[o + 1] += g * w00; acc[o + 2] += b * w00;
    acc[o + 3] += r * w10; acc[o + 4] += g * w10; acc[o + 5] += b * w10;
    acc[o2] += r * w01; acc[o2 + 1] += g * w01; acc[o2 + 2] += b * w01;
    acc[o2 + 3] += r * w11; acc[o2 + 4] += g * w11; acc[o2 + 5] += b * w11;
    if (bold && x0 > 0 && y0 > 0 && x0 < W - 2 && y0 < H - 2) {
      const q = 0.35;
      const ol = o - 3, or = o + 6, ou = o - W * 3, od = o2 + W * 3;
      acc[ol] += r * q; acc[ol + 1] += g * q; acc[ol + 2] += b * q;
      acc[or] += r * q; acc[or + 1] += g * q; acc[or + 2] += b * q;
      acc[ou] += r * q; acc[ou + 1] += g * q; acc[ou + 2] += b * q;
      acc[od] += r * q; acc[od + 1] += g * q; acc[od + 2] += b * q;
    }
  }

  const d = img.data;
  for (let p = 0, k = 0, j = 0; p < W * H; p++, k += 3, j += 4) {
    // Where light piles up past full brightness, scale the colour down instead of letting each
    // channel clip separately. Clipping turns every bright colour white; this keeps its hue.
    const r = acc[k], g = acc[k + 1], b = acc[k + 2];
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m > 255) { const f = 255 / m; d[j] = r * f; d[j + 1] = g * f; d[j + 2] = b * f; }
    else { d[j] = r; d[j + 1] = g; d[j + 2] = b; }
  }
  octx.putImageData(img, 0, 0);

  const cw = canvas.width, ch = canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, cw, ch);
  // The whole halo also breathes slowly (about every 4 seconds).
  const breathe = 1 + S.pulse * 0.45 * Math.sin(t * 1.6);
  if (S.glow > 0.01) {
    const blur = Math.max(2, Math.round((4 + S.glow * 16 * breathe) * cw / 1920));
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = Math.min(1, S.glow * 1.1 * breathe);
    ctx.filter = `blur(${blur}px)`;
    ctx.drawImage(off, 0, 0, cw, ch);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  if (outline && S.outlineGlow > 0.01) {
    // Building outline: a soft, slowly breathing glow behind a crisp line
    const sx = cw / W, sy = ch / H;
    const x = (layout.ox + outline.place.x * layout.w) * sx, y = (layout.oy + outline.place.y * layout.h) * sy;
    const w = outline.place.w * layout.w * sx, h = outline.place.h * layout.h * sy;
    const a = S.outlineGlow * (0.8 + 0.2 * Math.sin(t * 0.9));
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = a * 0.7;
    ctx.filter = `blur(${Math.max(2, Math.round(8 * cw / 1920))}px)`;
    ctx.drawImage(outline.cv, x, y, w, h);
    ctx.filter = 'none';
    ctx.globalAlpha = a;
    ctx.drawImage(outline.cv, x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  if (S.showFrame) {
    const sx = cw / W, sy = ch / H;
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(1, cw / 1200);
    ctx.strokeRect(layout.ox * sx, layout.oy * sy, layout.w * sx, layout.h * sy);
    ctx.setLineDash([]);
  }
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  step(dt, t);
  render(t);
}
requestAnimationFrame(frame);

// ---------- Messages from the operator ----------
CH.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.type === 'add') {
    if (m.aspect && Math.abs(m.aspect - aspect) > 0.001) { aspect = m.aspect; relayout(); }
    addPoints(m.pts, true);
  } else if (m.type === 'sync' && m.to === ID) {
    if (m.aspect) { aspect = m.aspect; relayout(); }
    count = 0;
    addPoints(m.pts, true);
  } else if (m.type === 'outline') {
    if (m.to && m.to !== ID) return;
    if (!m.on) { outline = null; return; }
    if (m.aspect && Math.abs(m.aspect - aspect) > 0.001) { aspect = m.aspect; relayout(); }
    const cv = document.createElement('canvas');
    cv.width = m.w; cv.height = m.h;
    const c = cv.getContext('2d');
    const id = c.createImageData(m.w, m.h);
    for (let i = 0, j = 0; i < m.w * m.h; i++, j += 4) {
      id.data[j] = 190; id.data[j + 1] = 215; id.data[j + 2] = 255; id.data[j + 3] = m.mask[i];
    }
    c.putImageData(id, 0, 0);
    outline = { cv, place: m.place };
  } else if (m.type === 'clear') {
    releaseAll();
  } else if (m.type === 'settings') {
    Object.assign(S, m.settings);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {}
  } else if (m.type === 'control-hello') {
    CH.postMessage({ type: 'hello', id: ID, preview: PREVIEW });
  }
};
CH.postMessage({ type: 'hello', id: ID, preview: PREVIEW });
setInterval(() => CH.postMessage({ type: 'ping', id: ID, preview: PREVIEW }), 1500);
window.addEventListener('beforeunload', () => CH.postMessage({ type: 'bye', id: ID }));

// ---------- Full screen, clear key, cursor ----------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') toggleFullscreen();
  if ((e.code === 'Space' || e.code === 'KeyC') && !e.repeat) {
    e.preventDefault();
    CH.postMessage({ type: 'request-clear' });
  }
});
window.addEventListener('dblclick', toggleFullscreen);

const hint = document.getElementById('hint');
setTimeout(() => hint.classList.add('gone'), 6000);
let idleTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});
