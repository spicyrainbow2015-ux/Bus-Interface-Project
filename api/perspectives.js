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
//   perspectives:labels           HASH    category -> its most recent
//                                  bubble_label (what the bubble shows);
//                                  also holds the setup-done marker field
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
// category -> most recent bubble_label (written by refresh-themes.js). This
// hash is read on EVERY poll to get the labels, so it also carries the
// one-time-setup marker as a field — checking "has setup run?" is then free
// instead of a separate Redis command per poll.
const LABELS_KEY = 'perspectives:labels';
const LABELS_INIT_FIELD = '__initV2__';
// The previous version kept its setup marker in its own key. If that's
// present, the on-screen list was already built — don't build it again.
const PREVIOUS_INIT_KEY = 'perspectives:initV2';
// Same cap/key as refresh-themes.js — keep them in sync.
const MAX_ON_SCREEN = 8;

// One-time setup. Only runs on the first request after deploying (a normal
// request sees the marker and skips this entirely). It does two things:
//  1. brand-new database -> seed the sample content;
//  2. build the on-screen list from whatever data already exists, so
//     upgrading doesn't blank the screen: the 8 biggest categories that
//     were visible under the old "Clear bubbles" snapshot (if any). Smaller
//     totals get earlier scores, i.e. they're the first to be replaced.
// After this runs once, "Clear bubbles" can safely empty the on-screen list
// without it ever being mistaken for "never set up".
async function ensureInitialized(){
  if (await redis.exists(PREVIOUS_INIT_KEY)) {
    await redis.hset(LABELS_KEY, { [LABELS_INIT_FIELD]: '1' });
    return;
  }

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

  await redis.hset(LABELS_KEY, { [LABELS_INIT_FIELD]: '1' });
}

// The 5 reads every request makes (the 6th command is fetching the featured
// submission itself, once its id is known).
const readAll = () => Promise.all([
  redis.hgetall('perspectives:keywords'),
  redis.zrange(ON_SCREEN_KEY, 0, -1), // categories currently shown, earliest-to-appear first
  redis.hgetall(LABELS_KEY),
  redis.lrange('perspectives:submissionIds', 0, 0), // most recent submission id
  redis.get('perspectives:peopleCount'),
]);

module.exports = async (req, res) => {
  // No edge caching: a stale response right after "Clear bubbles" or
  // "Refresh themes" would resurrect bubbles / hide new ones for up to ~20s
  // (the old s-maxage=5 + stale-while-revalidate=15 caused exactly that kind
  // of bug once already). Only the single kiosk page polls this.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    let [keywordsMap, onScreen, labelsMap, recentIds, peopleCount] = await readAll();
    if (!(labelsMap && labelsMap[LABELS_INIT_FIELD])) {
      await ensureInitialized();
      [keywordsMap, onScreen, labelsMap, recentIds, peopleCount] = await readAll();
    }

    const totals = keywordsMap || {};
    const labels = labelsMap || {};
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    // Exactly the categories on screen, each with its ALL-TIME total (so a
    // category that was bumped off and comes back keeps its size) and the
    // specific label the bubble should display (absent for categories that
    // predate labels — the page falls back to the category name).
    // String(): the Redis client auto-converts number-looking members/values.
    const keywords = (onScreen || []).map(String).filter(word => has(totals, word))
      .map(word => ({
        word,
        count: Number(totals[word]),
        label: word !== LABELS_INIT_FIELD && has(labels, word) ? String(labels[word]) : undefined,
      }));
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
