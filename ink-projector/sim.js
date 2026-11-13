// A fake overhead camera: a sheet of paper on a table, with a hand drawing on it.
// Lets you test the whole pipeline without a camera or projector.

const SPEED = 0.3; // paper widths per second while drawing
const GAP = 0.35;  // seconds between strokes (pen lifted)

function circle(cx, cy, r, aspect, steps = 48, start = 0) {
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const a = start + (k / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * aspect]);
  }
  return pts;
}

function line(points, steps = 12) {
  const pts = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [x1, y1] = points[k], [x2, y2] = points[k + 1];
    for (let s = 0; s < steps; s++) pts.push([x1 + (x2 - x1) * (s / steps), y1 + (y2 - y1) * (s / steps)]);
  }
  pts.push(points[points.length - 1]);
  return pts;
}

function buildStrokes() {
  const A = 1.414; // landscape sheet: 1 unit across is 1.414 units down
  const strokes = [];
  const ink = '#17171d', orange = '#e8590c', magenta = '#c2255c', green = '#2b8a3e', blue = '#1c4fd8';

  // Sun
  strokes.push({ color: orange, pts: circle(0.18, 0.26, 0.075, A) });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    strokes.push({ color: orange, pts: line([
      [0.18 + Math.cos(a) * 0.1, 0.26 + Math.sin(a) * 0.1 * A],
      [0.18 + Math.cos(a) * 0.14, 0.26 + Math.sin(a) * 0.14 * A],
    ], 4) });
  }
  // Birds
  strokes.push({ color: ink, pts: line([[0.5, 0.14], [0.53, 0.11], [0.56, 0.14], [0.59, 0.11], [0.62, 0.14]], 6) });
  strokes.push({ color: ink, pts: line([[0.66, 0.2], [0.68, 0.18], [0.7, 0.2], [0.72, 0.18], [0.74, 0.2]], 6) });
  // House
  strokes.push({ color: ink, pts: line([[0.4, 0.45], [0.4, 0.8], [0.62, 0.8], [0.62, 0.45], [0.4, 0.45]], 14) });
  strokes.push({ color: ink, pts: line([[0.37, 0.46], [0.51, 0.26], [0.65, 0.46]], 14) });
  strokes.push({ color: ink, pts: line([[0.48, 0.8], [0.48, 0.64], [0.54, 0.64], [0.54, 0.8]], 8) });
  strokes.push({ color: ink, pts: line([[0.43, 0.52], [0.47, 0.52], [0.47, 0.58], [0.43, 0.58], [0.43, 0.52]], 4) });
  // Flower
  strokes.push({ color: green, pts: line([[0.82, 0.5], [0.81, 0.66], [0.82, 0.84]], 14) });
  strokes.push({ color: green, pts: line([[0.815, 0.7], [0.86, 0.64], [0.88, 0.67], [0.815, 0.7]], 6) });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    strokes.push({ color: magenta, pts: circle(0.82 + Math.cos(a) * 0.035, 0.42 + Math.sin(a) * 0.035 * A, 0.022, A, 20, a) });
  }
  strokes.push({ color: orange, pts: circle(0.82, 0.42, 0.014, A, 16) });
  // Waves
  const wave = [];
  for (let k = 0; k <= 90; k++) {
    const u = 0.07 + (k / 90) * 0.86;
    wave.push([u, 0.9 + Math.sin(u * 40) * 0.022]);
  }
  strokes.push({ color: blue, pts: wave });

  // Precompute timing
  let t = 1.8; // a moment with a clean sheet so the paper can be found and locked
  for (const s of strokes) {
    let len = 0;
    s.cum = [0];
    for (let k = 1; k < s.pts.length; k++) {
      const dx = s.pts[k][0] - s.pts[k - 1][0];
      const dy = (s.pts[k][1] - s.pts[k - 1][1]) / A;
      len += Math.hypot(dx, dy);
      s.cum.push(len);
    }
    s.len = len;
    s.start = t;
    s.end = t + len / SPEED;
    t = s.end + GAP;
  }
  return { strokes, total: t };
}

export function createSim(W = 1280, H = 720) {
  const quad = [[318, 150], [992, 168], [1018, 642], [288, 618]]; // TL TR BR BL
  const { strokes, total } = buildStrokes();
  let t0 = performance.now();

  function map(u, v) {
    const [a, b, c, d] = quad;
    const tx = a[0] + (b[0] - a[0]) * u, ty = a[1] + (b[1] - a[1]) * u;
    const bx = d[0] + (c[0] - d[0]) * u, by = d[1] + (c[1] - d[1]) * u;
    return [tx + (bx - tx) * v, ty + (by - ty) * v];
  }

  function pointAt(s, dist) {
    let k = 1;
    while (k < s.cum.length - 1 && s.cum[k] < dist) k++;
    const span = s.cum[k] - s.cum[k - 1] || 1;
    const f = Math.min(1, Math.max(0, (dist - s.cum[k - 1]) / span));
    const p = s.pts[k - 1], q = s.pts[k];
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, k];
  }

  // Table + blank paper, and the room lighting, are drawn once and reused every frame.
  const base = document.createElement('canvas');
  base.width = W; base.height = H;
  {
    const b = base.getContext('2d');
    const tg = b.createLinearGradient(0, 0, W, H);
    tg.addColorStop(0, '#4a3a2e');
    tg.addColorStop(1, '#2c221b');
    b.fillStyle = tg;
    b.fillRect(0, 0, W, H);
    b.beginPath();
    quad.forEach(([x, y], k) => (k ? b.lineTo(x, y) : b.moveTo(x, y)));
    b.closePath();
    b.fillStyle = '#f3f0e8';
    b.fill();
  }
  const light = document.createElement('canvas');
  light.width = W; light.height = H;
  {
    const l = light.getContext('2d');
    const vg = l.createRadialGradient(W * 0.42, H * 0.38, H * 0.15, W * 0.5, H * 0.5, W * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    l.fillStyle = vg;
    l.fillRect(0, 0, W, H);
  }

  function draw(ctx, now) {
    const t = (now - t0) / 1000;
    ctx.drawImage(base, 0, 0);

    // Strokes drawn so far
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 7;
    let pen = null;
    for (const s of strokes) {
      if (t < s.start) break;
      const dist = t >= s.end ? s.len : (t - s.start) * SPEED;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      const [sx, sy] = map(s.pts[0][0], s.pts[0][1]);
      ctx.moveTo(sx, sy);
      let k = 1;
      for (; k < s.pts.length && s.cum[k] <= dist; k++) {
        const [x, y] = map(s.pts[k][0], s.pts[k][1]);
        ctx.lineTo(x, y);
      }
      const [eu, ev] = pointAt(s, dist);
      const [ex, ey] = map(eu, ev);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      if (t < s.end) pen = [eu, ev];
    }

    // Pen travelling between strokes, or leaving once the drawing is done
    if (!pen) {
      const idx = strokes.findIndex((s) => t < s.start);
      if (idx > 0) {
        const prev = strokes[idx - 1], next = strokes[idx];
        const f = Math.min(1, (t - prev.end) / GAP);
        const a = prev.pts[prev.pts.length - 1], b = next.pts[0];
        pen = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - Math.sin(f * Math.PI) * 0.03];
      } else if (idx === 0) {
        const f = Math.min(1, t / strokes[0].start);
        pen = [1.3 + (strokes[0].pts[0][0] - 1.3) * f, 1.3 + (strokes[0].pts[0][1] - 1.3) * f];
      } else if (t < total + 1.2) {
        const last = strokes[strokes.length - 1].pts.at(-1);
        const f = Math.min(1, (t - total) / 1.2);
        pen = [last[0] + (1.4 - last[0]) * f, last[1] + (1.4 - last[1]) * f];
      }
    }
    if (pen) drawHand(ctx, map(pen[0], pen[1]));

    // Uneven room lighting, so the ink detector has to cope with it
    ctx.drawImage(light, 0, 0);
  }

  function drawHand(ctx, [x, y]) {
    const hx = x + 58, hy = y + 66;
    // Shadow
    // Soft shadow (a radial gradient; canvas blur filters are very slow on readable canvases)
    const sg = ctx.createRadialGradient(hx + 34, hy + 40, 10, hx + 34, hy + 40, 95);
    sg.addColorStop(0, 'rgba(0,0,0,0.32)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(hx - 70, hy - 60, 210, 200);
    // Arm
    const skin = ctx.createLinearGradient(hx - 60, hy - 40, hx + 60, hy + 60);
    skin.addColorStop(0, '#dca684');
    skin.addColorStop(1, '#a8705a');
    ctx.strokeStyle = skin;
    ctx.lineCap = 'round';
    ctx.lineWidth = 110;
    ctx.beginPath();
    ctx.moveTo(hx + 30, hy + 30);
    ctx.lineTo(hx + 420, hy + 360);
    ctx.stroke();
    // Pen
    ctx.strokeStyle = '#2a2a3a';
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(x + 4, y + 4);
    ctx.lineTo(x + 70, y + 84);
    ctx.stroke();
    // Hand
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(hx, hy, 62, 44, -0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  return {
    width: W,
    height: H,
    draw,
    reset() { t0 = performance.now(); },
  };
}
