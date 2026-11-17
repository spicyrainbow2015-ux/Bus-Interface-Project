// Phone page: choose a part of the doorway, photograph a drawing on any paper, pull out
// just the ink, trim to the drawing, and send it to the operator's approval queue.
// All image processing happens on the phone, so only a small transparent PNG is uploaded.
import { detectPaper, warpQuad, extractInk, makeInkBuffers } from './vision.js';

const $ = (id) => document.getElementById(id);
const API = '/api/ink';
const RECT_LONG = 1000;   // flattened sheet resolution (long side)
const PAD = 0.04;         // breathing room around the trimmed drawing

let frames = [];
let frame = null;         // { id, name } the visitor picked
let photo = null;         // loaded <img>
let turns = 0;            // quarter turns applied by the Rotate button
let result = null;        // { png, w, h }

function show(step) {
  for (const s of ['stepPick', 'stepCapture', 'stepReview', 'stepDone']) $(s).hidden = s !== step;
  window.scrollTo(0, 0);
}

// ---------- 1. Pick a part ----------
async function loadFrames() {
  try {
    const r = await fetch(`${API}?op=state`, { cache: 'no-store' });
    frames = (await r.json()).frames || [];
  } catch { frames = []; }
  const box = $('frames');
  if (!frames.length) {
    box.innerHTML = '<p class="msg err">Couldn\'t load the doorway. Check your connection and reload.</p>';
    return;
  }
  box.innerHTML = '';
  for (const f of frames) {
    const b = document.createElement('button');
    b.textContent = f.name;
    b.addEventListener('click', () => pickFrame(f));
    box.append(b);
  }
}

function pickFrame(f) {
  frame = f;
  document.querySelectorAll('[data-frame-name]').forEach((el) => (el.textContent = f.name));
  show(photo && result ? 'stepReview' : 'stepCapture');
}
document.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => show('stepPick')));
loadFrames();

// ---------- 2. Photo in ----------
for (const id of ['fileTake', 'filePick']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => { photo = img; turns = 0; processPhoto(); show('stepReview'); };
    img.onerror = () => alert("Couldn't open that photo. Try another one.");
    img.src = URL.createObjectURL(file);
  });
}

// ---------- 3. Find the sheet, keep the ink, trim to the drawing ----------
function processPhoto() {
  // Photo into a canvas (phone photos are huge; 1600px is plenty)
  const k = Math.min(1, 1600 / Math.max(photo.naturalWidth, photo.naturalHeight));
  const fw = Math.round(photo.naturalWidth * k), fh = Math.round(photo.naturalHeight * k);
  const fc = document.createElement('canvas');
  fc.width = fw; fc.height = fh;
  const fx = fc.getContext('2d', { willReadFrequently: true });
  fx.drawImage(photo, 0, 0, fw, fh);
  const frameData = fx.getImageData(0, 0, fw, fh);

  // Find the sheet of paper
  const sw = 300, sh = Math.round(300 * fh / fw);
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sx = sc.getContext('2d', { willReadFrequently: true });
  sx.drawImage(fc, 0, 0, sw, sh);
  const found = detectPaper(sx.getImageData(0, 0, sw, sh));
  let corners = found ? found.corners : [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let t = 0; t < turns; t++) corners = [corners[3], corners[0], corners[1], corners[2]]; // quarter turn
  const q = corners.map(([x, y]) => [x * fw, y * fh]);

  // Flatten it, keeping the sheet's own proportions (any paper size works)
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const across = (d(q[0], q[1]) + d(q[3], q[2])) / 2, down = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = RECT_LONG / Math.max(across, down);
  const rw = Math.max(50, Math.round(across * s)), rh = Math.max(50, Math.round(down * s));
  const rect = new ImageData(rw, rh);
  warpQuad(frameData, q, rect);

  // Ink only (ignore a thin band at the sheet's edges, where shadows sit)
  const buf = makeInkBuffers(rw, rh);
  extractInk(rect, { threshold: parseFloat($('threshold').value), margin: found ? 0.025 : 0.01, ignoreSkin: true }, buf);
  const mask = buf.mask;

  // Trim to the drawing. Ignore the outermost 0.5% of ink on each side so a stray speck
  // or smudge near the edge doesn't stretch the box.
  const cols = new Uint32Array(rw), rows = new Uint32Array(rh);
  let total = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (mask[y * rw + x]) { cols[x]++; rows[y]++; total++; }
    }
  }
  const msg = $('reviewMsg');
  if (total < 40) {
    drawPreview(null, 300, 200);
    msg.className = 'msg warn';
    msg.textContent = "We couldn't find a drawing. Try more light, a thicker dark marker, or move the Line pickup slider.";
    $('btnSend').disabled = true;
    result = null;
    return;
  }
  const edge = (arr) => {
    const cut = total * 0.005;
    let lo = 0, hi = arr.length - 1;
    for (let acc = 0; lo < arr.length; lo++) { acc += arr[lo]; if (acc > cut) break; }
    for (let acc = 0; hi > 0; hi--) { acc += arr[hi]; if (acc > cut) break; }
    return [lo, hi];
  };
  const [x0, x1] = edge(cols), [y0, y1] = edge(rows);
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * PAD);
  const cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad);
  const cw = Math.min(rw, x1 + pad + 1) - cx, ch = Math.min(rh, y1 + pad + 1) - cy;

  // Transparent image with just the ink, in its own colours
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const ox = out.getContext('2d');
  const od = ox.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (cy + y) * rw + (cx + x);
      if (!mask[si]) continue;
      const a = si * 4, o = (y * cw + x) * 4;
      od.data[o] = rect.data[a]; od.data[o + 1] = rect.data[a + 1]; od.data[o + 2] = rect.data[a + 2]; od.data[o + 3] = 255;
    }
  }
  ox.putImageData(od, 0, 0);
  drawPreview(out, cw, ch);

  if (!found) {
    msg.className = 'msg warn';
    msg.textContent = "We couldn't find the edges of the paper, so we used the whole photo. If extra things got picked up, retake it on a darker surface.";
  } else {
    msg.className = 'msg';
    msg.textContent = "This is what will be projected. Use Rotate if it's sideways or upside down.";
  }
  $('btnSend').disabled = false;

  // Keep the upload small
  let png = out.toDataURL('image/png'), w = cw, h = ch;
  while (png.length > 550000 && w > 120) {
    w = Math.round(w * 0.75); h = Math.round(h * 0.75);
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    c2.getContext('2d').drawImage(out, 0, 0, w, h);
    png = c2.toDataURL('image/png');
  }
  result = { png, w, h };
}

function drawPreview(img, w, h) {
  const pv = $('preview');
  pv.width = w; pv.height = h;
  const px = pv.getContext('2d');
  px.fillStyle = '#f6f3ec';
  px.fillRect(0, 0, w, h);
  if (img) px.drawImage(img, 0, 0);
}

$('threshold').addEventListener('change', () => photo && processPhoto());
$('btnRotate').addEventListener('click', () => { turns = (turns + 1) % 4; processPhoto(); });
$('btnRetake').addEventListener('click', () => show('stepCapture'));
$('btnAnother').addEventListener('click', () => { photo = null; result = null; show('stepPick'); });

// ---------- 4. Send ----------
$('btnSend').addEventListener('click', async () => {
  if (!result || !frame) return;
  const btn = $('btnSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await fetch(`${API}?op=submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame: frame.id, ...result }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Upload failed');
    show('stepDone');
  } catch (err) {
    const msg = $('reviewMsg');
    msg.className = 'msg err';
    msg.textContent = `Couldn't send it: ${err.message}. Please try again.`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to the doorway';
  }
});
