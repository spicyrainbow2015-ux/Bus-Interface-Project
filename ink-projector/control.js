import { detectPaper, warpQuad, extractInk, makeInkBuffers, outlineFromImage, solveHomography } from './vision.js';
import { createSim } from './sim.js';
import { BRUSHES, createStroke } from './brushes.js';
import { createBrushSound } from './brushsound.js';

const $ = (id) => document.getElementById(id);
const CH = new BroadcastChannel('ink-projector-v1');
const STORE_KEY = 'inkProjector.settings';

const DEFAULTS = {
  source: 'sim', mirror: false, paper: 'a4', rotation: 0,
  outlineOn: false, outlineSrc: 'door', outlineMode: 'photo', outlineDetail: 0.4,
  drawLimit: 'shape', guideOpacity: 0.55, outlineOut: true, outlineGlow: 0.45,
  padColor: '#17171d', padSize: 6, padBrush: 'pen', padMix: 0.35, drawSound: 0.6, mapGuides: false,
  threshold: 0.38, hold: 0.4, margin: 0.03, density: 0.7, ignoreSkin: true, waitStill: true,
  colorMode: 'ink', motion: 0.5, wisps: 0.3, glow: 0.6, trails: 0.55, brightness: 0.8, pulse: 0.4,
  fade: 3, size: '1', showFrame: false, showQr: true, autoApprove: true, drawTime: 4, partFit: 'fill',
  camCapture: 'live', sheetTurn: 6, sheetClearAfter: 30,
};
const OUTPUT_KEYS = ['colorMode', 'motion', 'wisps', 'glow', 'pulse', 'trails', 'brightness', 'fade', 'size', 'showFrame', 'outlineGlow', 'padBrush', 'padSize', 'drawSound', 'sheetTurn'];
const OUTLINE_KEYS = ['outlineOn', 'outlineSrc', 'outlineMode', 'outlineDetail'];
const PAPER_RATIO = { a4: 1.4142, letter: 1.2941, square: 1 };
const LONG_SIDE = 480;
const PHOTO_LONG_SIDE = 800; // photo submissions get more detail, since each fills only part of the doorway
const isPad = () => S.source === 'draw' || S.source === 'photos' || S.source === 'phones';
const drawsLive = () => S.source === 'draw' || S.source === 'phones'; // strokes are drawn as they happen
const sheetMode = () => !isPad() && S.camCapture === 'sheet'; // paper: capture the whole sheet once it's placed
const MAX_POINTS = 140000;

let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch {}
if (!S.doorwayIntroduced) { S.outlineSrc = 'door'; S.outlineOn = true; S.doorwayIntroduced = true; }
if (S.padBrush === 'dots') S.padBrush = 'spray'; // Dots brush was folded into Spray
if (S.outlineSrc === 'boxes') S.outlineSrc = 'shapes'; // Two boxes became editable shapes
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} }

// ---------- Elements ----------
const video = $('video');
const cam = $('cam'), camCtx = cam.getContext('2d');
const paperCv = $('paper'), paperCtx = paperCv.getContext('2d');
const inkCv = $('ink'), inkCtx = inkCv.getContext('2d');
const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true });
const small = document.createElement('canvas');
const sctx = small.getContext('2d', { willReadFrequently: true });
const simCanvas = document.createElement('canvas');
const simCtx = simCanvas.getContext('2d');

// ---------- State ----------
let running = false;
let sim = null;
let photo = null;
let stream = null;
let frameData = null;

let corners = null;            // normalized TL, TR, BR, BL in camera space
let paperMode = 'auto';        // 'auto' | 'locked'
let paperSeen = false;
let candidate = null;
let stableSince = 0;
let autoLocked = false;        // locked by itself (unlocks on Clear) vs. by the operator (stays)

let rw = 0, rh = 0, rect = null, inkBuf = null, hold = null, committed = null, inkView = null;
let chunks = [];               // Float32Array chunks of [x, y, r, g, b] sent to the output
let pointCount = 0;
let lastInkCount = 0;
let awaiting = null;           // after Clear: wait until the old drawing leaves the camera
let lastClear = 0;

let frameNo = 0, lastProc = 0, fps = 30, fpsAcc = 0, fpsFrames = 0, fpsT = performance.now();
const outputs = new Map();     // id -> { preview, last }

// ---------- Settings UI ----------
function fmt(el, v) {
  if (el.hasAttribute('data-pct')) return Math.round(v * 100) + '%';
  return (+v).toFixed(2).replace(/\.?0+$/, '') + (el.dataset.unit || '');
}
function refreshOutputs() {
  document.querySelectorAll('output[data-for]').forEach((o) => { o.textContent = fmt(o, S[o.dataset.for]); });
}
document.querySelectorAll('[data-key]').forEach((el) => {
  const key = el.dataset.key;
  if (el.type === 'checkbox') el.checked = !!S[key];
  else el.value = S[key];
  el.addEventListener('input', () => {
    S[key] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
    save();
    refreshOutputs();
    if (OUTPUT_KEYS.includes(key)) sendSettings();
    if (key === 'drawSound') brushSound.volume(S.drawSound);
    if (key === 'source') { if (pointCount) doClear(true); updateSourceFields(); start(); afterOutlineChange(); photosModeChanged(); phonesModeChanged(); sheetModeChanged(); }
    if (key === 'camCapture') { if (pointCount) doClear(true); resetBuffers(); sheetModeChanged(); }
    if (key === 'mapGuides') sendParts();
    if (OUTLINE_KEYS.includes(key)) { buildOutline(); updateSourceFields(); }
    if (key === 'guideOpacity') updatePadGuide();
    if (key === 'outlineOut') sendOutline();
    if (key === 'showQr') sendQr();
    if (key === 'partFit') refitParts();
    if (key === 'paper') { resetBuffers(); if (S.source === 'photos') sendPaperSize(); }
  });
});
refreshOutputs();

function updateSourceFields() {
  const draw = isPad();
  const photos = S.source === 'photos';
  $('fieldDevice').hidden = S.source !== 'camera';
  $('fieldFile').hidden = S.source !== 'image';
  $('fieldCapture').hidden = draw;
  $('sheetFields').hidden = !sheetMode();
  $('camStage').hidden = draw;
  $('paperRow').hidden = draw;
  $('padStage').hidden = !draw;
  $('padTools').hidden = !draw || photos;
  $('subsPanel').hidden = !photos;
  $('phonesPanel').hidden = S.source !== 'phones';
  $('mapPanel').hidden = !(S.outlineOn && S.outlineSrc === 'shapes');
  if (wallViewReady) updateWallView();
  if (!$('mapPanel').hidden) requestAnimationFrame(() => drawMap());
  $('camTitle').textContent = photos ? 'Doorway' : draw ? 'Drawing pad' : 'Camera';
  $('camHint').textContent = photos
    ? 'Approved phone drawings appear here and on the output, in the part each visitor chose.'
    : S.source === 'phones'
      ? 'Phone drawings appear here as visitors draw. You can draw here too.'
    : draw
      ? 'Draw with a mouse, trackpad or stylus. Lines appear on the output as you draw.'
      : 'Drag the corner dots to fit the paper outline';
}
updateSourceFields();

// ---------- Sources ----------
async function start() {
  stopCamera();
  running = false;
  try { sheet.state = 'empty'; } catch {} // a new photo or a restart counts as a fresh sheet
  sim = null;
  if (S.source === 'sim') {
    sim = createSim(1280, 720);
    running = true;
  } else if (isPad()) {
    running = true;
  } else if (S.source === 'camera') {
    try {
      const id = $('selDevice').value;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      running = true;
      listCameras();
    } catch (err) {
      showEmpty('Camera unavailable: ' + err.message);
      return;
    }
  } else if (S.source === 'image') {
    if (!photo) { showEmpty('Pick a photo of a drawing on paper'); return; }
    running = true;
  }
  showEmpty(null);
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function listCameras() {
  const sel = $('selDevice');
  const current = sel.value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  sel.innerHTML = '<option value="">Default camera</option>' +
    devices.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`).join('');
  sel.value = current;
}

$('selDevice').addEventListener('change', () => { if (S.source === 'camera') start(); });
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { photo = img; corners = null; paperMode = 'auto'; start(); };
  img.src = URL.createObjectURL(file);
});
$('btnStart').addEventListener('click', start);

function showEmpty(msg) {
  const el = $('camEmpty');
  el.hidden = !msg;
  if (msg) el.textContent = msg;
}

function grabFrame(now) {
  let sw, sh, src;
  if (sim) {
    // Render the simulation on a GPU canvas, then copy it like a camera frame (much faster)
    sw = sim.width; sh = sim.height; src = simCanvas;
    if (simCanvas.width !== sw) { simCanvas.width = sw; simCanvas.height = sh; }
    sim.draw(simCtx, now);
  }
  else if (S.source === 'camera') {
    if (video.readyState < 2 || !video.videoWidth) return false;
    sw = video.videoWidth; sh = video.videoHeight; src = video;
  } else if (photo) { sw = photo.naturalWidth; sh = photo.naturalHeight; src = photo; }
  else return false;

  const scale = Math.min(1, 1280 / sw);
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  if (frame.width !== w || frame.height !== h) {
    frame.width = w; frame.height = h;
    cam.width = w; cam.height = h;
    small.width = 240; small.height = Math.round(240 * h / w);
  }
  fctx.save();
  if (S.mirror) { fctx.translate(w, 0); fctx.scale(-1, 1); }
  fctx.drawImage(src, 0, 0, w, h);
  fctx.restore();
  frameData = fctx.getImageData(0, 0, w, h);
  return true;
}

// ---------- Paper detection ----------
function cornerDist(a, b) {
  let m = 0;
  for (let k = 0; k < 4; k++) m = Math.max(m, Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]));
  return m;
}

// While searching, the outline follows the paper. Once it has held still for a moment it
// locks itself, so a hand covering a corner can't drag the outline (and the captured ink) around.
// Clear unlocks it again so the next sheet is found.
function runDetect(now) {
  sctx.drawImage(frame, 0, 0, small.width, small.height);
  const res = detectPaper(sctx.getImageData(0, 0, small.width, small.height));
  if (!res) { paperSeen = false; stableSince = 0; return; }
  paperSeen = true;
  if (!corners) { corners = res.corners; stableSince = now; return; }
  const diff = cornerDist(res.corners, corners);
  if (diff < 0.012) {
    corners = corners.map((c, k) => [c[0] + (res.corners[k][0] - c[0]) * 0.3, c[1] + (res.corners[k][1] - c[1]) * 0.3]);
    candidate = null;
    if (!stableSince) stableSince = now;
    if (now - stableSince > 600 && !awaiting) { paperMode = 'locked'; autoLocked = true; }
  } else {
    stableSince = 0;
    if (candidate && cornerDist(candidate.c, res.corners) < 0.012) {
      // A big change that holds steady: the paper really moved.
      if (now - candidate.since > 700) { corners = res.corners; candidate = null; }
    } else {
      candidate = { c: res.corners, since: now };
    }
  }
}

function quadPx() {
  const r = ((S.rotation % 4) + 4) % 4;
  const q = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = corners[(k + r) % 4];
    q.push([x * frame.width, y * frame.height]);
  }
  return q;
}

function rectSizeFor(q) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const across = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
  const down = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const ratio = PAPER_RATIO[S.paper] || 1.4142;
  const L = sheetMode() ? PHOTO_LONG_SIDE : LONG_SIDE; // a whole sheet of small boxes needs more detail
  if (ratio === 1) return [Math.round(L * 0.83), Math.round(L * 0.83)];
  return across >= down ? [L, Math.round(L / ratio)] : [Math.round(L / ratio), L];
}

function resetBuffers() { rw = rh = 0; }

function ensureBuffers(w, h) {
  if (w === rw && h === rh) return;
  if (pointCount) doClear(true); // the paper's shape changed, so old points no longer line up
  rw = w; rh = h;
  rect = new ImageData(w, h);
  inkView = new ImageData(w, h);
  inkBuf = makeInkBuffers(w, h);
  hold = new Uint8Array(w * h);
  committed = new Uint8Array(w * h);
  paperCv.width = inkCv.width = w;
  paperCv.height = inkCv.height = h;
  if (building) sendOutline(); // its placement depends on the drawing area's shape
}

// ---------- Capturing ink ----------
function keep(i) {
  return ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296) < S.density;
}

function updateCommit(inkCount, now) {
  const mask = inkBuf.mask;
  if (awaiting) {
    if (inkCount < Math.max(40, awaiting.baseline * 0.15)) {
      if (!awaiting.lowSince) awaiting.lowSince = now;
      else if (now - awaiting.lowSince > 500) endAwaiting();
    } else awaiting.lowSince = 0;
    if (awaiting) { hold.fill(0); return; }
  }
  const holdFrames = Math.max(2, Math.min(250, Math.round(S.hold * fps)));
  const d = rect.data;
  const pts = [];
  const n = rw * rh;
  const still = S.waitStill ? stillnessMap() : null;
  for (let i = 0; i < n; i++) {
    if (committed[i]) continue;
    if (still && !still[motionBlockOf(i)]) continue; // something is moving nearby (hand, pen): wait
    if (mask[i]) {
      if (++hold[i] >= holdFrames) {
        committed[i] = 1;
        if (keep(i) && pointCount + pts.length / 5 < MAX_POINTS) {
          const j = i * 4;
          pts.push((i % rw + 0.5) / rw, ((i / rw | 0) + 0.5) / rh, d[j], d[j + 1], d[j + 2]);
        }
      }
    } else if (hold[i]) {
      hold[i] = hold[i] > 2 ? hold[i] - 2 : 0;
    }
  }
  if (pts.length) {
    const arr = new Float32Array(pts);
    chunks.push(arr);
    pointCount += arr.length / 5;
    CH.postMessage({ type: 'add', aspect: rw / rh, res: Math.max(rw, rh), pts: arr });
  }
}

// Motion detection on a coarse grid. A block counts as "still" when neither it nor any
// block within two blocks of it changed since the last frame. This keeps the pen body
// and hand from being captured while they move across the page.
const MB = 24;
let prevGray = null, mbw = 0, mbh = 0, moving = null, stillArr = null;
function motionBlockOf(i) {
  return ((i / rw | 0) / MB | 0) * mbw + ((i % rw) / MB | 0);
}
function stillnessMap() {
  const g = inkBuf.gray;
  const n = rw * rh;
  mbw = Math.ceil(rw / MB); mbh = Math.ceil(rh / MB);
  if (!prevGray || prevGray.length !== n) {
    prevGray = new Float32Array(g);
    moving = new Uint16Array(mbw * mbh);
    stillArr = new Uint8Array(mbw * mbh);
  }
  moving.fill(0);
  for (let i = 0; i < n; i++) {
    const dlt = g[i] - prevGray[i];
    if (dlt > 28 || dlt < -28) moving[motionBlockOf(i)]++;
  }
  prevGray.set(g);
  for (let by = 0; by < mbh; by++) {
    for (let bx = 0; bx < mbw; bx++) {
      let ok = 1;
      for (let oy = -2; oy <= 2 && ok; oy++) {
        const yy = by + oy;
        if (yy < 0 || yy >= mbh) continue;
        for (let ox = -2; ox <= 2; ox++) {
          const xx = bx + ox;
          if (xx < 0 || xx >= mbw) continue;
          if (moving[yy * mbw + xx] > 4) { ok = 0; break; }
        }
      }
      stillArr[by * mbw + bx] = ok;
    }
  }
  return stillArr;
}

function endAwaiting() {
  awaiting = null;
  $('awaitBanner').hidden = true;
}

function doClear(local) {
  const now = performance.now();
  if (now - lastClear < 400) return;
  if (S.source === 'photos' && local !== true) api('clear', {}).catch(() => {}); // forget approved drawings too
  try { phoneStrokes.clear(); visitorChunks.clear(); if (owner) owner.fill(0); } catch {} // phone strokes waiting to be replayed, and who drew what (not set up yet at start)
  lastClear = now;
  if (committed) committed.fill(0);
  if (hold) hold.fill(0);
  chunks = [];
  pointCount = 0;
  CH.postMessage({ type: 'clear' });
  if (sim) sim.reset();
  clearPad();
  placed.clear();
  seenApproved.clear();
  clearedAt = now;
  partChunks.clear();
  try { sheetCleared(); } catch {} // (not set up yet at start)
  if (autoLocked) { paperMode = 'auto'; autoLocked = false; stableSince = 0; candidate = null; }
  // The old drawing is probably still under the camera. Don't capture it again
  // until it disappears (sheet removed or swapped).
  if (!sim && !isPad() && !sheetMode() && lastInkCount > 80) {
    awaiting = { baseline: lastInkCount, lowSince: 0 };
    $('awaitBanner').hidden = false;
  }
  const b = $('btnClear');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 180);
}

$('btnClear').addEventListener('click', () => doClear());
$('btnRecapture').addEventListener('click', endAwaiting);

// ---------- Drawing the operator views ----------
function drawCamera() {
  camCtx.putImageData(frameData, 0, 0);
  if (!corners) return;
  const q = corners.map(([x, y]) => [x * cam.width, y * cam.height]);
  const color = paperMode === 'locked' ? '#7cc4ff' : paperSeen ? '#5fd38d' : '#ffb547';
  const u = cam.width / 640;
  camCtx.lineWidth = 2.5 * u;
  camCtx.strokeStyle = color;
  camCtx.beginPath();
  q.forEach(([x, y], k) => (k ? camCtx.lineTo(x, y) : camCtx.moveTo(x, y)));
  camCtx.closePath();
  camCtx.stroke();
  q.forEach(([x, y]) => {
    camCtx.beginPath();
    camCtx.arc(x, y, 7 * u, 0, Math.PI * 2);
    camCtx.fillStyle = color;
    camCtx.fill();
    camCtx.lineWidth = 2 * u;
    camCtx.strokeStyle = '#000';
    camCtx.stroke();
  });
  // Mark which edge becomes the top of the output
  const r = ((S.rotation % 4) + 4) % 4;
  const a = q[r], b = q[(r + 1) % 4];
  camCtx.font = `600 ${13 * u}px -apple-system, sans-serif`;
  camCtx.textAlign = 'center';
  camCtx.fillStyle = color;
  camCtx.fillText('TOP', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 10 * u);
}

function drawPaperAndInk() {
  paperCtx.putImageData(rect, 0, 0);
  const v = inkView.data, mask = inkBuf.mask, d = rect.data;
  const n = rw * rh;
  const muted = !!awaiting;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (committed[i]) { v[j] = 244; v[j + 1] = 241; v[j + 2] = 234; }
    else if (mask[i]) {
      if (muted) { v[j] = 90; v[j + 1] = 90; v[j + 2] = 96; }
      else { v[j] = 255; v[j + 1] = 154; v[j + 2] = 46; }
    } else { v[j] = 14; v[j + 1] = 15; v[j + 2] = 18; }
    v[j + 3] = 255;
  }
  inkCtx.putImageData(inkView, 0, 0);
  if (sheetMode() && lastDrawnBoxes) {
    // The boxes found on the sheet, named after the wall box each one goes to
    for (const c of [paperCtx, inkCtx]) {
      c.lineWidth = 3;
      c.strokeStyle = '#5fd38d';
      c.fillStyle = '#5fd38d';
      c.font = '600 14px -apple-system, sans-serif';
      for (const b of lastDrawnBoxes) {
        c.beginPath();
        b.quad.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.closePath();
        c.stroke();
        c.fillText(b.name || '', b.quad[0][0] + 6, b.quad[0][1] + 18);
      }
    }
  }
}

function updateStatus() {
  const pp = $('pillPaper');
  if (S.source === 'photos') { pp.textContent = 'Taking phone drawings'; pp.className = 'pill ok'; }
  else if (S.source === 'draw') { pp.textContent = 'Drawing on screen'; pp.className = 'pill ok'; }
  else if (S.source === 'phones') { pp.textContent = 'Phones drawing live'; pp.className = 'pill ok'; }
  else if (!corners) { pp.textContent = 'Paper: searching…'; pp.className = 'pill warn'; }
  else if (paperMode === 'locked') { pp.textContent = autoLocked ? 'Paper: found & locked' : 'Paper: locked (manual)'; pp.className = 'pill ok'; }
  else { pp.textContent = paperSeen ? 'Paper: found (auto)' : 'Paper: not visible'; pp.className = paperSeen ? 'pill ok' : 'pill warn'; }

  const now = performance.now();
  let proj = 0;
  for (const [id, o] of outputs) {
    if (now - o.last > 5000) outputs.delete(id);
    else if (!o.preview) proj++;
  }
  const po = $('pillOutput');
  po.textContent = proj ? `Output: ${proj} window${proj > 1 ? 's' : ''} open` : 'Output: none open';
  po.className = proj ? 'pill ok' : 'pill';
  $('pillStats').textContent = `${Math.round(fps)} fps · ${pointCount.toLocaleString()} particles`;
  $('btnAuto').classList.toggle('active', paperMode === 'auto');
  $('btnLock').classList.toggle('active', paperMode === 'locked');
}

// ---------- Main loop ----------
function tick(now) {
  requestAnimationFrame(tick);
  // Whole-sheet capture doesn't need every frame: about 12 a second is plenty and much lighter
  if (!running || now - lastProc < (sheetMode() && !isPad() ? 1000 / 12 : 1000 / 30) - 2) return;
  lastProc = now;
  if (isPad()) {
    padTick();
    if (++frameNo % 10 === 0) updateStatus();
    return;
  }
  if (!grabFrame(now)) return;
  frameNo++;

  fpsFrames++;
  if (now - fpsT > 1000) { fps = (fpsFrames * 1000) / (now - fpsT); fpsFrames = 0; fpsT = now; }

  const sheet = sheetMode();
  if (paperMode === 'auto' && frameNo % (sheet ? 2 : 3) === 0) runDetect(now);
  drawCamera();
  if (corners) {
    // With a captured sheet still lying there, only check now and then whether it's been taken away
    const idle = sheet && sheetWaitingForRemoval() && frameNo % 4 !== 0;
    if (!idle) {
      const q = quadPx();
      const [w, h] = rectSizeFor(q);
      ensureBuffers(w, h);
      warpQuad(frameData, q, rect);
      lastInkCount = extractInk(rect, S, inkBuf);
      if (sheet) sheetTick(now, lastInkCount); else updateCommit(lastInkCount, now);
      drawPaperAndInk();
    }
  } else if (sheet) sheetTick(now, 0);
  if (frameNo % 10 === 0) updateStatus();
}
requestAnimationFrame(tick);

// ---------- Paper buttons and corner dragging ----------
$('btnAuto').addEventListener('click', () => { paperMode = 'auto'; autoLocked = false; stableSince = 0; candidate = null; updateStatus(); });
$('btnLock').addEventListener('click', () => { if (corners) { paperMode = 'locked'; autoLocked = false; } updateStatus(); });
$('btnFull').addEventListener('click', () => {
  corners = [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]];
  paperMode = 'locked';
  autoLocked = false;
  updateStatus();
});
$('btnRotate').addEventListener('click', () => {
  S.rotation = (S.rotation + 1) % 4;
  save();
  if (pointCount) doClear(true);
  resetBuffers();
});

let dragging = -1;
function camPoint(e) {
  const r = cam.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r];
}
cam.addEventListener('pointerdown', (e) => {
  if (!corners) return;
  const [x, y, r] = camPoint(e);
  let best = -1, bestD = 22;
  corners.forEach(([cx, cy], k) => {
    const d = Math.hypot((cx - x) * r.width, (cy - y) * r.height);
    if (d < bestD) { bestD = d; best = k; }
  });
  if (best >= 0) {
    dragging = best;
    paperMode = 'locked';
    autoLocked = false;
    cam.setPointerCapture(e.pointerId);
  }
});
cam.addEventListener('pointermove', (e) => {
  if (dragging < 0) return;
  const [x, y] = camPoint(e);
  corners[dragging] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
});
cam.addEventListener('pointerup', () => { dragging = -1; updateStatus(); });

// ---------- Drawing on screen ----------
// Strokes are drawn twice: on the visible pad (2x, crisp) and on a hidden canvas at the
// capture resolution. New pixels on the hidden canvas become particles right away;
// no hold time or motion check is needed because there's no hand or pen in the picture.
const PAD_SCALE = 2;
const PAD_COLORS = ['#17171d', '#e03131', '#e8590c', '#f2c200', '#2b8a3e', '#15aabf', '#1c4fd8', '#7048e8', '#c2255c', '#f06595'];
const pad = $('pad');
const padCtx = pad.getContext('2d');
const padRaster = document.createElement('canvas');
const padRctx = padRaster.getContext('2d', { willReadFrequently: true });
let padDirty = false, padDrawing = false;
let padVersion = 0; // goes up whenever the pad's picture changes (the wall view redraws only then)

function padTick() {
  const a = areaAspect();
  const L = padLong();
  const w = a >= 1 ? L : Math.round(L * a), h = a >= 1 ? Math.round(L / a) : L;
  ensureBuffers(w, h);
  if (padRaster.width !== w || padRaster.height !== h) {
    padRaster.width = w; padRaster.height = h;
    pad.width = w * PAD_SCALE; pad.height = h * PAD_SCALE;
  }
  if (pendingReplay) replayApproved();
  if (deferredParts.length && building) deferredParts.splice(0).forEach(placePart);
  if (!padDirty) return;
  padDirty = false;
  const d = padRctx.getImageData(0, 0, w, h).data;
  const pts = [];
  for (let i = 0, j = 3; i < w * h; i++, j += 4) {
    if (committed[i] || d[j] < 60) continue; // low enough to keep tiny stipple dots
    committed[i] = 1;
    if (pointCount + pts.length / 5 < MAX_POINTS) { // keep every pixel so brush texture survives
      pts.push((i % w + 0.5) / w, ((i / w | 0) + 0.5) / h, d[j - 3], d[j - 2], d[j - 1]);
    }
  }
  if (pts.length) {
    const arr = new Float32Array(pts);
    chunks.push(arr);
    pointCount += arr.length / 5;
    CH.postMessage({ type: 'add', aspect: w / h, res: Math.max(w, h), pts: arr, live: drawsLive() });
  }
}

function clearPad() {
  padVersion++;
  padCtx.clearRect(0, 0, pad.width, pad.height);
  padRctx.clearRect(0, 0, padRaster.width, padRaster.height);
}

function padPos(e) {
  if (wallPen) return wallPos(e); // drawing on the wall view: through the corners of the shape it started in
  const r = pad.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * padRaster.width, ((e.clientY - r.top) / r.height) * padRaster.height];
}

function paintMarks(c, s, marks) {
  c.lineCap = 'round';
  for (const m of marks) {
    if (m.t === 'd') {
      c.fillStyle = m.c;
      c.beginPath();
      c.arc(m.x * s, m.y * s, m.r * s, 0, Math.PI * 2);
      c.fill();
    } else if (m.t === 'p') {
      c.fillStyle = m.c;
      c.beginPath();
      m.pts.forEach(([px, py], k) => (k ? c.lineTo(px * s, py * s) : c.moveTo(px * s, py * s)));
      c.closePath();
      c.fill();
    } else {
      c.strokeStyle = m.c;
      c.lineWidth = m.w * s;
      c.beginPath();
      c.moveTo(m.x1 * s, m.y1 * s);
      c.lineTo(m.x2 * s, m.y2 * s);
      c.stroke();
    }
  }
}

function marksBounds(marks) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, r) => {
    if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r;
    if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r;
  };
  for (const m of marks) {
    if (m.t === 'd') add(m.x, m.y, m.r + 2);
    else if (m.t === 'p') m.pts.forEach(([x, y]) => add(x, y, 2));
    else { add(m.x1, m.y1, m.w / 2 + 2); add(m.x2, m.y2, m.w / 2 + 2); }
  }
  return { x0, y0, x1, y1 };
}

// When drawing is limited to a shape, new marks are painted on a scratch canvas, cut to the
// allowed area (strokeClip), and only then added to the pad. Only the marks' bounding box is touched.
const scratchR = document.createElement('canvas');
const scratchD = document.createElement('canvas');
let strokeClip = null;

function drawMarks(marks) {
  if (!marks.length) return;
  padVersion++;
  if (!strokeClip) {
    paintMarks(padRctx, 1, marks);
    paintMarks(padCtx, PAD_SCALE, marks);
    padDirty = true;
    return;
  }
  paintClipped(marksBounds(marks), strokeClip, (g, s) => paintMarks(g, s, marks));
}

// Paints into both pad canvases through a clip mask (a canvas whose alpha is the allowed area,
// stretched over the whole pad). bb is the area touched, in capture pixels.
function paintClipped(bb, clip, paint) {
  for (const [c, s, scratch] of [[padRctx, 1, scratchR], [padCtx, PAD_SCALE, scratchD]]) {
    const W = c.canvas.width, H = c.canvas.height;
    if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; }
    const sx = Math.max(0, Math.floor(bb.x0 * s)), sy = Math.max(0, Math.floor(bb.y0 * s));
    const ex = Math.min(W, Math.ceil(bb.x1 * s)), ey = Math.min(H, Math.ceil(bb.y1 * s));
    if (ex <= sx || ey <= sy) continue;
    const g = scratch.getContext('2d');
    g.globalCompositeOperation = 'source-over';
    g.clearRect(sx, sy, ex - sx, ey - sy);
    paint(g, s);
    g.globalCompositeOperation = 'destination-in';
    const kx = clip.width / W, ky = clip.height / H;
    g.drawImage(clip, sx * kx, sy * ky, (ex - sx) * kx, (ey - sy) * ky, sx, sy, ex - sx, ey - sy);
    g.globalCompositeOperation = 'source-over';
    c.drawImage(scratch, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
  }
  padDirty = true;
}

const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0);
let padStrokeObj = null;

// Drawing sound on this laptop when drawing on the pad (the output window plays its own when
// drawing straight on the projection).
const brushSound = createBrushSound();
brushSound.volume(S.drawSound);
const padArea = () => { const r = (wallOn() ? wallView : pad).getBoundingClientRect(); return { left: r.left, width: r.width }; };

function padDown(e) {
  if (S.source === 'photos') return; // visitors choose the part on their phone
  if (wallOn()) {
    wallPen = wallPartAt(e);
    if (!wallPen) return; // started outside every shape: draws nothing
  }
  brushSound.begin(e.clientX, e.clientY, { brush: S.padBrush, size: S.padSize, area: padArea(), time: e.timeStamp });
  padDrawing = true;
  e.currentTarget.setPointerCapture(e.pointerId);
  strokeClip = clipForStroke(padPos(e));
  padStrokeObj = createStroke({ brush: S.padBrush, size: S.padSize, color: S.padColor, mix: S.padMix });
  drawMarks(padStrokeObj.begin(padPos(e), pressureOf(e)));
}
function padMove(e) {
  if (!padDrawing) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) {
    drawMarks(padStrokeObj.move(padPos(ev), pressureOf(ev)));
    brushSound.move(ev.clientX, ev.clientY, pressureOf(ev), ev.timeStamp);
  }
}
const padUp = () => { padDrawing = false; wallPen = null; brushSound.end(); };
pad.addEventListener('pointerdown', padDown);
pad.addEventListener('pointermove', padMove);
['pointerup', 'pointercancel'].forEach((t) => pad.addEventListener(t, padUp));

// Strokes drawn straight onto the projection (output window), in drawing-area fractions.
// They go through the same brushes and shape limits as the pad. The output window is usually the
// focused one then, and this page may be throttled, so the pad is flushed right away.
let remoteStroke = null, flushTimer = 0;
function drawRemote(m) {
  if (!drawsLive() || !padRaster.width) return;
  const p = [m.u * padRaster.width, m.v * padRaster.height];
  if (m.phase === 'down') {
    strokeClip = clipForStroke(p);
    remoteStroke = createStroke({ brush: S.padBrush, size: S.padSize, color: S.padColor, mix: S.padMix });
    drawMarks(remoteStroke.begin(p, m.pressure || 0));
  } else if (m.phase === 'move' && remoteStroke) {
    drawMarks(remoteStroke.move(p, m.pressure || 0));
  } else if (m.phase === 'up') {
    remoteStroke = null;
  }
  // Flush now rather than on a timer: when this page isn't the focused window, Chrome slows its
  // timers and animation frames down to about once a second, which made drawing lag badly.
  const now = performance.now();
  if (m.phase === 'up' || now - lastFlush > 25) { lastFlush = now; padTick(); }
  else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = 0; lastFlush = performance.now(); padTick(); }, 30);
}
let lastFlush = 0;

function renderBrushes() {
  $('brushes').innerHTML = BRUSHES.map((b) =>
    `<button class="brush${b.id === S.padBrush ? ' on' : ''}" data-brush="${b.id}">${b.label}</button>`).join('');
}
$('brushes').addEventListener('click', (e) => {
  const id = e.target.dataset && e.target.dataset.brush;
  if (!id) return;
  S.padBrush = id;
  save();
  renderBrushes();
  sendSettings();
});
renderBrushes();

function renderSwatches() {
  $('swatches').innerHTML = PAD_COLORS.map((c) =>
    `<button class="swatch${c === S.padColor ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
}
$('swatches').addEventListener('click', (e) => {
  const c = e.target.dataset && e.target.dataset.color;
  if (!c) return;
  S.padColor = c;
  save();
  renderSwatches();
});
renderSwatches();

// ---------- Talking to output windows ----------
// Bump with every change to the operator or output code: an output window still running older code
// (opened before an update) reloads itself when it hears a newer number.
const BUILD = 24;
function settingsMsg() {
  const s = {};
  OUTPUT_KEYS.forEach((k) => (s[k] = S[k]));
  return { type: 'settings', settings: s, build: BUILD };
}
function sendSettings() { CH.postMessage(settingsMsg()); }

function sendSync(to) {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const groups = [...partChunks].map(([group, pts]) => ({ group, pts }));
  for (const [group, sc] of sheetChunks) groups.push({ group, pts: sc.pts });
  for (const [group, list] of visitorChunks) {
    const pts = new Float32Array(list.reduce((n, c) => n + c.length, 0));
    let q = 0;
    for (const c of list) { pts.set(c, q); q += c.length; }
    if (pts.length) groups.push({ group, pts });
  }
  CH.postMessage({ type: 'sync', to, aspect: rw && rh ? rw / rh : PAPER_RATIO[S.paper], res: Math.max(rw, rh) || LONG_SIDE, pts: all, groups });
  for (const [group, sc] of sheetChunks) CH.postMessage({ type: 'sheet', to, group, box: sc.box, rect: sc.rect });
  CH.postMessage(settingsMsg());
}

CH.onmessage = ({ data: m }) => {
  if (!m) return;
  if ((m.type === 'hello' || m.type === 'ping') && !m.preview && m.sw && m.sh) noteScreen(m.sw, m.sh);
  if (m.type === 'hello') { outputs.set(m.id, { preview: m.preview, last: performance.now() }); sendSync(m.id); sendOutline(m.id); sendHighlight(m.id); sendQr(m.id); }
  else if (m.type === 'ping') {
    if (!outputs.has(m.id)) { sendSync(m.id); sendOutline(m.id); sendHighlight(m.id); sendQr(m.id); }
    outputs.set(m.id, { preview: m.preview, last: performance.now() });
  }
  else if (m.type === 'bye') outputs.delete(m.id);
  else if (m.type === 'request-clear') doClear();
  else if (m.type === 'draw') drawRemote(m);
};
CH.postMessage({ type: 'control-hello' });

$('btnOpenOutput').addEventListener('click', () => {
  window.open('output.html', 'ink-projector-output', 'popup,width=1280,height=720');
});

// ---------- Keyboard (and USB buttons that act as keyboards) ----------
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type === 'file') return;
  if (e.code === 'Space' || e.code === 'KeyC') {
    e.preventDefault();
    if (tag === 'button' || tag === 'select') e.target.blur(); // so Space doesn't also press that control
    if (!e.repeat) doClear();
  }
});

// ---------- Building outline ----------
// The outline is a line mask of the building. On the drawing pad it's a faint guide that is
// never captured. On the output it can glow. For paper, it's printed in light blue as a template.
const OUTLINE_LONG = 960;
let building = null;          // { w, h, mask, aspect }
let buildingImg = null;       // uploaded image (not saved between reloads)
const outlineCv = document.createElement('canvas');

function makeSampleBuilding() {
  const c = document.createElement('canvas');
  c.width = 1200; c.height = 860;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = '#000';
  x.lineWidth = 5;
  x.lineJoin = 'round';
  const rect = (l, t, r, b) => x.strokeRect(l, t, r - l, b - t);
  const ln = (pts) => { x.beginPath(); pts.forEach(([a, b], k) => (k ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke(); };
  ln([[20, 820], [1180, 820]]);                       // ground
  rect(180, 190, 860, 820);                           // main block
  ln([[165, 190], [875, 190]]);                       // cornice
  rect(180, 150, 860, 190);                           // parapet
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 5; col++) {
      if (r === 3 && col === 2) continue;
      const l = 228 + col * 125, t = 240 + r * 135;
      rect(l, t, l + 70, t + 92);
      ln([[l + 35, t], [l + 35, t + 92]]);
    }
  }
  x.beginPath();                                      // arched door
  x.moveTo(470, 820); x.lineTo(470, 700); x.arc(520, 700, 50, Math.PI, 0); x.lineTo(570, 820);
  x.stroke();
  rect(860, 100, 1040, 820);                          // tower
  ln([[845, 100], [950, 25], [1055, 100]]);
  for (let r = 0; r < 5; r++) for (let col = 0; col < 2; col++) rect(895 + col * 70, 140 + r * 125, 935 + col * 70, 205 + r * 125);
  rect(40, 480, 180, 820);                            // low wing
  ln([[30, 480], [190, 480]]);
  rect(75, 560, 145, 650); rect(75, 690, 145, 780);
  return c;
}

// The central doorway from your photo, traced as clean lines (photo pixel coordinates,
// cropped to the middle bay: pilaster to pilaster, cornice to the bottom step).
function makeDoorway() {
  const X0 = 220, Y0 = 0, K = 2;
  const c = document.createElement('canvas');
  c.width = (705 - X0) * K; c.height = (752 - Y0) * K;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.setTransform(K, 0, 0, K, -X0 * K, -Y0 * K);
  x.strokeStyle = '#000';
  x.lineWidth = 2.6;
  x.lineJoin = 'round';
  x.lineCap = 'round';
  const rect = (l, t, r, b) => x.strokeRect(l, t, r - l, b - t);
  const ln = (...pts) => { x.beginPath(); pts.forEach(([a, b], k) => (k ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke(); };
  const arc = (cx, cy, r) => { x.beginPath(); x.arc(cx, cy, r, Math.PI, 0); x.stroke(); };

  // Entablature
  ln([240, 8], [685, 8]);
  ln([240, 30], [685, 30]);
  ln([240, 8], [240, 30]); ln([685, 8], [685, 30]);
  ln([270, 30], [270, 85]); ln([655, 30], [655, 85]);
  ln([262, 85], [663, 85]);
  ln([266, 97], [659, 97]);
  ln([262, 112], [663, 112]);

  // Outer pilasters: capital, shaft, base, pedestal
  for (const [l, r, pl, pr, baseY, pedY, ground] of [[278, 335, 250, 346, 525, 545, 682], [588, 650, 576, 668, 520, 550, 688]]) {
    rect(l - 10, 112, r + 10, 126);
    rect(l - 5, 126, r + 5, 150);
    rect(l, 150, r, baseY);
    rect(l - 8, baseY, r + 8, pedY);
    rect(pl, pedY, pr, ground);
  }

  // Inner pilasters with impost caps
  rect(337, 282, 370, 605);
  rect(551, 282, 585, 605);
  rect(333, 264, 374, 282);
  rect(547, 264, 589, 282);

  // Arches: the stone archivolt and the door opening
  arc(461, 265, 124);
  arc(461, 270, 93);

  // Doors
  ln([368, 270], [368, 600]); ln([554, 270], [554, 600]);
  ln([461, 177], [461, 600]);
  for (const [l, r] of [[380, 452], [470, 542]]) {
    const m = (l + r) / 2;
    x.beginPath(); x.arc(m, 283, 6, 0, Math.PI * 2); x.stroke();
    rect(l, 298, r, 418);
    rect(l + 9, 306, r - 9, 410);
    rect(l, 425, r, 445);
    rect(l + 12, 455, r - 12, 476);
    rect(l, 486, r, 505);
    rect(l, 512, r, 570);
    rect(l + 9, 520, r - 9, 562);
  }

  // Lantern and its arms
  ln([461, 122], [461, 175]);
  ln([447, 175], [475, 175], [486, 190], [436, 190], [447, 175]);
  ln([440, 190], [447, 262], [475, 262], [482, 190]);
  ln([368, 183], [438, 204]);
  ln([555, 183], [484, 204]);

  // Plaque and small round plate on the right pilaster
  rect(600, 578, 648, 602);
  x.beginPath(); x.arc(621, 405, 9, 0, Math.PI * 2); x.stroke();

  // Threshold and steps
  rect(345, 600, 578, 632);
  rect(315, 640, 605, 673);
  rect(275, 673, 647, 706);
  rect(230, 706, 690, 745);
  return c;
}

// Mapped shapes: boxes the operator adds and pins onto the real wall by their four corners
// (Map the shapes panel). Flat, each shape is a tile with its own proportions; the tiles are laid
// out in rows to make the drawing area, so the pad, the colouring-book limits and the particles all
// work as usual. On the output, each tile is warped onto its corners on the wall.
const SHAPE_COLORS = ['#ffd27a', '#7ad7ff', '#ff9ec7', '#9effa8', '#c9a7ff', '#ffb27a', '#7affe4', '#ff7a7a'];
const TILE_H = 600, TILE_GAP = 70, TILE_MARGIN = 70, TILES_PER_ROW = 3;
function defaultShapes() {
  return [
    { id: 'shape-1', name: 'Box 1', aspect: 0.8, quad: [[0.12, 0.2], [0.42, 0.2], [0.42, 0.8], [0.12, 0.8]] },
    { id: 'shape-2', name: 'Box 2', aspect: 0.8, quad: [[0.58, 0.2], [0.88, 0.2], [0.88, 0.8], [0.58, 0.8]] },
  ];
}
if (!Array.isArray(S.shapes) || !S.shapes.length) S.shapes = defaultShapes();

function shapeLayout() {
  const rows = [];
  S.shapes.forEach((sh, i) => { (rows[(i / TILES_PER_ROW) | 0] ||= []).push(sh); });
  const rowW = rows.map((r) => r.reduce((a, sh) => a + TILE_H * sh.aspect, 0) + TILE_GAP * (r.length - 1));
  const W = Math.round(Math.max(...rowW) + 2 * TILE_MARGIN);
  const H = Math.round(rows.length * TILE_H + (rows.length - 1) * TILE_GAP + 2 * TILE_MARGIN);
  const tiles = [];
  rows.forEach((r, ri) => {
    let x = (W - rowW[ri]) / 2;
    const y = TILE_MARGIN + ri * (TILE_H + TILE_GAP);
    for (const sh of r) { const w = TILE_H * sh.aspect; tiles.push({ id: sh.id, x, y, w, h: TILE_H }); x += w + TILE_GAP; }
  });
  return { W, H, tiles };
}
function makeShapesOutline() {
  const L = shapeLayout();
  const c = document.createElement('canvas');
  c.width = L.W; c.height = L.H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = '#000';
  x.lineWidth = Math.max(5, L.W / 240);
  for (const t of L.tiles) x.strokeRect(t.x, t.y, t.w, t.h);
  return c;
}

// The pieces the output window warps onto the wall: each mapped shape (with its corners), or
// otherwise the whole picture (which the output can pin itself with M). Fractions of the drawing area.
function mapParts() {
  if (building && S.outlineSrc === 'shapes') {
    const pl = placeIn(areaAspect(), outlineMargin());
    const L = shapeLayout();
    return {
      sig: 'shapes', guides: !!S.mapGuides,
      parts: L.tiles.map((t) => {
        const sh = S.shapes.find((x) => x.id === t.id);
        return {
          id: t.id, name: sh.name, quad: sh.quad,
          x: pl.x + (t.x / L.W) * pl.w, y: pl.y + (t.y / L.H) * pl.h,
          w: (t.w / L.W) * pl.w, h: (t.h / L.H) * pl.h,
        };
      }),
    };
  }
  return { sig: 'whole', parts: [{ id: 'whole', name: 'Picture', x: 0, y: 0, w: 1, h: 1 }] };
}
function sendParts(to) { CH.postMessage({ type: 'parts', to, aspect: areaAspect(), ...mapParts() }); }
// Long side of the drawing pad in capture pixels. Phone drawings get more detail.
const padLong = () => (S.source === 'photos' || S.source === 'phones' ? PHOTO_LONG_SIDE : LONG_SIDE);

function buildOutline() {
  updateOutlineFields();
  if (!S.outlineOn) { building = null; afterOutlineChange(); return; }
  const useUpload = S.outlineSrc === 'upload' && buildingImg;
  const src = useUpload ? buildingImg
    : S.outlineSrc === 'door' ? makeDoorway()
    : S.outlineSrc === 'shapes' ? makeShapesOutline()
    : makeSampleBuilding();
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const k = OUTLINE_LONG / Math.max(sw, sh);
  const w = Math.round(sw * k), h = Math.round(sh * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, w, h);
  const mask = outlineFromImage(x.getImageData(0, 0, w, h), useUpload ? S.outlineMode : 'lines', S.outlineDetail);
  building = { w, h, mask, aspect: w / h };
  computeRegions();
  outlineCv.width = w; outlineCv.height = h;
  const o = outlineCv.getContext('2d');
  const id = o.createImageData(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    id.data[j] = id.data[j + 1] = id.data[j + 2] = 255;
    id.data[j + 3] = mask[i];
  }
  o.putImageData(id, 0, 0);
  afterOutlineChange();
}

function updateOutlineFields() {
  $('outlineFields').hidden = !S.outlineOn;
  const up = S.outlineSrc === 'upload';
  $('fieldBuildingFile').hidden = !up;
  $('fieldOutlineMode').hidden = !up;
  $('fieldOutlineDetail').hidden = !up || S.outlineMode !== 'photo';
}

// Shape of the drawing area (width / height)
function areaAspect() {
  if (isPad()) return building ? building.aspect : (PAPER_RATIO[S.paper] || 1.4142);
  return rw && rh ? rw / rh : (PAPER_RATIO[S.paper] || 1.4142);
}

// Where the building sits inside an area of this shape, as fractions of the area.
// On screen it fills the pad; on paper it keeps a margin so it prints and detects cleanly.
function placeIn(aspect, margin, objAspect = building.aspect) {
  let bw = (1 - 2 * margin) * aspect, bh = bw / objAspect;
  if (bh > 1 - 2 * margin) { bh = 1 - 2 * margin; bw = bh * objAspect; }
  return { x: (aspect - bw) / 2 / aspect, y: (1 - bh) / 2, w: bw / aspect, h: bh };
}
const outlineMargin = () => (isPad() ? 0 : 0.08);

function afterOutlineChange() {
  updatePadGuide();
  if (wallViewReady) updateWallView();
  sendOutline();
  sendHighlight();
}

function updatePadGuide() {
  if (!building || !isPad() || S.guideOpacity <= 0) { pad.style.backgroundImage = 'none'; return; }
  const g = document.createElement('canvas');
  g.width = building.w; g.height = building.h;
  const gx = g.getContext('2d');
  gx.drawImage(outlineCv, 0, 0);
  gx.globalCompositeOperation = 'source-in';
  gx.fillStyle = `rgba(60, 110, 210, ${S.guideOpacity})`;
  gx.fillRect(0, 0, g.width, g.height);
  if (S.source === 'photos' && activeSection) {
    gx.globalCompositeOperation = 'destination-over';
    gx.drawImage(tintCanvas(regionCanvas(activeSection), 'rgba(255, 179, 71, 0.35)'), 0, 0);
  }
  pad.style.backgroundImage = `url(${g.toDataURL()})`;
}

function sendOutline(to) {
  sendParts(to);
  if (!building || !S.outlineOut) { CH.postMessage({ type: 'outline', to, on: false }); return; }
  const aspect = areaAspect();
  CH.postMessage({
    type: 'outline', to, on: true, aspect,
    place: placeIn(aspect, outlineMargin()),
    w: building.w, h: building.h, mask: building.mask,
  });
}

$('buildingFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    buildingImg = img;
    S.outlineSrc = 'upload';
    document.querySelector('[data-key="outlineSrc"]').value = 'upload';
    save();
    buildOutline();
  };
  img.src = URL.createObjectURL(file);
});

// A printable sheet with the outline in light blue. Light blue is far below the ink
// darkness threshold, so the camera ignores it and captures only what's drawn on top.
$('btnTemplate').addEventListener('click', () => {
  if (!building) return;
  const ratio = PAPER_RATIO[S.paper] || 1.4142;
  const landscape = building.aspect >= 1;
  const W = landscape ? 2400 : Math.round(2400 / ratio), H = landscape ? Math.round(2400 / ratio) : 2400;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, W, H);
  const p = placeIn(W / H, 0.08);
  const t = document.createElement('canvas');
  t.width = building.w; t.height = building.h;
  const tx = t.getContext('2d');
  tx.drawImage(outlineCv, 0, 0);
  tx.globalCompositeOperation = 'source-in';
  tx.fillStyle = '#a9cdf9';
  tx.fillRect(0, 0, t.width, t.height);
  x.drawImage(t, p.x * W, p.y * H, p.w * W, p.h * H);
  const url = c.toDataURL('image/png');
  const size = S.paper === 'letter' ? 'letter' : 'A4';
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!doctype html><title>Building template</title><style>@page{size:${size} ${landscape ? 'landscape' : 'portrait'};margin:0}html,body{margin:0;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}</style><img src="${url}" onload="setTimeout(()=>print(),300)">`);
  win.document.close();
});

// ---------- Drawing limits ----------
// The outline's lines split the picture into shapes (door panels, arch, pilasters, steps…).
// Shapes that reach the picture's edge are "outside" the doorway.
//   shape  — a stroke stays inside the shape it started in, like a colouring book
//   inside — strokes can go anywhere within the doorway's silhouette
//   free   — no limits
function computeRegions() {
  const { w, h, mask } = building;
  const n = w * h;
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (mask[i] > 60) wall[i] = 1;
  // Thicken lines by a pixel so small gaps in the drawing still separate shapes
  const thick = new Uint8Array(wall);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (wall[i]) { thick[i - 1] = thick[i + 1] = thick[i - w] = thick[i + w] = 1; }
    }
  }
  const labels = new Int32Array(n);
  const outside = [false];
  const stack = new Int32Array(n);
  let next = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (thick[s0] || labels[s0]) continue;
    const L = ++next;
    let sp = 0, edge = false;
    stack[sp++] = s0;
    labels[s0] = L;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      if (x > 0 && !thick[i - 1] && !labels[i - 1]) { labels[i - 1] = L; stack[sp++] = i - 1; }
      if (x < w - 1 && !thick[i + 1] && !labels[i + 1]) { labels[i + 1] = L; stack[sp++] = i + 1; }
      if (y > 0 && !thick[i - w] && !labels[i - w]) { labels[i - w] = L; stack[sp++] = i - w; }
      if (y < h - 1 && !thick[i + w] && !labels[i + w]) { labels[i + w] = L; stack[sp++] = i + w; }
    }
    outside[L] = edge;
  }
  // Bounding box of every shape, in outline pixels
  const bbox = new Int32Array((next + 1) * 4);
  for (let L = 1; L <= next; L++) { bbox[L * 4] = w; bbox[L * 4 + 1] = h; bbox[L * 4 + 2] = -1; bbox[L * 4 + 3] = -1; }
  for (let i = 0; i < n; i++) {
    const L = labels[i];
    if (!L) continue;
    const x = i % w, y = (i / w) | 0, o = L * 4;
    if (x < bbox[o]) bbox[o] = x;
    if (y < bbox[o + 1]) bbox[o + 1] = y;
    if (x > bbox[o + 2]) bbox[o + 2] = x;
    if (y > bbox[o + 3]) bbox[o + 3] = y;
  }
  building.bbox = bbox;
  building.labels = labels;
  building.outside = outside;
  building.regionCache = new Map();
  building.insideCv = maskCanvas((i) => !labels[i] || !outside[labels[i]]);
}

function maskCanvas(test) {
  const { w, h } = building;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  for (let i = 0, j = 3; i < w * h; i++, j += 4) if (test(i)) id.data[j] = 255;
  x.putImageData(id, 0, 0);
  return c;
}

const EMPTY_CLIP = document.createElement('canvas');
EMPTY_CLIP.width = EMPTY_CLIP.height = 1;

function clipForStroke(p) {
  if (!drawsLive() || !building || !building.labels || S.drawLimit === 'free') return null;
  if (S.drawLimit === 'inside') return building.insideCv;
  const { w, h, labels, outside } = building;
  const bx = Math.round((p[0] / padRaster.width) * w), by = Math.round((p[1] / padRaster.height) * h);
  // Started on a line? Use the nearest shape.
  let L = 0;
  for (let r = 0; r <= 10 && !L; r++) {
    for (let dy = -r; dy <= r && !L; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (labels[y * w + x]) { L = labels[y * w + x]; break; }
      }
    }
  }
  if (!L || outside[L]) return EMPTY_CLIP; // outside the doorway: nothing is drawn
  return regionCanvas(L);
}

function regionCanvas(L) {
  let c = building.regionCache.get(L);
  if (!c) { c = maskCanvas((i) => building.labels[i] === L); building.regionCache.set(L, c); }
  return c;
}

function labelAt(p) {
  const { w, h, labels } = building;
  const bx = Math.round((p[0] / padRaster.width) * w), by = Math.round((p[1] / padRaster.height) * h);
  for (let r = 0; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (labels[y * w + x]) return labels[y * w + x];
      }
    }
  }
  return 0;
}

// ---------- Photo submissions ----------
// You open one shape of the doorway at a time. It glows on the output next to a QR code.
// Visitors draw on that shape's printed template, photograph it on their phone (submit.html),
// and the phone sends just the ink. Drawings wait here until you approve them; approved ones
// are fitted into the shape, cut to its outline, and become particles like everything else.
const API = '/api/ink';
const OPKEY_STORE = 'inkProjector.opKey';
let activeSection = 0;       // label of the open shape (0 = none)
let pendingReplay = false;   // re-draw approved drawings after a reload
let pollTimer = 0;
let queueIds = null;
const placed = new Set();    // submission ids already drawn on the pad

async function api(op, body) {
  let key = '';
  try { key = localStorage.getItem(OPKEY_STORE) || ''; } catch {}
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-operator-key': key }, body: JSON.stringify(body) }
    : { headers: { 'x-operator-key': key }, cache: 'no-store' };
  const r = await fetch(`${API}?op=${op}`, opts);
  if (r.status === 404 && op.startsWith('item')) throw new Error('missing');
  if (r.status === 401) {
    const k = prompt('Enter the operator key for photo submissions:');
    if (k) { try { localStorage.setItem(OPKEY_STORE, k); } catch {} return api(op, body); }
    throw new Error('operator key required');
  }
  if (r.status === 404) throw new Error('offline');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const submitUrl = () => new URL('submit.html', location.href).href;
const drawUrl = () => new URL('draw.html', location.href).href;
// Phones need the template paper's proportions to find the shape on the sheet
function sendPaperSize() {
  api('setState', { section: null, paperRatio: PAPER_RATIO[S.paper] || 1.2941 }).catch(() => {});
}
function setSubsStatus(t) { $('subsStatus').textContent = t; }

function photosModeChanged() {
  clearInterval(pollTimer);
  if (S.source !== 'photos') { sendHighlight(); sendQr(); updatePadGuide(); return; }
  if (!S.outlineOn) {
    S.outlineOn = true;
    save();
    document.querySelector('[data-key="outlineOn"]').checked = true;
    buildOutline();
  }
  $('submitLink').href = submitUrl();
  $('submitLink').textContent = submitUrl();
  placed.clear();
  seenApproved.clear();
  pendingReplay = true;
  queueIds = null;
  sendPaperSize();
  setActive(0, false); // visitors choose the part on their phone; nothing is "opened" here
  pollQueue();
  pollTimer = setInterval(pollQueue, 1500);
}

function sectionBox(L) {
  const b = building.bbox, o = L * 4;
  return { x: b[o], y: b[o + 1], w: b[o + 2] - b[o] + 1, h: b[o + 3] - b[o + 1] + 1 };
}
const sectionAspect = (L) => { const b = sectionBox(L); return b.w / b.h; };

function tintCanvas(src, color) {
  const t = document.createElement('canvas');
  t.width = src.width; t.height = src.height;
  const x = t.getContext('2d');
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, t.width, t.height);
  return t;
}

// The doorway with one shape filled in: for the phone page and the printed template
function locatorCanvas(L, lineColor, fillColor, bg) {
  const c = document.createElement('canvas');
  c.width = building.w; c.height = building.h;
  const x = c.getContext('2d');
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); }
  x.drawImage(tintCanvas(regionCanvas(L), fillColor), 0, 0);
  x.drawImage(tintCanvas(outlineCv, lineColor), 0, 0);
  return c;
}

function sectionThumb(L) {
  const src = locatorCanvas(L, '#2c2f37', '#ffb347', '#ffffff');
  const t = document.createElement('canvas');
  t.height = 260; t.width = Math.round(260 * building.aspect);
  const x = t.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}

function setActive(L, push = true) {
  activeSection = L;
  const thumb = L ? sectionThumb(L) : '';
  $('sectionThumb').hidden = !L;
  if (L) $('sectionThumb').src = thumb;
  $('sectionText').textContent = L
    ? 'This shape is open for drawing and glows on the output. Click another shape to switch.'
    : 'No section is open. Click a shape on the doorway to open it for drawing.';
  $('btnTemplateSection').disabled = $('btnCloseSection').disabled = !L;
  updatePadGuide();
  sendHighlight();
  sendQr();
  queueIds = null; // re-label queue items for the new section
  updateStatus();
  if (push) {
    api('setState', { section: L || null, aspect: L ? sectionAspect(L) : 1, paperRatio: PAPER_RATIO[S.paper] || 1.4142, thumb })
      .catch((e) => setSubsStatus(`Couldn't update the phones: ${e.message}`));
  }
}

function pickSection(p) {
  if (!building || !building.labels) return;
  const L = labelAt(p);
  if (!L || building.outside[L]) return;
  setActive(L);
}

$('btnCloseSection').addEventListener('click', () => setActive(0));
$('btnPartTemplates').addEventListener('click', printPartTemplates);

// One click to make drawings easy to read: still, solid dots with only a soft glow
function applyPreset(values) {
  for (const [key, v] of Object.entries(values)) {
    S[key] = v;
    const el = document.querySelector(`[data-key="${key}"]`);
    if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
  }
  save();
  refreshOutputs();
  sendSettings();
}
$('btnCrisp').addEventListener('click', () => applyPreset({ motion: 0, wisps: 0, trails: 0, glow: 0.2, pulse: 0.1, size: '2', brightness: 0.9 }));
$('btnDreamy').addEventListener('click', () => applyPreset({ motion: 0.5, wisps: 0.3, trails: 0.55, glow: 0.6, pulse: 0.4, size: '1', brightness: 0.8 }));
$('btnTemplateSection').addEventListener('click', () => { if (activeSection) printSectionTemplate(activeSection); });

function sendHighlight(to) {
  if (S.source !== 'photos' || !building || !building.bbox || !activeSection) {
    CH.postMessage({ type: 'highlight', to, on: false });
    return;
  }
  const L = activeSection, bx = sectionBox(L);
  const mask = new Uint8Array(bx.w * bx.h);
  for (let y = 0; y < bx.h; y++) {
    for (let x = 0; x < bx.w; x++) {
      if (building.labels[(bx.y + y) * building.w + bx.x + x] === L) mask[y * bx.w + x] = 255;
    }
  }
  const area = areaAspect(), op = placeIn(area, outlineMargin());
  CH.postMessage({
    type: 'highlight', to, on: true, aspect: area,
    place: {
      x: op.x + (bx.x / building.w) * op.w, y: op.y + (bx.y / building.h) * op.h,
      w: (bx.w / building.w) * op.w, h: (bx.h / building.h) * op.h,
    },
    w: bx.w, h: bx.h, mask,
  });
}

function sendQr(to) {
  const phones = S.source === 'phones';
  CH.postMessage({
    type: 'qr', to, on: (S.source === 'photos' || phones) && !!S.showQr,
    url: phones ? drawUrl() : submitUrl(),
    caption: phones ? 'Scan to draw<br>on the wall' : 'Scan to draw<br>on the doorway',
  });
}

let pollBusy = false;
async function pollQueue() {
  if (S.source !== 'photos' || pollBusy) return;
  pollBusy = true;
  try {
    const { items } = await api('pending');
    if (S.autoApprove && items.length) {
      // Testing mode: show drawings as soon as they arrive, oldest first
      for (const it of [...items].reverse()) {
        await api('decide', { id: it.id, approve: true });
        it.frame ? placePart(it) : placeSubmission(it);
      }
      setSubsStatus(`Auto-approved ${items.length}`);
      renderQueue([]);
      await syncApproved();
      return;
    }
    setSubsStatus(items.length ? `${items.length} waiting` : 'Listening for drawings');
    renderQueue(items);
    await syncApproved();
  } catch (e) {
    setSubsStatus(e.message === 'offline' ? 'Needs the local server or Vercel' : "Can't reach the server");
  } finally {
    pollBusy = false;
  }
}

function renderQueue(items) {
  const ids = items.map((i) => i.id).join(',');
  if (ids === queueIds) return;
  queueIds = ids;
  const q = $('queue');
  if (!items.length) { q.innerHTML = '<p class="note">No drawings waiting.</p>'; return; }
  q.innerHTML = '';
  for (const it of [...items].reverse()) { // oldest first
    const card = document.createElement('div');
    card.className = 'sub-card';
    const img = new Image();
    img.src = it.png;
    img.alt = 'Submitted drawing';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = new Date(it.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const where = it.frameName ? ` · for <b>${it.frameName}</b>` : it.section === activeSection ? '' : ' · for a different shape';
    meta.innerHTML = `<span>${time}${where}</span>` +
      '<div class="btn-row"><button class="approve">Approve</button><button class="reject">Reject</button></div>';
    meta.querySelector('.approve').addEventListener('click', () => decide(it, true, card));
    meta.querySelector('.reject').addEventListener('click', () => decide(it, false, card));
    card.append(img, meta);
    q.append(card);
  }
}

async function decide(it, approve, card) {
  card.style.opacity = '0.4';
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await api('decide', { id: it.id, approve });
    if (approve) (it.frame ? placePart(it) : placeSubmission(it));
    queueIds = null;
    pollQueue();
  } catch (e) {
    card.style.opacity = '';
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    setSubsStatus(`Couldn't save that: ${e.message}`);
  }
}

// Fit an approved drawing into its shape's box and cut it to the shape's outline
function placeSubmission(it) {
  if (placed.has(it.id) || !building || !building.bbox) return;
  const L = it.section;
  if (!L || L >= building.outside.length || building.outside[L]) return;
  placed.add(it.id);
  const img = new Image();
  img.onload = () => {
    const bx = sectionBox(L);
    const kx = padRaster.width / building.w, ky = padRaster.height / building.h;
    const bb = { x0: bx.x * kx, y0: bx.y * ky, x1: (bx.x + bx.w) * kx, y1: (bx.y + bx.h) * ky };
    paintClipped(bb, regionCanvas(L), (g, s) => {
      g.imageSmoothingEnabled = true;
      g.drawImage(img, bb.x0 * s, bb.y0 * s, (bb.x1 - bb.x0) * s, (bb.y1 - bb.y0) * s);
    });
  };
  img.src = it.png;
}

// ---------- Phone drawings into doorway parts ----------
// Visitors choose a part on their phone and draw on that part's printed template. Each part is a
// real shape on the traced doorway, in the photo's pixel coordinates (see makeDoorway). The phone
// sends exactly the template's shape area, so the drawing maps one-to-one onto the part's box and
// anything past the part's outline is cut off, like the colouring-book mode on the drawing pad.
// A new drawing for a part replaces (fades out) that part's previous drawing.
// Boxes must match DEFAULT_FRAMES in lib/ink-api.js.
function doorHalf(x0, x1, cx, cy, r, left) {
  const p = new Path2D();
  p.moveTo(x0, 600);
  p.lineTo(x0, cy);
  // Up the outer edge, around the quarter arch to its top, then straight down the centre line
  if (left) p.arc(cx, cy, r, Math.PI, Math.PI * 1.5); else p.arc(cx, cy, r, 0, Math.PI * 1.5, true);
  p.lineTo(x1, 600);
  p.closePath();
  return p;
}
function polyPath(pts) {
  const p = new Path2D();
  pts.forEach(([x, y], k) => (k ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}
function archBand(cx, cy, r0, r1) {
  const p = new Path2D();
  p.arc(cx, cy, r0, Math.PI, Math.PI * 2);
  p.arc(cx, cy, r1, Math.PI * 2, Math.PI, true);
  p.closePath();
  return p;
}
const DOOR_PARTS = {
  'left-door': { name: 'Left door', path: doorHalf(370, 461, 461, 270, 91, true), box: [370, 179, 460, 598] },
  'right-door': { name: 'Right door', path: doorHalf(552, 461, 461, 270, 91, false), box: [462, 179, 552, 598] },
  'arch': { name: 'Arch', path: archBand(461, 267, 121, 96), box: [340, 146, 582, 267], polar: { cx: 461, cy: 267, r0: 121, r1: 96 } },
  'left-column': { name: 'Left column', path: polyPath([[281, 153], [332, 153], [332, 522], [281, 522]]), box: [281, 153, 332, 522] },
  'right-column': { name: 'Right column', path: polyPath([[591, 153], [647, 153], [647, 517], [591, 517]]), box: [591, 153, 647, 517] },
  'steps': {
    name: 'Steps',
    path: polyPath([[317, 642], [603, 642], [603, 675], [645, 675], [645, 708], [688, 708], [688, 743],
      [232, 743], [232, 708], [277, 708], [277, 675], [317, 675]]),
    box: [232, 642, 688, 743],
  },
};
const partChunks = new Map(); // part id -> Float32Array of its current drawing's particles
const pathCtx = document.createElement('canvas').getContext('2d');

// The rectangle inside a shape that lets a drawing of this aspect be largest.
// Scans the shape on a 1px grid and checks every maximal rectangle (histogram method).
function bestRectIn(part, drawAspect) {
  const [l, t, r, b] = part.box;
  const w = r - l + 1, h = b - t + 1;
  const heights = new Int32Array(w);
  let best = { x: l, y: t, w: 1, h: 1, scale: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) heights[x] = pathCtx.isPointInPath(part.path, l + x + 0.5, t + y + 0.5) ? heights[x] + 1 : 0;
    const stack = [];
    for (let x = 0; x <= w; x++) {
      const hx = x < w ? heights[x] : 0;
      let start = x;
      while (stack.length && stack[stack.length - 1][1] >= hx) {
        const [sx, sh] = stack.pop();
        const rw_ = x - sx, rh_ = sh;
        const scale = Math.min(rw_ / drawAspect, rh_);
        // Biggest drawing wins; on a tie, the bigger rectangle, so the drawing sits centred in the shape
        if (scale > best.scale * 1.04 || (scale > best.scale * 0.96 && rw_ * rh_ > best.w * best.h)) {
          best = { x: l + sx, y: t + y - sh + 1, w: rw_, h: rh_, scale: Math.max(scale, best.scale) };
        }
        start = sx;
      }
      stack.push([start, hx]);
    }
  }
  return best;
}


const deferredParts = []; // drawings that arrived before the drawing area was set up
function placePart(it) {
  const part = DOOR_PARTS[it.frame];
  if (!part || placed.has(it.id)) return;
  if (!building || !rw) { if (!deferredParts.some((d) => d.id === it.id)) deferredParts.push(it); return; }
  placed.add(it.id);
  const img = new Image();
  img.onload = () => {
    // Photo pixel (doorway trace) -> drawing-area pixel
    const op = placeIn(areaAspect(), outlineMargin());
    const kx = (op.w * rw) / 485, ky = (op.h * rh) / 752;
    const [l, t, r, b] = part.box;
    const boxAspect = (r - l + 1) / (b - t + 1);
    const template = Math.abs(Math.log((img.width / img.height) / boxAspect)) < 0.15;
    const toArea = (px, py) => [op.x * rw + (px - 220) * kx, op.y * rh + py * ky];
    const k = (kx + ky) / 2;

    // A plain-paper drawing is turned sideways when that makes it much bigger in its part
    // (a tall drawing laid along the arch, a wide one stood up in a door). Template photos never turn.
    let src = img;
    const arcStrip = part.polar ? (Math.PI * ((part.polar.r0 + part.polar.r1) / 2)) / (part.polar.r0 - part.polar.r1) : 0;
    const sizeFor = (a) => {
      if (part.polar) { const h = Math.min(arcStrip / a, 1); return h * h * a; }
      const R = bestRectIn(part, a); const h = Math.min(R.w / a, R.h); return h * h * a;
    };
    const fill = S.partFit !== 'fit';
    const targetAspect = part.polar ? arcStrip : boxAspect;
    if (!template) {
      const a0 = img.width / img.height;
      const turn = fill
        ? Math.abs(Math.log(1 / a0 / targetAspect)) < Math.abs(Math.log(a0 / targetAspect)) - 0.2 // less stretching
        : sizeFor(1 / a0) > sizeFor(a0) * 1.3; // bigger
      if (turn) {
        const c = document.createElement('canvas');
        c.width = img.height; c.height = img.width;
        const x = c.getContext('2d');
        x.translate(0, img.width);
        x.rotate(-Math.PI / 2); // a quarter turn left: the drawing's top ends up on the left
        x.drawImage(img, 0, 0);
        src = c;
      }
    }
    const imgAspect = src.width / src.height;

    // Draw the image at a target size and read its ink. When it's shrunk a lot, thicken thin
    // lines by a pixel so they stay solid strokes instead of breaking into dots.
    const sample = (dw, dh) => {
      const c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingEnabled = true;
      x.drawImage(src, 0, 0, dw, dh);
      const d = x.getImageData(0, 0, dw, dh).data;
      if (dw / src.width < 0.6) {
        const src = new Uint8ClampedArray(d);
        for (let y = 0; y < dh; y++) {
          for (let x2 = 0; x2 < dw; x2++) {
            const j = (y * dw + x2) * 4;
            if (src[j + 3] >= 60) continue;
            for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const xx = x2 + ox, yy = y + oy;
              if (xx < 0 || yy < 0 || xx >= dw || yy >= dh) continue;
              const q = (yy * dw + xx) * 4;
              if (src[q + 3] >= 60) { d[j] = src[q]; d[j + 1] = src[q + 1]; d[j + 2] = src[q + 2]; d[j + 3] = 255; break; }
            }
          }
        }
      }
      return d;
    };
    const pts = [], cells = [];
    let gw = 1, gh = 1;

    if (!template && part.polar) {
      // A plain-paper drawing on the arch: unroll the band into a strip, fit the drawing, bend it back
      const { cx, cy, r0, r1 } = part.polar;
      const L = Math.PI * ((r0 + r1) / 2) * k, T = (r0 - r1) * k;
      const s2 = Math.min((L * 0.94) / src.width, (T * 0.9) / src.height);
      let dw = Math.max(1, Math.round(src.width * s2)), dh = Math.max(1, Math.round(src.height * s2));
      if (fill) { dw = Math.max(1, Math.round(L * 0.96)); dh = Math.max(1, Math.round(T * 0.92)); } // stretch along the whole arch
      const sw = Math.round(dw * (r0 / ((r0 + r1) / 2))); // sample along the outer edge so the curve has no gaps
      const d = sample(sw, dh);
      gw = sw; gh = dh;
      const u0 = (L - dw) / 2 / L, v0 = (T - dh) / 2 / T;
      for (let i = 0, j = 0; i < sw * dh; i++, j += 4) {
        if (d[j + 3] < 60) continue;
        const u = u0 + (((i % sw) + 0.5) / sw) * (dw / L), v = v0 + ((((i / sw) | 0) + 0.5) / dh) * (dh / T);
        const ang = Math.PI + u * Math.PI, rr = r0 - v * (r0 - r1);
        const [X, Y] = toArea(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
        pts.push(X / rw, Y / rh, d[j], d[j + 1], d[j + 2]);
        cells.push(i);
      }
    } else {
      // A template photo maps one-to-one onto the part's box; anything else is fitted inside the
      // part without squashing. Either way, anything past the part's outline is cut off.
      let fx, fy, fw, fh;
      if (template) {
        fx = l; fy = t; fw = r - l + 1; fh = b - t + 1;
      } else if (fill) {
        // Stretch over the biggest rectangle inside the part (its whole area for doors and columns)
        const R = bestRectIn(part, boxAspect);
        fx = R.x + R.w * 0.02; fy = R.y + R.h * 0.02; fw = R.w * 0.96; fh = R.h * 0.96;
      } else {
        const R = bestRectIn(part, imgAspect);
        const sc = Math.min((R.w * 0.94) / imgAspect, R.h * 0.94);
        fw = sc * imgAspect; fh = sc;
        fx = R.x + (R.w - fw) / 2; fy = R.y + (R.h - fh) / 2;
      }
      const [bx, by] = toArea(fx, fy);
      const dw = Math.max(1, Math.round(fw * kx)), dh = Math.max(1, Math.round(fh * ky));
      const d = sample(dw, dh);
      gw = dw; gh = dh;
      for (let i = 0, j = 0; i < dw * dh; i++, j += 4) {
        if (d[j + 3] < 60) continue;
        const u = (i % dw) + 0.5, v = ((i / dw) | 0) + 0.5;
        if (!pathCtx.isPointInPath(part.path, fx + u / kx, fy + v / ky)) continue; // cut at the border
        pts.push((bx + u) / rw, (by + v) / rh, d[j], d[j + 1], d[j + 2]);
        cells.push(i);
      }
    }
    const old = partChunks.get(it.frame);
    if (old) {
      CH.postMessage({ type: 'release', group: it.frame });
      pointCount -= old.length / 5;
    }
    const arr = new Float32Array(pts);
    partChunks.set(it.frame, arr);
    pointCount += arr.length / 5;
    // Reveal it as if it were being drawn, over S.drawTime seconds
    let delays = null;
    if (S.drawTime > 0 && cells.length) {
      delays = drawOrder(cells, gw, gh);
      for (let k = 0; k < delays.length; k++) delays[k] *= S.drawTime;
    }
    CH.postMessage({ type: 'add', aspect: rw / rh, res: Math.max(rw, rh), pts: arr, group: it.frame, delays });
    redrawPartsOnPad();
  };
  img.src = it.png;
}

// A photo doesn't record stroke order, so guess one that looks hand-drawn: separate marks one
// after another from left to right, and within a mark, grow outward from its leftmost point
// along the stroke (breadth-first through touching pixels), like ink following a pen.
// cells are pixel indices in a gw x gh grid; returns each one's reveal time from 0 to 1.
function drawOrder(cells, gw, gh) {
  const n = cells.length;
  const idx = new Int32Array(gw * gh).fill(-1);
  for (let k = 0; k < n; k++) idx[cells[k]] = k;
  const dist = new Int32Array(n).fill(-1);
  const comp = new Int32Array(n);
  const lens = [];
  const seeds = Array.from({ length: n }, (_, k) => k).sort((a, b) => (cells[a] % gw) - (cells[b] % gw) || cells[a] - cells[b]);
  const queue = new Int32Array(n);
  for (const s0 of seeds) {
    if (dist[s0] >= 0) continue;
    const id = lens.length;
    let qh = 0, qt = 0, maxD = 0;
    queue[qt++] = s0; dist[s0] = 0; comp[s0] = id;
    while (qh < qt) {
      const k = queue[qh++];
      const c = cells[k], x = c % gw, y = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const q = idx[yy * gw + xx];
          if (q < 0 || dist[q] >= 0) continue;
          dist[q] = dist[k] + 1; comp[q] = id; queue[qt++] = q;
          if (dist[q] > maxD) maxD = dist[q];
        }
      }
    }
    lens.push(maxD + 1);
  }
  // Each mark takes time in proportion to its length, with a short pause between marks
  const GAP = 4;
  let total = 0;
  const start = lens.map((len) => { const s1 = total; total += len + GAP; return s1; });
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = (start[comp[k]] + dist[k]) / total;
  return out;
}

// One printable page per part: the part's shape in light blue (too faint to count as ink),
// placed where the phone expects it, with its name and a small map of the doorway.
function printPartTemplates() {
  if (!building) return;
  const ratio = PAPER_RATIO[S.paper] || 1.2941;
  const paper = S.paper === 'a4' ? ['210mm', '297mm'] : ['8.5in', '11in'];
  const pages = [];
  for (const [id, part] of Object.entries(DOOR_PARTS)) {
    const [l, t, r, b] = part.box;
    const aspect = (r - l + 1) / (b - t + 1);
    const landscape = aspect >= 1;
    const W = landscape ? 2400 : Math.round(2400 / ratio), H = landscape ? Math.round(2400 / ratio) : 2400;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, W, H);
    const p = placeIn(W / H, 0.08, aspect);
    const sx = (p.w * W) / (r - l + 1), sy = (p.h * H) / (b - t + 1);
    x.save();
    x.translate(p.x * W - l * sx, p.y * H - t * sy);
    x.scale(sx, sy);
    x.fillStyle = '#f1f7fe';
    x.fill(part.path);
    x.lineWidth = Math.max(5, W / 420) / sx;
    x.strokeStyle = '#a9cdf9';
    x.lineJoin = 'round';
    x.stroke(part.path);
    x.restore();
    // Name and doorway map in the margins (outside the area the phone reads)
    const m = Math.round(Math.min(W, H) * 0.08);
    x.fillStyle = '#a9cdf9';
    x.textBaseline = 'middle';
    x.font = `600 ${Math.round(m * 0.42)}px -apple-system, Helvetica, sans-serif`;
    x.fillText(part.name.toUpperCase(), Math.round(W * 0.04), Math.round(m * 0.5));
    const lh = Math.round(m * 0.8), lw = Math.round(lh * building.aspect);
    const lx = Math.round(W * 0.03), ly = H - lh - Math.round(m * 0.1);
    const loc = document.createElement('canvas');
    loc.width = building.w; loc.height = building.h;
    const lc = loc.getContext('2d');
    lc.save();
    lc.scale(building.w / 485, building.h / 752);
    lc.translate(-220, 0);
    lc.fillStyle = '#d3e5fd';
    lc.fill(part.path);
    lc.restore();
    lc.drawImage(tintCanvas(outlineCv, '#a9cdf9'), 0, 0);
    x.drawImage(loc, lx, ly, lw, lh);
    x.font = `${Math.round(lh * 0.3)}px -apple-system, Helvetica, sans-serif`;
    x.fillText('Draw inside the shape with a dark marker. Then scan the QR code by the doorway and choose "' + part.name + '".', lx + lw + 24, ly + lh / 2);
    pages.push({ url: c.toDataURL('image/png'), landscape });
  }
  const win = window.open('', '_blank');
  if (!win) return;
  const [pw, ph] = paper;
  win.document.write(`<!doctype html><title>Doorway templates</title><style>
    @page port { size: ${pw} ${ph}; margin: 0 } @page land { size: ${ph} ${pw}; margin: 0 }
    html, body { margin: 0 }
    .pg { break-after: page; } .pg img { display: block; }
    .port { page: port; } .port img { width: ${pw}; height: ${ph}; }
    .land { page: land; } .land img { width: ${ph}; height: ${pw}; }
    </style>${pages.map((p) => `<div class="pg ${p.landscape ? 'land' : 'port'}"><img src="${p.url}"></div>`).join('')}
    <script>Promise.all([...document.images].map(i => i.decode())).then(() => setTimeout(() => print(), 300));<\/script>`);
  win.document.close();
}

// Operator's view: paint every part's current drawing from its particles
function redrawPartsOnPad() {
  padCtx.clearRect(0, 0, pad.width, pad.height);
  const kx = pad.width, ky = pad.height, dot = Math.max(1.5, pad.width / rw);
  for (const arr of partChunks.values()) {
    for (let i = 0; i < arr.length; i += 5) {
      padCtx.fillStyle = `rgb(${arr[i + 2] | 0},${arr[i + 3] | 0},${arr[i + 4] | 0})`;
      padCtx.fillRect(arr[i] * kx - dot / 2, arr[i + 1] * ky - dot / 2, dot, dot);
    }
  }
}

// Show every approved drawing, including ones approved by another window or device,
// in the order they were approved (a later drawing for a part replaces an earlier one).
const seenApproved = new Set();
let clearedAt = 0;
async function syncApproved() {
  if (S.source !== 'photos' || !building || !building.bbox) return;
  if (performance.now() - clearedAt < 2500) return; // let the server finish forgetting them first
  const { ids } = await api('approved');
  for (const id of ids) {
    if (seenApproved.has(id)) continue;
    seenApproved.add(id);
    try { const it = await api(`item&id=${encodeURIComponent(id)}`); it.frame ? placePart(it) : placeSubmission(it); } catch {}
  }
}

// Re-place everything on the doorway (after the sizing setting changes)
function refitParts() {
  for (const [group, arr] of partChunks) {
    CH.postMessage({ type: 'release', group });
    pointCount -= arr.length / 5;
  }
  partChunks.clear();
  placed.clear();
  seenApproved.clear();
  syncApproved().catch(() => {});
}

function replayApproved() {
  pendingReplay = false;
  syncApproved().catch(() => {});
}

// A sheet with just this shape on it (light blue, so it isn't captured as ink),
// placed exactly where the phone page expects it, plus a small map of the doorway.
function printSectionTemplate(L) {
  const ratio = PAPER_RATIO[S.paper] || 1.4142;
  const aspect = sectionAspect(L);
  const landscape = aspect >= 1;
  const W = landscape ? 2400 : Math.round(2400 / ratio), H = landscape ? Math.round(2400 / ratio) : 2400;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, W, H);

  const bx = sectionBox(L);
  const crop = document.createElement('canvas');
  crop.width = bx.w; crop.height = bx.h;
  crop.getContext('2d').drawImage(regionCanvas(L), bx.x, bx.y, bx.w, bx.h, 0, 0, bx.w, bx.h);
  const p = placeIn(W / H, 0.08, aspect);
  const dx = p.x * W, dy = p.y * H, dw = p.w * W, dh = p.h * H;
  // The shape mask is small, so enlarging it gives stair-stepped curves. Blur it at full
  // print size and cut it at half opacity: the steps melt into smooth edges.
  const smooth = document.createElement('canvas');
  smooth.width = Math.round(dw); smooth.height = Math.round(dh);
  const sx = smooth.getContext('2d', { willReadFrequently: true });
  sx.imageSmoothingEnabled = true;
  sx.filter = `blur(${Math.max(2, Math.round((dw / bx.w) * 0.9))}px)`;
  sx.drawImage(crop, 0, 0, smooth.width, smooth.height);
  sx.filter = 'none';
  const sd = sx.getImageData(0, 0, smooth.width, smooth.height);
  for (let j = 3; j < sd.data.length; j += 4) sd.data[j] = Math.min(255, Math.max(0, (sd.data[j] - 110) * 7));
  sx.putImageData(sd, 0, 0);
  x.imageSmoothingEnabled = true;
  const edge = tintCanvas(smooth, '#a9cdf9');
  const k = Math.max(4, Math.round(W / 400));
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    x.drawImage(edge, dx + Math.cos(ang) * k, dy + Math.sin(ang) * k);
  }
  x.drawImage(tintCanvas(smooth, '#f1f7fe'), dx, dy);

  const lh = Math.round(Math.min(W, H) * 0.06), lw = Math.round(lh * building.aspect);
  const lx = Math.round(W * 0.03), ly = H - lh - Math.round(Math.min(W, H) * 0.012);
  x.drawImage(locatorCanvas(L, '#a9cdf9', '#d3e5fd'), lx, ly, lw, lh);
  x.fillStyle = '#a9cdf9';
  x.font = `${Math.round(lh * 0.3)}px -apple-system, Helvetica, sans-serif`;
  x.textBaseline = 'middle';
  x.fillText('Draw inside the shape with a dark marker, then scan the QR code by the doorway to send it.', lx + lw + 24, ly + lh / 2);

  const url = c.toDataURL('image/png');
  const size = S.paper === 'letter' ? 'letter' : 'A4';
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!doctype html><title>Section template</title><style>@page{size:${size} ${landscape ? 'landscape' : 'portrait'};margin:0}html,body{margin:0;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}</style><img src="${url}" onload="setTimeout(()=>print(),300)">`);
  win.document.close();
}

buildOutline();
start();
photosModeChanged();

// ---------- Map the shapes onto the wall (on this laptop) ----------
// The canvas is a mirror of the projector screen. Drag a shape's corners onto the real corners you
// see on the wall, and the projection follows straight away. The shapes are saved here and on the
// server, so visitors' phones show the same shapes.
const mapCv = $('mapCv');
const mapCtx = mapCv.getContext('2d');
let screenSize = S.screenSize || { w: 1920, h: 1080 }; // the projector window, in CSS pixels
let mapSel = null;   // { id, corner } picked corner (arrow keys nudge it)
let mapDrag = null;
let shapesSyncTimer = 0;
const screenAspect = () => screenSize.w / screenSize.h;

function noteScreen(w, h) {
  if (Math.abs(w - screenSize.w) < 1 && Math.abs(h - screenSize.h) < 1) return;
  screenSize = { w, h };
  S.screenSize = screenSize;
  save();
  drawMap();
  syncShapesSoon();
}

function shapeColor(i) { return SHAPE_COLORS[i % SHAPE_COLORS.length]; }

function drawMap() {
  if ($('mapPanel').hidden) return;
  mapCv.style.aspectRatio = `${screenSize.w} / ${screenSize.h}`;
  const dpr = window.devicePixelRatio || 1;
  const cw = mapCv.clientWidth || 600, ch = mapCv.clientHeight || cw / screenAspect();
  if (mapCv.width !== Math.round(cw * dpr) || mapCv.height !== Math.round(ch * dpr)) {
    mapCv.width = Math.round(cw * dpr); mapCv.height = Math.round(ch * dpr);
  }
  const c = mapCtx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#07080a';
  c.fillRect(0, 0, cw, ch);
  c.strokeStyle = 'rgba(255,255,255,0.05)';
  c.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    c.beginPath(); c.moveTo((cw * i) / 10, 0); c.lineTo((cw * i) / 10, ch); c.stroke();
    c.beginPath(); c.moveTo(0, (ch * i) / 10); c.lineTo(cw, (ch * i) / 10); c.stroke();
  }
  c.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  S.shapes.forEach((sh, i) => {
    const col = shapeColor(i);
    const q = sh.quad.map(([x, y]) => [x * cw, y * ch]);
    c.beginPath();
    q.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.globalAlpha = 0.16; c.fillStyle = col; c.fill();
    c.globalAlpha = 1; c.strokeStyle = col; c.lineWidth = 2; c.stroke();
    const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
    c.fillStyle = col; c.textAlign = 'center';
    c.fillText(sh.name, cx, cy + 4);
    c.textAlign = 'left';
    q.forEach(([x, y], k) => {
      const sel = mapSel && mapSel.id === sh.id && mapSel.corner === k;
      c.beginPath(); c.arc(x, y, 8, 0, Math.PI * 2);
      c.lineWidth = 2; c.strokeStyle = sel ? '#fff' : col; c.stroke();
      c.beginPath(); c.arc(x, y, 2, 0, Math.PI * 2); c.fillStyle = sel ? '#fff' : col; c.fill();
      c.fillText('ABCD'[k], x + 10, y - 8);
    });
  });
}

function mapPoint(e) {
  const r = mapCv.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r];
}
function mapHit(u, v, r) {
  let best = null, bd = 14;
  for (const sh of S.shapes) sh.quad.forEach(([x, y], k) => {
    const d = Math.hypot((x - u) * r.width, (y - v) * r.height);
    if (d < bd) { bd = d; best = { id: sh.id, corner: k }; }
  });
  if (best) return best;
  for (let i = S.shapes.length - 1; i >= 0; i--) {
    const q = S.shapes[i].quad;
    let inside = false;
    for (let a = 0, b = 3; a < 4; b = a++) {
      const [xa, ya] = q[a], [xb, yb] = q[b];
      if ((ya > v) !== (yb > v) && u < ((xb - xa) * (v - ya)) / (yb - ya) + xa) inside = !inside;
    }
    if (inside) return { id: S.shapes[i].id, corner: -1 };
  }
  return null;
}

mapCv.addEventListener('pointerdown', (e) => {
  const [u, v, r] = mapPoint(e);
  const hit = mapHit(u, v, r);
  mapCv.focus();
  if (!hit) { mapSel = null; drawMap(); return; }
  if (hit.corner >= 0) mapSel = hit;
  const sh = S.shapes.find((x) => x.id === hit.id);
  mapDrag = { ...hit, u, v, orig: sh.quad.map((p) => p.slice()) };
  mapCv.setPointerCapture(e.pointerId);
  drawMap();
});
mapCv.addEventListener('pointermove', (e) => {
  const [u, v, r] = mapPoint(e);
  if (!mapDrag) {
    const hit = mapHit(u, v, r);
    mapCv.style.cursor = hit ? (hit.corner >= 0 ? 'grab' : 'move') : 'default';
    return;
  }
  const k = e.shiftKey ? 0.2 : 1; // Shift: fine control
  const du = (u - mapDrag.u) * k, dv = (v - mapDrag.v) * k;
  const sh = S.shapes.find((x) => x.id === mapDrag.id);
  if (!sh) return;
  sh.quad = mapDrag.orig.map(([x, y], i) => (mapDrag.corner === -1 || mapDrag.corner === i ? [x + du, y + dv] : [x, y]));
  shapesMoved();
});
['pointerup', 'pointercancel'].forEach((t) => mapCv.addEventListener(t, () => { if (mapDrag) { mapDrag = null; save(); } }));
mapCv.addEventListener('keydown', (e) => {
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = arrows[e.code];
  if (!a || !mapSel) return;
  e.preventDefault();
  const sh = S.shapes.find((x) => x.id === mapSel.id);
  if (!sh) return;
  const step = e.shiftKey ? 10 : 1; // projector pixels
  const p = sh.quad[mapSel.corner];
  sh.quad[mapSel.corner] = [p[0] + (a[0] * step) / screenSize.w, p[1] + (a[1] * step) / screenSize.h];
  shapesMoved();
  save();
});
window.addEventListener('resize', () => drawMap());

// Corners moved: the wall follows right away; phones get the new map shortly after
function shapesMoved() {
  sendParts();
  drawMap();
  syncShapesSoon();
}
// Shapes added, removed or reshaped: the drawing area is laid out again, which clears the drawing
function shapesRelaid() {
  save();
  if (pointCount) doClear(true);
  buildOutline();
  renderShapeList();
  drawMap();
  syncShapesSoon();
}

function syncShapesSoon() {
  clearTimeout(shapesSyncTimer);
  shapesSyncTimer = setTimeout(syncShapes, 500);
}
function syncShapes() {
  if (S.source !== 'phones') return;
  const a = areaAspect(), L = padLong();
  const pw = a >= 1 ? L : Math.round(L * a), ph = a >= 1 ? Math.round(L / a) : L;
  const parts = mapParts().parts;
  const shapes = S.shapes.map((sh) => {
    const p = parts.find((x) => x.id === sh.id);
    return { id: sh.id, name: sh.name, aspect: sh.aspect, quad: sh.quad, tw: p ? Math.round(p.w * pw) : 200, th: p ? Math.round(p.h * ph) : 200 };
  });
  api('setShapes', { shapes, screen: screenAspect() })
    .then(() => setPhonesStatus(phoneStatusText()))
    .catch((err) => setPhonesStatus(err.message === 'offline' ? "Can't reach the server" : err.message));
}

// Proportions of the shape as it appears on the wall (from its corners on the projector)
function wallAspect(sh) {
  const q = sh.quad.map(([x, y]) => [x * screenSize.w, y * screenSize.h]);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return (d(q[0], q[1]) + d(q[3], q[2])) / Math.max(1, d(q[0], q[3]) + d(q[1], q[2]));
}

function renderShapeList() {
  const box = $('shapeList');
  box.innerHTML = '';
  S.shapes.forEach((sh, i) => {
    const row = document.createElement('div');
    row.className = 'shape-row';
    row.innerHTML = `
      <i class="shape-dot" style="background:${shapeColor(i)}"></i>
      <input class="shape-name" type="text" maxlength="40" aria-label="Shape name">
      <label class="shape-aspect">Width ÷ height <input type="number" min="0.1" max="10" step="0.05" aria-label="Proportions"></label>
      <button class="shape-match" title="Set the proportions from how the shape is mapped on the wall">Match the wall</button>
      <button class="shape-del" title="Remove this shape" aria-label="Remove ${sh.name}">✕</button>`;
    const [name, aspect] = row.querySelectorAll('input');
    name.value = sh.name;
    aspect.value = (+sh.aspect).toFixed(2);
    name.addEventListener('input', () => { sh.name = name.value || `Box ${i + 1}`; save(); sendParts(); drawMap(); syncShapesSoon(); });
    aspect.addEventListener('change', () => {
      const v = parseFloat(aspect.value);
      if (!(v > 0.05)) { aspect.value = (+sh.aspect).toFixed(2); return; }
      sh.aspect = Math.min(10, v);
      shapesRelaid();
    });
    row.querySelector('.shape-match').addEventListener('click', () => { sh.aspect = Math.round(wallAspect(sh) * 100) / 100; shapesRelaid(); });
    const del = row.querySelector('.shape-del');
    del.disabled = S.shapes.length < 2;
    del.addEventListener('click', () => { S.shapes = S.shapes.filter((x) => x !== sh); shapesRelaid(); });
    box.append(row);
  });
}

$('btnAddShape').addEventListener('click', () => {
  const n = S.shapes.length;
  const w = 0.22, h = (w * screenSize.w) / screenSize.h / 0.8;
  const x0 = 0.1 + ((n * 0.07) % 0.55), y0 = Math.max(0.05, 0.5 - h / 2 + ((n % 3) - 1) * 0.06);
  S.shapes.push({
    id: `shape-${Date.now().toString(36)}`, name: `Box ${n + 1}`, aspect: 0.8,
    quad: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]],
  });
  shapesRelaid();
});

function initShapes() {
  renderShapeList();
  drawMap();
}

// ---------- Phones drawing live (draw.html) ----------
// Visitors pick a shape on their phone and draw. Each stroke arrives in small pieces about a second
// after it was drawn. It's replayed here at the speed it was drawn, with the same brushes and limits
// as the pad, so it appears on the wall as if drawn live.
let strokeNext = -1;          // position in the server's stroke list (-1 = start from now)
let phonePollTimer = 0, phoneDrainTimer = 0, phoneBusy = false;
let phoneStrokeCount = 0;
const phoneStrokes = new Map(); // sid -> { part, brush, size, color, mix, queue, offset, obj, clip, ended, last }

function setPhonesStatus(t) { $('phonesStatus').textContent = t; }
const phoneStatusText = () => (phoneStrokeCount ? `${phoneStrokeCount} stroke${phoneStrokeCount === 1 ? '' : 's'} so far` : 'Waiting for phones');

function phonesModeChanged() {
  clearInterval(phonePollTimer);
  clearInterval(phoneDrainTimer);
  sendQr();
  if (S.source !== 'phones') return;
  if (!S.outlineOn || S.outlineSrc !== 'shapes') {
    S.outlineOn = true;
    S.outlineSrc = 'shapes';
    save();
    document.querySelector('[data-key="outlineOn"]').checked = true;
    document.querySelector('[data-key="outlineSrc"]').value = 'shapes';
    buildOutline();
    updateSourceFields();
  }
  $('drawLink').href = drawUrl();
  $('drawLink').textContent = drawUrl();
  strokeNext = -1;
  phoneStrokes.clear();
  syncShapes();
  pollPhones();
  phonePollTimer = setInterval(pollPhones, 400);
  phoneDrainTimer = setInterval(drainPhones, 16);
}

async function pollPhones() {
  if (S.source !== 'phones' || phoneBusy) return;
  phoneBusy = true;
  try {
    const r = await api(`strokes&since=${strokeNext}`);
    strokeNext = r.next;
    for (const it of r.items || []) queuePiece(it);
    setPhonesStatus(phoneStatusText());
  } catch (err) {
    setPhonesStatus(err.message === 'offline' ? 'Needs the live site or node serve.js' : "Can't reach the server");
  } finally {
    phoneBusy = false;
  }
}

function queuePiece(it) {
  const part = mapParts().parts.find((p) => p.id === it.shape);
  if (!part) return;
  const vid = it.vid || 'anon';
  if (it.clear) { clearVisitor(vid, it.shape); return; }
  if (!Array.isArray(it.pts)) return;
  const now = performance.now();
  let st = phoneStrokes.get(it.sid);
  if (!st) {
    st = { part, brush: it.brush, size: it.size, color: it.color, mix: it.mix, queue: [], offset: null, obj: null, clip: null, ended: false, last: now,
      own: ownerNum(vid, it.shape), group: visitorGroup(vid, it.shape) };
    phoneStrokes.set(it.sid, st);
    phoneStrokeCount++;
  }
  for (const [u, v, pr, t] of it.pts) {
    if (st.offset == null) st.offset = now + 120 - t; // replay at the speed it was drawn
    st.queue.push({ due: st.offset + t, u, v, pr });
  }
  if (it.end) st.ended = true;
  st.last = now;
}

function drainPhones() {
  if (!phoneStrokes.size || !building || !building.labels) return;
  padTick(); // makes sure the pad is set up at the right size before drawing (cheap when nothing's new)
  if (!padRaster.width || !committed) return;
  const now = performance.now();
  let drew = false;
  for (const [sid, st] of phoneStrokes) {
    while (st.queue.length && st.queue[0].due <= now) {
      const { u, v, pr } = st.queue.shift();
      const p = [(st.part.x + u * st.part.w) * padRaster.width, (st.part.y + v * st.part.h) * padRaster.height];
      let marks;
      const eraser = st.brush === 'eraser';
      if (!st.obj) {
        // Always kept inside the shape it was drawn in. Found from the shape's centre: a stroke that
        // starts right on the shape's border (easy on a small sideways phone) would otherwise be lost.
        const L = labelAt([(st.part.x + st.part.w / 2) * padRaster.width, (st.part.y + st.part.h / 2) * padRaster.height]);
        st.clip = L && !building.outside[L] ? regionCanvas(L) : EMPTY_CLIP;
        st.obj = createStroke(eraser ? { brush: 'pen', size: st.size, color: '#ffffff', mix: 0 } : { brush: st.brush, size: st.size, color: st.color, mix: st.mix });
        marks = st.obj.begin(p, pr);
      } else {
        marks = st.obj.move(p, pr);
      }
      if (!marks.length) continue;
      if (eraser) { eraseMarks(st, marks); continue; } // only ever removes this visitor's own lines
      const keep = strokeClip, wasDirty = padDirty;
      strokeClip = st.clip;
      drawMarks(marks);
      strokeClip = keep;
      commitRegion(marksBounds(marks), st.own, st.group); // on the wall right away, tagged as theirs
      padDirty = wasDirty; // already sent, so the whole pad needn't be scanned again for it
      drew = true;
    }
    if (!st.queue.length && (st.ended || now - st.last > 8000)) phoneStrokes.delete(sid);
  }
  if (drew) padVersion++;
}

// ---------- Visitors' own lines: Clear and the eraser on the phone ----------
// Every pad pixel a phone stroke adds is tagged with whose it is (one tag per phone per shape), and its
// particles join that tag's group on the output. A visitor's Clear or eraser then removes only their
// own lines, on the pad and on the wall, and never anyone else's.
let owner = null;                 // per pad pixel: whose it is (0 = the operator / nobody)
const ownerIds = new Map();       // 'vid|shape' -> tag number
const visitorChunks = new Map();  // group -> [Float32Array of particles], for output windows opened later
const ownerNum = (vid, shape) => {
  const k = `${vid}|${shape}`;
  if (!ownerIds.has(k)) ownerIds.set(k, ownerIds.size + 1);
  return ownerIds.get(k);
};
const visitorGroup = (vid, shape) => `v:${vid}:${shape}`;
function ensureOwner() {
  const n = padRaster.width * padRaster.height;
  if (!owner || owner.length !== n) owner = new Int32Array(n);
}
function boxOf(b) {
  const w = padRaster.width, h = padRaster.height;
  const x0 = Math.max(0, Math.floor(b.x0)), y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(w, Math.ceil(b.x1)), y1 = Math.min(h, Math.ceil(b.y1));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1, bw: x1 - x0, bh: y1 - y0 } : null;
}

// Sends the new ink in one area to the wall, tagged with whose it is (like padTick, for one area)
function commitRegion(bounds, own, group) {
  const b = boxOf(bounds);
  if (!b || !committed) return;
  ensureOwner();
  const w = padRaster.width, h = padRaster.height;
  const d = padRctx.getImageData(b.x0, b.y0, b.bw, b.bh).data;
  const pts = [];
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0, j = (y - b.y0) * b.bw * 4; x < b.x1; x++, j += 4) {
      const i = y * w + x;
      if (committed[i] || d[j + 3] < 60) continue;
      committed[i] = 1;
      owner[i] = own;
      if (pointCount + pts.length / 5 < MAX_POINTS) pts.push((x + 0.5) / w, (y + 0.5) / h, d[j], d[j + 1], d[j + 2]);
    }
  }
  if (!pts.length) return;
  const arr = new Float32Array(pts);
  pointCount += arr.length / 5;
  if (!visitorChunks.has(group)) visitorChunks.set(group, []);
  visitorChunks.get(group).push(arr);
  CH.postMessage({ type: 'add', aspect: w / h, res: Math.max(w, h), pts: arr, live: true, group });
}

// Removes pixels from the pad and from what later output windows get. tell = also fade them on the wall.
const eraseMaskCv = document.createElement('canvas');
let erasedMark = null;
function erasePixels(idx, group, tell) {
  if (!idx.length) return;
  const w = padRaster.width, h = padRaster.height;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const i of idx) {
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(w - 1, x1 + 1); y1 = Math.min(h - 1, y1 + 1);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const mask = new ImageData(bw, bh);
  const hit = (x, y) => { mask.data[((y - y0) * bw + (x - x0)) * 4 + 3] = 255; };
  for (const i of idx) {
    const x = i % w, y = (i / w) | 0;
    committed[i] = 0; owner[i] = 0;
    hit(x, y);
    // also the faint, never-captured edge pixels around the line
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 && !committed[ny * w + nx]) hit(nx, ny);
    }
  }
  padVersion++;
  eraseMaskCv.width = bw; eraseMaskCv.height = bh;
  eraseMaskCv.getContext('2d').putImageData(mask, 0, 0);
  for (const [c, k] of [[padRctx, 1], [padCtx, PAD_SCALE]]) {
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.imageSmoothingEnabled = false;
    c.drawImage(eraseMaskCv, x0 * k, y0 * k, bw * k, bh * k);
    c.restore();
  }
  // Drop them from the particles kept for output windows opened later
  if (!erasedMark || erasedMark.length !== w * h) erasedMark = new Uint8Array(w * h);
  for (const i of idx) erasedMark[i] = 1;
  const list = visitorChunks.get(group) || [];
  for (let n = 0; n < list.length; n++) {
    const a = list[n], keep = [];
    for (let k = 0; k + 4 < a.length; k += 5) {
      const i = Math.floor(a[k + 1] * h) * w + Math.floor(a[k] * w);
      if (erasedMark[i]) pointCount--; else keep.push(a[k], a[k + 1], a[k + 2], a[k + 3], a[k + 4]);
    }
    if (keep.length !== a.length) list[n] = new Float32Array(keep);
  }
  for (const i of idx) erasedMark[i] = 0;
  if (tell) CH.postMessage({ type: 'erase', group, w, h, idx });
}

// The visitor's eraser: removes only their own lines under it
const eraserCv = document.createElement('canvas');
function eraseMarks(st, marks) {
  const b = boxOf(marksBounds(marks));
  if (!b || !committed) return;
  ensureOwner();
  const w = padRaster.width, h = padRaster.height;
  if (eraserCv.width !== w || eraserCv.height !== h) { eraserCv.width = w; eraserCv.height = h; }
  const g = eraserCv.getContext('2d', { willReadFrequently: true });
  g.clearRect(b.x0, b.y0, b.bw, b.bh);
  paintMarks(g, 1, marks);
  const d = g.getImageData(b.x0, b.y0, b.bw, b.bh).data;
  const idx = [];
  for (let y = b.y0; y < b.y1; y++) {
    for (let x = b.x0, j = (y - b.y0) * b.bw * 4 + 3; x < b.x1; x++, j += 4) {
      const i = y * w + x;
      if (d[j] > 20 && owner[i] === st.own) idx.push(i);
    }
  }
  if (idx.length) erasePixels(Int32Array.from(idx), st.group, true);
}

// The visitor's Clear: all their lines in that shape drift away
function clearVisitor(vid, shape) {
  const own = ownerIds.get(`${vid}|${shape}`), group = visitorGroup(vid, shape);
  for (const [sid, st] of phoneStrokes) if (st.own === own) phoneStrokes.delete(sid);
  if (own && owner) {
    const idx = [];
    for (let i = 0; i < owner.length; i++) if (owner[i] === own) idx.push(i);
    erasePixels(Int32Array.from(idx), group, false);
  }
  visitorChunks.delete(group);
  CH.postMessage({ type: 'release', group });
}

// ---------- The drawing pad as the wall (with mapped shapes) ----------
// With "My shapes", the pad is shown as a mirror of the projector screen: each shape sits where it's
// mapped, skewed the same way, so it's clear which box is which. You draw straight on the skewed
// shapes; a stroke goes through the corners of the shape it starts in, like drawing on the projection.
var wallViewReady = false;
var wallPen = null;   // { h, part } while drawing on the wall view
const wallView = document.createElement('div');
wallView.className = 'wall-view';
wallView.hidden = true;
$('padStage').append(wallView);
const wallTiles = new Map(); // shape id -> { cv, cx, label }
let wallRaf = 0;

const wallOn = () => isPad() && S.source !== 'photos' && !!building && S.outlineOn && S.outlineSrc === 'shapes';

function updateWallView() {
  const on = wallOn();
  wallView.hidden = !on;
  pad.style.display = on ? 'none' : '';
  if (on && !wallRaf) wallRaf = setInterval(wallFrame, 33); // a timer, so it keeps up even when this window isn't in front
  if (!on && wallRaf) { clearInterval(wallRaf); wallRaf = 0; }
  if (on) wallFrame();
}

function wallSize() {
  const stage = $('padStage');
  const maxW = Math.max(200, stage.clientWidth - 28), maxH = Math.max(200, window.innerHeight * 0.7);
  let w = maxW, h = w / screenAspect();
  if (h > maxH) { h = maxH; w = h * screenAspect(); }
  return { w: Math.round(w), h: Math.round(h) };
}

function wallFrame() {
  if (!wallOn()) { updateWallView(); return; }
  const { w: W, h: H } = wallSize();
  if (wallView.style.width !== `${W}px` || wallView.style.height !== `${H}px`) {
    wallView.style.width = `${W}px`; wallView.style.height = `${H}px`;
  }
  const parts = mapParts().parts.filter((p) => p.quad);
  for (const [id, t] of wallTiles) if (!parts.some((p) => p.id === id)) { t.cv.remove(); t.label.remove(); wallTiles.delete(id); }
  parts.forEach((p) => {
    const i = S.shapes.findIndex((x) => x.id === p.id);
    let t = wallTiles.get(p.id);
    if (!t) {
      const cv = document.createElement('canvas');
      const label = document.createElement('span');
      label.className = 'wall-label';
      wallView.append(cv, label);
      t = { cv, cx: cv.getContext('2d'), label, tf: '' };
      wallTiles.set(p.id, t);
    }
    // The shape's piece of the pad, at about the size it's shown (sharp, but no bigger than needed)
    const q = p.quad.map(([a, b]) => [a * W, b * H]);
    const sx = p.x * pad.width, sy = p.y * pad.height, sw = Math.max(1, p.w * pad.width), sh = Math.max(1, p.h * pad.height);
    const shown = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]));
    const k = Math.min(1, (shown * (window.devicePixelRatio || 1) * 1.2) / sw);
    const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
    const col = shapeColor(Math.max(0, i));
    const key = `${padVersion}|${cw}x${ch}|${col}`;
    if (t.cv.width !== cw || t.cv.height !== ch) {
      t.cv.width = cw; t.cv.height = ch;
      t.cv.style.width = `${cw}px`; t.cv.style.height = `${ch}px`;
      t.tf = '';
    }
    if (t.key !== key) {
      t.key = key;
      const c = t.cx;
      c.fillStyle = '#f3f0e8';
      c.fillRect(0, 0, cw, ch);
      c.drawImage(pad, sx, sy, sw, sh, 0, 0, cw, ch);
      c.strokeStyle = col;
      c.lineWidth = Math.max(2, cw / 120);
      c.strokeRect(c.lineWidth / 2, c.lineWidth / 2, cw - c.lineWidth, ch - c.lineWidth);
    }
    // Warp it onto the shape's corners
    const h = solveHomography([[0, 0], [cw, 0], [cw, ch], [0, ch]], q);
    if (h) {
      const tf = `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
      if (tf !== t.tf) { t.cv.style.transform = tf; t.tf = tf; }
    }
    const cx = q.reduce((a, v) => a + v[0], 0) / 4, cy = Math.min(...q.map((v) => v[1]));
    t.label.textContent = p.name || `Shape ${i + 1}`;
    t.label.style.color = col;
    t.label.style.left = `${cx}px`;
    t.label.style.top = `${cy}px`;
  });
}

function wallInQuad(q, u, v) {
  let inside = false;
  for (let a = 0, b = 3; a < 4; b = a++) {
    const [xa, ya] = q[a], [xb, yb] = q[b];
    if ((ya > v) !== (yb > v) && u < ((xb - xa) * (v - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
// The shape under the pointer, with the mapping from the wall view onto its piece of the pad
function wallPartAt(e) {
  const r = wallView.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  const parts = mapParts().parts.filter((p) => p.quad);
  for (let k = parts.length - 1; k >= 0; k--) {
    const p = parts[k];
    if (!wallInQuad(p.quad, u, v)) continue;
    const X = padRaster.width, Y = padRaster.height;
    const h = solveHomography(p.quad.map(([a, b]) => [a * r.width, b * r.height]),
      [[p.x * X, p.y * Y], [(p.x + p.w) * X, p.y * Y], [(p.x + p.w) * X, (p.y + p.h) * Y], [p.x * X, (p.y + p.h) * Y]]);
    if (h) return { h, part: p };
  }
  return null;
}
function wallPos(e) {
  const r = wallView.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, h = wallPen.h;
  const d = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
}
wallView.addEventListener('pointerdown', padDown);
wallView.addEventListener('pointermove', padMove);
['pointerup', 'pointercancel'].forEach((t) => wallView.addEventListener(t, padUp));
wallViewReady = true;
updateWallView();

// ---------- Paper sheets with template boxes (camera) ----------
// Visitors draw on a printed sheet that shows every mapped box, laid out as on the wall. When a
// finished sheet is placed under the camera and nothing has moved for a moment, the whole sheet is
// read at once: the ink inside each box goes to the same box on the wall, all in one random colour.
// The sheet must then be taken away before the next one is read. After the 5th sheet the wall
// clears itself (Each drawing's glow, and drawings taking turns, happen in the output window).
const SHEET_COLORS = ['#ff4d6d', '#ff8a3d', '#ffd23f', '#4dff88', '#3dd6ff', '#5b7cff', '#b45bff', '#ff5bd1', '#7affe4', '#c6ff3d'];
const SHEETS_PER_ROUND = 5;
const sheet = { state: 'empty', since: 0, count: 0, n: 0, clearTimer: 0, goneSince: 0, baseline: 0, lastColor: -1 };
const sheetChunks = new Map(); // group -> { pts, box, rect } (for output windows opened later)

function setSheetStatus(t) { const el = $('sheetStatus'); if (el && el.textContent !== t) el.textContent = t; }
const sheetWaitingForRemoval = () => sheet.state === 'taken';

function sheetModeChanged() {
  updateSourceFields();
  if (!sheetMode()) return;
  if (!S.outlineOn || S.outlineSrc !== 'shapes') {
    S.outlineOn = true;
    S.outlineSrc = 'shapes';
    save();
    document.querySelector('[data-key="outlineOn"]').checked = true;
    document.querySelector('[data-key="outlineSrc"]').value = 'shapes';
    buildOutline();
    updateSourceFields();
  }
  sheet.state = 'empty'; sheet.since = 0;
  setSheetStatus(sheet.count ? `${sheet.count} of ${SHEETS_PER_ROUND} sheets on the wall. Place the next sheet.` : 'Waiting for a sheet.');
}

// Where each box sits on the sheet: its place on the wall, straightened, fitted to the paper.
// Returns { landscape, boxes: [{ id, name, x, y, w, h }] } in fractions of the sheet.
function sheetLayout() {
  const list = S.shapes.filter((sh) => sh.quad);
  if (!list.length) return { landscape: true, boxes: [] };
  const SW = screenSize.w, SH = screenSize.h;
  const bb = list.map((sh) => {
    const xs = sh.quad.map((c) => c[0] * SW), ys = sh.quad.map((c) => c[1] * SH);
    return { sh, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  });
  const U = { x0: Math.min(...bb.map((b) => b.x0)), x1: Math.max(...bb.map((b) => b.x1)), y0: Math.min(...bb.map((b) => b.y0)), y1: Math.max(...bb.map((b) => b.y1)) };
  const Uw = Math.max(1, U.x1 - U.x0), Uh = Math.max(1, U.y1 - U.y0);
  const ratio = PAPER_RATIO[S.paper] || 1.4142;
  const landscape = Uw >= Uh;
  const A = landscape ? ratio : 1 / ratio; // sheet width, with its height = 1
  const m = 0.08;
  const k = Math.min((A * (1 - 2 * m)) / Uw, (1 - 2 * m) / Uh);
  const ox = (A - Uw * k) / 2, oy = (1 - Uh * k) / 2;
  const boxes = bb.map(({ sh, x0, x1, y0, y1 }) => {
    const cx = ox + ((x0 + x1) / 2 - U.x0) * k, cy = oy + ((y0 + y1) / 2 - U.y0) * k;
    // The box keeps the shape's own proportions inside the space its corners take up
    const aw = (x1 - x0) * k * 0.94, ah = (y1 - y0) * k * 0.94;
    let w = aw, h = w / sh.aspect;
    if (h > ah) { h = ah; w = h * sh.aspect; }
    return { id: sh.id, name: sh.name, x: (cx - w / 2) / A, y: cy - h / 2, w: w / A, h };
  });
  return { landscape, boxes };
}

function sheetTick(now, inkCount) {
  if (sheet.state === 'taken') {
    // Wait for the sheet to be taken away (or to go blank) before reading another
    const gone = !paperSeen || inkCount < Math.max(40, sheet.baseline * 0.15);
    if (gone) {
      if (!sheet.goneSince) sheet.goneSince = now;
      else if (now - sheet.goneSince > 600) {
        sheet.state = 'empty';
        lastDrawnBoxes = null;
        setSheetStatus(`${sheet.count} of ${SHEETS_PER_ROUND} sheets on the wall. Place the next sheet.`);
      }
    } else sheet.goneSince = 0;
    return;
  }
  if (!corners || !paperSeen || !inkBuf) { sheet.state = 'empty'; return; }
  // Read it once the paper has stopped moving and no hand is over it
  const still = stillnessMap();
  let calm = true;
  for (let b = 0; b < still.length; b++) if (!still[b]) { calm = false; break; }
  const settled = (paperMode === 'locked' || (stableSince && now - stableSince > 500)) && calm && inkCount > 30;
  if (!settled) { if (sheet.state === 'settling') setSheetStatus('Hold still…'); sheet.state = 'empty'; return; }
  if (sheet.state !== 'settling') { sheet.state = 'settling'; sheet.since = now; setSheetStatus('Sheet found. Reading it…'); return; }
  if (now - sheet.since > 700) captureSheet(inkCount);
}

function captureSheet(inkCount) {
  const { boxes } = sheetLayout();
  const parts = new Map(mapParts().parts.map((p) => [p.id, p]));
  const mask = inkBuf.mask;
  const per = new Map();
  // Boxes drawn by hand on the sheet? Then they're used instead of the printed template's positions.
  const drawn = findDrawnBoxes(mask, rw, rh, boxes);
  // One random colour for the whole sheet (never the same as the last one)
  let ci;
  do { ci = Math.floor(Math.random() * SHEET_COLORS.length); } while (ci === sheet.lastColor && SHEET_COLORS.length > 1);
  sheet.lastColor = ci;
  const hex = SHEET_COLORS[ci];
  const R = parseInt(hex.slice(1, 3), 16), G = parseInt(hex.slice(3, 5), 16), B = parseInt(hex.slice(5, 7), 16);
  const inset = 0.02; // skip the box's own printed edge
  let total = 0;
  if (drawn) {
    // Ink inside each drawn box (not its outline), placed through the box's four corners
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        if (!mask[i] || !keep(i) || drawn.depth[i] <= drawn.edge) continue;
        const b = drawn.byLabel.get(drawn.label[i]);
        if (!b) continue;
        const p = parts.get(b.id);
        if (!p) continue;
        const h = b.h, dd = h[6] * x + h[7] * y + 1;
        const tu = Math.min(1, Math.max(0, (h[0] * x + h[1] * y + h[2]) / dd)), tv = Math.min(1, Math.max(0, (h[3] * x + h[4] * y + h[5]) / dd));
        if (!per.has(b.id)) per.set(b.id, []);
        per.get(b.id).push(p.x + tu * p.w, p.y + tv * p.h, R, G, B);
        total++;
      }
    }
  }
  for (let y = 0; y < rh && !drawn; y++) {
    const v = (y + 0.5) / rh;
    for (let x = 0; x < rw; x++) {
      const i = y * rw + x;
      if (!mask[i] || !keep(i)) continue;
      const u = (x + 0.5) / rw;
      for (const b of boxes) {
        const tu = (u - b.x) / b.w, tv = (v - b.y) / b.h;
        if (tu < inset || tu > 1 - inset || tv < inset || tv > 1 - inset) continue;
        const p = parts.get(b.id);
        if (!p) break;
        if (!per.has(b.id)) per.set(b.id, []);
        per.get(b.id).push(p.x + tu * p.w, p.y + tv * p.h, R, G, B);
        total++;
        break;
      }
    }
  }
  sheet.state = 'taken'; sheet.goneSince = 0; sheet.baseline = inkCount;
  if (autoLocked || paperMode === 'locked') { paperMode = 'auto'; autoLocked = false; stableSince = 0; candidate = null; }
  lastDrawnBoxes = drawn ? drawn.boxes : null;
  if (total < 20) { setSheetStatus(drawn ? `Found ${drawn.boxes.length} box${drawn.boxes.length === 1 ? '' : 'es'}, but nothing drawn inside. Take the sheet away and try another.` : 'Nothing drawn inside the boxes. Take the sheet away and try another.'); return; }
  const found = drawn ? ` Found ${drawn.boxes.length} of ${boxes.length} drawn boxes.` : '';
  // The 5th sheet already had its time: clear the wall before this one goes up
  if (sheet.clearTimer) doClear(true);
  sheet.n++;
  sheet.count++;
  const room = Math.max(0, MAX_POINTS - pointCount);
  for (const [id, list] of per) {
    const p = parts.get(id);
    let arr = new Float32Array(list);
    if (arr.length / 5 > room) arr = arr.slice(0, Math.floor(room) * 5);
    if (!arr.length) continue;
    const group = `sheet:${sheet.n}:${id}`;
    const rect = { x: p.x, y: p.y, w: p.w, h: p.h };
    sheetChunks.set(group, { pts: arr, box: id, rect });
    pointCount += arr.length / 5;
    CH.postMessage({ type: 'sheet', group, box: id, rect });
    CH.postMessage({ type: 'add', aspect: rw / rh, res: Math.max(rw, rh), pts: arr, group });
  }
  if (sheet.count >= SHEETS_PER_ROUND) {
    sheet.clearTimer = setTimeout(() => { sheet.clearTimer = 0; doClear(true); }, S.sheetClearAfter * 1000);
    setSheetStatus(`Sheet ${sheet.count} of ${SHEETS_PER_ROUND} is up.${found} The wall clears in ${S.sheetClearAfter} s. Take the sheet away.`);
  } else {
    setSheetStatus(`Sheet ${sheet.count} of ${SHEETS_PER_ROUND} is up.${found} Take the sheet away for the next one.`);
  }
}

// ---------- Boxes drawn by hand ----------
// Finds boxes drawn in marker on a blank sheet: closed outlines big enough to be a box. Everything the
// outside of the sheet can't reach (the box line, its inside and the drawing in it) is one blob per box.
// Each blob's four corners map it onto its wall box, and how deep a pixel is inside the blob tells the
// box's own outline (near the edge) apart from the drawing (further in).
// Drawn boxes are matched to wall boxes by where they sit on the sheet. Returns null when none are found.
let lastDrawnBoxes = null; // [{ quad, name }] shown on the operator's paper view
function findDrawnBoxes(mask, w, h, layout) {
  const n = w * h;
  // 1. Close small gaps in hand-drawn lines (2 px each way)
  const R = 2, tmp = new Uint8Array(n), dil = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    let run = -1e9;
    for (let x = 0; x < w + R; x++) {
      if (x < w && mask[y * w + x]) run = x;
      const tx = x - R;
      if (tx >= 0 && tx < w && x - run <= 2 * R) tmp[y * w + tx] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = -1e9;
    for (let y = 0; y < h + R; y++) {
      if (y < h && tmp[y * w + x]) run = y;
      const ty = y - R;
      if (ty >= 0 && ty < h && y - run <= 2 * R) dil[ty * w + x] = 1;
    }
  }
  // 2. Flood the outside in from the sheet's edges
  const outside = new Uint8Array(n), queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = (i) => { if (!dil[i] && !outside[i]) { outside[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  // 3. Blobs of what the outside couldn't reach
  const label = new Int32Array(n);
  const blobs = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (outside[s0] || label[s0]) continue;
    const id = blobs.length + 1;
    const b = { id, area: 0, sx: 0, sy: 0, x0: w, y0: h, x1: 0, y1: 0, tl: [0, 0, 1e9], tr: [0, 0, -1e9], br: [0, 0, -1e9], bl: [0, 0, 1e9] };
    qh = qt = 0;
    label[s0] = id; queue[qt++] = s0;
    while (qh < qt) {
      const i = queue[qh++], x = i % w, y = (i / w) | 0;
      b.area++; b.sx += x; b.sy += y;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      if (x + y < b.tl[2]) b.tl = [x, y, x + y];
      if (x - y > b.tr[2]) b.tr = [x, y, x - y];
      if (x + y > b.br[2]) b.br = [x, y, x + y];
      if (x - y < b.bl[2]) b.bl = [x, y, x - y];
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !outside[j] && !label[j]) { label[j] = id; queue[qt++] = j; }
    }
    blobs.push(b);
  }
  // Big enough to be a box, and box-like (fills most of its bounding box)
  const boxes = blobs.filter((b) => {
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    return b.area > n * 0.012 && bw > w * 0.06 && bh > h * 0.06 && b.area / (bw * bh) > 0.6;
  }).sort((a, b) => b.area - a.area).slice(0, Math.max(1, layout.length));
  if (!boxes.length || !layout.length) return null;
  // 4. Match drawn boxes to wall boxes by position (each set scaled to its own extent)
  const norm = (pts) => {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const ax = Math.min(...xs), bx = Math.max(...xs), ay = Math.min(...ys), by = Math.max(...ys);
    return pts.map(([x, y]) => [bx - ax > 1e-6 ? (x - ax) / (bx - ax) : 0.5, by - ay > 1e-6 ? (y - ay) / (by - ay) : 0.5]);
  };
  const dc = norm(boxes.map((b) => [b.sx / b.area / w, b.sy / b.area / h]));
  const wc = norm(layout.map((L) => [L.x + L.w / 2, L.y + L.h / 2]));
  const pairs = [];
  dc.forEach((a, i) => wc.forEach((c, j) => pairs.push([Math.hypot(a[0] - c[0], a[1] - c[1]), i, j])));
  pairs.sort((a, b) => a[0] - b[0]);
  const usedD = new Set(), usedW = new Set(), byLabel = new Map(), found = [];
  for (const [, i, j] of pairs) {
    if (usedD.has(i) || usedW.has(j)) continue;
    usedD.add(i); usedW.add(j);
    const b = boxes[i];
    const quad = [b.tl, b.tr, b.br, b.bl].map(([x, y]) => [x, y]);
    const hm = solveHomography(quad, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    if (!hm) continue;
    byLabel.set(b.id, { id: layout[j].id, h: hm });
    found.push({ quad, name: layout[j].name });
  }
  if (!found.length) return null;
  // 5. How deep each pixel is inside its blob (2-pass chamfer distance): the box's outline sits near
  // the blob's edge, the drawing further in
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) depth[i] = outside[i] ? 0 : 1e6;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!depth[i]) continue;
    let d = depth[i];
    if (x > 0) d = Math.min(d, depth[i - 1] + 1);
    if (y > 0) d = Math.min(d, depth[i - w] + 1);
    if (x > 0 && y > 0) d = Math.min(d, depth[i - w - 1] + 1.414);
    if (x < w - 1 && y > 0) d = Math.min(d, depth[i - w + 1] + 1.414);
    depth[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!depth[i]) continue;
    let d = depth[i];
    if (x < w - 1) d = Math.min(d, depth[i + 1] + 1);
    if (y < h - 1) d = Math.min(d, depth[i + w] + 1);
    if (x < w - 1 && y < h - 1) d = Math.min(d, depth[i + w + 1] + 1.414);
    if (x > 0 && y < h - 1) d = Math.min(d, depth[i + w - 1] + 1.414);
    depth[i] = d;
  }
  // The outline's thickness: how deep its ink goes in at the middle of each box's left edge
  let edge = 4;
  for (const b of boxes) {
    const y = Math.round((b.y0 + b.y1) / 2);
    let x = b.x0;
    while (x < b.x1 && !mask[y * w + x]) x++;
    let t = 0;
    while (x + t < b.x1 && mask[y * w + x + t]) t++;
    edge = Math.max(edge, t + R + 3);
  }
  edge = Math.min(edge, Math.round(Math.min(w, h) * 0.04));
  return { label, depth, edge, byLabel, boxes: found };
}

// Called from doClear: a fresh round
function sheetCleared() {
  clearTimeout(sheet.clearTimer);
  sheet.clearTimer = 0;
  sheet.count = 0;
  sheetChunks.clear();
  if (sheetMode()) setSheetStatus(sheet.state === 'taken' ? 'Wall cleared. Take the sheet away for the next one.' : 'Wall cleared. Waiting for a sheet.');
}

// The printed sheet: every mapped box in light blue (too faint to count as ink), named, laid out as on the wall
$('btnSheetTemplate').addEventListener('click', () => {
  const { landscape, boxes } = sheetLayout();
  if (!boxes.length) return;
  const ratio = PAPER_RATIO[S.paper] || 1.4142;
  const W = landscape ? 2400 : Math.round(2400 / ratio), H = landscape ? Math.round(2400 / ratio) : 2400;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, W, H);
  x.strokeStyle = '#a9cdf9';
  x.fillStyle = '#a9cdf9';
  x.lineWidth = 6;
  x.textAlign = 'center';
  x.font = '600 34px -apple-system, Helvetica, sans-serif';
  for (const b of boxes) {
    x.strokeRect(b.x * W, b.y * H, b.w * W, b.h * H);
    x.fillText(b.name || '', (b.x + b.w / 2) * W, b.y * H - 16);
  }
  x.font = '500 30px -apple-system, Helvetica, sans-serif';
  x.fillText('Draw inside the boxes with a dark marker', W / 2, H - 0.035 * H);
  const url = c.toDataURL('image/png');
  const size = S.paper === 'letter' ? 'letter' : 'A4';
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`<!doctype html><title>Sheet template</title><style>@page{size:${size} ${landscape ? 'landscape' : 'portrait'};margin:0}html,body{margin:0;height:100%}img{width:100%;height:100%;object-fit:contain;display:block}</style><img src="${url}" onload="setTimeout(()=>print(),300)">`);
  win.document.close();
});

sheetModeChanged();

initShapes();
phonesModeChanged();
