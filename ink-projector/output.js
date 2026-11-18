// The projector window: turns captured ink into glowing, moving particles.
// It receives points from the operator window over a BroadcastChannel.

import { solveHomography } from './vision.js';
import { createBrushSound } from './brushsound.js';

const PREVIEW = new URLSearchParams(location.search).has('preview');
const BUILD = 27; // must match control.js; a newer operator makes this window reload (see 'settings')
if (PREVIEW) document.body.classList.add('preview');
const CH = new BroadcastChannel('ink-projector-v1');
const ID = Math.random().toString(36).slice(2);
const STORE_KEY = 'inkProjector.output';

const canvas = document.getElementById('out');
const ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');

const S = { colorMode: 'ink', motion: 0.5, wisps: 0.3, glow: 0.6, trails: 0.55, brightness: 0.8, pulse: 0.4, fade: 3, size: '1', showFrame: false, outlineGlow: 0.45, sheetTurn: 6 };
let outline = null; // { cv, place } glowing building outline
let highlight = null; // { cv, place } the shape open for photo submissions
let res = 480; // capture resolution along the long side (particles are sized from it)
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch {}

// ---------- Particles (structure of arrays for speed) ----------
const CAP = 220000;
const px = new Float32Array(CAP), py = new Float32Array(CAP);
const vx = new Float32Array(CAP), vy = new Float32Array(CAP);
const nx = new Float32Array(CAP), ny = new Float32Array(CAP); // home position, 0..1 on the paper
const cr = new Float32Array(CAP), cg = new Float32Array(CAP), cb = new Float32Array(CAP);
const al = new Float32Array(CAP), seed = new Float32Array(CAP);
const st = new Uint8Array(CAP); // 1 = on the drawing, 2 = released by Clear, 3 = wisp, 4 = waiting to be drawn in
const born = new Float32Array(CAP); // when a waiting particle appears (seconds)
const grp = new Uint16Array(CAP); // which phone drawing group (a doorway part, or one visitor's lines in a shape); 0 = none
const ALL = [px, py, vx, vy, nx, ny, cr, cg, cb, al, seed, st, grp, born];
const groupIds = new Map();
const groupId = (name) => { if (!name) return 0; if (!groupIds.has(name)) groupIds.set(name, Math.min(65535, groupIds.size + 1)); return groupIds.get(name); };
let count = 0;
let alive = 0;

// ---------- Paper sheets: each drawing glows in a ripple, then darkens; drawings in a box take turns ----------
// A sheet's drawing in one box is one group. In each box the groups take turns: the one whose turn it
// is lights up in a wave spreading from the middle of the box (with a bright crest), holds, then
// darkens the same way while the next one starts. With one drawing in a box it simply pulses.
const DIM = 0.1;          // a drawing waiting for its turn stays faintly visible
const showOn = new Uint8Array(65536), showActive = new Uint8Array(65536);
const showT0 = new Float32Array(65536), showCx = new Float32Array(65536), showCy = new Float32Array(65536);
const showRx = new Float32Array(65536), showRy = new Float32Array(65536);
const boxes = new Map();  // box id -> { list: [gid], epoch }
let lastT = performance.now() / 1000;

function addSheetDrawing({ group, box, rect }) {
  const gid = groupId(group);
  if (!gid || !rect) return;
  let b = boxes.get(box);
  if (!b) { b = { list: [], epoch: lastT }; boxes.set(box, b); }
  if (b.list.includes(gid)) return;
  b.list.push(gid);
  // The newest drawing gets its turn right away; the others follow in order after it
  b.epoch = lastT - (b.list.length - 1) * Math.max(1, S.sheetTurn);
  showOn[gid] = 1;
  showCx[gid] = rect.x + rect.w / 2; showCy[gid] = rect.y + rect.h / 2;
  showRx[gid] = Math.max(0.01, rect.w / 2); showRy[gid] = Math.max(0.01, rect.h / 2);
}
function updateShows(t) {
  const T = Math.max(1, S.sheetTurn);
  for (const b of boxes.values()) {
    const n = b.list.length;
    if (!n) continue;
    const k = Math.floor((t - b.epoch) / T);
    const active = ((k % n) + n) % n;
    b.list.forEach((gid, j) => {
      showActive[gid] = j === active ? 1 : 0;
      if (j === active) showT0[gid] = b.epoch + k * T;
    });
  }
}
// How bright a sheet particle is now: the wave reaches it later the further it is from the box's middle
function showGain(i, t) {
  const g = grp[i];
  if (!showActive[g]) return DIM;
  const T = Math.max(1, S.sheetTurn);
  const d = Math.hypot((nx[i] - showCx[g]) / showRx[g], (ny[i] - showCy[g]) / showRy[g]); // 0 middle, ~1.4 corners
  const tau = t - showT0[g] - d * 0.9;
  // Darkens late in the turn, so the next drawing's ripple starts as this one fades (no empty gap)
  const darkStart = Math.max(1.2, T - 2.3), darkLen = Math.min(1.0, Math.max(0.4, T - darkStart - 1.3));
  if (tau < 0) return DIM;
  if (tau < 0.3) return DIM + (1.9 - DIM) * (tau / 0.3);                 // the bright crest arrives
  if (tau < 1.1) return 1.9 - 0.9 * ((tau - 0.3) / 0.8);                 // settles to a steady glow
  if (tau < darkStart) return 1;
  if (tau < darkStart + darkLen) return 1 + (DIM - 1) * ((tau - darkStart) / darkLen); // darkens
  return DIM;
}
function clearSheetShows(t) {
  // Released particles keep the brightness they had, so dim ones don't flash as they drift away
  for (let i = 0; i < count; i++) if (showOn[grp[i]]) al[i] *= Math.min(1, showGain(i, t));
  for (const b of boxes.values()) for (const gid of b.list) { showOn[gid] = 0; showActive[gid] = 0; }
  boxes.clear();
}
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
function addPoints(arr, animate, group, delays) {
  const gid = groupId(group);
  const now = performance.now() / 1000;
  const { ox, oy, w, h } = layout;
  const unit = W / 1000;
  for (let k = 0; k + 4 < arr.length && count < CAP; k += 5) {
    const i = count++;
    nx[i] = arr[k]; ny[i] = arr[k + 1];
    const [r, g, b] = inkColor(arr[k + 2], arr[k + 3], arr[k + 4]);
    cr[i] = r; cg[i] = g; cb[i] = b;
    const hx = ox + nx[i] * w, hy = oy + ny[i] * h;
    if (animate === 'live') {
      // Drawn live: appear right under the pen and brighten quickly, so drawing doesn't feel late
      px[i] = hx; py[i] = hy; al[i] = 0.6;
    } else if (animate) {
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
    grp[i] = gid;
    if (delays) {
      // Drawn in: wait at its spot, then appear (see step())
      px[i] = hx; py[i] = hy; al[i] = 0;
      st[i] = 4;
      born[i] = now + delays[k / 5];
    }
  }
}

function releaseAll(group) {
  const unit = W / 1000;
  const gid = group ? groupId(group) : 0;
  for (let i = 0; i < count; i++) {
    if (gid && grp[i] !== gid) continue;
    if (st[i] === 4) { st[i] = 2; al[i] = 0; continue; } // never drawn in: just remove
    if (st[i] !== 1) continue;
    st[i] = 2;
    vx[i] += (Math.random() - 0.5) * 50 * unit;
    vy[i] += (Math.random() - 0.7) * 40 * unit;
  }
}

// A visitor's eraser: their particles on the erased pixels drift off and fade
let eraseLookup = null;
function eraseAt({ group, w, h, idx }) {
  const gid = groupIds.get(group);
  if (!gid || !idx || !w || !h) return;
  if (!eraseLookup || eraseLookup.length !== w * h) eraseLookup = new Uint8Array(w * h);
  for (const i of idx) eraseLookup[i] = 1;
  const unit = W / 1000;
  for (let i = 0; i < count; i++) {
    if (grp[i] !== gid || (st[i] !== 1 && st[i] !== 4)) continue;
    if (!eraseLookup[Math.floor(ny[i] * h) * w + Math.floor(nx[i] * w)]) continue;
    if (st[i] === 4) { st[i] = 2; al[i] = 0; continue; }
    st[i] = 2;
    vx[i] += (Math.random() - 0.5) * 14 * unit;
    vy[i] += (Math.random() - 0.6) * 10 * unit;
  }
  for (const i of idx) eraseLookup[i] = 0;
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
  const nowS = performance.now() / 1000;
  for (let i = 0; i < count; i++) {
    let s = st[i];
    if (s === 4) {
      if (nowS < born[i]) continue;
      // Its turn: appear with a bright "pen tip" flash that settles over a moment
      st[i] = s = 1;
      al[i] = 1.8;
    }
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
      else if (al[i] > 1) al[i] = Math.max(1, al[i] - dt * 2.2);
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
  const cell = Math.max(layout.w, layout.h) / res;
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
      const I = al[i] * bright * (1 + pulseAmp * Math.sin(pulseT - (nx[i] * 5 + ny[i] * 3))) * (showOn[grp[i]] ? showGain(i, t) : 1);
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
    const I = al[i] * bright * (1 + pulseAmp * Math.sin(pulseT - (nx[i] * 5 + ny[i] * 3))) * (showOn[grp[i]] ? showGain(i, t) : 1);
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
  if (highlight) {
    // The shape that's open for drawing: a warm fill that slowly breathes, with a soft halo
    const sx = cw / W, sy = ch / H;
    const x = (layout.ox + highlight.place.x * layout.w) * sx, y = (layout.oy + highlight.place.y * layout.h) * sy;
    const w = highlight.place.w * layout.w * sx, h = highlight.place.h * layout.h * sy;
    const b = 0.5 + 0.5 * Math.sin(t * 2.1);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.18 + 0.22 * b;
    ctx.filter = `blur(${Math.max(3, Math.round(18 * cw / 1920))}px)`;
    ctx.drawImage(highlight.cv, x, y, w, h);
    ctx.filter = 'none';
    ctx.globalAlpha = 0.1 + 0.16 * b;
    ctx.drawImage(highlight.cv, x, y, w, h);
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
  presentMapped();
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  lastT = t;
  step(dt, t);
  if (boxes.size) updateShows(t);
  render(t);
}
requestAnimationFrame(frame);

// ---------- Messages from the operator ----------
CH.onmessage = ({ data: m }) => {
  if (!m) return;
  if (m.res) res = m.res;
  if (m.type === 'add') {
    if (m.aspect && Math.abs(m.aspect - aspect) > 0.001) { aspect = m.aspect; relayout(); }
    addPoints(m.pts, m.live ? 'live' : true, m.group, m.delays);
  } else if (m.type === 'release') {
    releaseAll(m.group);
  } else if (m.type === 'sheet') {
    if (!m.to || m.to === ID) addSheetDrawing(m);
  } else if (m.type === 'erase') {
    eraseAt(m);
  } else if (m.type === 'sync' && m.to === ID) {
    if (m.aspect) { aspect = m.aspect; relayout(); }
    count = 0;
    clearSheetShows(lastT); // the sheets' turns are sent again right after
    addPoints(m.pts, true);
    for (const g of m.groups || []) addPoints(g.pts, true, g.group);
  } else if (m.type === 'highlight') {
    if (m.to && m.to !== ID) return;
    if (!m.on) { highlight = null; return; }
    if (m.aspect && Math.abs(m.aspect - aspect) > 0.001) { aspect = m.aspect; relayout(); }
    const cv = document.createElement('canvas');
    cv.width = m.w; cv.height = m.h;
    const c = cv.getContext('2d');
    const id = c.createImageData(m.w, m.h);
    for (let i = 0, j = 0; i < m.w * m.h; i++, j += 4) {
      id.data[j] = 255; id.data[j + 1] = 196; id.data[j + 2] = 110; id.data[j + 3] = m.mask[i];
    }
    c.putImageData(id, 0, 0);
    highlight = { cv, place: m.place };
  } else if (m.type === 'qr') {
    if (m.to && m.to !== ID) return;
    showQr(m.on ? m.url : null, m.caption);
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
  } else if (m.type === 'parts') {
    if (m.to && m.to !== ID) return;
    if (m.aspect && Math.abs(m.aspect - aspect) > 0.001) { aspect = m.aspect; relayout(); }
    setParts(m.sig, m.parts, m.guides);
  } else if (m.type === 'clear') {
    clearSheetShows(lastT);
    releaseAll();
  } else if (m.type === 'settings') {
    if (m.build > BUILD) {
      // The operator page was updated after this window opened: reload to get the new code (once per version)
      let tried = '';
      try { tried = sessionStorage.getItem('inkProjector.reloadedFor') || ''; } catch {}
      if (tried !== String(m.build)) {
        try { sessionStorage.setItem('inkProjector.reloadedFor', String(m.build)); } catch {}
        location.reload();
        return;
      }
    }
    Object.assign(S, m.settings);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {}
  } else if (m.type === 'control-hello') {
    CH.postMessage({ type: 'hello', id: ID, preview: PREVIEW, ...sizeInfo() });
  }
};
const sizeInfo = () => ({ sw: window.innerWidth, sh: window.innerHeight });
CH.postMessage({ type: 'hello', id: ID, preview: PREVIEW, ...sizeInfo() });
setInterval(() => CH.postMessage({ type: 'ping', id: ID, preview: PREVIEW, ...sizeInfo() }), 1500);
window.addEventListener('beforeunload', () => CH.postMessage({ type: 'bye', id: ID }));

// ---------- Full screen, clear key, cursor ----------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') toggleFullscreen();
  if (mapKey(e)) return;
  if ((e.code === 'Space' || e.code === 'KeyC') && !e.repeat) {
    e.preventDefault();
    CH.postMessage({ type: 'request-clear' });
  }
});


const hint = document.getElementById('hint');
setTimeout(() => hint.classList.add('gone'), 6000);
let idleTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2000);
});

// ---------- QR code for photo submissions ----------
const qrBox = document.getElementById('qr');
let qrUrl = null;
function showQr(url, caption) {
  if (caption) qrBox.querySelector('p').innerHTML = caption;
  if (url === qrUrl) return;
  qrUrl = url;
  if (!url || typeof window.qrcode !== 'function') { qrBox.hidden = true; return; }
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount(), q = 2, px = 8;
  const c = qrBox.querySelector('canvas');
  c.width = c.height = (n + q * 2) * px;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) x.fillRect((k + q) * px, (r + q) * px, px, px);
  qrBox.hidden = false;
}

// ---------- Mapping onto the real surface (press M) ----------
// Each part (the whole picture, or each box of the Two boxes outline) gets four corners you drag
// onto the real wall. The flat picture is cut into parts and each part is warped onto its corners
// with a perspective (homography) transform, so it lines up even when the projector is at an angle.
// Corners are saved per outline in this browser, as fractions of the window.
const MAP_KEY = 'inkProjector.map';
let mapParts = { sig: 'whole', parts: [{ id: 'whole', name: 'Picture', x: 0, y: 0, w: 1, h: 1 }] };
let mapping = {};
try { mapping = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; } catch {}
let mapMode = false;
let drag = null;      // { id, corner (0..3) or -1 for the whole part, start, orig }
let selected = null;  // { id, corner } nudged by the arrow keys
const layer = document.createElement('div');
layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden';
document.body.insertBefore(layer, canvas.nextSibling);
const ui = document.createElement('canvas');
ui.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:none;cursor:default';
document.body.append(ui);
const uictx = ui.getContext('2d');
const pieces = new Map(); // part id -> { cv, cx, tf }

function saveMapping() { try { localStorage.setItem(MAP_KEY, JSON.stringify(mapping)); } catch {} }
const vw = () => window.innerWidth || 640, vh = () => window.innerHeight || 360;

// A part's flat rectangle on screen (CSS pixels)
function flatRect(p) {
  const k = vw() / W;
  return { x: (layout.ox + p.x * layout.w) * k, y: (layout.oy + p.y * layout.h) * k, w: p.w * layout.w * k, h: p.h * layout.h * k };
}
function defaultQuad(p) {
  const r = flatRect(p), X = vw(), Y = vh();
  return [[r.x / X, r.y / Y], [(r.x + r.w) / X, r.y / Y], [(r.x + r.w) / X, (r.y + r.h) / Y], [r.x / X, (r.y + r.h) / Y]];
}
const saved = () => mapping[mapParts.sig] || null;
// Parts that carry their own corners are mapped on the operator page; here M only shows guides.
const managed = () => mapParts.parts.some((p) => p.quad);
let opGuides = false; // operator's "Show guides on the wall"
const showGuides = () => mapMode || opGuides;
const quadOf = (p) => p.quad || (saved() && saved()[p.id]) || defaultQuad(p);
const isMapped = () => !PREVIEW && (showGuides() || managed() || (saved() && Object.keys(saved()).length > 0));

function setParts(sig, parts, guides) {
  if (!parts || !parts.length) return;
  mapParts = { sig, parts };
  opGuides = !!guides;
  updateUi();
  for (const [id, pc] of pieces) if (!parts.some((p) => p.id === id)) { pc.cv.remove(); pieces.delete(id); }
}

function presentMapped() {
  const on = isMapped();
  canvas.style.visibility = on ? 'hidden' : 'visible';
  layer.style.display = on ? 'block' : 'none';
  if (!on) return;
  const k = canvas.width / vw(), X = vw(), Y = vh();
  for (const p of mapParts.parts) {
    let pc = pieces.get(p.id);
    if (!pc) {
      const cv = document.createElement('canvas');
      cv.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
      layer.append(cv);
      pc = { cv, cx: cv.getContext('2d'), tf: '', size: '' };
      pieces.set(p.id, pc);
    }
    const r = flatRect(p);
    // Each part ends exactly at its corners, so parts mapped side by side don't spill onto each other
    const pad = 0;
    const ew = r.w + 2 * pad, eh = r.h + 2 * pad;
    const iw = Math.max(1, Math.round(ew * k)), ih = Math.max(1, Math.round(eh * k));
    const size = `${iw}x${ih}`;
    if (pc.size !== size) {
      pc.cv.width = iw; pc.cv.height = ih;
      pc.cv.style.width = `${ew}px`; pc.cv.style.height = `${eh}px`;
      pc.size = size;
    }
    const q = quadOf(p).map(([a, b]) => [a * X, b * Y]);
    const h = solveHomography([[pad, pad], [pad + r.w, pad], [pad + r.w, pad + r.h], [pad, pad + r.h]], q);
    if (h) {
      const tf = `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
      if (tf !== pc.tf) { pc.cv.style.transform = tf; pc.tf = tf; }
    }
    pc.cx.clearRect(0, 0, iw, ih);
    pc.cx.drawImage(canvas, (r.x - pad) * k, (r.y - pad) * k, iw, ih, 0, 0, iw, ih);
    if (showGuides()) {
      // The part's border and a grid, warped with it, so you can line it up with the wall
      const c = pc.cx, x0 = pad * k, y0 = pad * k, w = r.w * k, hh = r.h * k;
      c.strokeStyle = 'rgba(255, 210, 122, 0.35)';
      c.lineWidth = Math.max(1, k);
      for (let i = 1; i < 4; i++) {
        c.beginPath(); c.moveTo(x0 + (w * i) / 4, y0); c.lineTo(x0 + (w * i) / 4, y0 + hh); c.stroke();
        c.beginPath(); c.moveTo(x0, y0 + (hh * i) / 4); c.lineTo(x0 + w, y0 + (hh * i) / 4); c.stroke();
      }
      c.strokeStyle = '#ffd27a';
      const lw = Math.max(2, 3 * k);
      c.lineWidth = lw;
      c.strokeRect(x0 + lw / 2, y0 + lw / 2, w - lw, hh - lw); // just inside the edge
    }
  }
  if (showGuides()) drawHandles();
}

function updateUi() {
  if (PREVIEW) { ui.style.display = 'none'; return; }
  ui.style.display = showGuides() ? 'block' : 'none';
  ui.style.pointerEvents = mapMode && !managed() ? 'auto' : 'none'; // drag here only when not mapped on the laptop
}

const LETTERS = ['A', 'B', 'C', 'D'];
function drawHandles() {
  const dpr = canvas.width / vw(), X = vw(), Y = vh();
  if (ui.width !== canvas.width || ui.height !== canvas.height) { ui.width = canvas.width; ui.height = canvas.height; }
  const c = uictx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, X, Y);
  c.font = '600 14px -apple-system, BlinkMacSystemFont, sans-serif';
  for (const p of mapParts.parts) {
    const q = quadOf(p).map(([a, b]) => [a * X, b * Y]);
    q.forEach(([x, y], i) => {
      const sel = selected && selected.id === p.id && selected.corner === i;
      c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2);
      c.lineWidth = 2; c.strokeStyle = sel ? '#fff' : '#ffd27a'; c.stroke();
      c.beginPath(); c.arc(x, y, 2.5, 0, Math.PI * 2); c.fillStyle = sel ? '#fff' : '#ffd27a'; c.fill();
      c.fillText(i === 0 && mapParts.parts.length > 1 ? `A · ${p.name}` : LETTERS[i], x + 16, y - 14);
    });
  }
}

function hitTest(mx, my) {
  const X = vw(), Y = vh();
  let best = null, bd = 30;
  for (const p of mapParts.parts) {
    quadOf(p).forEach(([a, b], i) => {
      const d = Math.hypot(a * X - mx, b * Y - my);
      if (d < bd) { bd = d; best = { id: p.id, corner: i }; }
    });
  }
  if (best) return best;
  // Inside a part: drag the whole part
  for (const p of mapParts.parts) {
    const q = quadOf(p).map(([a, b]) => [a * X, b * Y]);
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > my) !== (yj > my) && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return { id: p.id, corner: -1 };
  }
  return null;
}

function editableQuads() {
  // Start from the current corners of every part, so moving one doesn't reset the others
  const m = {};
  for (const p of mapParts.parts) m[p.id] = quadOf(p).map((c) => c.slice());
  mapping[mapParts.sig] = m;
  return m;
}

ui.addEventListener('pointerdown', (e) => {
  const hit = hitTest(e.clientX, e.clientY);
  selected = hit && hit.corner >= 0 ? hit : selected;
  if (!hit) return;
  ui.setPointerCapture(e.pointerId);
  const m = editableQuads();
  drag = { ...hit, sx: e.clientX, sy: e.clientY, orig: m[hit.id].map((c) => c.slice()) };
});
ui.addEventListener('pointermove', (e) => {
  if (!drag) {
    const hit = hitTest(e.clientX, e.clientY);
    ui.style.cursor = hit ? (hit.corner >= 0 ? 'grab' : 'move') : 'default';
    return;
  }
  const dx = (e.clientX - drag.sx) / vw(), dy = (e.clientY - drag.sy) / vh();
  const q = mapping[mapParts.sig][drag.id];
  drag.orig.forEach(([a, b], i) => {
    if (drag.corner === -1 || drag.corner === i) q[i] = [a + dx, b + dy];
  });
});
ui.addEventListener('pointerup', () => { if (drag) { drag = null; saveMapping(); } });

function setMapMode(on) {
  mapMode = on;
  updateUi();
  if (!on) { selected = null; drag = null; }
  hint.textContent = on
    ? managed()
      ? 'Guides on. These shapes are mapped on the operator page (Map the shapes onto the wall). M hides the guides.'
      : 'Mapping: drag the yellow corners onto the real surface (drag inside to move it). Arrow keys nudge the picked corner. R resets. M when done.'
    : 'Drag this window to the projector, then press F for full screen. M lines it up with the wall.';
  hint.classList.toggle('gone', !on);
}

function mapKey(e) {
  if (PREVIEW) return false;
  if (e.code === 'KeyM') { setMapMode(!mapMode); return true; }
  if (!mapMode) return false;
  if (e.code === 'KeyR' && !managed()) {
    delete mapping[mapParts.sig];
    saveMapping();
    selected = null;
    return true;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.code] && selected && !managed()) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const m = editableQuads();
    const q = m[selected.id];
    if (q) {
      q[selected.corner] = [q[selected.corner][0] + (arrows[e.code][0] * step) / vw(), q[selected.corner][1] + (arrows[e.code][1] * step) / vh()];
      saveMapping();
    }
    return true;
  }
  return false;
}

// ---------- Drawing straight onto the projected boxes ----------
// With the mouse (or a pen tablet) on this window, a stroke that starts inside one of the mapped
// parts is turned back into flat drawing-pad coordinates through that part's corners and sent to
// the operator, which paints it with the chosen brush and keeps it inside the part, like the pad.
// A stroke started outside every part draws nothing.
function applyH(h, x, y) {
  const d = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}
const brushSound = createBrushSound(); // the sound of drawing, played from the projector laptop
let pen = null; // { h } inverse homography of the part the stroke started in

function partUnder(mx, my) {
  const X = vw(), Y = vh();
  for (const p of mapParts.parts) {
    const q = quadOf(p).map(([a, b]) => [a * X, b * Y]);
    let inside = false;
    for (let i = 0, j = 3; i < 4; j = i++) {
      const [xi, yi] = q[i], [xj, yj] = q[j];
      if ((yi > my) !== (yj > my) && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (!inside) continue;
    const r = flatRect(p);
    const h = solveHomography(q, [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);
    if (h) return h;
  }
  return null;
}
function penMsg(phase, e) {
  const [fx, fy] = applyH(pen.h, e.clientX, e.clientY);
  const k = W / vw();
  CH.postMessage({
    type: 'draw', phase,
    u: (fx * k - layout.ox) / layout.w, v: (fy * k - layout.oy) / layout.h,
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0,
  });
}
window.addEventListener('pointerdown', (e) => {
  if (PREVIEW || mapMode || e.button !== 0 || e.target.closest('.qr')) return;
  const h = partUnder(e.clientX, e.clientY);
  if (!h) return;
  pen = { h };
  try { document.body.setPointerCapture(e.pointerId); } catch {}
  penMsg('down', e);
  brushSound.volume(S.drawSound ?? 0.6);
  brushSound.begin(e.clientX, e.clientY, { brush: S.padBrush, size: S.padSize, area: { left: 0, width: vw() }, time: e.timeStamp });
});
window.addEventListener('pointermove', (e) => {
  if (!pen) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of evs.length ? evs : [e]) {
    penMsg('move', ev);
    brushSound.move(ev.clientX, ev.clientY, ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0, ev.timeStamp);
  }
});
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, () => {
  if (pen) { CH.postMessage({ type: 'draw', phase: 'up' }); brushSound.end(); }
  pen = null;
});
