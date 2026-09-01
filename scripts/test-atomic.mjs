/**
 * AtomicCounter tests. The point of this class is behavior under CONCURRENCY,
 * so a test that calls it once proves nothing. Each case fires many overlapping
 * operations against one object and asserts the invariant held.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AtomicCounter } from '../worker/src/atomic-do.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}

// A Durable Object serializes requests to one id. Model that faithfully: the
// storage is strongly consistent and handlers do not interleave.
//
// BE CLEAR ABOUT WHAT THIS PROVES AND WHAT IT DOES NOT. Because this stub
// chains every call, it cannot detect a racy implementation: the arithmetic is
// tested, the atomicity is assumed. Run the same class against a storage that
// yields between get and put and it grants 50 of a cap of 3.
//
// That is not a bug. Atomicity here comes from the RUNTIME, not from this code:
// Cloudflare's input gates hold other events while a handler awaits storage.
// But it means the guarantee rests on a property nothing in this file checks,
// and it breaks the moment someone awaits something that is NOT storage between
// the read and the write, because the input gate does not cover that. The
// source assertion at the bottom of this file is what guards that.
function makeStub() {
  const store = new Map();
  const storage = {
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
  };
  const inst = new AtomicCounter({ storage });
  let chain = Promise.resolve();
  return (op, body) => {
    const run = () => inst.fetch(new Request(`https://a.internal${op}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })).then(r => r.json());
    chain = chain.then(run, run);
    return chain;
  };
}

await t('consume enforces the cap under 50 concurrent callers', async () => {
  const call = makeStub();
  const results = await Promise.all(
    Array.from({ length: 50 }, () => call('/consume', { limit: 3 })));
  const granted = results.filter(r => r.ok).length;
  assert.equal(granted, 3, `exactly 3 grants, got ${granted}`);
  assert.equal(results.filter(r => !r.ok).length, 47);
});

await t('consume never returns a used value above the cap', async () => {
  const call = makeStub();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => call('/consume', { limit: 5 })));
  for (const r of results.filter(x => x.ok)) {
    assert.ok(r.used <= 5, `used ${r.used} exceeded cap`);
  }
  const used = results.filter(r => r.ok).map(r => r.used).sort((a, b) => a - b);
  assert.deepEqual(used, [1, 2, 3, 4, 5], 'grants are sequential with no duplicates');
});

await t('a cap of 0 grants nothing', async () => {
  const call = makeStub();
  const r = await call('/consume', { limit: 0 });
  assert.equal(r.ok, false);
});

await t('claim is won by exactly one of 100 concurrent callers', async () => {
  const call = makeStub();
  const results = await Promise.all(
    Array.from({ length: 100 }, () => call('/claim', { ttlMs: 60000 })));
  assert.equal(results.filter(r => r.claimed).length, 1, 'exactly one winner');
});

await t('a claim stays claimed on later attempts', async () => {
  const call = makeStub();
  assert.equal((await call('/claim', { ttlMs: 60000 })).claimed, true);
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('/claim', { ttlMs: 60000 })).claimed, false);
  }
});

await t('a claim past its ttl can be re-won', async () => {
  const call = makeStub();
  assert.equal((await call('/claim', { ttlMs: 1 })).claimed, true);
  await new Promise(r => setTimeout(r, 12));
  assert.equal((await call('/claim', { ttlMs: 1 })).claimed, true, 'expired claim is reclaimable');
});

await t('garbage input never throws and never grants', async () => {
  const call = makeStub();
  for (const body of [{}, { limit: 'abc' }, { limit: -1 }, { limit: null }]) {
    const r = await call('/consume', body);
    assert.ok(r && (r.ok === false || r.error), 'no accidental grant on bad input');
  }
});

await t('an unknown op is refused rather than silently succeeding', async () => {
  const call = makeStub();
  const r = await call('/nope', {});
  assert.equal(r.error, 'unknown_op');
});

await t('consume never awaits anything but storage between read and write', () => {
  // The cap holds because Cloudflare's input gates keep other events out while
  // a handler awaits STORAGE. That protection does not extend to any other
  // await: a fetch, a crypto call or a timer between the read and the write
  // reopens the gate and the counter becomes a plain read-modify-write race,
  // which the serialized stub above would still report as passing.
  const src = readFileSync(new URL('../worker/src/atomic-do.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async consume('), src.indexOf('async claim('));
  const awaits = [...body.matchAll(/await\s+([^;\n]+)/g)].map(m => m[1].trim());
  const nonStorage = awaits.filter(a => !/this\.state\.storage\./.test(a));
  assert.deepEqual(nonStorage, [],
    `consume() must only await storage; found: ${nonStorage.join(' | ')}`);
});

console.log(out.join('\n'));
console.log(`\natomic primitives: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
