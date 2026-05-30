// Generate a sample audit certificate so we can inspect the output.
import workerModule from '../worker/src/index.js';
import { readFile, writeFile } from 'node:fs/promises';

const env = {};

const pdfBytes = await readFile('test-pdfs/01-simple-signature.pdf');
const pdfBase64 = pdfBytes.toString('base64');

async function call(method, path, body, extraHeaders = {}) {
  const init = { method, headers: { 'accept': 'application/json', ...extraHeaders } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const req = new Request(`http://cybersygn.io${path}`, init);
  const res = await workerModule.fetch(req, env);
  return res;
}

const createRes = await call('POST', '/api/docs', {
  title: 'Painting Services Agreement',
  senderName: 'Nathan Wilson',
  pdfBase64,
  fields: [
    { id: 'f1', page: 1, x: 100, y: 100, width: 200, height: 20, type: 'signature', label: 'Artist signature', confidence: 0.9 },
    { id: 'f2', page: 1, x: 100, y: 80, width: 200, height: 20, type: 'signature', label: 'Client signature', confidence: 0.9 },
    { id: 'f3', page: 1, x: 100, y: 60, width: 200, height: 20, type: 'date', label: 'Date of execution', confidence: 0.9 },
    { id: 'f4', page: 1, x: 100, y: 40, width: 200, height: 14, type: 'initial', label: 'Initial', confidence: 0.85 },
  ],
  signers: [
    { id: 'p1', name: 'Alice Brushworks', email: 'alice@brushworks.example' },
    { id: 'p2', name: 'Bob Patron',       email: 'bob.patron@example.com' },
  ],
  assignments: { f1: 'p1', f2: 'p2', f3: 'p2', f4: 'p1' },
});
const created = await createRes.json();
const { docId, signerLinks } = created;
const t1 = signerLinks[0].token;
const t2 = signerLinks[1].token;

// Hydrate both to record viewed events. Different UAs / IPs would be
// recorded in production; here we craft a few headers.
await call('GET', `/api/docs/${docId}/signer/${t1}`, undefined, {
  'cf-connecting-ip': '203.0.113.42',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
});
await call('GET', `/api/docs/${docId}/signer/${t2}`, undefined, {
  'cf-connecting-ip': '198.51.100.7',
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15',
});

await call('POST', `/api/docs/${docId}/signer/${t1}/fills`, {
  fills: {
    f1: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    f4: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  },
}, { 'cf-connecting-ip': '203.0.113.42', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' });

// Bob signs over two submissions, from a phone.
await call('POST', `/api/docs/${docId}/signer/${t2}/fills`, {
  fills: { f2: { kind: 'signature', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } },
}, { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)' });

await call('POST', `/api/docs/${docId}/signer/${t2}/fills`, {
  fills: { f3: { kind: 'date', text: 'May 24, 2026' } },
}, { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)' });

// Fetch the audit and save.
const auditRes = await call('GET', `/api/docs/${docId}/audit?t=${t1}`);
const auditBytes = await auditRes.arrayBuffer();
// Output sits at the repo root so it's discoverable from README links.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(HERE, '..', 'sample-audit.pdf');
await writeFile(outPath, Buffer.from(auditBytes));
console.log(`saved ${auditBytes.byteLength} bytes to ${outPath}`);
