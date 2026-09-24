// Phase 1 of 2 — CAPTURE ONLY. Stores a submitted perspective (quote +
// optional author) in Redis with status "pending". No AI call happens
// here, on purpose: the submitter shouldn't have to wait on an API round
// trip, and this keeps API calls fully under manual control (see
// api/refresh-themes.js, which is Phase 2 and does the actual Claude
// call). Flipping this to fully automatic later is a one-line change —
// call the same processing function this endpoint intentionally does NOT
// call — not a rearchitecture.
//
// Redis keys used (all under the "perspectives:" namespace so they don't
// collide with anything else that might land in this KV store later):
//   perspectives:submission:<id>  STRING  JSON blob: {id, quote, author,
//                                  timestamp, status: 'pending'|'processed',
//                                  keywords: []}
//   perspectives:submissionIds    LIST    ids, newest first, capped at 50
//   perspectives:keywords         HASH    keyword -> mention count
//                                  (only written during Phase 2)
//   perspectives:peopleCount      STRING  running total of submissions —
//                                  counts everyone who submitted, whether
//                                  or not their text has been processed yet

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const MAX_QUOTE_LENGTH = 500;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const quote = String(body.quote || '').trim();
    const author = String(body.author || 'Anonymous').trim().slice(0, 60);

    if (!quote) { res.status(400).json({ error: 'quote is required' }); return; }
    if (quote.length > MAX_QUOTE_LENGTH) {
      res.status(400).json({ error: `quote must be ${MAX_QUOTE_LENGTH} characters or fewer` });
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, quote, author, timestamp: new Date().toISOString(), status: 'pending', keywords: [] };

    await redis.set(`perspectives:submission:${id}`, JSON.stringify(record));
    await redis.lpush('perspectives:submissionIds', id);
    await redis.ltrim('perspectives:submissionIds', 0, 49); // keep the list from growing forever
    const peopleCount = await redis.incr('perspectives:peopleCount');

    res.status(200).json({ ok: true, id, peopleCount });
  } catch (err) {
    console.error('submit-perspective error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong saving that submission.' });
  }
};
