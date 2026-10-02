// Clears the bubbles from the kiosk display WITHOUT losing any data.
//
// The screen shows exactly the categories in the sorted set
// perspectives:onScreen (see refresh-themes.js for how it fills up and
// trims itself), so clearing is just emptying that set. The real totals in
// perspectives:keywords and the "N responses" count in
// perspectives:peopleCount are never touched, which is why a category
// comes back later at its full old size plus the new response, and a
// brand-new category simply appears.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ON_SCREEN_KEY = 'perspectives:onScreen';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const clearedCount = await redis.zcard(ON_SCREEN_KEY);
    await redis.del(ON_SCREEN_KEY);
    res.status(200).json({ ok: true, clearedCount });
  } catch (err) {
    console.error('clear-bubbles error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong clearing the bubbles.' });
  }
};
