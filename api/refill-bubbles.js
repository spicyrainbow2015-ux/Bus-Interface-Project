// Fills the kiosk's bubbles from the most recent answers: walks the stored
// submissions newest-first and collects each answer's categories until there
// are MAX_ON_SCREEN of them (or the answers run out — so answers from before
// the current question fill in if the current question has fewer). The
// earliest-submitted ones get the earliest scores, so the usual
// first-in-first-out replacement still holds from here on. Replaces whatever
// is on screen now; totals and the response count are never touched.
//
// Only the latest 50 submissions are kept in the id list (see
// submit-perspective.js), so that's the most this can look back through.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ON_SCREEN_KEY = 'perspectives:onScreen';
const MAX_ON_SCREEN = 15; // same cap as lib/themes.js and perspectives.js — keep them in sync

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const ids = await redis.lrange('perspectives:submissionIds', 0, 49); // newest first
    const totals = await redis.hgetall('perspectives:keywords') || {};
    const raws = ids.length ? await redis.mget(...ids.map(id => `perspectives:submission:${id}`)) : [];

    const picked = []; // categories, newest answer's first
    let answersUsed = 0;
    for (const raw of raws) {
      if (!raw) continue;
      const rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (rec.status !== 'processed') continue;
      let added = false;
      for (const cat of rec.keywords || []) {
        if (picked.length < MAX_ON_SCREEN && !picked.includes(cat) && Object.prototype.hasOwnProperty.call(totals, cat)) {
          picked.push(cat); added = true;
        }
      }
      if (added) answersUsed++;
      if (picked.length >= MAX_ON_SCREEN) break;
    }

    await redis.del(ON_SCREEN_KEY);
    if (picked.length) {
      const base = Date.now();
      // oldest answer's categories first = lowest score = first to be replaced
      const members = [...picked].reverse().map((member, i) => ({ score: base + i, member }));
      const [first, ...rest] = members;
      await redis.zadd(ON_SCREEN_KEY, first, ...rest);
    }
    res.status(200).json({ ok: true, count: picked.length, answers: answersUsed, categories: picked });
  } catch (err) {
    console.error('refill-bubbles error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong refilling the bubbles.' });
  }
};
