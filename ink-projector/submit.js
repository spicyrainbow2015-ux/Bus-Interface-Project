// Phone page: choose a part of the doorway, photograph the drawing made on that part's printed
// template, pull out just the ink inside the template's shape area, and send it to the
// operator's approval queue. The drawing lands on the doorway exactly where it was drawn;
// anything outside the part's border is cut off there.
// All image processing happens on the phone, so only a small transparent PNG is uploaded.
import { detectPaper, warpQuad, extractInk, makeInkBuffers } from './vision.js';

const $ = (id) => document.getElementById(id);
const API = '/api/ink';
const RECT_LONG = 1000;   // flattened sheet resolution (long side)
const TEMPLATE_MARGIN = 0.08; // must match the operator's printed templates

let frames = [];
let paperRatio = 1.2941;  // the operator's paper size (US Letter unless set otherwise)
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
    const st = await r.json();
    frames = st.frames || [];
    if (st.paperRatio) paperRatio = st.paperRatio;
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

  // Flatten it at the template's paper shape, in whichever orientation it was photographed
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const across = (d(q[0], q[1]) + d(q[3], q[2])) / 2, down = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const [rw, rh] = across >= down
    ? [RECT_LONG, Math.round(RECT_LONG / paperRatio)]
    : [Math.round(RECT_LONG / paperRatio), RECT_LONG];
  const rect = new ImageData(rw, rh);
  warpQuad(frameData, q, rect);

  // Ink only
  const buf = makeInkBuffers(rw, rh);
  extractInk(rect, { threshold: parseFloat($('threshold').value), margin: 0.01, ignoreSkin: true }, buf);
  const mask = buf.mask;

  // The part's shape area on the template (same placement the operator prints)
  const aspect = frame.aspect || rw / rh;
  let bw = (1 - 2 * TEMPLATE_MARGIN) * (rw / rh), bh = bw / aspect;
  if (bh > 1 - 2 * TEMPLATE_MARGIN) { bh = 1 - 2 * TEMPLATE_MARGIN; bw = bh * aspect; }
  const cw = Math.max(1, Math.round((bw / (rw / rh)) * rw)), ch = Math.max(1, Math.round(bh * rh));
  const cx = Math.round((rw - cw) / 2), cy = Math.round((rh - ch) / 2);
  let total = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (mask[(cy + y) * rw + cx + x]) total++;

  const msg = $('reviewMsg');
  if (total < 40) {
    drawPreview(null, cw, ch);
    msg.className = 'msg warn';
    msg.textContent = "We couldn't find a drawing inside the shape. Try more light, a thicker dark marker, or move the Line pickup slider.";
    $('btnSend').disabled = true;
    result = null;
    return;
  }

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
    msg.textContent = "We couldn't find the edges of the paper, so it may not line up. Retake it with the whole sheet on a darker surface.";
  } else {
    msg.className = 'msg';
    msg.textContent = "This is what will be projected. Anything outside the shape gets cut off. Use Rotate if it's sideways or upside down.";
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
