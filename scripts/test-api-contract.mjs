/**
 * Two contracts the public API owes an integrator: a ceiling, and one error
 * shape.
 *
 * The public API had no rate limiting at all.
 *
 * worker/src/index.js dispatched straight into routeApiV1 with no ceiling of
 * any kind, while the browser-facing POST /detect next door was capped at
 * 20/min per IP. That was survivable only while server-side detection was
 * broken and every parse failed instantly. Detection started working on
 * 2026-09-01, so POST /documents and POST /detect each run a real pdf.js
 * parse now, and one key could drive them flat out.
 *
 * What these tests pin down is not "a limiter exists" but the three decisions
 * inside it, each of which is wrong in an obvious-looking alternative:
 *
 *   1. The subject is the ACCOUNT (auth.senderId). Per key would let one
 *      customer mint a second key to buy a second budget. Per IP would make a
 *      server-to-server caller throttle itself from one egress address.
 *   2. Unmetered partner keys are STILL limited, just higher. `unmetered` is a
 *      billing flag; exempting it would aim the limiter away from precisely
 *      the keys allowed unlimited volume.
 *   3. Tiers bucket separately, so cheap polling cannot lock out a send.
 *
 * The limiter must also run BEFORE dispatch, or it rejects the request after
 * paying for the work it was supposed to prevent.
 */
import assert from 'node:assert';
import { routeApiV1 } from '../worker/src/api-v1.js';
import { createApiKey } from '../worker/src/apikeys.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

function mkEnv() {
  const kv = new Map();
  const st = {
    get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return (ty === 'json' || (ty && ty.type === 'json')) ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { CYBERSYGN_DOCS: st, CYBERSYGN_PDFS: st };
}

let created = 0;
const deps = {
  handleCreateDoc: async () => { created++; return new Response(JSON.stringify({ docId: 'd1', signerLinks: [] }), { status: 201, headers: { 'content-type': 'application/json' } }); },
  handleGetPdf: async () => new Response('pdf', { status: 200 }),
  handleGetAudit: async () => new Response('audit', { status: 200 }),
};

const call = (env, method, path, opts = {}) => {
  const url = new URL(`https://cybersygn.io${path}`);
  const headers = { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.headers || {}) };
  const req = new Request(url.toString(), { method, headers, ...(opts.body ? { body: opts.body } : {}) });
  return routeApiV1(req, env, url, {}, deps);
};

// The limiter buckets on floor(now/windowSec), so a burst that straddles a
// minute boundary silently gets a fresh allowance. Re-run rather than ship a
// test that fails once an hour.
async function burst(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = Math.floor(Date.now() / 60000);
    const result = await fn();
    if (Math.floor(Date.now() / 60000) === before) return result;
  }
  throw new Error('minute boundary kept rolling');
}

async function mkKey(env, senderId, opts = {}) {
  const made = await createApiKey(env, senderId, opts);
  assert.ok(made && made.key, 'key minted');
  return made.key;
}

// Drive `n` heavy requests, return how many were allowed before the first 429.
async function heavyUntilBlocked(env, key, n) {
  let allowed = 0;
  for (let i = 0; i < n; i++) {
    const r = await call(env, 'POST', '/api/v1/detect', { key, body: JSON.stringify({}) });
    if (r.status === 429) return { allowed, blocked: r };
    allowed++;
  }
  return { allowed, blocked: null };
}

await t('a heavy route is capped, and the cap is the documented 20/min', async () => {
  await burst(async () => {
    const env = mkEnv();
    const key = await mkKey(env, 'acct-a');
    const { allowed, blocked } = await heavyUntilBlocked(env, key, 25);
    assert.ok(blocked, 'a 429 arrived');
    assert.equal(allowed, 20, `expected 20 allowed, got ${allowed}`);
  });
});

await t('the 429 body and headers match the product-wide contract', async () => {
  await burst(async () => {
    const env = mkEnv();
    const key = await mkKey(env, 'acct-shape');
    const { blocked } = await heavyUntilBlocked(env, key, 25);
    assert.ok(blocked, 'got a 429');
    const body = await blocked.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(typeof body.message === 'string' && body.message.length, 'has a message');
    assert.ok(Number.isFinite(body.retryAfterSec), 'carries retryAfterSec');
    assert.ok(blocked.headers.get('retry-after'), 'sets Retry-After');
    assert.ok(blocked.headers.get('ratelimit-limit'), 'sets RateLimit-Limit');
    // The v1 security headers must still ride along on a 429.
    assert.equal(blocked.headers.get('x-content-type-options'), 'nosniff');
  });
});

await t('the budget belongs to the ACCOUNT, so a second key buys nothing', async () => {
  await burst(async () => {
    const env = mkEnv();
    const k1 = await mkKey(env, 'acct-same', { label: 'one' });
    const k2 = await mkKey(env, 'acct-same', { label: 'two' });
    const first = await heavyUntilBlocked(env, k1, 25);
    assert.equal(first.allowed, 20);
    // Same account through a different key: already spent.
    const r = await call(env, 'POST', '/api/v1/detect', { key: k2, body: '{}' });
    assert.equal(r.status, 429, 'a second key on the same account shares the budget');
  });
});

await t('one account cannot exhaust another account', async () => {
  await burst(async () => {
    const env = mkEnv();
    const a = await mkKey(env, 'acct-noisy');
    const b = await mkKey(env, 'acct-quiet');
    const spent = await heavyUntilBlocked(env, a, 25);
    assert.ok(spent.blocked, 'the noisy account is blocked');
    const r = await call(env, 'POST', '/api/v1/detect', { key: b, body: '{}' });
    assert.notEqual(r.status, 429, 'the quiet account is unaffected');
  });
});

await t('partner tenants are isolated from each other', async () => {
  await burst(async () => {
    const env = mkEnv();
    // provisionTenantKey namespaces each tenant as p-<partner>-<tenant>.
    const t1 = await mkKey(env, 'p-acme-tenant1', { unmetered: true });
    const t2 = await mkKey(env, 'p-acme-tenant2', { unmetered: true });
    let blocked = null;
    for (let i = 0; i < 70 && !blocked; i++) {
      const r = await call(env, 'POST', '/api/v1/detect', { key: t1, body: '{}' });
      if (r.status === 429) blocked = r;
    }
    assert.ok(blocked, 'tenant1 hits its own ceiling');
    const r = await call(env, 'POST', '/api/v1/detect', { key: t2, body: '{}' });
    assert.notEqual(r.status, 429, 'tenant2 still has its full budget');
  });
});

await t('an unmetered key gets a higher ceiling but is still limited', async () => {
  await burst(async () => {
    const env = mkEnv();
    const key = await mkKey(env, 'acct-partner', { unmetered: true });
    const { allowed, blocked } = await heavyUntilBlocked(env, key, 70);
    assert.ok(blocked, 'unmetered is NOT a bypass');
    assert.equal(allowed, 60, `expected the 60/min partner ceiling, got ${allowed}`);
  });
});

await t('tiers bucket separately, so polling cannot lock out a send', async () => {
  await burst(async () => {
    const env = mkEnv();
    const key = await mkKey(env, 'acct-tiers');
    const spent = await heavyUntilBlocked(env, key, 25);
    assert.ok(spent.blocked, 'the heavy tier is exhausted');
    const light = await call(env, 'GET', '/api/v1/me', { key });
    assert.notEqual(light.status, 429, 'the light tier still has budget');
    assert.equal(light.status, 200);
  });
});

await t('the limiter runs BEFORE the work it is protecting', async () => {
  await burst(async () => {
    const env = mkEnv();
    const key = await mkKey(env, 'acct-order');
    // Exhaust the heavy tier using /detect, then confirm a blocked
    // POST /documents never reaches the document creator.
    const spent = await heavyUntilBlocked(env, key, 25);
    assert.ok(spent.blocked, 'heavy tier exhausted');
    const before = created;
    const r = await call(env, 'POST', '/api/v1/documents', {
      key, body: JSON.stringify({ pdf_base64: 'x', signers: [{ name: 'A', email: 'a@b.com' }] }),
    });
    assert.equal(r.status, 429);
    assert.equal(created, before, 'handleCreateDoc must not run on a rejected request');
  });
});

await t('failed auth is throttled per IP, and still 401s below the ceiling', async () => {
  await burst(async () => {
    const env = mkEnv();
    const hdrs = { 'cf-connecting-ip': '203.0.113.9' };
    const first = await call(env, 'GET', '/api/v1/me', { key: 'cs_live_' + 'z'.repeat(24), headers: hdrs });
    assert.equal(first.status, 401, 'a wrong key is unauthorized, not rate limited, at first');
    let blocked = null;
    for (let i = 0; i < 40 && !blocked; i++) {
      const r = await call(env, 'GET', '/api/v1/me', { key: 'cs_live_' + 'z'.repeat(24), headers: hdrs });
      if (r.status === 429) blocked = r;
    }
    assert.ok(blocked, 'a sustained wrong-key flood is throttled');
    assert.equal((await blocked.json()).error, 'rate_limited');
  });
});

await t('a throttled IP does not affect a caller holding a valid key', async () => {
  await burst(async () => {
    const env = mkEnv();
    const hdrs = { 'cf-connecting-ip': '203.0.113.10' };
    const key = await mkKey(env, 'acct-innocent');
    let blocked = null;
    for (let i = 0; i < 40 && !blocked; i++) {
      const r = await call(env, 'GET', '/api/v1/me', { key: 'cs_live_' + 'q'.repeat(24), headers: hdrs });
      if (r.status === 429) blocked = r;
    }
    assert.ok(blocked, 'the bad-key flood is throttled');
    const good = await call(env, 'GET', '/api/v1/me', { key, headers: hdrs });
    assert.equal(good.status, 200, 'a valid key from the same IP still works');
  });
});

await t('the limiter fails CLOSED when its counter store is unreachable', async () => {
  const env = mkEnv();
  const key = await mkKey(env, 'acct-kvdown');
  // Break reads only after the key record is written, so auth still succeeds.
  const realGet = env.CYBERSYGN_DOCS.get;
  env.CYBERSYGN_DOCS.get = async (k, ty) => {
    if (String(k).startsWith('ratelimit:')) throw new Error('KV down');
    return realGet(k, ty);
  };
  const r = await call(env, 'POST', '/api/v1/detect', { key, body: '{}' });
  assert.equal(r.status, 429, 'an unreadable counter must not hand out unlimited requests');
});

// ---- The error envelope ------------------------------------------------------
//
// The docs promise "errors come back as JSON with a stable `error` code and a
// human `message`". DELETE /api/v1/keys broke that: an unknown key_id returned
// 404 with `{ "revoked": false }`, no error and no message, so a client
// switching on `error` read undefined and could not tell a miss from a hit.
// Asserted as an invariant over many routes rather than the one endpoint that
// happened to be wrong, since the next violation will be somewhere else.

await t('every v1 error response carries the { error, message } envelope', async () => {
  const env = mkEnv();
  const key = await mkKey(env, 'acct-envelope');
  const partner = await mkKey(env, 'acct-partner-master', { canProvision: true });
  const probes = [
    ['GET',    '/api/v1/nope',             { key }],
    ['DELETE', '/api/v1/documents',        { key }],
    ['GET',    '/api/v1/documents/nosuch', { key }],
    ['POST',   '/api/v1/documents',        { key, body: 'not json' }],
    ['POST',   '/api/v1/documents',        { key, body: '{}' }],
    ['POST',   '/api/v1/detect',           { key, body: '{}' }],
    ['POST',   '/api/v1/keys',             { key, body: '{}' }],
    ['GET',    '/api/v1/keys',             { key }],
    ['DELETE', '/api/v1/keys',             { key, body: '{}' }],
    ['POST',   '/api/v1/keys',             { key: partner, body: '{}' }],
    ['DELETE', '/api/v1/keys',             { key: partner, body: JSON.stringify({ key_id: 'key_missing' }) }],
    ['GET',    '/api/v1/me',               {}],
  ];
  for (const [method, path, opts] of probes) {
    const r = await call(env, method, path, opts);
    assert.ok(r.status >= 400, `${method} ${path} is an error (got ${r.status})`);
    const body = await r.json();
    assert.ok(typeof body.error === 'string' && body.error.length,
      `${method} ${path} -> ${r.status} must carry an error code, got ${JSON.stringify(body)}`);
    assert.ok(typeof body.message === 'string' && body.message.length,
      `${method} ${path} -> ${r.status} must carry a message, got ${JSON.stringify(body)}`);
  }
});

await t('revoking an unknown key_id is a 404 with key_not_found', async () => {
  const env = mkEnv();
  const partner = await mkKey(env, 'acct-partner-2', { canProvision: true });
  const r = await call(env, 'DELETE', '/api/v1/keys', { key: partner, body: JSON.stringify({ key_id: 'key_nope' }) });
  assert.equal(r.status, 404, 'status is unchanged, so status-based handling still works');
  const body = await r.json();
  assert.equal(body.error, 'key_not_found');
  assert.ok(!('revoked' in body), 'the bare { revoked: false } shape is gone');
});

console.log(out.join('\n'));
console.log(`api contract: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
