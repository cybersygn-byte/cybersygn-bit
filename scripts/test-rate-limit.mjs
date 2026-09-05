/**
 * The rate limiter was a ceiling per sequential caller, not a ceiling.
 *
 * checkRateLimit did `get`, then `+1`, then `put` against KV, which has no
 * compare-and-set. N requests arriving before any of them landed its put all
 * read the same counter and all wrote the same value, so the bucket advanced
 * by about one however many were in flight. Measured against production, a
 * 40-way concurrent burst put 38 requests through a limit of 30.
 *
 * That mattered everywhere a single admitted request spends real money: the
 * vision endpoint bills an Anthropic call per page, the snapshot endpoint
 * mails a PDF to arbitrary addresses, and the limiter is the only brute-force
 * control in front of owner login.
 *
 * The fix routes the whole read-modify-write through the AtomicCounter Durable
 * Object, whose input gates serialize calls to one instance. atomic-do.js
 * already opened by describing this exact race; it just was not wired here.
 *
 * These tests pin the windowing logic, the cleanup alarm, and the wiring that
 * prefers the object over KV. The serialization itself is a platform
 * guarantee, so what is tested here is that we depend on it correctly.
 */
import assert from 'node:assert';
import { AtomicCounter } from '../worker/src/atomic-do.js';
import { checkRateLimit } from '../worker/src/rate-limit.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

// Minimal DO state. Calls are applied one at a time, which is what the runtime
// guarantees for a single object, so this models the real thing.
function mkState() {
  const map = new Map();
  let alarmAt = null;
  return {
    storage: {
      async get(k) { return map.get(k); },
      async put(k, v) { map.set(k, v); },
      async delete(k) { map.delete(k); },
      async list({ prefix } = {}) {
        const m = new Map();
        for (const [k, v] of map) if (!prefix || k.startsWith(prefix)) m.set(k, v);
        return m;
      },
      async setAlarm(ts) { alarmAt = ts; },
    },
    _map: map,
    _alarmAt: () => alarmAt,
  };
}
const rate = async (obj, policies, nowMs) =>
  await (await obj.rate({ policies, nowMs })).json();

await t('a single window admits exactly max and then refuses', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = 1_800_000_000_000;
  let allowed = 0, refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await rate(obj, [{ windowSec: 60, max: 30 }], now);
    r.ok ? allowed++ : refused++;
  }
  assert.equal(allowed, 30, `expected exactly 30 admitted, got ${allowed}`);
  assert.equal(refused, 10);
});

await t('the window rolls over to a fresh allowance, and not before', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = 1_800_000_000_000;
  for (let i = 0; i < 30; i++) await rate(obj, [{ windowSec: 60, max: 30 }], now);
  const blocked = await rate(obj, [{ windowSec: 60, max: 30 }], now + 59_000);
  assert.equal(blocked.ok, false, 'still inside the window, must stay refused');
  const fresh = await rate(obj, [{ windowSec: 60, max: 30 }], now + 61_000);
  assert.equal(fresh.ok, true, 'next window starts clean');
});

await t('the tighter of two policies governs', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = 1_800_000_000_000;
  const policies = [{ windowSec: 60, max: 100 }, { windowSec: 3600, max: 5 }];
  let allowed = 0;
  for (let i = 0; i < 10; i++) if ((await rate(obj, policies, now)).ok) allowed++;
  assert.equal(allowed, 5, 'the hourly cap binds even though the minute cap is loose');
});

await t('every policy still counts while another is exceeded', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = 1_800_000_000_000;
  const policies = [{ windowSec: 60, max: 2 }, { windowSec: 3600, max: 100 }];
  for (let i = 0; i < 6; i++) await rate(obj, policies, now);
  // The hourly bucket must have seen all six, not just the two admitted, so it
  // reflects the pressure that actually arrived.
  assert.equal(st._map.get('w:3600').count, 6);
});

await t('retryAfterSec is the longest locked window, not the shortest', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = 1_800_000_000_000;
  const policies = [{ windowSec: 60, max: 1 }, { windowSec: 3600, max: 1 }];
  await rate(obj, policies, now);
  const r = await rate(obj, policies, now);
  assert.equal(r.ok, false);
  assert.ok(r.retryAfterSec > 60, `expected the hourly reset, got ${r.retryAfterSec}`);
});

await t('the cleanup alarm does NOT clear a bucket that is still live', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  const now = Date.now();
  await rate(obj, [{ windowSec: 60, max: 5 }], now);
  await obj.alarm();
  assert.ok(st._map.has('w:60'), 'a live bucket must survive the alarm, or the caller gets a free reset');
});

await t('the cleanup alarm clears a bucket that has gone idle', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  await rate(obj, [{ windowSec: 60, max: 5 }], Date.now());
  st._map.set('lastSeen', Date.now() - 10 * 60 * 1000); // idle for ten minutes
  await obj.alarm();
  assert.ok(!st._map.has('w:60'), 'an abandoned subject must not hold storage forever');
  assert.ok(!st._map.has('lastSeen'));
});

await t('the alarm never touches consume/claim state', async () => {
  const st = mkState(); const obj = new AtomicCounter(st);
  st._map.set('used', 7);
  st._map.set('claimedAt', 123);
  await rate(obj, [{ windowSec: 60, max: 5 }], Date.now());
  st._map.set('lastSeen', Date.now() - 10 * 60 * 1000);
  await obj.alarm();
  assert.equal(st._map.get('used'), 7, 'the free-tier counter has no expiry by design');
  assert.equal(st._map.get('claimedAt'), 123, 'the at-most-once token has no expiry by design');
});

// ---- wiring -----------------------------------------------------------------

function mkEnvWithDo() {
  const objects = new Map();
  // A counter, so a test cannot quietly pass through the KV fallback and look
  // like it proved the object path. That is exactly the shape of a test that
  // proves nothing: both paths cap at the same number for sequential traffic.
  const calls = { rate: 0 };
  return {
    _calls: calls,
    ATOMIC: {
      idFromName: (n) => n,
      get: (n) => ({
        fetch: async (u, init) => {
          if (!objects.has(n)) objects.set(n, new AtomicCounter(mkState()));
          const obj = objects.get(n);
          const body = JSON.parse(init.body);
          if (new URL(u).pathname !== '/rate') return new Response('{}', { status: 400 });
          calls.rate++;
          return obj.rate(body);
        },
      }),
    },
    CYBERSYGN_DOCS: null,
  };
}

await t('checkRateLimit uses the Durable Object when ATOMIC is bound', async () => {
  const env = mkEnvWithDo();
  let allowed = 0;
  for (let i = 0; i < 12; i++) {
    const r = await checkRateLimit(env, 'subject-a', [{ windowSec: 60, max: 10 }]);
    if (r.ok) allowed++;
  }
  assert.equal(allowed, 10, `the object must cap at 10, got ${allowed}`);
  assert.equal(env._calls.rate, 12,
    `every call must reach the object, got ${env._calls.rate} of 12. If this is 0 the ` +
    'test passed through the KV fallback and proved nothing about the fix.');
});

await t('subjects are isolated from each other', async () => {
  const env = mkEnvWithDo();
  for (let i = 0; i < 10; i++) await checkRateLimit(env, 'noisy', [{ windowSec: 60, max: 10 }]);
  const quiet = await checkRateLimit(env, 'quiet', [{ windowSec: 60, max: 10 }]);
  assert.equal(quiet.ok, true, 'one subject must not spend another subject budget');
});

await t('a 429 from the object carries the same headers as the KV path', async () => {
  const env = mkEnvWithDo();
  let last = null;
  for (let i = 0; i < 4; i++) last = await checkRateLimit(env, 'hdrs', [{ windowSec: 60, max: 2 }]);
  assert.equal(last.ok, false);
  assert.ok(last.headers['Retry-After'], 'Retry-After');
  assert.ok(last.headers['RateLimit-Limit'], 'RateLimit-Limit');
  assert.equal(last.headers['RateLimit-Remaining'], '0');
});

await t('with no ATOMIC binding it still limits, via the KV fallback', async () => {
  // This is local dev and the node harness. The fallback is weaker, not absent.
  const kv = new Map();
  const env = { CYBERSYGN_DOCS: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  } };
  let allowed = 0;
  for (let i = 0; i < 12; i++) {
    const r = await checkRateLimit(env, 'nodo', [{ windowSec: 60, max: 10 }]);
    if (r.ok) allowed++;
  }
  assert.equal(allowed, 10, `the KV fallback must still cap sequential traffic, got ${allowed}`);
});

console.log(out.join('\n'));
console.log(`rate limiter: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
