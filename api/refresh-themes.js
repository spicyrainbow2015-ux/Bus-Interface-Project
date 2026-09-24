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

// Exact wording tested in the Anthropic Workbench. Claude does its own
// matching against the existing themes it's given (see buildUserMessage
// below), so the response is {matched: [...], new: [...]} rather than a
// flat tag list — no separate case-insensitive matching pass needed here.
const SYSTEM_PROMPT = `You organize short local observations into community themes.

First identify the main takeaway of the observation, then compare it with the existing themes.

Rules:
1. Focus on the most meaningful, memorable, or recognizable idea. Ignore minor background details.
2. Use simple, everyday language a passerby would naturally understand.
3. Themes may describe atmosphere, emotion, activity, notable objects or places, or recurring local experiences.
4. Avoid vague or overly poetic labels such as "shared awe", "urban wonder", "collective joy", or "sky drama".
5. Keep themes to 1–3 words.

Tags can describe:
- atmosphere
- emotion
- activity
- a notable object or place
- a recurring local experience

Ignore supporting details unless they are the main point.

Good examples:
"pretty sky"
"quiet morning"
"rainy day"
"street music"
"cat"
"peaceful"
"sunset"

When starting off there's no existing themes, then generate as normal.
When existing theme exists, comparing with existing themes:
- Match an existing theme whenever it reasonably represents the same idea, even if the wording is different.
- Prefer an existing theme over creating a slightly different duplicate.
- Only create a new theme when the observation contains a meaningful idea not represented by the existing themes.
- A submission may match more than one theme if there are multiple important ideas.


Return only JSON:

{
"matched": [],
"new": []
}`;

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheapest/fastest Claude tier

function buildUserMessage(quote, existingKeywords){
  const themesLine = existingKeywords.length
    ? `Existing themes: ${JSON.stringify(existingKeywords)}`
    : `Existing themes: none yet`;
  return `${themesLine}\n\nObservation: "${quote}"`;
}

// Finds the first *balanced* {...} object in text, unlike a greedy regex
// (which grabs from the first "{" to the LAST "}" in the whole string —
// if Claude adds any trailing note after the JSON, and that note happens
// to contain its own "}", the regex swallows both and JSON.parse chokes
// on the leftover text in between). This is what was causing every
// "Refresh themes" call to fail outright.
function extractFirstJsonObject(text){
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++){
    if (text[i] === '{') depth++;
    else if (text[i] === '}'){
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function extractTags(quote, existingKeywords){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 150, // {"matched":[...],"new":[...]} can run longer than a flat array
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(quote, existingKeywords) }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const textOut = (data.content || []).map(b => b.text || '').join('').trim();
  let parsed;
  try {
    parsed = JSON.parse(textOut);
  } catch {
    // Claude occasionally wraps the object in a little extra text despite
    // instructions not to — fall back to pulling the first balanced {...}
    // out. If even that isn't valid JSON, treat it as no tags rather than
    // throwing (a single malformed response shouldn't fail the whole batch).
    const extracted = extractFirstJsonObject(textOut);
    try {
      parsed = extracted ? JSON.parse(extracted) : {};
    } catch (err) {
      console.error('refresh-themes: could not parse Claude response, skipping tags for this one:', textOut, err);
      parsed = {};
    }
  }
  const asStringList = (v) => Array.isArray(v) ? v.filter(t => typeof t === 'string' && t.trim()) : [];
  return { matched: asStringList(parsed.matched), new: asStringList(parsed.new) };
}

async function processSubmission(id, existingKeywords){
  const raw = await redis.get(`perspectives:submission:${id}`);
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (record.status !== 'pending') return null;

  const { matched, new: newThemes } = await extractTags(record.quote, existingKeywords);
  const finalKeywords = [];
  const newKeywords = [];

  for (const tag of matched) {
    // Claude already matched this against the existing themes it was given —
    // this just finds the stored casing so counts land on the same bubble.
    const kw = existingKeywords.find(k => k.toLowerCase() === tag.toLowerCase()) || tag;
    finalKeywords.push(kw);
    await redis.hincrby('perspectives:keywords', kw, 1);
  }

  for (const kw of newThemes) {
    if (!existingKeywords.includes(kw)) { existingKeywords.push(kw); newKeywords.push(kw); }
    finalKeywords.push(kw);
    await redis.hincrby('perspectives:keywords', kw, 1);
  }

  record.status = 'processed';
  record.keywords = finalKeywords;
  await redis.set(`perspectives:submission:${id}`, JSON.stringify(record));
  // quote/author/timestamp included so the client can play the "new
  // submission dropped" envelope animation without a second round trip.
  return { id, quote: record.quote, author: record.author, timestamp: record.timestamp, keywords: finalKeywords, newKeywords };
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
      try {
        const result = await processSubmission(id, existingKeywords);
        if (result) processed.push(result);
      } catch (err) {
        // One submission's Claude call failing (rate limit, transient API
        // error, etc.) shouldn't block every other pending submission from
        // being processed — log it and move on, same as a null result.
        console.error(`refresh-themes: failed to process submission ${id}, skipping:`, err);
      }
    }

    res.status(200).json({ ok: true, processedCount: processed.length, processed });
  } catch (err) {
    console.error('refresh-themes error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong refreshing themes.' });
  }
};
