// Saves a submitted perspective (quote + optional author) in Redis, then
// immediately tags it with Claude (lib/themes.js) so the kiosk can show it,
// with its tags and bubbles, on its next poll. The submission is saved
// FIRST: if the AI call fails or times out, the submitter still gets a
// success and the record just stays "pending" (api/refresh-themes.js can
// retry it). Only the quote text goes to Claude — never the author or date.
//
// Redis keys used (all under the "perspectives:" namespace so they don't
// collide with anything else that might land in this KV store later):
//   perspectives:submission:<id>  STRING  JSON blob: {id, quote, author,
//                                  timestamp, status: 'pending'|'processed',
//                                  keywords: []}
//   perspectives:submissionIds    LIST    ids, newest first, capped at 50
//   perspectives:keywords         HASH    keyword -> mention count
//                                  (written when the submission is tagged)
//   perspectives:peopleCount      STRING  running total of submissions —
//                                  counts everyone who submitted, whether
//                                  or not their text has been processed yet

const { Redis } = require('@upstash/redis');
const { processOne } = require('../lib/themes');

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

    // Must finish before responding — a serverless function can be frozen
    // the moment the response is sent. Failure here never fails the submission.
    try {
      await processOne(id);
    } catch (err) {
      console.error(`submit-perspective: tagging ${id} failed, leaving it pending:`, err);
    }

    res.status(200).json({ ok: true, id, peopleCount });
  } catch (err) {
    console.error('submit-perspective error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong saving that submission.' });
  }
};
