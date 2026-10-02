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
//   perspectives:keywords         HASH    keyword -> mention count
//   perspectives:clearedCounts    HASH    keyword -> total at the last "Clear
//                                  bubbles" (see clear-bubbles.js); a
//                                  category is shown only if it has grown
//                                  past this
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

async function ensureSeeded(){
  const exists = await redis.exists('perspectives:submissionIds');
  if (exists) return;
  await redis.hset('perspectives:keywords', SEED_KEYWORDS);
  await redis.set(`perspectives:submission:${SEED_ID}`, JSON.stringify(SEED_SUBMISSION));
  await redis.lpush('perspectives:submissionIds', SEED_ID);
  await redis.set('perspectives:peopleCount', SEED_PEOPLE_COUNT);
}

module.exports = async (req, res) => {
  // No edge caching: a stale response right after "Clear bubbles" or
  // "Refresh themes" would resurrect bubbles / hide new ones for up to ~20s
  // (the old s-maxage=5 + stale-while-revalidate=15 caused exactly that kind
  // of bug once already). Only the single kiosk page polls this.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await ensureSeeded();

    const [keywordsMap, clearedMap, recentIds, peopleCount] = await Promise.all([
      redis.hgetall('perspectives:keywords'),
      redis.hgetall('perspectives:clearedCounts'), // snapshot written by api/clear-bubbles.js
      redis.lrange('perspectives:submissionIds', 0, 0), // most recent submission id
      redis.get('perspectives:peopleCount'),
    ]);

    const allKeywords = Object.entries(keywordsMap || {}).map(([word, count]) => ({ word, count: Number(count) }));
    const cleared = clearedMap || {};
    // A category is on screen only if it has grown since the last clear
    // (no snapshot yet == 0, so before any clear everything is visible).
    const keywords = allKeywords.filter(k => k.count > Number(cleared[k.word] || 0));
    // All-time max, INCLUDING hidden categories: bubble size is scaled
    // against this so a category keeps the size it had before a clear
    // instead of ballooning just because the visible ones are all small.
    const maxKeywordCount = allKeywords.reduce((m, k) => Math.max(m, k.count), 0);

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
