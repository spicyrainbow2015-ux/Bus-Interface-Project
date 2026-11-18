// Photo submissions for the Ink Projector (ink-projector/).
// Shared by the Vercel function (api/ink.js, Upstash Redis) and the local dev
// server (ink-projector/serve.js, an in-memory store with the same methods).
//
// Flow: visitors scan a QR code, choose which part of the doorway their drawing
// is for (a "frame"), and photograph a drawing on any paper. Their phone extracts
// just the ink, trims to the drawing and submits it as a small PNG.
// Submissions wait in a queue until the operator approves or rejects them.
// (Older flow, still supported: the operator opens one doorway shape with setState
// and the phone submits for that shape.)
//
// Redis keys (all under "ink:"):
//   ink:state        JSON  { section, aspect, paperRatio, thumb, updatedAt }
//                          section = which shape is open (null = closed)
//   ink:frames       JSON  [{ id, name }] parts visitors can choose (defaults below)
//   ink:sub:<id>     JSON  { id, frame, frameName, section, png, w, h, ts }   (expires after 7 days)
//   ink:pending      LIST  submission ids, newest first (capped at 100)
//   ink:approved     LIST  approved ids in the order they were approved (capped at 80)
//
// Live phone drawing (draw.html): the operator maps shapes onto the wall and saves them here;
// visitors pick a shape on their phone and draw, and each stroke is sent in small pieces as it's drawn.
//   ink:shapes       JSON  { shapes: [{ id, name, aspect, quad, tw, th }], screen }   quad = corners on the projector
//   ink:strokes      LIST  stroke pieces { sid, shape, brush, size, color, mix, pts: [[u, v, pressure, ms]], end }
//   ink:strokeBase   INT   how many old pieces were trimmed off the front of ink:strokes
//
// Operator actions can be locked with a shared key: set INK_OPERATOR_KEY in the
// Vercel project and the operator page will ask for it once.

const MAX_PNG_CHARS = 600000; // keeps each Redis request well under Upstash's size limit
const MAX_THUMB_CHARS = 80000;
const SUB_TTL_SECONDS = 7 * 24 * 3600;
// The parts of the doorway visitors can choose from, until the operator sets its own list.
// box = the part's bounding box in the traced doorway photo's pixels [left, top, right, bottom];
// it must match DOOR_PARTS in ink-projector/control.js. The phone uses its proportions to find
// the part's shape on the printed template.
const partAspect = ([l, t, r, b]) => (r - l + 1) / (b - t + 1);
const DEFAULT_FRAMES = [
  { id: 'left-door', name: 'Left door', box: [370, 179, 460, 598] },
  { id: 'right-door', name: 'Right door', box: [462, 179, 552, 598] },
  { id: 'arch', name: 'Arch', box: [340, 146, 582, 267] },
  { id: 'left-column', name: 'Left column', box: [281, 153, 332, 522] },
  { id: 'right-column', name: 'Right column', box: [591, 153, 647, 517] },
  { id: 'steps', name: 'Steps', box: [232, 642, 688, 743] },
].map((f) => ({ ...f, aspect: partAspect(f.box) }));
const K = {
  frames: 'ink:frames',
  state: 'ink:state',
  pending: 'ink:pending',
  approved: 'ink:approved',
  sub: (id) => `ink:sub:${id}`,
  shapes: 'ink:shapes',
  strokes: 'ink:strokes',
  strokeBase: 'ink:strokeBase',
};
const OPERATOR_OPS = new Set(['setState', 'pending', 'decide', 'approved', 'item', 'clear', 'setShapes', 'strokes']);
const BRUSH_IDS = new Set(['pen', 'spray', 'hatch', 'ripple', 'polka', 'tri']);
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const ok = (json) => ({ status: 200, json });
const fail = (status, error) => ({ status, json: { ok: false, error } });

async function loadMany(store, ids) {
  if (!ids || !ids.length) return [];
  const recs = await store.mget(...ids.map(K.sub));
  return recs.filter(Boolean);
}

async function handle(store, { method, query, body, headers, operatorKey }) {
  const op = (query && query.op) || '';
  if (OPERATOR_OPS.has(op) && operatorKey && (headers['x-operator-key'] || '') !== operatorKey) {
    return fail(401, 'Operator key required');
  }

  switch (op) {
    case 'state': {
      const s = (await store.get(K.state)) || { section: null };
      const frames = (await store.get(K.frames)) || DEFAULT_FRAMES;
      const sh = (await store.get(K.shapes)) || { shapes: [], screen: 16 / 9 };
      return ok({ ...s, frames, shapes: sh.shapes, screen: sh.screen });
    }

    case 'setShapes': {
      if (method !== 'POST') return fail(405, 'Use POST');
      const list = Array.isArray(body.shapes) ? body.shapes.slice(0, 24) : [];
      const shapes = list.map((x) => ({
        id: String(x.id || '').slice(0, 40),
        name: String(x.name || '').slice(0, 40),
        aspect: num(x.aspect, 0.05, 20, 1),
        quad: Array.isArray(x.quad) && x.quad.length === 4 ? x.quad.map((c) => [num(c[0], -2, 3, 0), num(c[1], -2, 3, 0)]) : null,
        tw: num(x.tw, 1, 4000, 200), th: num(x.th, 1, 4000, 200),
      })).filter((x) => x.id);
      await store.set(K.shapes, { shapes, screen: num(body.screen, 0.2, 5, 16 / 9), updatedAt: Date.now() });
      return ok({ ok: true });
    }

    case 'stroke': {
      // One piece of a visitor's stroke (public)
      if (method !== 'POST') return fail(405, 'Use POST');
      const sh = (await store.get(K.shapes)) || { shapes: [] };
      const shape = String(body.shape || '');
      if (!sh.shapes.some((x) => x.id === shape)) return fail(400, 'That shape is gone. Go back to the map.');
      const pts = (Array.isArray(body.pts) ? body.pts.slice(0, 600) : [])
        .map((q) => [num(q[0], -1, 2, 0), num(q[1], -1, 2, 0), num(q[2], 0, 1, 0), Math.round(num(q[3], 0, 600000, 0))]);
      const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#17171d';
      const piece = {
        sid: String(body.sid || '').slice(0, 40), shape,
        brush: BRUSH_IDS.has(body.brush) ? body.brush : 'pen',
        size: num(body.size, 1, 60, 6), color, mix: num(body.mix, 0, 1, 0.35),
        pts: pts.map((q) => q.map((v) => Math.round(v * 10000) / 10000)), end: !!body.end,
      };
      if (!piece.sid || (!pts.length && !piece.end)) return fail(400, 'Empty stroke');
      const len = await store.rpush(K.strokes, piece);
      if (len > 3000) {
        await store.ltrim(K.strokes, -1500, -1);
        await store.incrby(K.strokeBase, len - 1500);
      }
      return ok({ ok: true });
    }

    case 'strokes': {
      // New stroke pieces since a position; since=-1 means "start from now"
      const base = Number(await store.get(K.strokeBase)) || 0;
      const len = await store.llen(K.strokes);
      let since = Number(query.since);
      if (!Number.isFinite(since) || since < 0) return ok({ next: base + len, items: [] });
      if (since < base) since = base;
      const start = since - base;
      const items = start < len ? await store.lrange(K.strokes, start, Math.min(len - 1, start + 400)) : [];
      return ok({ next: since + items.length, items });
    }

    case 'setState': {
      if (method !== 'POST') return fail(405, 'Use POST');
      const section = body.section == null ? null : Number(body.section);
      const thumb = typeof body.thumb === 'string' ? body.thumb : '';
      if (thumb.length > MAX_THUMB_CHARS) return fail(400, 'Thumbnail too large');
      const state = {
        section: Number.isFinite(section) ? section : null,
        aspect: Number(body.aspect) || 1,
        paperRatio: Number(body.paperRatio) || 1.4142,
        thumb,
        updatedAt: Date.now(),
      };
      await store.set(K.state, state);
      return ok({ ok: true });
    }

    case 'submit': {
      if (method !== 'POST') return fail(405, 'Use POST');
      const png = String(body.png || '');
      if (!png.startsWith('data:image/png;base64,')) return fail(400, 'Expected a PNG image');
      if (png.length > MAX_PNG_CHARS) return fail(413, 'That image is too large');
      const w = Math.round(Number(body.w)), h = Math.round(Number(body.h));
      if (!(w > 0 && h > 0 && w <= 4000 && h <= 4000)) return fail(400, 'Bad image size');
      let frame = null, frameName = null, section = null;
      if (body.frame != null) {
        const frames = (await store.get(K.frames)) || DEFAULT_FRAMES;
        const f = frames.find((x) => x.id === String(body.frame));
        if (!f) return fail(400, 'Please choose where your drawing goes.');
        frame = f.id; frameName = f.name;
      } else if (Number.isFinite(Number(body.section)) && body.section !== null) {
        section = Number(body.section);
      } else {
        return fail(400, 'Please choose where your drawing goes.');
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await store.set(K.sub(id), { id, frame, frameName, section, png, w, h, ts: Date.now() }, { ex: SUB_TTL_SECONDS });
      await store.lpush(K.pending, id);
      await store.ltrim(K.pending, 0, 99);
      return ok({ ok: true, id });
    }

    case 'pending': {
      const ids = await store.lrange(K.pending, 0, 7);
      return ok({ items: await loadMany(store, ids) });
    }

    case 'decide': {
      if (method !== 'POST') return fail(405, 'Use POST');
      const id = String(body.id || '');
      if (!id) return fail(400, 'id is required');
      await store.lrem(K.pending, 0, id);
      if (body.approve) {
        await store.rpush(K.approved, id);
        await store.ltrim(K.approved, -80, -1);
      } else {
        await store.del(K.sub(id));
      }
      return ok({ ok: true });
    }

    case 'approved': {
      // Just the ids; the operator fetches each drawing with op=item so no response gets huge
      return ok({ ids: await store.lrange(K.approved, 0, -1) });
    }

    case 'item': {
      const rec = await store.get(K.sub(String((query && query.id) || '')));
      return rec ? ok(rec) : fail(404, 'Not found');
    }

    case 'clear': {
      if (method !== 'POST') return fail(405, 'Use POST');
      await store.del(K.approved);
      return ok({ ok: true });
    }

    default:
      return fail(400, 'Unknown op');
  }
}

// In-memory store with the subset of the Upstash Redis API used above.
function memoryStore() {
  const m = new Map();
  const list = (k) => m.get(k) || [];
  const range = (a, s, e) => {
    const n = a.length;
    if (s < 0) s = Math.max(0, n + s);
    if (e < 0) e = n + e;
    return a.slice(s, e + 1);
  };
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
    async del(k) { m.delete(k); },
    async mget(...ks) { return ks.map((k) => (m.has(k) ? m.get(k) : null)); },
    async lpush(k, v) { m.set(k, [v, ...list(k)]); },
    async rpush(k, v) { const a = [...list(k), v]; m.set(k, a); return a.length; },
    async llen(k) { return list(k).length; },
    async incrby(k, n) { const v = (Number(m.get(k)) || 0) + n; m.set(k, v); return v; },
    async ltrim(k, s, e) { m.set(k, range(list(k), s, e)); },
    async lrange(k, s, e) { return range(list(k), s, e); },
    async lrem(k, _count, v) { m.set(k, list(k).filter((x) => x !== v)); },
  };
}

module.exports = { handle, memoryStore };
