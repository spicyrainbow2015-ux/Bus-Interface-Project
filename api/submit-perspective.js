// Accepts a submitted perspective (quote + optional author), asks Claude
// Haiku to (a) extract 1-3 short meaningful themes and match each against
// the categories that already exist, and (b) flag anything unsuitable for
// a public kiosk display — then writes the result into Upstash Redis.
//
// Redis keys used (all under the "perspectives:" namespace so they don't
// collide with anything else that might land in this KV store later):
//   perspectives:keywords     HASH   keyword -> mention count
//   perspectives:submissions  LIST   JSON blobs, newest first, capped at 50
//   perspectives:peopleCount  STRING running total of submissions
//
// The Anthropic call uses forced tool-use so the response is always
// structured JSON, not free text to parse — see CATEGORIZE_TOOL below.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'; // cheapest/fastest Claude tier — plenty for this task
const MAX_QUOTE_LENGTH = 500;

const CATEGORIZE_TOOL = {
  name: 'categorize_perspective',
  description: 'Extract meaningful themes from a submitted perspective about a place, and flag whether the text is appropriate for public display on a community kiosk screen.',
  input_schema: {
    type: 'object',
    properties: {
      appropriate: {
        type: 'boolean',
        description: 'false if the text contains hate speech, harassment, spam, personal attacks, or anything else unsuitable for a public screen anyone can walk up and read',
      },
      categories: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Short (1-3 word) theme label, Title Case, e.g. "Nostalgic" or "In The Rain"' },
            matchedExisting: {
              type: 'string',
              description: 'If this theme closely matches one of the EXISTING categories listed in the prompt (even if worded differently), the exact existing category text to reuse. Omit this field entirely if it is a genuinely new theme.',
            },
          },
          required: ['keyword'],
        },
      },
    },
    required: ['appropriate', 'categories'],
  },
};

async function categorizeWithClaude(quote, existingKeywords) {
  const existingList = existingKeywords.length ? existingKeywords.join(', ') : '(none yet)';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      tools: [CATEGORIZE_TOOL],
      tool_choice: { type: 'tool', name: 'categorize_perspective' },
      messages: [{
        role: 'user',
        content:
          `Existing categories: ${existingList}\n\n` +
          `New submission: "${quote}"\n\n` +
          `Extract 1-3 short meaningful themes from this submission (emotions, notable details, activities — not generic words). ` +
          `For each theme, if it closely matches an existing category in MEANING (even if worded differently, e.g. "watching the sunset" matching an existing "Sunset" category), reuse that exact existing category text via matchedExisting. ` +
          `Otherwise it's a new category — just give the keyword, no matchedExisting field. ` +
          `Also flag whether this submission is appropriate for public display.`,
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const toolUse = (data.content || []).find(block => block.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not return a tool_use block');
  return toolUse.input; // { appropriate, categories: [{ keyword, matchedExisting? }] }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const quote = String(body.quote || '').trim();
    const author = String(body.author || 'Anonymous').trim().slice(0, 60);

    if (!quote) { res.status(400).json({ error: 'quote is required' }); return; }
    if (quote.length > MAX_QUOTE_LENGTH) {
      res.status(400).json({ error: `quote must be ${MAX_QUOTE_LENGTH} characters or fewer` });
      return;
    }

    const existingKeywordsMap = await redis.hgetall('perspectives:keywords') || {};
    const existingKeywords = Object.keys(existingKeywordsMap);

    const result = await categorizeWithClaude(quote, existingKeywords);

    if (!result.appropriate) {
      // Don't write anything — quietly reject rather than surfacing exactly
      // why, so this isn't a roadmap for how to word around the filter.
      res.status(200).json({ ok: false, reason: 'not_appropriate' });
      return;
    }

    const categories = Array.isArray(result.categories) ? result.categories.slice(0, 3) : [];
    const finalKeywords = [];
    const newKeywords = [];

    for (const c of categories) {
      const kw = (c.matchedExisting && existingKeywords.includes(c.matchedExisting))
        ? c.matchedExisting
        : c.keyword;
      if (!kw) continue;
      finalKeywords.push(kw);
      if (!existingKeywords.includes(kw) && !newKeywords.includes(kw)) newKeywords.push(kw);
      await redis.hincrby('perspectives:keywords', kw, 1);
    }

    await redis.lpush('perspectives:submissions', JSON.stringify({
      quote,
      author,
      keywords: finalKeywords,
      timestamp: new Date().toISOString(),
    }));
    await redis.ltrim('perspectives:submissions', 0, 49); // keep the list from growing forever
    const peopleCount = await redis.incr('perspectives:peopleCount');

    res.status(200).json({ ok: true, keywords: finalKeywords, newKeywords, peopleCount });
  } catch (err) {
    console.error('submit-perspective error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong processing that submission.' });
  }
};
