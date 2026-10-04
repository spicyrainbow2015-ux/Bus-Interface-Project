// The AI half of the pipeline: sends ONE submission's text (never the author
// or date) to Claude, and stores the returned tags back onto that submission
// plus into the aggregate counts and the on-screen bubble list.
//
// Used automatically by api/submit-perspective.js right after a submission is
// saved, and by api/refresh-themes.js (a manual retry for any submission whose
// AI call failed and so is still "pending"). Lives outside api/ so Vercel
// doesn't publish it as its own endpoint.

// The prompt is the wording from the Anthropic Workbench, pasted in as-is,
// with ONE change: its final "Return only JSON" block, which only showed
// {"matched": [], "new": []} without saying what goes inside the lists, now
// spells out the item shape the code reads — every item has a "category"
// (the broad tag used for matching/counting) AND a "bubble_label" (the
// specific phrase shown on the bubble). Claude does its own matching against
// the existing categories it's given (see buildUserMessage below).
const SYSTEM_PROMPT = `You organize short local observations into community themes.

First identify the main takeaway, then compare it with existing themes.

Rules:
1. Focus on the most meaningful or recognizable idea. Ignore minor details.
2. Use simple, everyday language.
3. Themes may describe atmosphere, emotion, activity, objects, places, or recurring local experiences.
4. Avoid vague or poetic labels like "shared awe", "urban wonder", or "sky drama".
5. Keep categories to 1–3 words.

For each theme:
- category = broader theme used for matching and counting
- bubble_label = more specific 2–5 word phrase shown to users
- Preserve a distinctive detail from the submission in the bubble_label.
- Do not invent details.

Examples:
"orange cat under the bench"
→ category: "cat"
→ bubble_label: "the bench cat"

"pink sunset reflected in windows"
→ category: "sunset"
→ bubble_label: "pink window sunsets"

When no existing themes exist, generate new ones normally.

When existing themes exist:
- Match an existing theme when it reasonably represents the same idea.
- Prefer an existing theme over a near-duplicate.
- Return matched category labels exactly as provided.
- Only create a new theme if the idea is meaningfully different.
- A submission may match more than one theme.

Return only JSON, in exactly this shape. Every item in "matched" and "new" is an object with both fields:

{
  "matched": [{ "category": "<existing category, exactly as provided>", "bubble_label": "<2-5 word label>" }],
  "new": [{ "category": "<new category>", "bubble_label": "<2-5 word label>" }]
}`;

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheapest/fastest Claude tier

// Which categories are currently shown as bubbles on the kiosk.
// perspectives:onScreen is a sorted set: member = category, score = the
// moment it came on screen. When more than MAX_ON_SCREEN are on, the ones
// with the lowest score (the earliest to appear) are dropped — plain
// first-in-first-out. Popularity deliberately doesn't protect a bubble: the
// point is to keep surfacing new, unusual perspectives, and a popular
// category simply comes back (at its full all-time size) the next time
// someone hits it. The category's total in perspectives:keywords is never
// touched by any of this.
// (Same cap/key as the initial setup in perspectives.js — keep them in sync.)
const ON_SCREEN_KEY = 'perspectives:onScreen';
const MAX_ON_SCREEN = 8;

// category -> its most recent bubble_label. The same hash also holds the
// one-time-setup marker field (see perspectives.js), which is why it's read on
// every poll anyway and the marker costs nothing extra.
const LABELS_KEY = 'perspectives:labels';
const LABELS_INIT_FIELD = '__initV2__';

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

const MAX_LABEL_LENGTH = 60;

// Turns Claude's list into [{ category, label }]. The expected item is
// { category, bubble_label }; a bare string (the old reply shape) is still
// accepted and just uses the category as its own label. A missing/blank
// bubble_label also falls back to the category, so a bubble never ends up
// with no text.
function normalizeThemes(list){
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const category = typeof item === 'string' ? item : (item && typeof item.category === 'string' ? item.category : '');
    const labelRaw = item && typeof item === 'object' && typeof item.bubble_label === 'string' ? item.bubble_label : '';
    if (!category.trim()) continue;
    out.push({ category: category.trim(), label: (labelRaw.trim() || category.trim()).slice(0, MAX_LABEL_LENGTH) });
  }
  return out;
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
      max_tokens: 300, // each item now carries category + bubble_label; a cut-off reply is unparseable JSON, which would silently drop every tag
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(quote, existingKeywords) }],
    }),
    signal: AbortSignal.timeout(8000), // never let a hung API call hold a submission open (Vercel's default function limit is 10s)
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
  return { matched: normalizeThemes(parsed.matched), new: normalizeThemes(parsed.new) };
}

// Puts a category on screen if it isn't already. nx:true means "only add if
// not already a member" — so a hit on a bubble that's already showing does
// NOT reset its clock (pure first-in-first-out, as chosen). ctx.tick hands
// out strictly increasing scores so ties can't scramble the order.
async function putOnScreen(kw, ctx){
  await redis.zadd(ON_SCREEN_KEY, { nx: true }, { score: ctx.tick++, member: kw });
}

// Remembers the most recent bubble_label for a category — that's the text
// the bubble displays (the category itself stays the identity used for
// matching and counting). Latest wins, so a bubble always shows the newest
// specific phrase someone used for it.
async function rememberLabel(category, label){
  if (category === LABELS_INIT_FIELD) return; // that field is the setup marker, not a category
  await redis.hset(LABELS_KEY, { [category]: label });
}

async function processSubmission(id, existingKeywords, ctx){
  const raw = await redis.get(`perspectives:submission:${id}`);
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (record.status !== 'pending') return null;

  const { matched, new: newThemes } = await extractTags(record.quote, existingKeywords);
  const themes = []; // [{ category, label }] for THIS submission — shown as tags on the card
  const newKeywords = [];

  for (const t of matched) {
    // Claude already matched this against the existing themes it was given —
    // this just finds the stored casing so counts land on the same bubble.
    const kw = existingKeywords.find(k => k.toLowerCase() === t.category.toLowerCase()) || t.category;
    themes.push({ category: kw, label: t.label });
    await redis.hincrby('perspectives:keywords', kw, 1);
    await rememberLabel(kw, t.label);
    await putOnScreen(kw, ctx);
  }

  for (const t of newThemes) {
    const kw = t.category;
    if (!existingKeywords.includes(kw)) { existingKeywords.push(kw); newKeywords.push(kw); }
    themes.push({ category: kw, label: t.label });
    await redis.hincrby('perspectives:keywords', kw, 1);
    await rememberLabel(kw, t.label);
    await putOnScreen(kw, ctx);
  }

  const finalKeywords = themes.map(t => t.category);
  record.status = 'processed';
  record.keywords = finalKeywords; // categories only (what older code read)
  record.themes = themes;          // categories + their labels
  await redis.set(`perspectives:submission:${id}`, JSON.stringify(record));
  // quote/author/timestamp included so the client can play the "new
  // submission dropped" envelope animation without a second round trip.
  return { id, quote: record.quote, author: record.author, timestamp: record.timestamp, keywords: finalKeywords, themes, newKeywords };
}


// Over the cap? Drop the earliest-to-appear bubbles (lowest scores).
async function trimOnScreen(){
  const onScreen = await redis.zcard(ON_SCREEN_KEY);
  if (onScreen > MAX_ON_SCREEN) await redis.zpopmin(ON_SCREEN_KEY, onScreen - MAX_ON_SCREEN);
}

// Tags one submission by id (no-op if it's missing or already processed).
async function processOne(id){
  const existingKeywordsMap = await redis.hgetall('perspectives:keywords') || {};
  const existingKeywords = Object.keys(existingKeywordsMap);
  const result = await processSubmission(id, existingKeywords, { tick: Date.now() });
  if (result) await trimOnScreen();
  return result;
}

module.exports = { processSubmission, processOne, trimOnScreen };
