#!/usr/bin/env node
/**
 * fuzz-api.mjs - hostile-input fuzzer for the CyberSygn HTTP API.
 *
 * Two execution modes, chosen so nothing destructive ever reaches production:
 *
 *   --local  (default)  Imports worker/src/index.js directly and drives it with
 *                       constructed Request objects against an in-memory KV mock
 *                       and a stubbed global fetch (no outbound network, no
 *                       email, no Stripe). Every route, including every mutating
 *                       one, is fuzzed here.
 *
 *   --live              Sends requests to a real origin (default
 *                       https://cybersygn.io). ONLY routes flagged liveSafe are
 *                       sent: read-only GETs, validation-rejection paths, and
 *                       method-confusion probes (GET on a POST-only route never
 *                       reaches a handler). No mutating request is ever sent
 *                       live, and the oversized-body payloads are local-only.
 *
 * PASS CRITERIA per response:
 *   - status is a deliberate code (not 5xx)
 *   - body carries no stack trace, source path, env var name, KV key, or raw
 *     unhandled-error string
 *   - HTML responses do not reflect the injected payload unescaped
 *
 * Usage:
 *   node scripts/fuzz-api.mjs                       # local, all routes
 *   node scripts/fuzz-api.mjs --live                # live, read-only subset
 *   node scripts/fuzz-api.mjs --live --base=https://x.workers.dev
 *   node scripts/fuzz-api.mjs --route=/api/docs     # filter by substring
 *   node scripts/fuzz-api.mjs --json=out.json       # machine-readable results
 *   node scripts/fuzz-api.mjs --big                 # include >cap body payloads
 *   node scripts/fuzz-api.mjs --configured          # bind dummy secrets so the
 *                                                   # Stripe/vision/owner-login
 *                                                   # handlers actually run
 *   node scripts/fuzz-api.mjs --kvlimit             # enforce Cloudflare's real
 *                                                   # 512-byte KV key cap in the
 *                                                   # mock (reproduces the
 *                                                   # key-overflow crashes)
 *   node scripts/fuzz-api.mjs --shared-ip           # do not vary cf-connecting-ip
 *                                                   # (exercises the rate limiter)
 *
 * Recommended full local sweep:
 *   node scripts/fuzz-api.mjs --configured --kvlimit --json=fuzz-local.json
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- args ----
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const MODE = arg('live', false) ? 'live' : 'local';
const BASE = String(arg('base', 'https://cybersygn.io')).replace(/\/$/, '');
const FILTER = arg('route', null);
const PAYLOAD_FILTER = arg('payload', null);
const JSON_OUT = arg('json', null);
const INCLUDE_BIG = !!arg('big', false);
// --configured binds DUMMY values for every gated secret so the handlers behind
// the "not configured" 503s (Stripe checkout, webhook signature verification,
// owner login, vision) actually execute. Outbound fetch stays stubbed, so no
// request leaves the machine and no charge, email, or webhook is ever made.
const CONFIGURED = !!arg('configured', false);
// Give every local case its own client IP so per-IP rate limiting does not mask
// handler behaviour behind a 429. Live mode never does this.
const ISOLATE_IPS = MODE === 'local' && !arg('shared-ip', false);
// --kvlimit makes the local KV mock enforce Cloudflare's real limits (512-byte
// keys, 25 MB values) so key-overflow crashes reproduce locally instead of only
// against production.
const KV_LIMIT = !!arg('kvlimit', false);
const VERBOSE = !!arg('verbose', false);
const CONCURRENCY = Number(arg('concurrency', MODE === 'live' ? 3 : 8)) || 3;

// Caps documented in worker/src/index.js.
const MAX_JSON_BYTES = 256 * 1024;
const MAX_DOC_JSON_BYTES = 36 * 1024 * 1024;

// ---------------------------------------------------------- route table ----
// kind: 'read'  = no state change on any input
//       'reject'= mutating handler, but the fuzz payloads are all invalid so it
//                 should reject before writing (still LOCAL-ONLY to be safe)
//       'mutate'= writes state on a happy path. LOCAL ONLY, always.
// liveSafe: may be sent to production.
// bodyCap: byte cap the route documents, used by the oversize payload.
const R = (o) => ({ kind: 'mutate', liveSafe: false, bodyCap: MAX_JSON_BYTES, ...o });

const HEX32 = 'a'.repeat(32);
const HEX64 = 'b'.repeat(64);
const FAKE_SENDER = 'fuzz-sender-0000000000000000000000000000';

const ROUTES = [
  // ---- public reads (live safe) ----
  R({ method: 'GET', path: '/api/health', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/status', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/status/uptime', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/roadmap', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/testimonials', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/templates/list', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/billing/config', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/billing/founding-count', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/billing/lifetime-count', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/dataset/count', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/origin/wall', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/templates', kind: 'read', liveSafe: true, query: { hash: 'FUZZ' } }),
  R({ method: 'GET', path: '/api/billing/portal', kind: 'read', liveSafe: true, query: { senderId: 'FUZZ' } }),
  R({ method: 'GET', path: '/api/billing/subscription', kind: 'read', liveSafe: true, query: { senderId: 'FUZZ' } }),
  R({ method: 'GET', path: '/api/analytics/summary', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/metrics', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/ambassador/me', kind: 'read', liveSafe: true, query: { code: 'FUZZ' } }),
  R({ method: 'GET', path: `/api/affiliate/abcd`, kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: `/api/verify/FUZZ`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/docs/${HEX32}`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/docs/${HEX32}/pdf`, kind: 'read', liveSafe: true, query: { t: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'GET', path: `/api/docs/${HEX32}/audit`, kind: 'read', liveSafe: true, query: { t: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'GET', path: `/api/docs/${HEX32}/live`, kind: 'read', liveSafe: true, query: { t: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'GET', path: `/api/docs/${HEX32}/signer/FUZZ`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/docs`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/templates`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/brand`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/webhook`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/webhook/log`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/contacts`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/sender/${FAKE_SENDER}/gdpr-export`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/workspaces/${HEX32}/docs`, kind: 'read', liveSafe: true, query: { w: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'GET', path: `/api/workspaces/${HEX32}/members`, kind: 'read', liveSafe: true, query: { w: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'GET', path: `/api/invites/${HEX32}`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: '/api/templates/download/nda-mutual', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/verify', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/security-check', kind: 'read', liveSafe: true }),

  // ---- owner reads, unauthenticated (should 401). live safe: no writes ----
  R({ method: 'GET', path: '/api/owner/funnel', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/ambassadors', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/apikeys', kind: 'read', liveSafe: true, query: { senderId: 'FUZZ' } }),
  R({ method: 'GET', path: '/api/owner/drip-list', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/dataset/export', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/dataset/stats', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/report/preview', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/owner/metrics/dashboard', kind: 'read', liveSafe: true }),

  // ---- mutating POSTs. LOCAL ONLY ----
  R({ method: 'POST', path: '/detect', bodyCap: 36 * 1024 * 1024,
      seed: { pdfBase64: 'JVBERi0xLjQK' } }),
  R({ method: 'POST', path: '/api/detect-vision', bodyCap: 8 * 1024 * 1024,
      seed: { pageImageBase64: 'iVBORw0KGgo=', senderId: FAKE_SENDER } }),
  R({ method: 'POST', path: '/api/templates', seed: { hash: 'FUZZ', name: 'FUZZ', fields: [] } }),
  R({ method: 'POST', path: '/api/free/signup', seed: { email: 'owner@example.com', consent: true } }),
  R({ method: 'POST', path: '/api/free/consume', seed: { token: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/free/email-signed-pdf', bodyCap: MAX_DOC_JSON_BYTES,
      seed: { email: 'owner@example.com', pdfBase64: 'JVBERi0=', filename: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/auth/request-link', seed: { email: 'owner@example.com' } }),
  R({ method: 'POST', path: '/api/auth/verify', seed: { token: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/signup', seed: { email: 'owner@example.com', name: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/owner/claim', seed: { phrase: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/owner/login', seed: { username: 'FUZZ', password: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/owner/reset/request', seed: { email: 'owner@example.com' } }),
  R({ method: 'POST', path: '/api/owner/reset/confirm', seed: { token: 'FUZZ', password: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/owner/test-email', seed: { to: 'owner@example.com' } }),
  R({ method: 'POST', path: '/api/owner/drip/run', seed: { limit: 1 } }),
  R({ method: 'POST', path: '/api/owner/ambassadors/payout', seed: { code: 'FUZZ', amountCents: 1 } }),
  R({ method: 'POST', path: '/api/owner/ambassadors/taxdoc', seed: { code: 'FUZZ', year: 2026 } }),
  R({ method: 'POST', path: '/api/owner/ambassadors/revoke', seed: { code: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/owner/ambassadors/test-email', seed: { code: 'FUZZ', kind: 'welcome' } }),
  R({ method: 'POST', path: '/api/owner/apikeys', seed: { senderId: FAKE_SENDER, label: 'FUZZ' } }),
  R({ method: 'DELETE', path: '/api/owner/apikeys', seed: { senderId: FAKE_SENDER, keyId: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/event', seed: { name: 'FUZZ', props: { a: 'FUZZ' } } }),
  R({ method: 'POST', path: '/api/e', seed: { step: 'FUZZ', id: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/error', seed: { message: 'FUZZ', stack: 'FUZZ', url: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/contact', seed: { email: 'owner@example.com', message: 'FUZZ', name: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/roadmap/vote', seed: { itemId: 'FUZZ', voter: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/affiliate/register', seed: { email: 'owner@example.com', name: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/affiliate/click', seed: { code: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/ambassador/learn', seed: { code: 'FUZZ', lesson: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/ambassador/accept-terms', seed: { code: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/checkout/create-session', seed: { tier: 'solo', senderId: FAKE_SENDER, email: 'owner@example.com' } }),
  R({ method: 'POST', path: '/api/stripe/webhook', seed: { id: 'evt_FUZZ', type: 'checkout.session.completed', data: { object: {} } } }),
  R({ method: 'POST', path: '/api/testimonial', seed: { name: 'FUZZ', quote: 'FUZZ', email: 'owner@example.com' } }),
  R({ method: 'POST', path: '/api/draft/generate', seed: { prompt: 'FUZZ', kind: 'nda' } }),
  R({ method: 'POST', path: '/api/templates/send', seed: { slug: 'nda-mutual', email: 'owner@example.com', signers: [] } }),
  R({ method: 'POST', path: '/api/origin/profile', seed: { senderId: FAKE_SENDER, name: 'FUZZ', bio: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/snapshot/email', bodyCap: MAX_DOC_JSON_BYTES,
      seed: { to: ['owner@example.com'], pdfBase64: 'JVBERi0=', filename: 'FUZZ' } }),
  R({ method: 'POST', path: '/api/docs', bodyCap: MAX_DOC_JSON_BYTES,
      seed: { pdfBase64: 'JVBERi0xLjQK', signers: [{ name: 'FUZZ', email: 'owner@example.com' }], fields: [], assignments: {}, senderId: FAKE_SENDER } }),
  R({ method: 'POST', path: '/api/docs/bulk', bodyCap: MAX_DOC_JSON_BYTES,
      seed: { pdfBase64: 'JVBERi0xLjQK', recipients: [{ name: 'FUZZ', email: 'owner@example.com' }], fields: [], senderId: FAKE_SENDER } }),
  R({ method: 'POST', path: `/api/docs/${HEX32}/signer/FUZZ/fills`, seed: { fills: { f1: 'FUZZ' } }, pathFuzz: true }),
  R({ method: 'POST', path: `/api/docs/${HEX32}/signer/FUZZ/decline`, seed: { reason: 'FUZZ' }, pathFuzz: true }),
  R({ method: 'POST', path: `/api/docs/${HEX32}/summary`, seed: {}, query: { t: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'POST', path: `/api/docs/${HEX32}/remind/FUZZ`, seed: {}, query: { t: 'FUZZ' }, pathFuzz: true }),
  R({ method: 'POST', path: `/api/docs/${HEX32}/live`, seed: { signerId: 'FUZZ' }, query: { t: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'POST', path: '/api/workspaces', seed: { name: 'FUZZ', senderId: FAKE_SENDER } }),
  R({ method: 'POST', path: `/api/workspaces/${HEX32}/invites`, seed: { email: 'owner@example.com', name: 'FUZZ' }, query: { w: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'POST', path: `/api/invites/${HEX32}`, seed: { senderId: FAKE_SENDER, name: 'FUZZ' }, pathFuzz: true }),
  R({ method: 'POST', path: `/api/sender/${FAKE_SENDER}/brand`, seed: { color: 'FUZZ', logoUrl: 'FUZZ' } , pathFuzz: true }),
  R({ method: 'POST', path: `/api/sender/${FAKE_SENDER}/webhook`, seed: { url: 'https://example.com/hook' } , pathFuzz: true }),
  R({ method: 'DELETE', path: `/api/sender/${FAKE_SENDER}/webhook`, seed: {} , pathFuzz: true }),
  R({ method: 'POST', path: `/api/sender/${FAKE_SENDER}/contacts`, seed: { name: 'FUZZ', email: 'owner@example.com' } , pathFuzz: true }),
  R({ method: 'DELETE', path: `/api/sender/${FAKE_SENDER}/contacts`, seed: { email: 'owner@example.com' } , pathFuzz: true }),
  R({ method: 'POST', path: `/api/sender/${FAKE_SENDER}/gdpr-export/request`, seed: { email: 'owner@example.com' } , pathFuzz: true }),
  R({ method: 'POST', path: `/api/sender/${FAKE_SENDER}/gdpr-export/confirm`, seed: { code: 'FUZZ' } , pathFuzz: true }),

  // ---- public API v1 (API-key auth) ----
  R({ method: 'GET', path: '/api/v1/docs', kind: 'read', liveSafe: true }),
  R({ method: 'POST', path: '/api/v1/docs', bodyCap: MAX_DOC_JSON_BYTES,
      seed: { pdfBase64: 'JVBERi0xLjQK', signers: [{ name: 'FUZZ', email: 'owner@example.com' }] } }),
  R({ method: 'GET', path: `/api/v1/docs/${HEX32}`, kind: 'read', liveSafe: true, pathFuzz: true }),
  R({ method: 'GET', path: `/api/v1/docs/${HEX32}/pdf`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: `/api/v1/docs/${HEX32}/audit`, kind: 'read', liveSafe: true , pathFuzz: true }),
  R({ method: 'GET', path: '/api/v1/nonexistent-route', kind: 'read', liveSafe: true }),
  R({ method: 'GET', path: '/api/definitely-not-a-route', kind: 'read', liveSafe: true }),
];

// ------------------------------------------------------------ payloads ----
const XSS = '<script>alert(1)</script>';
const XSS2 = '"><img src=x onerror=alert(1)>';
const SQLI = "' OR 1=1 -- ";
const NOSQLI = '{"$ne":null}';
const TRAVERSAL = '../../../../etc/passwd';
const TEMPLATE = '{{7*7}}${7*7}<%= 7*7 %>#{7*7}';
const UNICODE = 'A B‮reversed‬💩﻿́  ';
const ASTRAL = '𝐀🤖🇺🇸';
const LONG = 'X'.repeat(100000);
const CRLF = 'a\r\nX-Injected: yes\r\n';

const HOSTILE_STRINGS = [
  ['xss', XSS], ['xss-attr', XSS2], ['sqli', SQLI], ['nosqli', NOSQLI],
  ['traversal', TRAVERSAL], ['template', TEMPLATE], ['unicode', UNICODE],
  ['astral', ASTRAL], ['crlf', CRLF], ['long100k', LONG],
];

function deepNest(levels) {
  let s = '';
  for (let i = 0; i < levels; i++) s += '{"a":';
  s += '1';
  for (let i = 0; i < levels; i++) s += '}';
  return s;
}

// Replace every 'FUZZ' marker (and every string leaf) in a seed with `str`.
function mutateSeed(seed, str) {
  if (typeof seed === 'string') return seed === 'FUZZ' ? str : seed;
  if (Array.isArray(seed)) return seed.map(v => mutateSeed(v, str));
  if (seed && typeof seed === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(seed)) out[k] = mutateSeed(v, str);
    return out;
  }
  return seed;
}

const J = 'application/json';

/**
 * Payload matrix. Each entry produces { name, body, headers, method?, query? }.
 * `route` is passed so a payload can respect that route's documented byte cap
 * and seed body shape.
 */
function payloadsFor(route) {
  const p = [];
  const seed = route.seed || {};
  const add = (name, o) => p.push({ name, ...o });

  // --- structural ---
  add('no-body', { body: undefined, headers: {} });
  add('empty-body', { body: '', headers: { 'content-type': J } });
  add('non-json', { body: 'this is not json at all <<<>>>', headers: { 'content-type': J } });
  add('json-null', { body: 'null', headers: { 'content-type': J } });
  add('json-array', { body: '[1,2,3]', headers: { 'content-type': J } });
  add('json-string', { body: '"just a string"', headers: { 'content-type': J } });
  add('json-number', { body: '1e309', headers: { 'content-type': J } });
  add('json-true', { body: 'true', headers: { 'content-type': J } });
  add('truncated-json', { body: '{"a": [1,2,', headers: { 'content-type': J } });
  add('deep-nest-100', { body: deepNest(100), headers: { 'content-type': J } });
  add('deep-nest-5000', { body: deepNest(5000), headers: { 'content-type': J } });
  add('dup-keys', { body: '{"email":"a@b.co","email":"' + XSS + '"}', headers: { 'content-type': J } });
  add('proto-pollution', {
    body: JSON.stringify({
      ...seed,
      __proto__: { polluted: 'yes', toString: 'boom' },
      constructor: { prototype: { polluted: 'yes' } },
      prototype: { polluted: 'yes' },
    }),
    headers: { 'content-type': J },
  });
  add('proto-raw', {
    body: '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
    headers: { 'content-type': J },
  });

  // --- content-type abuse ---
  add('ct-missing', { body: JSON.stringify(seed), headers: {} });
  add('ct-text-plain', { body: JSON.stringify(seed), headers: { 'content-type': 'text/plain' } });
  add('ct-multipart', { body: JSON.stringify(seed), headers: { 'content-type': 'multipart/form-data; boundary=x' } });
  add('ct-form', { body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  add('ct-nonsense', { body: JSON.stringify(seed), headers: { 'content-type': ' / ' } });

  // --- header abuse ---
  add('hdr-absurd-ip', {
    body: JSON.stringify(seed),
    headers: { 'content-type': J, 'cf-connecting-ip': `${'9'.repeat(400)}::${XSS}` },
  });
  add('hdr-spoof-owner', {
    body: JSON.stringify(seed),
    headers: { 'content-type': J, 'x-cybersygn-owner': 'not-a-real-owner-token', 'authorization': 'Bearer fake' },
  });
  add('hdr-spoof-owner-empty', {
    body: JSON.stringify(seed),
    headers: { 'content-type': J, 'x-cybersygn-owner': '' },
  });
  add('hdr-lying-content-length', {
    body: JSON.stringify(seed),
    headers: { 'content-type': J, 'content-length': '3' },
  });
  add('hdr-free-token-spoof', {
    body: JSON.stringify(seed),
    headers: { 'content-type': J, 'x-cybersygn-free': TRAVERSAL, 'x-api-key': 'cs_live_' + 'f'.repeat(40) },
  });

  // --- type confusion on the seed's own fields ---
  if (Object.keys(seed).length) {
    for (const [typeName, val] of [
      ['fields-null', null], ['fields-array', []], ['fields-number', 12345],
      ['fields-bool', true], ['fields-object', { nested: { deep: true } }],
    ]) {
      const mutated = {};
      for (const k of Object.keys(seed)) mutated[k] = val;
      add('type-' + typeName, { body: JSON.stringify(mutated), headers: { 'content-type': J } });
    }
    add('type-negative-numbers', {
      body: JSON.stringify(Object.fromEntries(Object.keys(seed).map(k => [k, -999999999999]))),
      headers: { 'content-type': J },
    });
    add('type-huge-number', {
      body: JSON.stringify(Object.fromEntries(Object.keys(seed).map(k => [k, 1e308 * 10 === Infinity ? 1e308 : 1e308]))),
      headers: { 'content-type': J },
    });
  }

  // --- hostile string injection into every string field ---
  for (const [name, str] of HOSTILE_STRINGS) {
    add('inject-' + name, {
      body: JSON.stringify(mutateSeedAllStrings(seed, str)),
      headers: { 'content-type': J },
      injected: str,
    });
  }

  // --- oversize ---
  const cap = route.bodyCap || MAX_JSON_BYTES;
  if (cap <= MAX_JSON_BYTES || INCLUDE_BIG) {
    add('oversize-cap-plus-1', { body: () => bigJson(cap + 1), headers: { 'content-type': J }, localOnly: true });
    add('at-cap', { body: () => bigJson(cap - 64), headers: { 'content-type': J }, localOnly: true });
  }

  // --- method confusion ---
  const other = route.method === 'GET' ? 'POST' : 'GET';
  add('method-confusion', { method: other, body: other === 'POST' ? JSON.stringify(seed) : undefined, headers: other === 'POST' ? { 'content-type': J } : {} });
  add('method-trace', { method: 'PUT', body: JSON.stringify(seed), headers: { 'content-type': J } });
  add('method-options', { method: 'OPTIONS', body: undefined, headers: {} });

  // --- query-string fuzzing (applies to every route) ---
  for (const [name, str] of [['xss', XSS], ['traversal', TRAVERSAL], ['unicode', UNICODE], ['long', 'Y'.repeat(4000)]]) {
    add('query-' + name, {
      body: route.method === 'GET' ? undefined : JSON.stringify(seed),
      headers: route.method === 'GET' ? {} : { 'content-type': J },
      queryOverride: str,
      injected: str,
    });
  }
  add('query-numeric-abuse', {
    body: route.method === 'GET' ? undefined : JSON.stringify(seed),
    headers: route.method === 'GET' ? {} : { 'content-type': J },
    rawQuery: 'limit=-1&limit=1e999&offset=NaN&days=99999999&cursor=' + encodeURIComponent(TRAVERSAL),
  });

  // --- path fuzzing for parameterized routes ---
  if (route.pathFuzz) {
    for (const [name, str] of [['xss', XSS], ['traversal', '..%2F..%2F..%2Fetc%2Fpasswd'], ['long', 'Z'.repeat(3000)], ['kvkey-509', 'Z'.repeat(509)], ['kvkey-508', 'Z'.repeat(508)], ['unicode', '%F0%9F%92%A9%00']]) {
      add('path-' + name, {
        body: route.method === 'GET' ? undefined : JSON.stringify(seed),
        headers: route.method === 'GET' ? {} : { 'content-type': J },
        pathOverride: str,
        injected: str,
      });
    }
  }

  return PAYLOAD_FILTER ? p.filter(x => x.name.includes(PAYLOAD_FILTER)) : p;
}

function mutateSeedAllStrings(seed, str) {
  if (typeof seed === 'string') return str;
  if (Array.isArray(seed)) return seed.map(v => mutateSeedAllStrings(v, str));
  if (seed && typeof seed === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(seed)) out[k] = mutateSeedAllStrings(v, str);
    return out;
  }
  return seed;
}

function bigJson(bytes) {
  const head = '{"pdfBase64":"';
  const tail = '","x":1}';
  const fill = Math.max(1, bytes - head.length - tail.length);
  return head + 'A'.repeat(fill) + tail;
}

// ------------------------------------------------------- sanity checks ----
const LEAK_PATTERNS = [
  [/\bat\s+[\w$.<>]+\s+\(?[\w/.\-]+\.(?:js|mjs|ts):\d+:\d+/, 'stack frame'],
  [/\/Users\/[a-z0-9_.-]+\//i, 'local filesystem path'],
  [/worker\/src\/[a-z-]+\.js/i, 'worker source path'],
  [/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError):/, 'raw JS error class'],
  [/Cannot read propert(?:y|ies) of (?:undefined|null)/i, 'unhandled property read'],
  [/is not a function|is not iterable|is not defined/, 'unhandled JS error text'],
  [/Error 1101|Worker threw exception/i, 'cloudflare worker exception page'],
  [/\b(?:CYBERSYGN_OWNER_HASH|OWNER_PASSWORD_HASH|OWNER_PASSWORD_SALT|CF_ANALYTICS_TOKEN|SENTRY_DSN)\b/, 'secret-bearing env var name'],
  [/\bsk_live_[A-Za-z0-9]/, 'stripe live key'],
  [/\bre_[A-Za-z0-9]{16,}/, 'resend key'],
  [/"?(?:doc|pdf|sub|free|owner|ratelimit|amb|aff):[A-Za-z0-9_-]{6,}/, 'raw KV key'],
];

// Strings that legitimately appear in prose and must not trip the leak scan.
const LEAK_ALLOW = [
  /rate limit/i,
];

// Informational, not a failure: the health/status probes name the *unset* config
// var (RESEND_API_KEY not set). Recorded separately so it is visible without
// drowning the real signal.
const HINT_PATTERNS = [
  [/\b(?:RESEND_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|ANTHROPIC_API_KEY) not set\b/, 'unset env var named in a public response'],
];

function checkResponse(route, payload, res, bodyText, headers) {
  const problems = [];
  const hints = [];
  const status = res.status;

  // A 503 that names a missing deployment secret is a deliberate "this feature
  // is not configured here" answer, not a crash. It only shows up in the local
  // harness (which binds no Stripe/Anthropic/owner secrets on purpose).
  const deliberate503 = status === 503 && /"error":"(?:not_configured|webhook_not_configured|vision_not_configured|login_not_configured|[a-z_]*not_configured)"/.test(bodyText);
  if (status >= 500 && !deliberate503) {
    problems.push({ kind: 'server-error', detail: `status ${status} :: ${bodyText.slice(0, 200)}` });
  }
  if (status === 0 || !Number.isFinite(status)) {
    problems.push({ kind: 'no-status', detail: String(status) });
  }

  const sample = deliberate503 ? '' : bodyText.slice(0, 20000);
  for (const [re, label] of LEAK_PATTERNS) {
    const m = sample.match(re);
    if (m && !LEAK_ALLOW.some(a => a.test(m[0]))) {
      problems.push({ kind: 'leak', detail: `${label}: ${JSON.stringify(m[0].slice(0, 160))}` });
    }
  }

  // Reflected-input check: only meaningful for HTML/text responses, or JSON
  // responses served with an HTML-ish content type.
  const ct = (headers.get('content-type') || '').toLowerCase();
  if (payload.injected && /html|xml|text\/plain/.test(ct)) {
    const raw = payload.injected;
    if (raw.includes('<') && bodyText.includes(raw)) {
      problems.push({ kind: 'reflected-unescaped', detail: `payload reflected verbatim into ${ct}` });
    }
  }
  // JSON that will be rendered by a client: flag only if the API echoes the
  // script tag AND declares a non-JSON content type (JSON echo is fine).
  if (payload.injected && /<script>/.test(payload.injected) && /html/.test(ct) && bodyText.includes('<script>alert(1)</script>')) {
    problems.push({ kind: 'xss', detail: 'script tag echoed into HTML response' });
  }

  // Prototype pollution: check the harness's own Object prototype after the call.
  if (({}).polluted !== undefined) {
    problems.push({ kind: 'proto-pollution', detail: 'Object.prototype.polluted set after request' });
    delete Object.prototype.polluted;
  }

  for (const [re, label] of HINT_PATTERNS) {
    const m = sample.match(re);
    if (m) hints.push({ kind: 'hint', detail: `${label}: ${m[0]}` });
  }

  return { problems, hints };
}

// ------------------------------------------------------------ runners ----
function buildUrl(origin, route, payload) {
  let path = route.path;
  if (payload.pathOverride) {
    // Replace the route's own id-shaped segment (a long hex id, the FUZZ marker,
    // or the fake sender id) with the hostile value. Falls back to the last
    // segment when the route has no obvious id.
    const parts = path.split('/');
    let i = parts.findIndex(seg => seg === 'FUZZ' || seg === FAKE_SENDER || /^[a-f0-9]{16,}$/.test(seg));
    if (i === -1) i = parts.length - 1;
    parts[i] = payload.pathOverride;
    path = parts.join('/');
  }
  const u = new URL(origin + path);
  if (route.query) {
    for (const [k, v] of Object.entries(route.query)) {
      u.searchParams.set(k, v === 'FUZZ' ? (payload.queryOverride || 'fuzz-value') : v);
    }
  } else if (payload.queryOverride) {
    u.searchParams.set('q', payload.queryOverride);
    u.searchParams.set('senderId', payload.queryOverride);
    u.searchParams.set('t', payload.queryOverride);
  }
  if (payload.rawQuery) u.search = (u.search ? u.search + '&' : '?') + payload.rawQuery;
  return u.toString();
}

let ipCounter = 0;

async function runOne(env, origin, route, payload, mode) {
  const method = payload.method || route.method;
  const url = buildUrl(origin, route, payload);
  let body = typeof payload.body === 'function' ? payload.body() : payload.body;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') body = undefined;

  const headers = new Headers();
  for (const [k, v] of Object.entries(payload.headers || {})) {
    try { headers.set(k, v); } catch { /* header value rejected by the runtime */ }
  }
  if (ISOLATE_IPS && !headers.has('cf-connecting-ip')) {
    ipCounter++;
    headers.set('cf-connecting-ip', `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`);
  }
  // Doc creation is gated on a signup-issued free token. Attach a fresh one so
  // the fuzzer reaches the real handler instead of stopping at the 402 gate.
  if (env && env.freeToken && method === 'POST' && /^\/api\/(docs|docs\/bulk)$/.test(new URL(url).pathname) && !headers.has('x-cybersygn-free')) {
    const t = await env.freeToken();
    if (t) headers.set('x-cybersygn-free', t);
  }

  const started = Date.now();
  let res, bodyText = '';
  try {
    if (mode === 'live') {
      res = await fetch(url, { method, headers, body, redirect: 'manual' });
      bodyText = await res.text();
    } else {
      const req = new Request(url, { method, headers, body });
      res = await env.worker.fetch(req, env.env, env.ctx);
      if (!res || typeof res.status !== 'number') {
        return { status: -1, ms: Date.now() - started, problems: [{ kind: 'no-response', detail: 'handler returned no Response' }] };
      }
      bodyText = await res.text();
    }
  } catch (e) {
    return {
      status: -1, ms: Date.now() - started,
      problems: [{ kind: 'threw', detail: `${e && e.name}: ${String(e && e.message).slice(0, 300)}` }],
      thrown: (e && e.stack) || String(e),
    };
  }

  const { problems, hints } = checkResponse(route, payload, res, bodyText, res.headers);
  return { status: res.status, ms: Date.now() - started, problems, hints, bodySample: bodyText.slice(0, 400), url, method };
}

// ---------------------------------------------------- local environment ----
function makeKV(name) {
  const store = new Map();
  // Cloudflare KV: keys are capped at 512 bytes, values at 25 MB. The real
  // binding THROWS on violation; --kvlimit reproduces that.
  const guard = (key, value) => {
    if (!KV_LIMIT) return;
    const kb = new TextEncoder().encode(String(key)).length;
    if (kb > 512) throw new TypeError(`KV ${name} failed: 400 Key length of ${kb} exceeds limit of 512.`);
    if (value !== undefined && typeof value === 'string' && value.length > 25 * 1024 * 1024) {
      throw new TypeError(`KV ${name} failed: 413 Value length exceeds limit of 26214400.`);
    }
  };
  return {
    _name: name, _store: store,
    async get(key, opts) {
      guard(key);
      const v = store.get(String(key));
      if (v === undefined) return null;
      const type = typeof opts === 'string' ? opts : (opts && opts.type) || 'text';
      if (type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      if (type === 'arrayBuffer') return new TextEncoder().encode(v).buffer;
      return v;
    },
    async put(key, value) { guard(key, typeof value === 'string' ? value : String(value)); store.set(String(key), typeof value === 'string' ? value : String(value)); },
    async delete(key) { guard(key); store.delete(String(key)); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit);
      return { keys: keys.map(name => ({ name })), list_complete: true, cursor: null };
    },
  };
}

async function makeLocalEnv() {
  const mod = await import(resolve(ROOT, 'worker/src/index.js'));
  const worker = mod.default;

  const outbound = [];
  const realFetch = globalThis.fetch;
  // Hard network cutoff for local runs: nothing leaves this machine. Any
  // outbound attempt is recorded and answered with a synthetic error.
  globalThis.fetch = async (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    outbound.push({ url: u, method: (init && init.method) || (input && input.method) || 'GET' });
    return new Response(JSON.stringify({ error: 'network_disabled_by_fuzzer' }), {
      status: 599, headers: { 'content-type': 'application/json' },
    });
  };

  const env = {
    CYBERSYGN_DOCS: makeKV('CYBERSYGN_DOCS'),
    CYBERSYGN_PDFS: makeKV('CYBERSYGN_PDFS'),
    CYBERSYGN_BACKUPS: makeKV('CYBERSYGN_BACKUPS'),
    CYBERSYGN_EVENTS: { writeDataPoint() {} },
    SIGNUPS: makeKV('SIGNUPS'),
    CYBERSYGN_ENV: 'fuzz',
    CYBERSYGN_APP_URL: 'https://fuzz.invalid',
    // Deliberately NO RESEND_API_KEY / STRIPE_SECRET_KEY / ANTHROPIC_API_KEY by
    // default: those paths must fall back to console/no-op. Global fetch is
    // stubbed either way, so nothing leaves the machine.
  };
  if (CONFIGURED) {
    Object.assign(env, {
      // All dummy. Outbound fetch is stubbed; these only unlock the code paths.
      RESEND_API_KEY: 're_fuzz_0000000000000000000000',
      STRIPE_SECRET_KEY: 'sk_test_fuzz0000000000000000',
      STRIPE_WEBHOOK_SECRET: 'whsec_fuzz0000000000000000',
      ANTHROPIC_API_KEY: 'sk-ant-fuzz-0000000000000000',
      CYBERSYGN_FROM: 'fuzz@cybersygn.invalid',
      CYBERSYGN_OWNER_EMAIL: 'owner@cybersygn.invalid',
      OWNER_EMAIL: 'owner@cybersygn.invalid',
      OWNER_USERNAME: 'fuzz-owner',
      OWNER_PASSWORD_SALT: 'fuzzsalt',
      OWNER_PASSWORD_HASH: 'f'.repeat(64),
      // sha256("cybersygn-dev-owner"), the same value scripts/test-multi-signer.js uses.
      CYBERSYGN_OWNER_HASH: 'db4620902e87f722ffe92d06b1d013e58a09aacceae9fce7899456da072698b5',
      VYAN_METRICS_KEY: 'fuzz-house-key',
      VYAN_HOUSE_KEY: 'fuzz-house-key',
      CYBERSYGN_BUSINESS_ADDRESS: '1 Fuzz St',
    });
  }
  const ctx = { waitUntil(p) { if (p && typeof p.catch === 'function') p.catch(() => {}); }, passThroughOnException() {} };

  // Free-token dispenser: signs up a throwaway email and hands out its tokens so
  // POST /api/docs reaches the real handler instead of the 402 free-tier gate.
  let tok = null, left = 0, n = 0;
  const freeToken = async () => {
    if (left <= 0) {
      n++;
      const req = new Request('https://cybersygn.io/api/free/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.200.${(n >> 8) & 255}.${n & 255}` },
        body: JSON.stringify({ firstName: 'Fuzz', lastName: 'Harness', email: `fuzz${n}@test.cybersygn.io` }),
      });
      const res = await worker.fetch(req, env, ctx);
      let j = null; try { j = await res.json(); } catch {}
      if (!j || !j.freeToken) return null;
      tok = j.freeToken; left = 3;
    }
    left--;
    return tok;
  };

  return { worker, env, ctx, outbound, freeToken, restore: () => { globalThis.fetch = realFetch; } };
}

// ---------------------------------------------------------------- main ----
async function main() {
  const routes = ROUTES.filter(r => !FILTER || r.path.includes(FILTER));
  const selected = MODE === 'live' ? routes.filter(r => r.liveSafe) : routes;

  let local = null;
  if (MODE === 'local') local = await makeLocalEnv();

  const jobs = [];
  for (const route of selected) {
    for (const payload of payloadsFor(route)) {
      if (MODE === 'live' && payload.localOnly) continue;
      // Live mode never sends a method that could reach a mutating handler.
      if (MODE === 'live') {
        const m = payload.method || route.method;
        if (m !== 'GET' && m !== 'OPTIONS' && !(route.kind === 'read' && m === 'PUT')) {
          // POST/PUT/DELETE on a read route cannot match a mutating dispatch arm
          // for these paths, but skip anything not provably inert.
          if (!(route.kind === 'read' && (m === 'POST' || m === 'PUT' || m === 'DELETE'))) continue;
        }
      }
      jobs.push({ route, payload });
    }
  }

  console.log(`# fuzz-api  mode=${MODE}  routes=${selected.length}  payloads/route~${payloadsFor(selected[0] || ROUTES[0]).length}  cases=${jobs.length}`);
  if (MODE === 'live') console.log(`# target ${BASE} (read-only + method-confusion only; mutating routes are LOCAL ONLY)`);

  const results = [];
  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      const r = await runOne(local, MODE === 'live' ? BASE : 'https://cybersygn.io', j.route, j.payload, MODE);
      const rec = { route: `${j.route.method} ${j.route.path}`, payload: j.payload.name, ...r };
      results.push(rec);
      if (rec.problems.length) {
        console.log(`FAIL ${rec.route}  [${rec.payload}]  -> ${rec.status}`);
        for (const p of rec.problems) console.log(`     ${p.kind}: ${p.detail}`);
        if (VERBOSE && rec.bodySample) console.log(`     body: ${rec.bodySample.replace(/\n/g, ' ').slice(0, 300)}`);
        if (rec.thrown) console.log(`     ${String(rec.thrown).split('\n').slice(0, 4).join('\n     ')}`);
      } else if (VERBOSE) {
        console.log(`ok   ${rec.route}  [${rec.payload}] -> ${rec.status}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const hintSet = new Set();
  for (const r of results) for (const h of (r.hints || [])) hintSet.add(`${r.route} :: ${h.detail}`);
  if (hintSet.size) {
    console.log(`\n# informational (not failures):`);
    for (const h of [...hintSet].slice(0, 20)) console.log(`#   ${h}`);
  }

  const failures = results.filter(r => r.problems.length);
  const byKind = {};
  for (const f of failures) for (const p of f.problems) byKind[p.kind] = (byKind[p.kind] || 0) + 1;

  console.log(`\n# ${results.length} cases, ${failures.length} failing`);
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`#   ${k}: ${v}`);

  const statuses = {};
  for (const r of results) statuses[r.status] = (statuses[r.status] || 0) + 1;
  console.log('# status distribution: ' + Object.entries(statuses).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' '));

  if (local) {
    local.restore();
    if (local.outbound.length) {
      const uniq = [...new Set(local.outbound.map(o => o.method + ' ' + o.url.split('?')[0]))];
      console.log(`# outbound fetch attempts blocked by the harness: ${local.outbound.length}`);
      for (const u of uniq.slice(0, 20)) console.log(`#   ${u}`);
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ mode: MODE, base: BASE, results }, null, 2));
    console.log(`# wrote ${JSON_OUT}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
