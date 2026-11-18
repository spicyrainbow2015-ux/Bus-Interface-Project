// Phone page for live drawing: shows the shapes the operator mapped onto the wall, the visitor taps
// one and draws in it with the same brushes as the operator's pad. Each stroke is sent in small
// pieces while it's being drawn, and the operator replays it on the wall about a second later.
import { BRUSHES, createStroke } from './brushes.js';
import { createBrushSound } from './brushsound.js';

const $ = (id) => document.getElementById(id);
const API = '/api/ink';
const COLORS = ['#17171d', '#e03131', '#e8590c', '#f2c200', '#2b8a3e', '#15aabf', '#1c4fd8', '#7048e8', '#c2255c', '#f06595'];
const SHAPE_COLORS = ['#ffd27a', '#7ad7ff', '#ff9ec7', '#9effa8', '#c9a7ff', '#ffb27a', '#7affe4', '#ff7a7a'];
const SCALE = 2;      // phone canvas pixels per drawing-pad pixel
const SEND_MS = 120;  // how often stroke pieces are sent

let shapes = [], screen = 16 / 9, shape = null;
let brush = 'pen', color = COLORS[6], mix = 0.35;
let soundOn = true;
const sound = createBrushSound();
sound.volume(0.55);

function show(step) {
  $('stepMap').hidden = step !== 'map';
  $('stepDraw').hidden = step !== 'draw';
  window.scrollTo(0, 0);
}

// ---------- 1. The map ----------
async function loadShapes() {
  try {
    const r = await fetch(`${API}?op=state`, { cache: 'no-store' });
    const st = await r.json();
    shapes = st.shapes || [];
    screen = st.screen || 16 / 9;
  } catch { shapes = null; }
  renderMap();
}

function renderMap() {
  const msg = $('mapMsg'), btns = $('shapeBtns');
  btns.innerHTML = '';
  if (shapes === null) { msg.className = 'msg err'; msg.textContent = "Couldn't reach the wall. Check your connection and reload."; drawMap(); return; }
  if (!shapes.length) { msg.className = 'msg'; msg.textContent = 'Nothing to draw on yet. Check back in a moment.'; drawMap(); return; }
  msg.textContent = '';
  shapes.forEach((sh, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<i style="background:${SHAPE_COLORS[i % SHAPE_COLORS.length]}"></i>`;
    b.append(sh.name || `Shape ${i + 1}`);
    b.addEventListener('click', () => pickShape(i));
    btns.append(b);
  });
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
  (shapes || []).forEach((sh, i) => {
    if (!sh.quad) return;
    const col = SHAPE_COLORS[i % SHAPE_COLORS.length];
    const q = sh.quad.map(([x, y]) => [x * w, y * h]);
    c.beginPath();
    q.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.globalAlpha = 0.22; c.fillStyle = col; c.fill();
    c.globalAlpha = 1; c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    c.fillStyle = '#fff';
    c.fillText(sh.name || '', cx, cy + 4);
  });
}

$('mapCv').addEventListener('click', (e) => {
  if (!shapes || !shapes.length) return;
  const r = e.currentTarget.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const q = shapes[i].quad;
    if (!q) continue;
    let inside = false;
    for (let a = 0, b = 3; a < 4; b = a++) {
      const [xa, ya] = q[a], [xb, yb] = q[b];
      if ((ya > v) !== (yb > v) && u < ((xb - xa) * (v - ya)) / (yb - ya) + xa) inside = !inside;
    }
    if (inside) { pickShape(i); return; }
  }
});

// Keep the map current while someone is looking at it (the operator may adjust it on site)
setInterval(() => { if (!$('stepMap').hidden) loadShapes(); }, 5000);
window.addEventListener('resize', () => { drawMap(); if (shape) sizeCanvas(); });

// ---------- 2. Drawing ----------
const cv = $('drawCv');
const ctx = cv.getContext('2d');

function pickShape(i) {
  shape = shapes[i];
  $('shapeName').textContent = shape.name || `Shape ${i + 1}`;
  $('shapeDot').style.background = SHAPE_COLORS[i % SHAPE_COLORS.length];
  cv.width = Math.max(2, Math.round(shape.tw * SCALE));
  cv.height = Math.max(2, Math.round(shape.th * SCALE));
  ctx.clearRect(0, 0, cv.width, cv.height);
  show('draw');
  sizeCanvas();
  setLive('Draw inside the box. It shows up on the wall in about a second.');
}
function sizeCanvas() {
  const maxW = $('stagebox').clientWidth || window.innerWidth - 32;
  const maxH = Math.max(200, window.innerHeight * 0.6);
  const a = shape.tw / shape.th;
  let w = maxW, h = w / a;
  if (h > maxH) { h = maxH; w = h * a; }
  cv.style.width = `${Math.floor(w)}px`;
  cv.style.height = `${Math.floor(h)}px`;
}
$('btnBack').addEventListener('click', () => { shape = null; show('map'); loadShapes(); });
$('btnSound').addEventListener('click', () => {
  soundOn = !soundOn;
  sound.volume(soundOn ? 0.55 : 0);
  $('btnSound').textContent = soundOn ? '🔊' : '🔇';
});

// Tools
function renderTools() {
  $('brushes').innerHTML = BRUSHES.map((b) => `<button data-brush="${b.id}" class="${b.id === brush ? 'on' : ''}">${b.label}</button>`).join('');
  $('swatches').innerHTML = COLORS.map((c) => `<button class="swatch${c === color ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
}
$('brushes').addEventListener('click', (e) => { const id = e.target.dataset.brush; if (id) { brush = id; renderTools(); } });
$('swatches').addEventListener('click', (e) => { const c = e.target.dataset.color; if (c) { color = c; renderTools(); } });
renderTools();

function paintMarks(c, s, marks) {
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
}

// One stroke at a time per finger; pieces go out in order, one request at a time
let stroke = null;   // { sid, obj, t0, pending: [], ended }
const outbox = [];   // pieces waiting to be sent
let sending = false;

function padPoint(e) {
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * shape.tw, ((e.clientY - r.top) / r.height) * shape.th];
}
const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0);

cv.addEventListener('pointerdown', (e) => {
  if (!shape || stroke) return;
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  const size = +$('size').value;
  stroke = { id: e.pointerId, sid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, obj: createStroke({ brush, size, color, mix }), t0: performance.now(), pts: [], size };
  const p = padPoint(e);
  paintMarks(ctx, SCALE, stroke.obj.begin(p, pressureOf(e)));
  addPoint(p, e);
  const r = cv.getBoundingClientRect();
  if (soundOn) sound.begin(e.clientX, e.clientY, { brush, size, area: { left: r.left, width: r.width }, time: e.timeStamp });
});
cv.addEventListener('pointermove', (e) => {
  if (!stroke || e.pointerId !== stroke.id) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of evs.length ? evs : [e]) {
    const p = padPoint(ev);
    paintMarks(ctx, SCALE, stroke.obj.move(p, pressureOf(ev)));
    addPoint(p, ev);
    if (soundOn) sound.move(ev.clientX, ev.clientY, pressureOf(ev), ev.timeStamp);
  }
});
function endStroke(e) {
  if (!stroke || (e && e.pointerId !== stroke.id)) return;
  queuePiece(true);
  stroke = null;
  sound.end();
}
cv.addEventListener('pointerup', endStroke);
cv.addEventListener('pointercancel', endStroke);

function addPoint([x, y], e) {
  stroke.pts.push([x / shape.tw, y / shape.th, pressureOf(e), Math.round(performance.now() - stroke.t0)]);
}
function queuePiece(end) {
  if (!stroke || (!stroke.pts.length && !end)) return;
  outbox.push({ shape: shape.id, sid: stroke.sid, brush, size: stroke.size, color, mix, pts: stroke.pts.splice(0), end: !!end });
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
      if (r.status === 400 && /gone/.test(j.error || '')) { outbox.length = 0; setTimeout(() => { show('map'); loadShapes(); }, 1500); }
    } else if (piece.end) {
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
