// Ink Projector photo submissions: active section, queue, approvals.
// All logic lives in lib/ink-api.js (shared with the local dev server).
//   GET  /api/ink?op=state        current open section (public)
//   POST /api/ink?op=submit       a visitor's extracted drawing (public)
//   POST /api/ink?op=setState     open/close a section        (operator)
//   GET  /api/ink?op=pending      queue awaiting approval      (operator)
//   POST /api/ink?op=decide       approve or reject one        (operator)
//   GET  /api/ink?op=approved     approved drawing ids, in order (operator)
//   GET  /api/ink?op=item&id=…    one drawing                  (operator)
//   POST /api/ink?op=clear        forget approved drawings     (operator)

const { Redis } = require('@upstash/redis');
const { handle } = require('../lib/ink-api');

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-operator-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const r = await handle(redis, {
      method: req.method,
      query: req.query || {},
      body,
      headers: req.headers || {},
      operatorKey: process.env.INK_OPERATOR_KEY || '',
    });
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('ink api error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
};
