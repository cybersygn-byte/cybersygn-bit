#!/usr/bin/env node
/**
 * Minimal, cwd-independent static file server for local preview / screenshot QA.
 *
 * The Preview MCP launches this via .claude/launch.json. It must NOT depend on
 * process.cwd() (the sandbox can deny getcwd in some spawn contexts — which is
 * exactly why the default `python -m http.server` config crashed). The document
 * root is passed as an absolute argument and every path is resolved against it.
 *
 *   node scripts/preview-server.mjs <port> <absolute-docroot>
 *
 * Serves <docroot> at "/", defaulting "/" (and any directory) to index.html.
 * Path traversal outside the docroot is rejected.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number.parseInt(process.argv[2], 10) || 5173;
const DOCROOT = resolve(process.argv[3] || '.');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

async function resolveFile(pathname) {
  // Decode, strip query, normalize, and confine to DOCROOT.
  let rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  let abs = normalize(join(DOCROOT, rel));
  if (abs !== DOCROOT && !abs.startsWith(DOCROOT + sep)) return null; // traversal
  try {
    const s = await stat(abs);
    if (s.isDirectory()) abs = join(abs, 'index.html');
  } catch {
    return null;
  }
  return abs;
}

const server = createServer(async (req, res) => {
  try {
    const abs = await resolveFile(req.url || '/');
    if (!abs) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': TYPES[extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`[preview] serving ${DOCROOT}`);
  console.log(`[preview] http://localhost:${PORT}/`);
});
