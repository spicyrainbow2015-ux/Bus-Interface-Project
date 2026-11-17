// Photo submissions for the Ink Projector (ink-projector/).
// Shared by the Vercel function (api/ink.js, Upstash Redis) and the local dev
// server (ink-projector/serve.js, an in-memory store with the same methods).
//
// Flow: the operator opens one section of the doorway for drawing (setState).
// Visitors scan a QR code, photograph their drawing on the printed template,
// and their phone extracts just the ink and submits it as a small PNG.
// Submissions wait in a queue until the operator approves or rejects them.
//
// Redis keys (all under "ink:"):
//   ink:state        JSON  { section, aspect, paperRatio, thumb, updatedAt }
//                          section = which shape is open (null = closed)
//   ink:sub:<id>     JSON  { id, section, png, w, h, ts }   (expires after 7 days)
//   ink:pending      LIST  submission ids, newest first (capped at 100)
//   ink:approved     LIST  approved ids in the order they were approved (capped at 80)
//
// Operator actions can be locked with a shared key: set INK_OPERATOR_KEY in the
// Vercel project and the operator page will ask for it once.

const MAX_PNG_CHARS = 600000; // keeps each Redis request well under Upstash's size limit
const MAX_THUMB_CHARS = 80000;
const SUB_TTL_SECONDS = 7 * 24 * 3600;
const K = {
  state: 'ink:state',
  pending: 'ink:pending',
  approved: 'ink:approved',
  sub: (id) => `ink:sub:${id}`,
};
const OPERATOR_OPS = new Set(['setState', 'pending', 'decide', 'approved', 'item', 'clear']);

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
      return ok(s);
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
      const state = await store.get(K.state);
      if (!state || state.section == null) return fail(409, 'Nothing is open for drawing right now.');
      const png = String(body.png || '');
      if (!png.startsWith('data:image/png;base64,')) return fail(400, 'Expected a PNG image');
      if (png.length > MAX_PNG_CHARS) return fail(413, 'That image is too large');
      const w = Math.round(Number(body.w)), h = Math.round(Number(body.h));
      if (!(w > 0 && h > 0 && w <= 4000 && h <= 4000)) return fail(400, 'Bad image size');
      const section = Number.isFinite(Number(body.section)) ? Number(body.section) : state.section;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await store.set(K.sub(id), { id, section, png, w, h, ts: Date.now() }, { ex: SUB_TTL_SECONDS });
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
    async rpush(k, v) { m.set(k, [...list(k), v]); },
    async ltrim(k, s, e) { m.set(k, range(list(k), s, e)); },
    async lrange(k, s, e) { return range(list(k), s, e); },
    async lrem(k, _count, v) { m.set(k, list(k).filter((x) => x !== v)); },
  };
}

module.exports = { handle, memoryStore };
