// Phase 2 of 2 — PROCESSING. Manually triggered only (the "Refresh
// themes" button on the kiosk page, for now) — finds every submission
// still marked "pending", sends each one's TEXT ONLY (never author or
// date — see submit-perspective.js, which never stores them together on
// the way to Claude) to Claude, and stores the returned tags back onto
// that submission plus into the aggregate keyword counts.
//
// To make this fully automatic later: call processSubmission() (below)
// at the end of submit-perspective.js instead of waiting for this
// endpoint to be hit manually. The processing logic itself doesn't
// change either way.

// PLACEHOLDER PROMPT — swap this for your exact Workbench-tested wording
// the moment you send it. Everything else in this file works regardless
// of the exact wording, since it only expects a JSON array of short
// strings back (e.g. ["quiet morning","peaceful"]).
const SYSTEM_PROMPT = `You extract 1-3 short, meaningful themes from a short piece of text someone wrote about a place — an emotion, a notable detail, or an activity, not generic filler words. Respond with ONLY a JSON array of short lowercase phrases, nothing else, no explanation. Example response: ["quiet morning","peaceful"]`;

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheapest/fastest Claude tier

async function extractTags(text){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 30,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const textOut = (data.content || []).map(b => b.text || '').join('').trim();
  let tags;
  try {
    tags = JSON.parse(textOut);
  } catch {
    // Claude occasionally wraps the array in a little extra text despite
    // instructions not to — fall back to pulling the first [...] out.
    const match = textOut.match(/\[[\s\S]*\]/);
    tags = match ? JSON.parse(match[0]) : [];
  }
  return Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 3) : [];
}

// Matches a returned tag against existing bubble categories case-
// insensitively, so "Peaceful" and "peaceful" merge into one bubble
// instead of becoming two separate ones. Exact-match only (no fuzzy/
// semantic matching) — flagged as a placeholder decision, same as the
// system prompt above.
function resolveKeyword(tag, existingKeywords){
  const found = existingKeywords.find(k => k.toLowerCase() === tag.toLowerCase());
  return found || tag;
}

async function processSubmission(id, existingKeywords){
  const raw = await redis.get(`perspectives:submission:${id}`);
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (record.status !== 'pending') return null;

  const rawTags = await extractTags(record.quote);
  const finalKeywords = [];
  const newKeywords = [];
  for (const tag of rawTags) {
    const kw = resolveKeyword(tag, existingKeywords);
    finalKeywords.push(kw);
    if (!existingKeywords.includes(kw)) { existingKeywords.push(kw); newKeywords.push(kw); }
    await redis.hincrby('perspectives:keywords', kw, 1);
  }

  record.status = 'processed';
  record.keywords = finalKeywords;
  await redis.set(`perspectives:submission:${id}`, JSON.stringify(record));
  return { id, keywords: finalKeywords, newKeywords };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const ids = await redis.lrange('perspectives:submissionIds', 0, 49);
    const existingKeywordsMap = await redis.hgetall('perspectives:keywords') || {};
    const existingKeywords = Object.keys(existingKeywordsMap);

    const processed = [];
    for (const id of ids) {
      const result = await processSubmission(id, existingKeywords);
      if (result) processed.push(result);
    }

    res.status(200).json({ ok: true, processedCount: processed.length, processed });
  } catch (err) {
    console.error('refresh-themes error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong refreshing themes.' });
  }
};
