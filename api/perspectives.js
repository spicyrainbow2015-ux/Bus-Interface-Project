// Reads the current shared state (keyword counts + a featured submission +
// people count) for the City Connector bus-stop screen. Auto-seeds Redis
// with the original design's sample content on the very first call, so a
// fresh deployment doesn't start from an empty, awkward-looking screen —
// real submissions build on top of that seed from then on, same idea as
// the SEPTA schedule-fallback data elsewhere in this project.
//
// Data model (see submit-perspective.js and refresh-themes.js):
//   perspectives:submission:<id>  STRING  JSON blob: {id, quote, author,
//                                  timestamp, status, keywords}
//   perspectives:submissionIds    LIST    ids, newest first
//   perspectives:keywords         HASH    keyword -> all-time mention count
//   perspectives:onScreen         ZSET    the categories currently shown as
//                                  bubbles; score = when each came on screen.
//                                  Filled and trimmed (oldest out first) by
//                                  refresh-themes.js, emptied by
//                                  clear-bubbles.js
//   perspectives:initV2           STRING  set once the setup below has run
//   perspectives:peopleCount      STRING  running total of submissions
//
// The "featured" submission is just the most recent one by submission
// order — it doesn't need to be processed (tagged) yet to be featured,
// since the postcard only shows the quote/author/photo, not its tags.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const SEED_ID = 'seed-midway';
const SEED_KEYWORDS = {
  Comforted: 48, Energized: 27, Nostalgic: 21, 'In the rain': 15,
  'Back garden': 13, Revisitor: 9, Sunset: 7, Architecture: 6,
};
const SEED_SUBMISSION = {
  id: SEED_ID,
  quote: 'Midway under snow storm!',
  author: 'Lucy Huang',
  keywords: ['Nostalgic'],
  timestamp: '2022-01-03T00:00:00.000Z',
  status: 'processed',
  photo: 'images/featured.jpg', // only the seed submission has a real photo; real submissions don't collect one yet
};
const SEED_PEOPLE_COUNT = 121;

const ON_SCREEN_KEY = 'perspectives:onScreen';
const INIT_KEY = 'perspectives:initV2';
// Same cap/key as refresh-themes.js — keep them in sync.
const MAX_ON_SCREEN = 8;

// One-time setup, guarded by a single marker so a normal request costs one
// existence check (same as before). It does two things:
//  1. brand-new database -> seed the sample content (as before);
//  2. build the on-screen list from whatever data already exists, so
//     upgrading doesn't blank the screen: the 8 biggest categories that
//     were visible under the old "Clear bubbles" snapshot (if any). Smaller
//     totals get earlier scores, i.e. they're the first to be replaced.
// After this runs once, "Clear bubbles" can safely empty the on-screen list
// without it ever being mistaken for "never set up".
async function ensureInitialized(){
  if (await redis.exists(INIT_KEY)) return;

  if (!(await redis.exists('perspectives:submissionIds'))) {
    await redis.hset('perspectives:keywords', SEED_KEYWORDS);
    await redis.set(`perspectives:submission:${SEED_ID}`, JSON.stringify(SEED_SUBMISSION));
    await redis.lpush('perspectives:submissionIds', SEED_ID);
    await redis.set('perspectives:peopleCount', SEED_PEOPLE_COUNT);
  }

  const totals = await redis.hgetall('perspectives:keywords') || {};
  const clearedSnapshot = await redis.hgetall('perspectives:clearedCounts') || {}; // legacy, only read here
  const visible = Object.entries(totals)
    .map(([word, count]) => [word, Number(count)])
    .filter(([word, count]) => count > Number(clearedSnapshot[word] || 0))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ON_SCREEN);
  if (visible.length) {
    const base = Date.now();
    const [first, ...rest] = visible.map(([word], i) => ({ score: base - i, member: word }));
    await redis.zadd(ON_SCREEN_KEY, { nx: true }, first, ...rest);
  }

  await redis.set(INIT_KEY, 1);
}

module.exports = async (req, res) => {
  // No edge caching: a stale response right after "Clear bubbles" or
  // "Refresh themes" would resurrect bubbles / hide new ones for up to ~20s
  // (the old s-maxage=5 + stale-while-revalidate=15 caused exactly that kind
  // of bug once already). Only the single kiosk page polls this.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await ensureInitialized();

    const [keywordsMap, onScreen, recentIds, peopleCount] = await Promise.all([
      redis.hgetall('perspectives:keywords'),
      redis.zrange(ON_SCREEN_KEY, 0, -1), // categories currently shown, earliest-to-appear first
      redis.lrange('perspectives:submissionIds', 0, 0), // most recent submission id
      redis.get('perspectives:peopleCount'),
    ]);

    const totals = keywordsMap || {};
    const hasTotal = (word) => Object.prototype.hasOwnProperty.call(totals, word);
    // Exactly the categories on screen, each with its ALL-TIME total (so a
    // category that was bumped off and comes back keeps its size).
    // String(): the Redis client auto-converts number-looking members.
    const keywords = (onScreen || []).map(String).filter(hasTotal)
      .map(word => ({ word, count: Number(totals[word]) }));
    // All-time max, INCLUDING categories not currently shown: bubble size is
    // scaled against this so sizes stay consistent as bubbles come and go.
    const maxKeywordCount = Object.values(totals).reduce((m, c) => Math.max(m, Number(c)), 0);

    let featured = SEED_SUBMISSION;
    const recentId = recentIds && recentIds[0];
    if (recentId) {
      const raw = await redis.get(`perspectives:submission:${recentId}`);
      if (raw) featured = typeof raw === 'string' ? JSON.parse(raw) : raw;
    }

    res.status(200).json({
      keywords,
      maxKeywordCount,
      featured,
      peopleCount: Number(peopleCount) || SEED_PEOPLE_COUNT,
    });
  } catch (err) {
    console.error('perspectives error:', err);
    // Fall back to the original seed content rather than an empty/broken
    // screen — same "never show nothing" principle as the bus data.
    res.status(200).json({
      keywords: Object.entries(SEED_KEYWORDS).map(([word, count]) => ({ word, count })),
      maxKeywordCount: Math.max(...Object.values(SEED_KEYWORDS)),
      featured: SEED_SUBMISSION,
      peopleCount: SEED_PEOPLE_COUNT,
      error: 'Live perspective data temporarily unavailable.',
    });
  }
};
