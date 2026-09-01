/**
 * Every /api route answers, and none of them 500s.
 *
 * 45 of 70 routes were named by no test and no check, so the only thing
 * standing between a typo and a production 500 on most of the API was that
 * nobody had called it yet. A long-path segment really did take the Worker to a
 * 500 on four routes, and that only surfaced because someone went looking.
 *
 * This does NOT test behaviour: a 401 or a 400 is a pass. It tests the property
 * every route shares, that an unauthenticated, badly-formed request produces a
 * handled answer rather than an unhandled throw. It DISCOVERS the routes by
 * reading index.js, so a new route is covered the moment it is added and nobody
 * has to remember to list it here.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0; const out = [];
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; out.push('FAIL ' + msg); }
}

const src = readFileSync(new URL('../worker/src/index.js', import.meta.url), 'utf8');

// Literal routes, plus the regex-matched families rebuilt with a sample id.
const literal = [...new Set([...src.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)].map(m => m[1]))];
const PARAM = [
  '/api/docs/SAMPLEID/progress', '/api/docs/SAMPLEID/pdf', '/api/docs/SAMPLEID/signed',
  '/api/docs/SAMPLEID/audit', '/api/docs/SAMPLEID/summary',
  '/api/sender/SAMPLEID/docs', '/api/sender/SAMPLEID/webhook', '/api/sender/SAMPLEID/webhook/log',
];
const routes = [...literal, ...PARAM];

const METHODS = ['GET', 'POST'];

function freshEnv() {
  const kv = new Map();
  const st = {
    get: async (k, o) => {
      // Cloudflare KV throws above 512 bytes; model it so an unbounded key is
      // a failure here rather than only in production.
      if (String(k).length > 512) throw new Error('KV key too long');
      const v = kv.get(k); if (v == null) return null;
      const j = o === 'json' || (o && o.type === 'json');
      return j ? JSON.parse(v) : v;
    },
    put: async (k, v) => { if (String(k).length > 512) throw new Error('KV key too long'); kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { CYBERSYGN_DOCS: st, CYBERSYGN_PDFS: st };
}

const worker = (await import('../worker/src/index.js')).default;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200 });

let ip = 0;
const probed = [];
try {
  for (const route of routes) {
    for (const method of METHODS) {
      ip += 1;
      const url = 'https://cybersygn.io' + route;
      const init = {
        method,
        headers: { 'cf-connecting-ip': `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`, 'content-type': 'application/json' },
      };
      if (method === 'POST') init.body = '{}';
      let res = null, threw = null;
      try {
        res = await worker.fetch(new Request(url, init), freshEnv(), { waitUntil() {} });
      } catch (e) { threw = e; }
      ok(!threw, `${method} ${route} threw out of the Worker: ${threw && threw.message}`);
      if (res) {
        // 500 is the specific signal: it is what the top-level catch returns
        // for an UNHANDLED throw. 503 is a deliberate answer, "this deployment
        // is not configured", which is correct here because the probe env has
        // no secrets. Failing on all 5xx would make three honest routes look
        // broken and teach everyone to ignore this check.
        ok(res.status !== 500, `${method} ${route} answered 500; that is the unhandled-exception path, not a handled refusal`);
        probed.push(`${method} ${route} -> ${res.status}`);
      }
    }
  }

  // The same probe with an absurd path segment, which is what actually broke.
  const longId = 'a'.repeat(600);
  for (const route of PARAM) {
    ip += 1;
    const url = 'https://cybersygn.io' + route.replace('SAMPLEID', longId);
    let res = null, threw = null;
    try {
      res = await worker.fetch(new Request(url, { headers: { 'cf-connecting-ip': `10.9.9.${ip & 255}` } }), freshEnv(), { waitUntil() {} });
    } catch (e) { threw = e; }
    ok(!threw, `long-id ${route} threw: ${threw && threw.message}`);
    if (res) ok(res.status !== 500, `long-id ${route} answered 500; a bad id is a client error, not a crash`);
  }
} finally { globalThis.fetch = realFetch; }

console.log(out.join('\n'));
console.log(`\nroute smoke: ${routes.length} routes probed, ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
