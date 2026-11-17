// Tiny static file server: node serve.js  →  http://localhost:8765
// The camera and window-to-window messaging need http://localhost, not a file:// page.
// It also answers /api/ink with an in-memory store, so photo submissions can be tested
// locally (on Vercel the real api/ink.js uses Redis instead).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, memoryStore } = require('../lib/ink-api');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const store = memoryStore();

function serveApi(req, res, url) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
      const body = raw ? JSON.parse(raw) : {};
      const r = await handle(store, { method: req.method, query, body, headers: req.headers, operatorKey: process.env.INK_OPERATOR_KEY || '' });
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(r.json));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/ink')) return serveApi(req, res, req.url);
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Ink Projector running at http://localhost:${PORT}`));
