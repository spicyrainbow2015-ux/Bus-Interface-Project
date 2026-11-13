// Textured brushes for the on-screen drawing pad.
// A stroke turns pointer movement into "marks" (dots and short lines). The caller draws the
// marks, so the same random texture lands on both the visible pad and the capture canvas.
//
//   pen    — a plain round line
//   spray  — a soft cloud of fine dots, dense in the middle, fading at the edges
//   hatch  — short dashes across the stroke; drawing in circles makes radiating rings
//   ripple — several parallel lines that follow the stroke, like contour bands
//   polka  — big evenly spaced dots, alternating slightly to either side of the stroke
//   tri    — scattered solid triangles in random rotations

export const BRUSHES = [
  { id: 'pen', label: 'Pen' },
  { id: 'spray', label: 'Spray' },
  { id: 'hatch', label: 'Hatch' },
  { id: 'ripple', label: 'Ripple' },
  { id: 'polka', label: 'Polka' },
  { id: 'tri', label: 'Triangles' },
];

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// opts: { brush, size, color: '#rrggbb', mix: 0..1 }
export function createStroke(opts) {
  const [H, S, L] = hexToHsl(opts.color);
  const size = opts.size;
  const brush = opts.brush;
  const marks = [];
  let last = null;
  let carry = 0;     // distance travelled since the last stamp
  let dir = null;    // smoothed stroke direction
  let rake = null;   // previous point of each ripple line

  // A colour near the chosen one. "mix" widens the hue/lightness spread.
  function shade(amount = 1, lighten = 0) {
    const m = opts.mix * amount;
    const h = H + (Math.random() * 2 - 1) * 55 * m;
    const s = clamp01(S + (Math.random() * 2 - 1) * 0.2 * m);
    const l = clamp01(L + lighten + (Math.random() * 2 - 1) * 0.2 * m);
    return `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
  }

  const dot = (x, y, r, c) => marks.push({ t: 'd', x, y, r, c });
  const line = (x1, y1, x2, y2, w, c) => marks.push({ t: 'l', x1, y1, x2, y2, w, c });
  const poly = (pts, c) => marks.push({ t: 'p', pts, c });
  let stampNo = 0;

  function spacing(sz) {
    if (brush === 'spray') return Math.max(1, sz * 0.3);
    if (brush === 'hatch') return Math.max(1.5, sz * 0.4);
    if (brush === 'polka') return Math.max(3, sz * 1.5);
    if (brush === 'tri') return Math.max(3, sz * 1.15);
    return 1;
  }

  function stamp(x, y, sz) {
    stampNo++;
    if (brush === 'polka') {
      // Zig-zag a little either side of the stroke so it reads as a dot pattern, not a line
      const side = dir ? (stampNo % 2 ? 1 : -1) * sz * 0.35 : 0;
      const nx = dir ? -dir[1] : 0, ny = dir ? dir[0] : 0;
      dot(x + nx * side, y + ny * side, sz * (0.45 + Math.random() * 0.08), shade(0.6));
      return;
    }
    if (brush === 'tri') {
      const r = sz * (0.55 + Math.random() * 0.4);
      const a = Math.random() * Math.PI * 2;
      const cx = x + (Math.random() * 2 - 1) * sz * 0.5, cy = y + (Math.random() * 2 - 1) * sz * 0.5;
      const pts = [0, 1, 2].map((k) => [cx + Math.cos(a + k * 2.094) * r, cy + Math.sin(a + k * 2.094) * r]);
      poly(pts, shade());
      return;
    }
    if (brush === 'spray') {
      const n = Math.max(3, Math.round(sz * 1.3));
      for (let k = 0; k < n; k++) {
        const ox = gauss() * sz * 0.75, oy = gauss() * sz * 0.75;
        dot(x + ox, y + oy, 0.7 + Math.random() * 0.45, shade());
      }
    } else if (brush === 'hatch') {
      if (!dir) return;
      const a = Math.atan2(dir[1], dir[0]) + Math.PI / 2 + (Math.random() * 2 - 1) * 0.18;
      const len = sz * (0.6 + Math.random() * 0.35);
      const jx = (Math.random() * 2 - 1) * sz * 0.15, jy = (Math.random() * 2 - 1) * sz * 0.15;
      const cx = x + jx, cy = y + jy, dx = Math.cos(a) * len, dy = Math.sin(a) * len;
      line(cx - dx, cy - dy, cx + dx, cy + dy, Math.max(1, sz * 0.16), shade());
    }
  }

  function rippleLines(p, sz) {
    if (!dir) return;
    const n = Math.max(3, Math.min(7, Math.round(sz / 3)));
    const nx = -dir[1], ny = dir[0];
    const w = Math.max(1, sz * 0.2);
    const pts = [];
    for (let k = 0; k < n; k++) {
      const off = (k / (n - 1) - 0.5) * sz * 2.4;
      pts.push([p[0] + nx * off, p[1] + ny * off]);
    }
    if (rake) {
      for (let k = 0; k < n; k++) {
        const c = k % 2 ? shade(0.4, 0.22) : shade(0.4);
        line(rake[k][0], rake[k][1], pts[k][0], pts[k][1], w, c);
      }
    }
    rake = pts;
  }

  function sizeFor(pressure) { return size * (pressure ? 0.4 + pressure * 1.2 : 1); }

  return {
    begin(p, pressure) {
      last = p;
      carry = 0;
      const sz = sizeFor(pressure);
      if (brush === 'pen') line(p[0], p[1], p[0], p[1], sz, opts.color);
      else if (brush !== 'hatch' && brush !== 'ripple') stamp(p[0], p[1], sz);
      return marks.splice(0);
    },
    move(p, pressure) {
      const dx = p[0] - last[0], dy = p[1] - last[1];
      const L = Math.hypot(dx, dy);
      if (L < 0.01) return [];
      const sz = sizeFor(pressure);
      const d = [dx / L, dy / L];
      if (!dir) dir = d;
      else {
        const k = brush === 'ripple' ? 0.2 : 0.35;
        const vx = dir[0] * (1 - k) + d[0] * k, vy = dir[1] * (1 - k) + d[1] * k;
        const vl = Math.hypot(vx, vy) || 1;
        dir = [vx / vl, vy / vl];
      }

      if (brush === 'pen') {
        line(last[0], last[1], p[0], p[1], sz, opts.color);
      } else if (brush === 'ripple') {
        carry += L;
        if (carry >= 1.5) { rippleLines(p, sz); carry = 0; }
      } else {
        const step = spacing(sz);
        let t = step - carry;
        while (t <= L) {
          stamp(last[0] + d[0] * t, last[1] + d[1] * t, sz);
          t += step;
        }
        carry = L - (t - step);
      }
      last = p;
      return marks.splice(0);
    },
  };
}
