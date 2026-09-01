/**
 * Cron-job and limiter regression tests.
 *
 * Plain node asserts with an in-memory KV mock, same pattern as
 * scripts/test-payout.mjs. Every case here is a defect that shipped:
 *  - a rate limiter that read its counter fine but could not write it, and so
 *    handed out unlimited attempts forever
 *  - the same limiter throwing on a null policy entry, and allowing everything
 *    when no KV was bound
 *  - a drip campaign whose per-run cap counted keys SCANNED, so it stopped
 *    reaching new signups once 200 lifetime records existed
 *  - a drip sweep that restarted at the top of the keyspace every run
 *  - one KV list hiccup at 14:00 UTC costing the entire day's campaign
 *  - a missed drip day permanently skipping stages 1 and 3
 *  - "Good week." with negative earnings, and the subject line "$-20"
 *  - an owner test send burning the real ambassador's weekly guard
 *  - a KV outage reported as a normal already_sent skip
 *  - a KV backup that has never run and said nothing about it
 *  - an uptime number that measured a KV round trip, not /api/health
 */
import assert from 'node:assert/strict';
import { checkRateLimit } from '../worker/src/rate-limit.js';
import { runDripCampaign } from '../worker/src/drip-campaign.js';
import { sendWeeklyDigest, runWeeklyDigest } from '../worker/src/ambassador-email.js';
import { runDailyKvBackup, getLatestKvBackup, backupSignedArtifacts, pruneOldBackups } from '../worker/src/kv-backup.js';
import { runUptimeProbe } from '../worker/src/uptime.js';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

// Email falls back to a console line without RESEND_API_KEY; keep the run quiet.
const REAL_LOG = console.log, REAL_WARN = console.warn, REAL_ERR = console.error;
function quiet() { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
function loud() { console.log = REAL_LOG; console.warn = REAL_WARN; console.error = REAL_ERR; }

const DAY = 24 * 60 * 60 * 1000;

/**
 * In-memory KV with real list pagination and cursors, plus per-op fault
 * injection: opts.fail(op, key) returning true makes that operation throw.
 */
function makeKv(seed = {}, opts = {}) {
  const map = new Map(Object.entries(seed));
  const fail = opts.fail || (() => false);
  return {
    _map: map,
    async get(key) {
      if (fail('get', key)) throw new Error('kv get failed (injected)');
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      if (fail('put', key)) throw new Error('kv put failed (injected)');
      map.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      if (opts.onPut) opts.onPut(key, map);
    },
    async delete(key) {
      if (fail('delete', key)) throw new Error('kv delete failed (injected)');
      map.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      if (fail('list', prefix)) throw new Error('kv list failed (injected)');
      const all = [...map.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const next = start + slice.length;
      const complete = next >= all.length;
      return {
        keys: slice.map(name => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(next),
      };
    },
  };
}

quiet();

// ------------------------------------------------------------- rate limiter
await t('limiter fails CLOSED when the counter cannot be written', async () => {
  const env = { CYBERSYGN_DOCS: makeKv({}, { fail: (op) => op === 'put' }) };
  const first = await checkRateLimit(env, 'signup:1.2.3.4', [{ windowSec: 600, max: 5 }]);
  assert.equal(first.ok, false, 'an unwritable counter must not allow the request');
  assert.equal(first.headers['RateLimit-Remaining'], '0');
  // The old shape: reads work, writes fail, so the counter never advances and
  // every call re-reads 0. Prove it is not just the first call that rejects.
  for (let i = 0; i < 10; i++) {
    const r = await checkRateLimit(env, 'signup:1.2.3.4', [{ windowSec: 600, max: 5 }]);
    assert.equal(r.ok, false, `call ${i} still rejected`);
  }
});

await t('limiter still fails CLOSED when the counter cannot be read', async () => {
  const env = { CYBERSYGN_DOCS: makeKv({}, { fail: (op) => op === 'get' }) };
  const r = await checkRateLimit(env, 'owner-login:1.2.3.4', [{ windowSec: 900, max: 10 }]);
  assert.equal(r.ok, false);
});

await t('a null policy entry is skipped instead of throwing', async () => {
  const env = { CYBERSYGN_DOCS: makeKv() };
  const r = await checkRateLimit(env, 'detect:9.9.9.9', [null, { windowSec: 60, max: 2 }]);
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 1, 'only the real policy produced a hit');
  await checkRateLimit(env, 'detect:9.9.9.9', [null, { windowSec: 60, max: 2 }]);
  const third = await checkRateLimit(env, 'detect:9.9.9.9', [null, { windowSec: 60, max: 2 }]);
  assert.equal(third.ok, false, 'the surviving policy still enforces its ceiling');
});

await t('an unbound KV namespace does not mean unlimited requests', async () => {
  const key = `unbound:${Math.random().toString(36).slice(2)}`;
  const policy = [{ windowSec: 600, max: 3 }];
  for (let i = 0; i < 3; i++) {
    const r = await checkRateLimit({}, key, policy);
    assert.equal(r.ok, true, `call ${i + 1} inside the ceiling`);
  }
  const over = await checkRateLimit({}, key, policy);
  assert.equal(over.ok, false, 'the 4th call over a max of 3 is rejected');
});

// -------------------------------------------------------------- drip sweep
function dripRec(ageDays, n) {
  return JSON.stringify({
    email: `drip${n}@example.com`,
    firstName: 'Test',
    createdAt: new Date(Date.now() - ageDays * DAY).toISOString(),
  });
}

/** Zero-padded so KV's lexicographic list order matches insertion order. */
const pad = (n) => String(n).padStart(4, '0');

function clearDripLock(env) {
  const dayKey = new Date().toISOString().slice(0, 10);
  env.CYBERSYGN_DOCS._map.delete(`meta:drip-lock:${dayKey}`);
}

await t('the per-run cap counts SENDS, so old records cannot crowd out new ones', async () => {
  const seed = {};
  // 210 signups that have already had all three emails: nothing left to send,
  // but under the old cap they consumed the entire run's budget.
  for (let i = 0; i < 210; i++) {
    seed[`drip:${pad(i)}`] = dripRec(30, i);
    for (const s of [1, 3, 7]) seed[`drip-sent:${pad(i)}:${s}`] = 'x';
  }
  // Yesterday's signup, last in key order.
  seed['drip:9999'] = dripRec(1, 9999);
  const env = { CYBERSYGN_DOCS: makeKv(seed) };
  const r = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(r.ok, true);
  assert.equal(r.day1Sent, 1, 'the new signup got its day 1 email');
  assert.equal(r.sent, 1, 'exactly one send was spent');
  assert.ok(r.scanned > 200, `scanned past the old 200-key wall (scanned ${r.scanned})`);
});

await t('a late sweep walks a user forward one stage per run, lowest first', async () => {
  const env = { CYBERSYGN_DOCS: makeKv({ 'drip:0001': dripRec(9, 1) }) };
  const first = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(first.day1Sent, 1, 'day 1 goes first even though day 7 is eligible');
  assert.equal(first.day7Sent, 0, 'the conversion ask is NOT the opening email');

  clearDripLock(env);
  const second = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(second.day3Sent, 1, 'next run sends day 3');

  clearDripLock(env);
  const third = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(third.day7Sent, 1, 'then day 7');

  clearDripLock(env);
  const fourth = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(fourth.sent, 0, 'and then nothing, forever');
});

await t('a failed sweep releases the day lock and reports ok:false', async () => {
  let listBroken = true;
  const env = {
    CYBERSYGN_DOCS: makeKv(
      { 'drip:0001': dripRec(2, 1) },
      { fail: (op) => op === 'list' && listBroken },
    ),
  };
  const broken = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(broken.ok, false, 'an aborted sweep is not a successful one');
  const dayKey = new Date().toISOString().slice(0, 10);
  assert.equal(env.CYBERSYGN_DOCS._map.has(`meta:drip-lock:${dayKey}`), false,
    'the lock must not survive a sweep that did no work');

  // Same day, KV recovered: the campaign is not lost until tomorrow.
  listBroken = false;
  const retry = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(retry.ok, true);
  assert.equal(retry.day1Sent, 1, 'the retry actually sent');
});

await t('a capped sweep saves its cursor and the next run resumes', async () => {
  const seed = {};
  for (let i = 0; i < 300; i++) seed[`drip:${pad(i)}`] = dripRec(1, i);
  const env = { CYBERSYGN_DOCS: makeKv(seed) };

  const first = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(first.day1Sent, 200, 'first run sends up to the send cap');
  assert.equal(first.cursorSaved, true, 'and remembers where it stopped');

  clearDripLock(env);
  const second = await runDripCampaign(env, { scheduledTime: Date.now() });
  assert.equal(second.resumed, true, 'second run picks up the stored cursor');
  assert.equal(second.day1Sent, 100, 'and finishes the remaining records');
  assert.equal(env.CYBERSYGN_DOCS._map.has('meta:drip-cursor'), false,
    'a completed sweep clears the cursor');
});

// ------------------------------------------------------- ambassador digest
/** Capture the exact Resend payload rather than trusting the console branch. */
function captureSends() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: 'e_test' }) };
  };
  return { sent, restore() { globalThis.fetch = realFetch; } };
}

await t('a net-negative week never says "Good week" and never renders $-20', async () => {
  const cap = captureSends();
  try {
    const env = { RESEND_API_KEY: 're_test', CYBERSYGN_DOCS: makeKv() };
    const r = await sendWeeklyDigest(env, {
      to: 'amb@example.com', code: 'abc', weekKey: '2026-w35',
      sales: 1, earned: -20, reversed: -40, dashUrl: 'https://cybersygn.io/ambassador/',
    });
    assert.equal(r.delivered, true);
    const msg = cap.sent[0];
    const all = `${msg.subject}\n${msg.text}\n${msg.html}`;
    assert.ok(!/Good week/.test(all), 'a week that went backwards is not a good week');
    assert.ok(!/\$-/.test(all), `the minus sign must sit outside the dollar sign: ${msg.subject}`);
    assert.ok(/-\$20/.test(msg.text), 'the real net is stated');
    assert.equal(msg.subject, 'Your week: 1 sale, and a reversal.');
  } finally { cap.restore(); }
});

await t('a genuinely good week still reads like one', async () => {
  const cap = captureSends();
  try {
    const env = { RESEND_API_KEY: 're_test', CYBERSYGN_DOCS: makeKv() };
    await sendWeeklyDigest(env, {
      to: 'amb@example.com', code: 'abc', weekKey: '2026-w35',
      sales: 2, earned: 40, reversed: 0, dashUrl: 'https://cybersygn.io/ambassador/',
    });
    assert.equal(cap.sent[0].subject, 'Your week: 2 sales, $40.');
    assert.ok(/Good week/.test(cap.sent[0].text));
  } finally { cap.restore(); }
});

await t('an owner test send does not burn the real weekly guard', async () => {
  const env = { CYBERSYGN_DOCS: makeKv() };
  const test = await sendWeeklyDigest(env, {
    to: 'amb@example.com', redirectTo: 'owner@cybersygn.io',
    code: 'abc', weekKey: '2026-w35', sales: 1, earned: 20,
    dashUrl: 'https://cybersygn.io/ambassador/',
  });
  assert.equal(test.delivered, true);
  assert.equal(env.CYBERSYGN_DOCS._map.has('ambmail:weekly:abc:2026-w35'), false,
    'the test send must not claim the ambassador\'s guard');

  const real = await sendWeeklyDigest(env, {
    to: 'amb@example.com', code: 'abc', weekKey: '2026-w35', sales: 1, earned: 20,
    dashUrl: 'https://cybersygn.io/ambassador/',
  });
  assert.equal(real.delivered, true, 'the ambassador still gets their digest');
});

await t('losing the claim race stands the second sender down', async () => {
  // Simulate another run's write landing on the key right after ours: the
  // read-back finds a nonce that is not ours.
  const kv = makeKv({}, {
    onPut(key, map) {
      if (key.startsWith('ambmail:')) map.set(key, JSON.stringify({ nonce: 'someone-else' }));
    },
  });
  const r = await sendWeeklyDigest({ CYBERSYGN_DOCS: kv }, {
    to: 'amb@example.com', code: 'race', weekKey: '2026-w35', sales: 1, earned: 20,
    dashUrl: 'https://cybersygn.io/ambassador/',
  });
  assert.equal(r.delivered, false);
  assert.equal(r.reason, 'already_sent');
});

await t('a KV outage during the claim is reported as guard_unavailable, not a skip', async () => {
  const kv = makeKv({}, { fail: (op, key) => String(key).startsWith('ambmail:') });
  const r = await sendWeeklyDigest({ CYBERSYGN_DOCS: kv }, {
    to: 'amb@example.com', code: 'abc', weekKey: '2026-w35', sales: 1, earned: 20,
    dashUrl: 'https://cybersygn.io/ambassador/',
  });
  assert.equal(r.reason, 'guard_unavailable', 'a total email outage must not look like a normal skip');
});

await t('the weekly sweep surfaces guard outages in its errors', async () => {
  const rec = {
    code: 'abc', email: 'amb@example.com', status: 'active',
    ledger: [{ at: new Date().toISOString(), type: 'bounty', amount: 20 }],
  };
  const kv = makeKv(
    { 'affiliate:code:abc': JSON.stringify(rec) },
    { fail: (op, key) => String(key).startsWith('ambmail:') },
  );
  const out = await runWeeklyDigest({ CYBERSYGN_DOCS: kv }, {});
  assert.equal(out.sent, 0);
  assert.ok(Array.isArray(out.errors) && out.errors.length === 1, 'the outage is reported');
  assert.ok(out.errors[0].startsWith('guard_unavailable:'), out.errors[0]);
});

// --------------------------------------------------------------- kv backup
await t('an unbound R2 bucket is a loud reported failure, not a silent no-op', async () => {
  const env = { CYBERSYGN_DOCS: makeKv({ 'sub:1': 'x' }) };
  const r = await runDailyKvBackup(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'r2_unbound');
  const latest = await getLatestKvBackup(env);
  assert.ok(latest && latest.reason === 'r2_unbound', 'the outcome is stored where it can be read');
  assert.ok(latest.ranAt, 'and stamped');
});

await t('a backup with a hole in it is not reported as a clean run', async () => {
  const puts = [];
  const env = {
    CYBERSYGN_DOCS: makeKv({ 'sub:1': 'a', 'doc:1': 'b' }, { fail: (op, key) => op === 'list' && key === 'doc:' }),
    CYBERSYGN_BACKUPS: {
      async head() { return null; },
      async put(key, body) { puts.push({ key, body }); },
    },
  };
  const r = await runDailyKvBackup(env);
  assert.equal(r.ok, false, 'a missing prefix means the backup is incomplete');
  assert.equal(r.reason, 'partial');
  assert.ok(r.errors.some(e => e.startsWith('list_failed:doc:')), JSON.stringify(r.errors));
  assert.equal(puts.length, 1, 'the partial object is still written, labelled partial');
});

await t('a clean backup reports what it actually wrote', async () => {
  const env = {
    CYBERSYGN_DOCS: makeKv({ 'sub:1': 'a', 'doc:1': 'b', 'unrelated:1': 'c' }),
    CYBERSYGN_BACKUPS: { async head() { return null; }, async put() {} },
  };
  const r = await runDailyKvBackup(env);
  assert.equal(r.ok, true);
  assert.equal(r.keyCount, 2, 'only the backed-up prefixes count');
  const latest = await getLatestKvBackup(env);
  assert.equal(latest.keyCount, 2);
});

// ------------------------------------------------------------------ uptime
await t('the uptime probe measures GET /api/health when given a dispatcher', async () => {
  const seen = [];
  const env = { CYBERSYGN_DOCS: makeKv(), CYBERSYGN_APP_URL: 'https://cybersygn.io' };
  const dispatch = async (req) => { seen.push(req.url); return new Response('{}', { status: 200 }); };
  const r = await runUptimeProbe(env, { dispatch });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'health');
  assert.equal(seen[0], 'https://cybersygn.io/api/health');
  const dayKey = new Date().toISOString().slice(0, 10);
  const rec = JSON.parse(env.CYBERSYGN_DOCS._map.get(`uptime:day:${dayKey}`));
  assert.equal(rec.ok, 1);
  assert.equal(rec.lastProbeVia, 'health', 'the day record says what produced the number');
});

await t('a 503 from /api/health is recorded as a failure', async () => {
  const env = { CYBERSYGN_DOCS: makeKv() };
  const dispatch = async () => new Response('{}', { status: 503 });
  const r = await runUptimeProbe(env, { dispatch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  const dayKey = new Date().toISOString().slice(0, 10);
  assert.equal(JSON.parse(env.CYBERSYGN_DOCS._map.get(`uptime:day:${dayKey}`)).fail, 1);
});

await t('without a dispatcher the probe degrades to KV and labels itself', async () => {
  const env = { CYBERSYGN_DOCS: makeKv() };
  const r = await runUptimeProbe(env, {});
  assert.equal(r.ok, true);
  assert.equal(r.via, 'kv', 'the weaker measurement must not claim to be a health check');
});

await t('signed PDFs and audit certs are backed up, once each', async () => {
  // These live in CYBERSYGN_PDFS, which the daily NDJSON dump never walks, so
  // the only artifacts the product promises to keep forever were the only ones
  // with no backup at all. Copy-once: a signed PDF is immutable (its hash is
  // published on the audit certificate), so re-uploading it nightly would
  // multiply cost by days for no benefit.
  const pdfKv = new Map([['signed:d1', 'PDF1'], ['audit:d1', 'CERT1'], ['signed:d2', 'PDF2'], ['pdf:d1', 'ORIGINAL']]);
  const r2 = new Map();
  const pdfs = {
    list: async ({ prefix }) => ({ keys: [...pdfKv.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
    get: async (k) => (pdfKv.has(k) ? pdfKv.get(k) : null),
  };
  const R2 = {
    head: async (k) => (r2.has(k) ? { key: k } : null),
    put: async (k, v) => { r2.set(k, v); },
    delete: async (k) => r2.delete(k),
    list: async ({ prefix }) => ({ objects: [...r2.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false }),
  };
  const env = { CYBERSYGN_BACKUPS: R2, CYBERSYGN_PDFS: pdfs, CYBERSYGN_DOCS: {} };

  const first = await backupSignedArtifacts(env);
  assert.equal(first.ok, true);
  assert.equal(first.copied, 3, 'both signed PDFs and the audit certificate');
  assert.ok(!([...r2.keys()].some(k => k.includes('pdf/d1'))),
    'the 30-day original is deliberately not archived');

  const second = await backupSignedArtifacts(env);
  assert.equal(second.copied, 0, 'nothing is re-uploaded');
  assert.equal(second.skipped, 3, 'they are recognised as already present');

  // The 35-day prune must never reach them: they are permanent records.
  r2.set('backups/2020-01-01.ndjson', 'old dump');
  await pruneOldBackups(env, new Date('2026-01-01T00:00:00Z'));
  assert.equal([...r2.keys()].filter(k => k.startsWith('artifacts/')).length, 3,
    'artifacts must survive the retention prune');
  assert.ok(!r2.has('backups/2020-01-01.ndjson'), 'while the dated dump is pruned');
});

loud();
console.log(results.join('\n'));
console.log(`\ncron jobs: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
