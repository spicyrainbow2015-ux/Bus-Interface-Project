// The question shown in the green block on the kiosk and as the heading on the
// submit page. GET returns it; POST {question} changes it (the kiosk's faint
// "Edit question" control). Stored in one Redis string. If nothing is stored
// yet, `question` is null and both pages keep the wording written in their HTML.
//
// No password on purpose (a project decision): anyone who can reach the kiosk
// page can change the question, the same as "Clear bubbles".

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const QUESTION_KEY = 'perspectives:question';
const MAX_QUESTION_LENGTH = 70; // the green block is sized for about two lines

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.method === 'GET') {
      const q = await redis.get(QUESTION_KEY);
      res.status(200).json({ question: q ? String(q) : null });
      return;
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const question = String(body.question || '').replace(/\s+/g, ' ').trim();
      if (!question) { res.status(400).json({ ok: false, error: 'The question can\'t be empty.' }); return; }
      if (question.length > MAX_QUESTION_LENGTH) {
        res.status(400).json({ ok: false, error: `Keep it to ${MAX_QUESTION_LENGTH} characters or fewer.` });
        return;
      }
      await redis.set(QUESTION_KEY, question);
      res.status(200).json({ ok: true, question });
      return;
    }
    res.status(405).json({ error: 'Use GET or POST' });
  } catch (err) {
    console.error('prompt error:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong with the question.' });
  }
};
