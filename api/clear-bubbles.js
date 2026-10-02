// Clears the bubbles from the kiosk display WITHOUT losing any data.
//
// How: snapshots every category's current total into
// perspectives:clearedCounts. api/perspectives.js only returns a category
// as a visible bubble when its live total is higher than its snapshot, so:
//   - everything disappears right after a clear (total == snapshot),
//   - a category that gets a new response comes back carrying its old
//     total (e.g. 49 -> 50), i.e. it "continues from where it left off",
//   - a brand-new category has no snapshot (treated as 0) and appears
//     immediately.
// perspectives:keywords (the real totals) and perspectives:peopleCount (the
// "N responses" number) are never touched, so a clear is fully reversible
// in the sense that no history is lost.
//
// Counts only ever go up, so overwriting the snapshot field-by-field with
// HSET (instead of DEL + HSET) is safe, and means a concurrent read never
// sees a half-empty snapshot and briefly flashes every bubble back.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const counts = await redis.hgetall('perspectives:keywords') || {};
    const snapshot = {};
    for (const [word, count] of Object.entries(counts)) snapshot[word] = Number(count);

    const words = Object.keys(snapshot);
    if (words.length) await redis.hset('perspectives:clearedCounts', snapshot);

    res.status(200).json({ ok: true, clearedCount: words.length });
  } catch (err) {
    console.error('clear-bubbles error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong clearing the bubbles.' });
  }
};
