// Reads the current shared state (keyword counts + a featured submission +
// people count) for the City Connector bus-stop screen. Auto-seeds Redis
// with the original design's sample content on the very first call, so a
// fresh deployment doesn't start from an empty, awkward-looking screen —
// real submissions build on top of that seed from then on, same idea as
// the SEPTA schedule-fallback data elsewhere in this project (a sensible
// starting point, not a permanent placeholder).

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const SEED_KEYWORDS = {
  Comforted: 48, Energized: 27, Nostalgic: 21, 'In the rain': 15,
  'Back garden': 13, Revisitor: 9, Sunset: 7, Architecture: 6,
};
const SEED_SUBMISSION = {
  quote: 'Midway under snow storm!',
  author: 'Lucy Huang',
  keywords: ['Nostalgic'],
  timestamp: '2022-01-03T00:00:00.000Z',
  photo: 'images/featured.jpg', // only the seed submission has a real photo; real submissions don't collect one yet
};
const SEED_PEOPLE_COUNT = 121;

async function ensureSeeded() {
  const exists = await redis.exists('perspectives:keywords');
  if (exists) return;
  await redis.hset('perspectives:keywords', SEED_KEYWORDS);
  await redis.lpush('perspectives:submissions', JSON.stringify(SEED_SUBMISSION));
  await redis.set('perspectives:peopleCount', SEED_PEOPLE_COUNT);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=15');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    await ensureSeeded();

    const [keywordsMap, submissionsRaw, peopleCount] = await Promise.all([
      redis.hgetall('perspectives:keywords'),
      redis.lrange('perspectives:submissions', 0, 0), // most recent submission
      redis.get('perspectives:peopleCount'),
    ]);

    const keywords = Object.entries(keywordsMap || {}).map(([word, count]) => ({ word, count: Number(count) }));
    // lrange over the REST API can hand back either a JSON string or an
    // already-parsed object depending on the client version — handle both.
    const raw = submissionsRaw && submissionsRaw[0];
    const featured = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : SEED_SUBMISSION;

    res.status(200).json({
      keywords,
      featured,
      peopleCount: Number(peopleCount) || SEED_PEOPLE_COUNT,
    });
  } catch (err) {
    console.error('perspectives error:', err);
    // Fall back to the original seed content rather than an empty/broken
    // screen — same "never show nothing" principle as the bus data.
    res.status(200).json({
      keywords: Object.entries(SEED_KEYWORDS).map(([word, count]) => ({ word, count })),
      featured: SEED_SUBMISSION,
      peopleCount: SEED_PEOPLE_COUNT,
      error: 'Live perspective data temporarily unavailable.',
    });
  }
};
