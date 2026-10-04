// Manual retry for the automatic tagging in submit-perspective.js: finds every
// submission still marked "pending" (its AI call failed or timed out at
// submit time) and runs it through Claude now, oldest first. Nothing on the
// kiosk calls this any more — hit it with a POST if a submission ever gets
// stuck pending. The actual processing lives in lib/themes.js.

const { Redis } = require('@upstash/redis');
const { processSubmission, trimOnScreen } = require('../lib/themes');

const redis = Redis.fromEnv();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const ids = await redis.lrange('perspectives:submissionIds', 0, 49);
    const existingKeywordsMap = await redis.hgetall('perspectives:keywords') || {};
    const existingKeywords = Object.keys(existingKeywordsMap);

    // ids is newest-first; walk it OLDEST-first so that when several pending
    // submissions are processed in one go, their categories land on screen
    // in the order people actually submitted.
    const ctx = { tick: Date.now() };
    const processed = [];
    for (const id of [...ids].reverse()) {
      try {
        const result = await processSubmission(id, existingKeywords, ctx);
        if (result) processed.push(result);
      } catch (err) {
        // One failing Claude call shouldn't block the rest.
        console.error(`refresh-themes: failed to process submission ${id}, skipping:`, err);
      }
    }

    if (processed.length) await trimOnScreen();

    res.status(200).json({ ok: true, processedCount: processed.length, processed });
  } catch (err) {
    console.error('refresh-themes error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong refreshing themes.' });
  }
};
