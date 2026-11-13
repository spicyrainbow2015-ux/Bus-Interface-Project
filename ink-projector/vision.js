// Paper detection, perspective flattening and ink extraction.
// Plain JavaScript, no libraries, so it runs anywhere a browser does.

// ---------- Homography ----------

// Solves the 3x3 perspective transform that maps four `from` points onto four `to` points.
// Returns [a,b,c,d,e,f,g,h] where X = (a x + b y + c) / (g x + h y + 1), Y = (d x + e y + f) / (g x + h y + 1).
export function solveHomography(from, to) {
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [X, Y] = to[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); B.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); B.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [B[c], B[p]] = [B[p], B[c]];
    const piv = A[c][c];
    if (Math.abs(piv) < 1e-12) return null;
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / piv;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  const h = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = B[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return h;
}

// Copies the quadrilateral `quad` (pixel corners TL, TR, BR, BL in `src`) into the rectangle `dst`,
// undoing the camera's perspective. Both are ImageData.
export function warpQuad(src, quad, dst) {
  const sw = src.width, sh = src.height, sd = src.data;
  const dw = dst.width, dh = dst.height, dd = dst.data;
  const H = solveHomography([[0, 0], [dw, 0], [dw, dh], [0, dh]], quad);
  if (!H) return false;
  const [a, b, c, d, e, f, g, h] = H;
  const maxX = sw - 1.001, maxY = sh - 1.001;
  let o = 0;
  for (let v = 0; v < dh; v++) {
    const vy = v + 0.5;
    for (let u = 0; u < dw; u++) {
      const ux = u + 0.5;
      const w = g * ux + h * vy + 1;
      let x = (a * ux + b * vy + c) / w - 0.5;
      let y = (d * ux + e * vy + f) / w - 0.5;
      if (x < 0) x = 0; else if (x > maxX) x = maxX;
      if (y < 0) y = 0; else if (y > maxY) y = maxY;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      dd[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      dd[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      dd[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      dd[o + 3] = 255;
      o += 4;
    }
  }
  return true;
}

// ---------- Paper detection ----------

// Finds the largest bright region in a small frame and returns its four corners,
// normalized to 0..1, in the order top-left, top-right, bottom-right, bottom-left.
// Works best with white paper on a darker surface.
export function detectPaper(img) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const g = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    g[i] = v;
    hist[v]++;
  }

  // Otsu's method picks the brightness that best splits "paper" from "not paper".
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 128, meanLo = 0, meanHi = 255;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; meanLo = mB; meanHi = mF; }
  }
  if (meanHi - meanLo < 35) return null; // not enough contrast between paper and surface

  // Largest connected bright region, tracking its extreme points as we go.
  const lab = new Uint8Array(n);
  const stack = new Int32Array(n);
  let bestSize = 0, bestExt = null;
  for (let start = 0; start < n; start++) {
    if (lab[start] || g[start] <= thr) continue;
    let sp = 0, size = 0;
    stack[sp++] = start;
    lab[start] = 1;
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    let tl = 0, br = 0, tr = 0, bl = 0;
    while (sp) {
      const i = stack[--sp];
      size++;
      const x = i % w, y = (i / w) | 0;
      const s = x + y, df = x - y;
      if (s < minS) { minS = s; tl = i; }
      if (s > maxS) { maxS = s; br = i; }
      if (df > maxD) { maxD = df; tr = i; }
      if (df < minD) { minD = df; bl = i; }
      if (x > 0 && !lab[i - 1] && g[i - 1] > thr) { lab[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !lab[i + 1] && g[i + 1] > thr) { lab[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !lab[i - w] && g[i - w] > thr) { lab[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && !lab[i + w] && g[i + w] > thr) { lab[i + w] = 1; stack[sp++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestExt = [tl, tr, br, bl]; }
  }
  if (!bestExt || bestSize < n * 0.04) return null;

  const corners = bestExt.map((i) => [((i % w) + 0.5) / w, (((i / w) | 0) + 0.5) / h]);
  // The region should fill its four-corner outline; if not, it is probably not a sheet.
  const px = corners.map(([x, y]) => [x * w, y * h]);
  let area = 0;
  for (let k = 0; k < 4; k++) {
    const [x1, y1] = px[k], [x2, y2] = px[(k + 1) % 4];
    area += x1 * y2 - x2 * y1;
  }
  area = Math.abs(area) / 2;
  const fill = bestSize / Math.max(1, area);
  if (fill < 0.8 || fill > 1.2) return null;
  return { corners, fill };
}

// ---------- Ink extraction ----------

// Skin looks red > green > blue with moderate saturation. Black, blue, green and most
// bright marker colors fail this test, so it mostly removes the drawer's hand.
function isSkin(r, g, b) {
  if (r < 60 || r <= g || r <= b) return false;
  if (g < b * 0.92) return false;
  const rb = r - b;
  if (rb < 18 || r - g < 8) return false;
  return rb / r < 0.62;
}

export function makeInkBuffers(w, h) {
  const n = w * h;
  return { w, h, gray: new Float32Array(n), raw: new Uint8Array(n), mask: new Uint8Array(n), xs: null };
}

// Marks pixels that are clearly darker than the paper around them.
// Compares each pixel to a local estimate of the paper's brightness, so uneven lighting is fine.
// params: threshold (0..1 darkness), margin (fraction of edge ignored), ignoreSkin (bool).
// Returns the number of ink pixels in buf.mask.
export function extractInk(img, params, buf) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const { gray, raw, mask } = buf;
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

  // Paper brightness per 16px block: the block's brightest value, widened and smoothed,
  // so solid filled shapes up to ~48px still see white paper nearby.
  const B = 16, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const bm = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y1 = Math.min(h, (by + 1) * B);
    for (let bx = 0; bx < bw; bx++) {
      const x1 = Math.min(w, (bx + 1) * B);
      let m = 0;
      for (let y = by * B; y < y1; y++) {
        const row = y * w;
        for (let x = bx * B; x < x1; x++) if (gray[row + x] > m) m = gray[row + x];
      }
      bm[by * bw + bx] = m;
    }
  }
  const dil = new Float32Array(bw * bh);
  const bg = new Float32Array(bw * bh);
  for (let pass = 0; pass < 2; pass++) {
    const srcA = pass === 0 ? bm : dil, dstA = pass === 0 ? dil : bg;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0, s = 0, c = 0;
        for (let oy = -1; oy <= 1; oy++) {
          const yy = by + oy;
          if (yy < 0 || yy >= bh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = bx + ox;
            if (xx < 0 || xx >= bw) continue;
            const v = srcA[yy * bw + xx];
            if (v > m) m = v;
            s += v; c++;
          }
        }
        dstA[by * bw + bx] = pass === 0 ? m : s / c;
      }
    }
  }

  if (!buf.xs || buf.xs.length !== w * 3) {
    buf.xs = new Float32Array(w * 3);
    for (let x = 0; x < w; x++) {
      let gx = (x + 0.5) / B - 0.5;
      if (gx < 0) gx = 0; else if (gx > bw - 1) gx = bw - 1;
      const x0 = Math.floor(gx);
      buf.xs[x * 3] = x0;
      buf.xs[x * 3 + 1] = Math.min(x0 + 1, bw - 1);
      buf.xs[x * 3 + 2] = gx - x0;
    }
  }
  const xs = buf.xs;
  const mx = Math.round(params.margin * w), my = Math.round(params.margin * h);
  const thr = params.threshold;
  const skin = params.ignoreSkin;

  for (let y = 0; y < h; y++) {
    let gy = (y + 0.5) / B - 0.5;
    if (gy < 0) gy = 0; else if (gy > bh - 1) gy = bh - 1;
    const y0 = Math.floor(gy), y1 = Math.min(y0 + 1, bh - 1), fy = gy - y0;
    const r0 = y0 * bw, r1 = y1 * bw;
    const inY = y >= my && y < h - my;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inY || x < mx || x >= w - mx) { raw[i] = 0; continue; }
      const x0 = xs[x * 3], x1 = xs[x * 3 + 1], fx = xs[x * 3 + 2];
      const top = bg[r0 + x0] * (1 - fx) + bg[r0 + x1] * fx;
      const bot = bg[r1 + x0] * (1 - fx) + bg[r1 + x1] * fx;
      const bgv = top * (1 - fy) + bot * fy;
      let ink = (bgv - gray[i]) / Math.max(bgv, 40) > thr;
      if (ink && skin) {
        const j = i * 4;
        if (isSkin(d[j], d[j + 1], d[j + 2])) ink = false;
      }
      raw[i] = ink ? 1 : 0;
    }
  }

  // Drop isolated specks: keep ink pixels with at least two ink neighbours.
  let count = 0;
  mask.fill(0);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!raw[i]) continue;
      const nb = raw[i - w - 1] + raw[i - w] + raw[i - w + 1] + raw[i - 1] + raw[i + 1] +
        raw[i + w - 1] + raw[i + w] + raw[i + w + 1];
      if (nb >= 2) { mask[i] = 1; count++; }
    }
  }
  return count;
}

// ---------- Building outline ----------

// Turns an image of a building into a line mask (0..255 per pixel).
// mode 'lines': the image is already a line drawing, so dark pixels become lines.
// mode 'photo': finds edges in a photo; `detail` (0..1) keeps more or fewer of them.
export function outlineFromImage(img, mode, detail) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const out = new Uint8Array(n);
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3] / 255;
    const g = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    gray[i] = g * a + 255 * (1 - a); // transparent areas count as white
  }
  if (mode === 'lines') {
    for (let i = 0; i < n; i++) {
      const v = (200 - gray[i]) / 110;
      out[i] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
    }
    return out;
  }
  // Light blur, then Sobel edge strength
  const b = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      b[i] = (gray[i - w - 1] + gray[i - w] + gray[i - w + 1] + gray[i - 1] + gray[i] + gray[i + 1] +
        gray[i + w - 1] + gray[i + w] + gray[i + w + 1]) / 9;
    }
  }
  const mag = new Float32Array(n);
  let max = 1;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1];
      const gy = b[i + w - 1] + 2 * b[i + w] + b[i + w + 1] - b[i - w - 1] - 2 * b[i - w] - b[i - w + 1];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      if (m > max) max = m;
    }
  }
  // Keep the strongest 2%–14% of edges, depending on detail
  const BINS = 1024;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, (mag[i] / max * (BINS - 1)) | 0)]++;
  const keepCount = n * (0.02 + detail * 0.12);
  let acc = 0, bin = BINS - 1;
  for (; bin > 0; bin--) { acc += hist[bin]; if (acc >= keepCount) break; }
  // Use the bin above the cut so we never keep more than asked, and ignore faint texture.
  const thr = Math.max(((bin + 1) / (BINS - 1)) * max, 14);
  for (let i = 0; i < n; i++) {
    if (mag[i] > thr) out[i] = Math.min(255, 140 + ((mag[i] - thr) / (thr || 1)) * 230);
  }
  return out;
}
