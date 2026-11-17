// Phone page: photograph a drawing on the printed template, pull out just the ink,
// and send it to the operator's approval queue.
// All image processing happens on the phone, so only a small transparent PNG is uploaded.
import { detectPaper, warpQuad, extractInk, makeInkBuffers } from './vision.js';

const $ = (id) => document.getElementById(id);
const API = '/api/ink';
const RECT_LONG = 900;     // flattened sheet resolution (long side)
const TEMPLATE_MARGIN = 0.08; // must match the operator's printed template

let state = null;          // { section, aspect, paperRatio, thumb }
let photo = null;          // loaded <img>
let flip = false;
let result = null;         // { png, w, h }

// ---------- Which section is open ----------
async function loadState() {
  try {
    const r = await fetch(`${API}?op=state`, { cache: 'no-store' });
    state = await r.json();
  } catch { state = null; }
  const open = state && state.section != null;
  $('closedCard').hidden = open;
  $('sectionCard').hidden = !open;
  $('btnTake').style.opacity = $('btnPick').style.opacity = open ? '' : '0.5';
  if (open && state.thumb && $('thumb').src !== state.thumb) $('thumb').src = state.thumb;
}
loadState();
setInterval(() => { if (!$('stepCapture').hidden) loadState(); }, 5000);

// ---------- Photo in ----------
for (const id of ['fileTake', 'filePick']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!state || state.section == null) { alert('Nothing is open for drawing right now.'); return; }
    const img = new Image();
    img.onload = () => { photo = img; flip = false; processPhoto(); show('stepReview'); };
    img.onerror = () => alert("Couldn't open that photo. Try another one.");
    img.src = URL.createObjectURL(file);
  });
}

function show(step) {
  for (const s of ['stepCapture', 'stepReview', 'stepDone']) $(s).hidden = s !== step;
  window.scrollTo(0, 0);
}

// Where a shape of `objAspect` sits inside an area of `aspect`, as fractions (centered, with margin).
function placeIn(aspect, margin, objAspect) {
  let bw = (1 - 2 * margin) * aspect, bh = bw / objAspect;
  if (bh > 1 - 2 * margin) { bh = 1 - 2 * margin; bw = bh * objAspect; }
  return { x: (aspect - bw) / 2 / aspect, y: (1 - bh) / 2, w: bw / aspect, h: bh };
}

function processPhoto() {
  // 1. Photo into a canvas (most phones' photos are huge; 1600px is plenty)
  const k = Math.min(1, 1600 / Math.max(photo.naturalWidth, photo.naturalHeight));
  const fw = Math.round(photo.naturalWidth * k), fh = Math.round(photo.naturalHeight * k);
  const fc = document.createElement('canvas');
  fc.width = fw; fc.height = fh;
  const fx = fc.getContext('2d', { willReadFrequently: true });
  fx.drawImage(photo, 0, 0, fw, fh);
  const frame = fx.getImageData(0, 0, fw, fh);

  // 2. Find the sheet
  const sw = 300, sh = Math.round(300 * fh / fw);
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sx = sc.getContext('2d', { willReadFrequently: true });
  sx.drawImage(fc, 0, 0, sw, sh);
  const found = detectPaper(sx.getImageData(0, 0, sw, sh));
  let corners = found ? found.corners : [[0, 0], [1, 0], [1, 1], [0, 1]];
  if (flip) corners = [corners[2], corners[3], corners[0], corners[1]];
  const q = corners.map(([x, y]) => [x * fw, y * fh]);

  // 3. Flatten it at the template's paper shape and orientation
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const across = (d(q[0], q[1]) + d(q[3], q[2])) / 2, down = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const ratio = state.paperRatio || 1.4142;
  const [rw, rh] = across >= down ? [RECT_LONG, Math.round(RECT_LONG / ratio)] : [Math.round(RECT_LONG / ratio), RECT_LONG];
  const rect = new ImageData(rw, rh);
  warpQuad(frame, q, rect);

  // 4. Ink only
  const buf = makeInkBuffers(rw, rh);
  extractInk(rect, { threshold: parseFloat($('threshold').value), margin: 0.01, ignoreSkin: true }, buf);

  // 5. Crop to where the shape was printed on the template
  const p = placeIn(rw / rh, TEMPLATE_MARGIN, state.aspect || rw / rh);
  const cx = Math.round(p.x * rw), cy = Math.round(p.y * rh);
  const cw = Math.max(1, Math.round(p.w * rw)), ch = Math.max(1, Math.round(p.h * rh));
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const ox = out.getContext('2d');
  const od = ox.createImageData(cw, ch);
  let inkCount = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = (cy + y) * rw + (cx + x);
      if (!buf.mask[si]) continue;
      const s = si * 4, o = (y * cw + x) * 4;
      od.data[o] = rect.data[s]; od.data[o + 1] = rect.data[s + 1]; od.data[o + 2] = rect.data[s + 2]; od.data[o + 3] = 255;
      inkCount++;
    }
  }
  ox.putImageData(od, 0, 0);

  // 6. Preview
  const pv = $('preview');
  pv.width = cw; pv.height = ch;
  const px = pv.getContext('2d');
  px.fillStyle = '#f6f3ec';
  px.fillRect(0, 0, cw, ch);
  px.drawImage(out, 0, 0);

  const msg = $('reviewMsg');
  if (inkCount < 40) {
    msg.className = 'msg warn';
    msg.textContent = "We couldn't find much drawing. Try more light, a thicker marker, or move the Line pickup slider.";
  } else if (!found) {
    msg.className = 'msg warn';
    msg.textContent = "We couldn't find the edges of the sheet, so we used the whole photo. For best results, put the sheet on a darker surface.";
  } else {
    msg.className = 'msg';
    msg.textContent = "This is what will be projected. If it's upside down, tap Turn upside down.";
  }
  $('btnSend').disabled = inkCount < 10;

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

$('threshold').addEventListener('change', () => photo && processPhoto());
$('btnFlip').addEventListener('click', () => { flip = !flip; processPhoto(); });
$('btnRetake').addEventListener('click', () => { loadState(); show('stepCapture'); });
$('btnAnother').addEventListener('click', () => { loadState(); show('stepCapture'); });

$('btnSend').addEventListener('click', async () => {
  if (!result) return;
  const btn = $('btnSend');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const r = await fetch(`${API}?op=submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: state.section, ...result }),
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
