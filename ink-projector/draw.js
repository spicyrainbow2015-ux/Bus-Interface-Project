// Phone page for live drawing: shows the shapes the operator mapped onto the wall, the visitor taps
// one and draws in it with the same brushes as the operator's pad. Each stroke is sent in small
// pieces while it's being drawn, and the operator replays it on the wall about a second later.
// Visitors switch boxes by swiping (one finger off the drawing, or two fingers on it), with the
// arrows, the dots, or by tapping a box on the mini map of the wall.
import { BRUSHES, createStroke } from './brushes.js';
import { createBrushSound } from './brushsound.js?v=3';
import { solveHomography } from './vision.js';

const $ = (id) => document.getElementById(id);
const API = '/api/ink';
const COLORS = ['#17171d', '#e03131', '#e8590c', '#f2c200', '#2b8a3e', '#15aabf', '#1c4fd8', '#7048e8', '#c2255c', '#f06595'];
const SHAPE_COLORS = ['#ffd27a', '#7ad7ff', '#ff9ec7', '#9effa8', '#c9a7ff', '#ffb27a', '#7affe4', '#ff7a7a'];
const SCALE = 2;      // phone canvas pixels per drawing-pad pixel
const SEND_MS = 120;  // how often stroke pieces are sent
const GRACE = 150;    // ms before a stroke is sent, so a second finger can still turn it into a swipe

let shapes = [], screen = 16 / 9, shape = null;
let order = [];       // shapes from left to right on the wall: the swipe order
let brush = 'pen', color = COLORS[6], mix = 0.35;
let soundOn = true;
// This phone's id, so its Clear and eraser only touch its own lines on the wall
let vid = '';
try { vid = localStorage.getItem('inkDraw.vid') || ''; } catch {}
if (!vid) {
  vid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  try { localStorage.setItem('inkDraw.vid', vid); } catch {}
}
const ERASER_SCALE = 2.5; // the eraser is wider than the brush at the same size
const sound = createBrushSound();
sound.volume(0.35);

function show(step) {
  $('stepMap').hidden = step !== 'map';
  $('stepDraw').hidden = step !== 'draw';
  window.scrollTo(0, 0);
}

const colorOf = (sh) => SHAPE_COLORS[Math.max(0, shapes.indexOf(sh)) % SHAPE_COLORS.length];
const nameOf = (sh) => sh.name || `Shape ${shapes.indexOf(sh) + 1}`;
const centre = (q) => [q.reduce((a, p) => a + p[0], 0) / 4, q.reduce((a, p) => a + p[1], 0) / 4];
function inQuad(q, u, v) {
  let inside = false;
  for (let a = 0, b = 3; a < 4; b = a++) {
    const [xa, ya] = q[a], [xb, yb] = q[b];
    if ((ya > v) !== (yb > v) && u < ((xb - xa) * (v - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
function shapeAt(u, v) {
  for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].quad && inQuad(shapes[i].quad, u, v)) return shapes[i];
  return null;
}

// ---------- Sound on phones ----------
// Phones only let a page start sound when a finger lifts (not when it touches down), so unlock it on
// every tap until it's running. Older iPhones also mute web sound on silent unless a media element
// is playing, so a silent loop keeps it audible there.
let keepAlive = null;
function silentWavUrl() {
  const n = 4000, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function unlockAudio() {
  if (!soundOn) return;
  sound.unlock();
  const iPhone = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iPhone && !navigator.audioSession && !keepAlive) {
    keepAlive = new Audio(silentWavUrl());
    keepAlive.loop = true;
    keepAlive.setAttribute('playsinline', '');
    keepAlive.play().catch(() => { keepAlive = null; });
  }
}
for (const t of ['touchend', 'pointerup', 'click', 'keydown']) window.addEventListener(t, unlockAudio, { capture: true, passive: true });

// ---------- 1. The map ----------
async function loadShapes() {
  let st;
  try {
    const r = await fetch(`${API}?op=state`, { cache: 'no-store' });
    st = await r.json();
  } catch {
    if (!shape) { shapes = null; renderMap(); }
    return;
  }
  shapes = st.shapes || [];
  screen = st.screen || 16 / 9;
  order = shapes.filter((s) => s.quad).sort((a, b) => {
    const ca = centre(a.quad), cb = centre(b.quad);
    return ca[0] - cb[0] || ca[1] - cb[1];
  });
  if (!shape) { renderMap(); setMode(); return; }
  // While drawing: follow the operator's changes
  const same = shapes.find((s) => s.id === shape.id);
  if (!same) { leaveDrawing('That shape was removed. Pick another one.'); return; }
  if (same.tw !== shape.tw || same.th !== shape.th) { store.delete(same.id); shape = null; openShape(same); return; }
  shape = same;
  updateLabel();
  setMode();
}

function renderMap() {
  const msg = $('mapMsg'), btns = $('shapeBtns');
  btns.innerHTML = '';
  if (shapes === null) { msg.className = 'msg err'; msg.textContent = "Couldn't reach the wall. Check your connection and reload."; drawMap(); return; }
  if (!shapes.length) { msg.className = 'msg'; msg.textContent = 'Nothing to draw on yet. Check back in a moment.'; drawMap(); return; }
  msg.textContent = '';
  for (const sh of order) {
    const b = document.createElement('button');
    b.innerHTML = `<i style="background:${colorOf(sh)}"></i>`;
    b.append(nameOf(sh));
    b.addEventListener('click', () => openShape(sh));
    btns.append(b);
  }
  drawMap();
}

function drawMap() {
  const cv = $('mapCv');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320, h = w / screen;
  cv.style.height = `${h}px`;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#07080a';
  c.fillRect(0, 0, w, h);
  c.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
  c.textAlign = 'center';
  for (const sh of shapes || []) {
    if (!sh.quad) continue;
    const col = colorOf(sh);
    const q = sh.quad.map(([x, y]) => [x * w, y * h]);
    c.beginPath();
    q.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.globalAlpha = 0.22; c.fillStyle = col; c.fill();
    c.globalAlpha = 1; c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    const [cx, cy] = centre(q);
    c.fillStyle = '#fff';
    c.fillText(sh.name || '', cx, cy + 4);
  }
}

$('mapCv').addEventListener('click', (e) => {
  if (!shapes || !shapes.length) return;
  const r = e.currentTarget.getBoundingClientRect();
  const sh = shapeAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  if (sh) openShape(sh);
});

// Keep the shapes current (the operator may adjust them on site): often on the map, now and then while drawing
let tick = 0;
setInterval(() => { if (!$('stepMap').hidden || ++tick % 3 === 0) loadShapes(); }, 5000);
window.addEventListener('resize', () => { drawMap(); setMode(); if (shape && !wallMode) { sizeCanvas(); drawMini(); } });

// ---------- 2. Drawing ----------
const cv = $('drawCv');
const ctx = cv.getContext('2d');
const store = new Map();                       // shape id -> what this phone drew there
const backup = document.createElement('canvas'); // the drawing before the current stroke
let firstOpen = true;

function openShape(sh, dir = 0) {
  if (stroke) endStroke();
  if (shape) saveCanvas();
  shape = sh;
  cv.width = Math.max(2, Math.round(sh.tw * SCALE));
  cv.height = Math.max(2, Math.round(sh.th * SCALE));
  ctx.clearRect(0, 0, cv.width, cv.height);
  const kept = store.get(sh.id);
  if (kept && kept.width === cv.width && kept.height === cv.height) ctx.drawImage(kept, 0, 0);
  if ($('stepDraw').hidden) show('draw');
  sizeCanvas();
  updateLabel();
  if (wallMode) { layoutWall(); dir = 0; }
  if (dir && cv.animate) {
    cv.animate([{ transform: `translateX(${dir * 48}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }
  if (firstOpen) {
    setLive(order.length > 1
      ? (wallMode ? 'Draw on any box. It shows up on the wall in about a second.' : 'Draw inside the box. It shows up on the wall in about a second. Swipe left or right for the other boxes.')
      : 'Draw inside the box. It shows up on the wall in about a second.');
    firstOpen = false;
  } else {
    setLive(`Now drawing on ${nameOf(sh)}.`);
  }
}
function saveCanvas() {
  let c = store.get(shape.id);
  if (!c || c.width !== cv.width || c.height !== cv.height) {
    c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    store.set(shape.id, c);
  }
  const x = c.getContext('2d');
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(cv, 0, 0);
}
function leaveDrawing(text) {
  if (stroke) endStroke();
  shape = null;
  show('map');
  renderMap();
  if (text) { $('mapMsg').className = 'msg'; $('mapMsg').textContent = text; }
}
function sizeCanvas() {
  const maxW = $('stagebox').clientWidth || window.innerWidth - 32;
  const maxH = Math.max(200, window.innerHeight * 0.55);
  const a = shape.tw / shape.th;
  let w = maxW, h = w / a;
  if (h > maxH) { h = maxH; w = h * a; }
  cv.style.width = `${Math.floor(w)}px`;
  cv.style.height = `${Math.floor(h)}px`;
}

// Moving between boxes
function step(delta) {
  if (!shape || order.length < 2) return;
  const i = Math.max(0, order.findIndex((s) => s.id === shape.id));
  openShape(order[(i + delta + order.length) % order.length], delta);
}
function goTo(sh) {
  if (!shape || sh.id === shape.id) return;
  const from = order.findIndex((s) => s.id === shape.id), to = order.findIndex((s) => s.id === sh.id);
  openShape(sh, to > from ? 1 : -1);
}
$('btnPrev').addEventListener('click', () => step(-1));
$('btnNext').addEventListener('click', () => step(1));

function updateLabel() {
  const i = order.findIndex((s) => s.id === shape.id);
  $('shapeName').textContent = nameOf(shape);
  $('shapeDot').style.background = colorOf(shape);
  $('shapePos').textContent = order.length > 1 ? `${i + 1} of ${order.length}` : '';
  $('toolsHead').querySelector('span').textContent = nameOf(shape);
  $('toolsHead').querySelector('i').style.background = colorOf(shape);
  $('btnPrev').disabled = $('btnNext').disabled = order.length < 2;
  const dots = $('dots');
  dots.innerHTML = '';
  if (order.length > 1) {
    for (const sh of order) {
      const b = document.createElement('button');
      b.style.background = colorOf(sh);
      b.className = sh.id === shape.id ? 'on' : '';
      b.setAttribute('aria-label', `Draw on ${nameOf(sh)}`);
      b.addEventListener('click', () => goTo(sh));
      dots.append(b);
    }
  }
  drawMini();
}

// The mini map of the wall, with the box being drawn on lit up
let mini = { ox: 0, w: 1, h: 1 };
function drawMini() {
  const mc = $('miniCv');
  const dpr = window.devicePixelRatio || 1;
  const W = mc.clientWidth || 240, H = mc.clientHeight || 64;
  mc.width = Math.round(W * dpr); mc.height = Math.round(H * dpr);
  const c = mc.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const h = Math.min(H, W / screen), w = h * screen, ox = (W - w) / 2, oy = (H - h) / 2;
  mini = { ox, oy, w, h };
  c.fillStyle = '#07080a';
  c.fillRect(ox, oy, w, h);
  for (const sh of shapes || []) {
    if (!sh.quad) continue;
    const on = shape && sh.id === shape.id, col = colorOf(sh);
    const q = sh.quad.map(([x, y]) => [ox + x * w, oy + y * h]);
    c.beginPath();
    q.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.globalAlpha = on ? 0.75 : 0.14; c.fillStyle = col; c.fill();
    c.globalAlpha = on ? 1 : 0.5; c.strokeStyle = on ? '#fff' : col; c.lineWidth = on ? 2 : 1; c.stroke();
  }
  c.globalAlpha = 1;
}
$('miniCv').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const sh = shapeAt((e.clientX - r.left - mini.ox) / mini.w, (e.clientY - r.top - mini.oy) / mini.h);
  if (sh) goTo(sh);
});

// One-finger swipe anywhere except the drawing and the brush row (which scrolls sideways)
let swipe = null;
$('stepDraw').addEventListener('touchstart', (e) => {
  swipe = null;
  if (wallMode || e.touches.length !== 1 || e.target.closest('#drawCv, .brushes, input')) return;
  swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
$('stepDraw').addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
}, { passive: true });

$('btnSound').addEventListener('click', () => {
  soundOn = !soundOn;
  sound.volume(soundOn ? 0.35 : 0);
  $('btnSound').textContent = soundOn ? '🔊' : '🔇';
});

// Tools
function renderTools() {
  $('brushes').innerHTML = BRUSHES.map((b) => `<button data-brush="${b.id}" class="${b.id === brush ? 'on' : ''}">${b.label}</button>`).join('');
  $('btnEraser').classList.toggle('on', brush === 'eraser');
  $('swatches').innerHTML = COLORS.map((c) => `<button class="swatch${c === color ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
}
$('btnEraser').addEventListener('click', () => { brush = brush === 'eraser' ? lastBrush : 'eraser'; renderTools(); });
let lastBrush = 'pen';
$('brushes').addEventListener('click', (e) => { const id = e.target.dataset.brush; if (id) { brush = lastBrush = id; renderTools(); } });
$('swatches').addEventListener('click', (e) => { const c = e.target.dataset.color; if (c) { color = c; if (brush === 'eraser') brush = lastBrush; renderTools(); } });

// Clear: tap twice (so it isn't hit by accident). Wipes this box here and this phone's lines in it on the wall.
let clearArmed = 0;
$('btnClear').addEventListener('click', () => {
  if (!shape) return;
  if (!clearArmed) {
    $('btnClear').classList.add('armed');
    $('btnClear').textContent = 'Tap again to clear';
    clearArmed = setTimeout(disarmClear, 3000);
    return;
  }
  disarmClear();
  if (stroke) cancelStroke();
  ctx.clearRect(0, 0, cv.width, cv.height);
  store.delete(shape.id);
  outbox.push({ shape: shape.id, vid, sid: `c-${Date.now().toString(36)}`, clear: true });
  flush();
  setLive('Cleared. Your lines in this box are fading off the wall.');
});
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = 0;
  $('btnClear').classList.remove('armed');
  $('btnClear').textContent = 'Clear';
}
renderTools();

function paintMarks(c, s, marks, erase = false) {
  c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  c.lineCap = 'round';
  for (const m of marks) {
    if (m.t === 'd') {
      c.fillStyle = m.c;
      c.beginPath(); c.arc(m.x * s, m.y * s, m.r * s, 0, Math.PI * 2); c.fill();
    } else if (m.t === 'p') {
      c.fillStyle = m.c;
      c.beginPath();
      m.pts.forEach(([px, py], k) => (k ? c.lineTo(px * s, py * s) : c.moveTo(px * s, py * s)));
      c.closePath(); c.fill();
    } else {
      c.strokeStyle = m.c; c.lineWidth = m.w * s;
      c.beginPath(); c.moveTo(m.x1 * s, m.y1 * s); c.lineTo(m.x2 * s, m.y2 * s); c.stroke();
    }
  }
  c.globalCompositeOperation = 'source-over';
}

// One stroke at a time; pieces go out in order, one request at a time
let stroke = null;   // { id, sid, obj, t0, pts, size, sent }
const outbox = [];   // pieces waiting to be sent
let sending = false;
const fingers = new Map(); // pointers down on the drawing -> { x0, x }
let twoFinger = null;      // { done } while two fingers swipe on the drawing

function padPoint(e) {
  if (wallMode && penH) {
    const r = wallIn.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, h = penH;
    const d = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  }
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * shape.tw, ((e.clientY - r.top) / r.height) * shape.th];
}
const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0);

function penDown(e) {
  if (!shape || (wallMode !== (e.currentTarget === wallIn))) return; // in wall mode the wall handles it
  e.preventDefault();
  if (wallMode) {
    // One finger at a time; the stroke goes into the box it starts in, through that box's corners
    if (stroke || fingers.size) return;
    const r = wallIn.getBoundingClientRect();
    const sh = shapeAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (!sh) return;
    if (sh.id !== shape.id) openShape(sh);
    penH = solveHomography(sh.quad.map(([a, b]) => [a * r.width, b * r.height]), [[0, 0], [sh.tw, 0], [sh.tw, sh.th], [0, sh.th]]);
    if (!penH) return;
  }
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  fingers.set(e.pointerId, { x0: e.clientX, x: e.clientX });
  if (wallMode && fingers.size >= 2) return;
  if (fingers.size >= 2) {
    // A second finger: swipe to another box. A stroke that only just started is taken back.
    if (stroke && !stroke.sent && performance.now() - stroke.t0 < GRACE) cancelStroke();
    if (!stroke && !twoFinger) twoFinger = { done: false };
    return;
  }
  if (stroke || twoFinger) return;
  const erase = brush === 'eraser';
  const size = erase ? Math.min(60, Math.round(+$('size').value * ERASER_SCALE)) : +$('size').value;
  if (backup.width !== cv.width || backup.height !== cv.height) { backup.width = cv.width; backup.height = cv.height; }
  const bx = backup.getContext('2d');
  bx.clearRect(0, 0, backup.width, backup.height);
  bx.drawImage(cv, 0, 0);
  stroke = { id: e.pointerId, sid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, brush,
    obj: createStroke(erase ? { brush: 'pen', size, color: '#000000', mix: 0 } : { brush, size, color, mix }), t0: performance.now(), pts: [], size, sent: false };
  const p = padPoint(e);
  paintMarks(ctx, SCALE, stroke.obj.begin(p, pressureOf(e)), erase);
  addPoint(p, e);
  const r = (wallMode ? wallIn : cv).getBoundingClientRect();
  if (soundOn) sound.begin(e.clientX, e.clientY, { brush, size, area: { left: r.left, width: r.width }, time: e.timeStamp });
}
function penMove(e) {
  if (wallMode !== (e.currentTarget === wallIn)) return;
  const f = fingers.get(e.pointerId);
  if (f) f.x = e.clientX;
  if (!stroke || e.pointerId !== stroke.id) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of evs.length ? evs : [e]) {
    const p = padPoint(ev);
    paintMarks(ctx, SCALE, stroke.obj.move(p, pressureOf(ev)), stroke.brush === 'eraser');
    addPoint(p, ev);
    if (soundOn) sound.move(ev.clientX, ev.clientY, pressureOf(ev), ev.timeStamp);
  }
}
function fingerUp(e) {
  if (wallMode !== (e.currentTarget === wallIn) || !fingers.has(e.pointerId)) return;
  if (twoFinger && !twoFinger.done && fingers.size >= 2) {
    // Decide the swipe when the first finger lifts: the average sideways travel of both fingers
    const all = [...fingers.values()];
    const dx = all.reduce((a, f) => a + (f.x - f.x0), 0) / all.length;
    twoFinger.done = true;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
  }
  fingers.delete(e.pointerId);
  if (!fingers.size) twoFinger = null;
  endStroke(e);
}
const wallIn = $('wallIn');
for (const el of [cv, wallIn]) {
  el.addEventListener('pointerdown', penDown);
  el.addEventListener('pointermove', penMove);
  el.addEventListener('pointerup', fingerUp);
  el.addEventListener('pointercancel', fingerUp);
}
let penH = null; // wall mode: from the wall view onto the box being drawn in

// ---------- Phone held sideways: the whole wall ----------
// Every box is shown where it's mapped and skewed the same way, and you draw straight on any of them.
// The box being drawn on uses the drawing canvas itself; the others show what was drawn there.
const landscape = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
let wallMode = false;
const wallItems = new Map(); // shape id -> { el, label }

function setMode() {
  const want = landscape.matches && Array.isArray(shapes) && order.length > 0;
  if (want === wallMode) { if (wallMode) layoutWall(); return; }
  if (stroke) endStroke();
  wallMode = want;
  document.body.classList.toggle('wallmode', wallMode);
  if (wallMode) {
    $('toolsHead').append($('btnSound'));
    if (!shape) openShape(order[0]); else layoutWall();
  } else {
    $('bar').append($('btnSound'));
    for (const [, it] of wallItems) { if (it.el !== cv) it.el.remove(); it.label.remove(); }
    wallItems.clear();
    cv.classList.remove('in-wall');
    cv.style.transform = ''; cv.style.boxShadow = '';
    $('stagebox').append(cv);
    if (shape) { sizeCanvas(); updateLabel(); }
  }
}
if (landscape.addEventListener) landscape.addEventListener('change', setMode); else landscape.addListener(setMode);

function canvasFor(sh) {
  const w = Math.max(2, Math.round(sh.tw * SCALE)), h = Math.max(2, Math.round(sh.th * SCALE));
  let c = store.get(sh.id);
  if (!c || c.width !== w || c.height !== h) {
    c = document.createElement('canvas');
    c.width = w; c.height = h;
    store.set(sh.id, c);
  }
  return c;
}

function layoutWall() {
  if (!wallMode || !shape) return;
  const maxW = $('wallBox').clientWidth || window.innerWidth - 260, maxH = window.innerHeight - 20;
  let W = maxW, H = W / screen;
  if (H > maxH) { H = maxH; W = H * screen; }
  wallIn.style.width = `${Math.floor(W)}px`;
  wallIn.style.height = `${Math.floor(H)}px`;
  const live = new Set();
  for (const sh of shapes) {
    if (!sh.quad) continue;
    live.add(sh.id);
    let it = wallItems.get(sh.id);
    if (!it) {
      const label = document.createElement('span');
      label.className = 'wall-label';
      wallIn.append(label);
      it = { el: null, label };
      wallItems.set(sh.id, it);
    }
    const on = sh.id === shape.id;
    const el = on ? cv : canvasFor(sh);
    if (it.el !== el) {
      if (it.el && it.el !== cv) it.el.remove();
      it.el = el;
    }
    el.classList.add('in-wall');
    wallIn.insertBefore(el, it.label);
    el.style.width = `${el.width}px`;
    el.style.height = `${el.height}px`;
    const q = sh.quad.map(([a, b]) => [a * W, b * H]);
    const h = solveHomography([[0, 0], [el.width, 0], [el.width, el.height], [0, el.height]], q);
    if (h) el.style.transform = `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
    // An outline in the box's colour (thicker on the one being drawn on), the same width on screen whatever the size
    const k = Math.max(0.01, Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) / el.width);
    el.style.boxShadow = `0 0 0 ${(on ? 3 : 1.5) / k}px ${on ? '#fff' : colorOf(sh)}`;
    el.style.opacity = on ? '1' : '0.85';
    const cx = q.reduce((a, v) => a + v[0], 0) / 4, top = Math.min(...q.map((v) => v[1]));
    it.label.textContent = nameOf(sh);
    it.label.className = `wall-label${on ? ' on' : ''}`;
    it.label.style.color = on ? '#fff' : colorOf(sh);
    it.label.style.left = `${cx}px`;
    it.label.style.top = `${Math.max(14, top)}px`;
  }
  for (const [id, it] of wallItems) if (!live.has(id)) { if (it.el !== cv) it.el.remove(); it.label.remove(); wallItems.delete(id); }
}

function cancelStroke() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(backup, 0, 0);
  stroke = null;
  sound.end();
}
function endStroke(e) {
  if (!stroke || (e && e.pointerId !== stroke.id)) return;
  queuePiece(true);
  stroke = null;
  sound.end();
}

function addPoint([x, y], e) {
  stroke.pts.push([x / shape.tw, y / shape.th, pressureOf(e), Math.round(performance.now() - stroke.t0)]);
}
function queuePiece(end) {
  if (!stroke || (!stroke.pts.length && !end)) return;
  if (!end && !stroke.sent && performance.now() - stroke.t0 < GRACE) return; // could still become a swipe
  stroke.sent = true;
  outbox.push({ shape: shape.id, vid, sid: stroke.sid, brush: stroke.brush, size: stroke.size, color, mix, pts: stroke.pts.splice(0), end: !!end });
  flush();
}
setInterval(() => queuePiece(false), SEND_MS);

async function flush() {
  if (sending || !outbox.length) return;
  sending = true;
  // Merge waiting pieces of the same stroke so a slow connection doesn't fall behind
  const piece = outbox.shift();
  while (outbox.length && outbox[0].sid === piece.sid && piece.pts.length + outbox[0].pts.length < 500) {
    const nx = outbox.shift();
    piece.pts.push(...nx.pts);
    piece.end = piece.end || nx.end;
  }
  try {
    const r = await fetch(`${API}?op=stroke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(piece) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setLive(j.error || "Couldn't send that. Try again.", true);
      if (r.status === 400 && /gone/.test(j.error || '')) { outbox.length = 0; setTimeout(() => { store.delete(piece.shape); leaveDrawing('That shape was removed. Pick another one.'); loadShapes(); }, 1500); }
    } else if (piece.end && piece.brush !== 'eraser') {
      setLive('On the wall ✓ Keep drawing.');
    }
  } catch {
    setLive('No connection. Your drawing isn\'t reaching the wall.', true);
  } finally {
    sending = false;
    if (outbox.length) flush();
  }
}

function setLive(t, err = false) {
  const el = $('live');
  el.textContent = t;
  el.className = err ? 'live err' : 'live';
}

loadShapes();
