#!/usr/bin/env node
/**
 * CyberSygn local dev server.
 *
 * Serves the project root so that web/app.js can import
 * ../worker/src/detect.js without bundling. Pdfjs is loaded from the CDN
 * via the importmap in web/index.html.
 *
 * Usage:
 *   node scripts/serve-web.js [port]
 *   open http://localhost:5173/web/
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number.parseInt(process.argv[2], 10) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.pdf':  'application/pdf',
  '.ico':  'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    // Prevent path traversal.
    const safeRel = normalize(pathname).replace(/^([\/\\]+|\.\.[\/\\])+/g, '');
    let filePath = join(ROOT, safeRel);

    // Default to web/index.html for /, /web, /web/.
    if (pathname === '/' || pathname === '/web' || pathname === '/web/') {
      filePath = join(ROOT, 'web', 'index.html');
    } else {
      try {
        const s = await stat(filePath);
        if (s.isDirectory()) filePath = join(filePath, 'index.html');
      } catch {
        // fall through to readFile and let it 404
      }
    }

    if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found: ' + req.url);
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Server error: ' + (err && err.message));
    }
  }
});

server.listen(PORT, () => {
  console.log(`CyberSygn preview serving from ${ROOT}`);
  console.log(`Open http://localhost:${PORT}/web/`);
});
