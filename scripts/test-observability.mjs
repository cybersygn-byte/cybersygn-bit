/**
 * Error visibility and configuration checks.
 *
 * Both exist because of the same failure: something important was OFF and
 * nothing said so. Four secrets were unset for an entire build, including the
 * one CAN-SPAM legally requires, and no surface reported it. Uncaught worker
 * errors reached console.error, which nobody tails and Cloudflare does not
 * retain, so a broken production path could survive indefinitely.
 */
import assert from 'node:assert';
import { recordError, getRecentErrors } from '../worker/src/sentry.js';
import { runSecurityCheck } from '../worker/src/security-check.js';

let pass = 0, fail = 0; const out = [];
async function t(name, fn) {
  try { await fn(); out.push('OK   ' + name); pass++; }
  catch (e) { out.push('FAIL ' + name + '\n     ' + e.message); fail++; }
}
const makeEnv = (extra = {}) => {
  const kv = new Map();
  return { CYBERSYGN_DOCS: {
    get: async (k) => kv.get(k) ?? null,
    put: async (k, v) => { kv.set(k, v); },
  }, ...extra };
};

await t('an error is recorded where a human can read it', async () => {
  const env = makeEnv();
  await recordError(env, new Error('kaboom'), { where: 'fetch', url: 'https://x/api/health' });
  const r = await getRecentErrors(env);
  assert.equal(r.length, 1);
  assert.equal(r[0].message, 'kaboom');
  assert.match(r[0].where, /\/api\/health/);
});

await t('a signer token in the URL NEVER reaches the ring', async () => {
  // The query string carries per-signer capabilities. A log that captured one
  // would turn error visibility into a credential leak.
  const env = makeEnv();
  await recordError(env, new Error('e'), { where: 'fetch', url: 'https://x/api/docs/d1/pdf?t=SUPERSECRET' });
  assert.ok(!JSON.stringify(await getRecentErrors(env)).includes('SUPERSECRET'));
});

await t('identical errors collapse instead of evicting everything else', async () => {
  const env = makeEnv();
  for (let i = 0; i < 5; i++) {
    await recordError(env, new Error('same'), { where: 'cron', url: 'https://x/api/a' });
  }
  const r = await getRecentErrors(env);
  assert.equal(r.length, 1, 'one entry, not five');
  assert.equal(r[0].count, 5, 'with a count');
});

await t('the ring is bounded, so a hot loop cannot fill KV', async () => {
  const env = makeEnv();
  for (let i = 0; i < 60; i++) await recordError(env, new Error('e' + i), { where: 'w' + i });
  assert.ok((await getRecentErrors(env)).length <= 25);
});

await t('recording NEVER throws, whatever it is handed', async () => {
  for (const [env, err] of [[{}, new Error('x')], [null, null], [makeEnv(), undefined]]) {
    const r = await recordError(env, err, {});
    assert.equal(typeof r, 'boolean');
  }
  assert.deepEqual(await getRecentErrors({}), []);
});

// ---------------------------------------------------- configuration surfacing
const probe = { dispatch: async () => new Response('{}', { status: 401 }) };

await t('a missing CAN-SPAM address is reported as CRITICAL', async () => {
  // 15 U.S.C. 7704(a)(5) requires a physical postal address in commercial
  // email. email-html.js only renders one when this is set, so unset means
  // every marketing email that goes out is non-compliant.
  const env = makeEnv({ CYBERSYGN_OWNER_HASH: 'a'.repeat(64) });
  const r = await runSecurityCheck(env, probe);
  const f = r.advisories.find(x => x.name === 'can_spam_address_set');
  assert.ok(f, 'the missing address must be reported');
  assert.equal(f.severity, 'critical');
});

await t('config advisories do NOT count as security failures', async () => {
  // They can never pass until the owner performs an account action, so
  // counting them would make the twice-daily alert fire forever and bury a
  // real regression. "A passing run sends no email" has to stay reachable.
  const env = makeEnv({ CYBERSYGN_OWNER_HASH: 'a'.repeat(64) });
  const r = await runSecurityCheck(env, probe);
  const names = r.failures.map(f => f.name);
  for (const n of ['can_spam_address_set', 'error_reporting_configured', 'analytics_configured', 'search_console_configured']) {
    assert.ok(!names.includes(n), `${n} must be an advisory, not a failure that pages the owner`);
  }
});

await t('a configured address clears the check', async () => {
  const env = makeEnv({ CYBERSYGN_OWNER_HASH: 'a'.repeat(64), CYBERSYGN_BUSINESS_ADDRESS: '1 Main St, Denver CO' });
  const r = await runSecurityCheck(env, probe);
  assert.ok(!r.advisories.some(x => x.name === 'can_spam_address_set'));
  assert.ok(!r.failures.some(x => x.name === 'can_spam_address_set'));
});

await t('missing error reporting and measurement are surfaced too', async () => {
  const env = makeEnv({ CYBERSYGN_OWNER_HASH: 'a'.repeat(64) });
  const names = (await runSecurityCheck(env, probe)).advisories.map(f => f.name);
  for (const n of ['error_reporting_configured', 'analytics_configured', 'search_console_configured']) {
    assert.ok(names.includes(n), `${n} must be reported when unset`);
  }
});

await t('a CRON failure is recorded, not just console.error-ed', async () => {
  // The error ring was wired only into fetch. Every scheduled job ended in
  // console.error or a bare .catch(() => {}), and Cloudflare retains neither,
  // so a cron failing every hour for a month looked exactly like one that had
  // never failed. The whole scheduled side of the worker was invisible.
  const worker = (await import('../worker/src/index.js')).default;
  const kv = new Map();
  const st = {
    get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return (ty === 'json' || (ty && ty.type === 'json')) ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  // Fail the reminder sweep the way a real KV outage would.
  const broken = { ...st, get: async (k) => { if (String(k).startsWith('index:')) throw new Error('KV outage during sweep'); return null; } };
  const waits = [];
  await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() },
    { CYBERSYGN_DOCS: broken, CYBERSYGN_PDFS: st }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);

  const ring = await getRecentErrors({ CYBERSYGN_DOCS: st });
  const list = ring.errors || ring || [];
  assert.ok(list.length >= 1, 'the failure must reach the error ring');
  assert.ok(list.some(e => String(e.where || '').startsWith('cron:')),
    `the entry must name the cron job, got ${JSON.stringify(list.map(e => e.where))}`);
});

await t('one failing cron job does not stop the others', async () => {
  // Visibility must not come at the cost of the sweep: cronTask reports and
  // resolves, it never rethrows into waitUntil.
  const worker = (await import('../worker/src/index.js')).default;
  const kv = new Map();
  const st = {
    get: async (k, ty) => { const v = kv.get(k); if (v == null) return null; return (ty === 'json' || (ty && ty.type === 'json')) ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  const broken = { ...st, get: async (k) => { if (String(k).startsWith('index:')) throw new Error('boom'); return null; } };
  const waits = [];
  await worker.scheduled({ cron: '0 * * * *', scheduledTime: Date.now() },
    { CYBERSYGN_DOCS: broken, CYBERSYGN_PDFS: st }, { waitUntil: (p) => waits.push(p) });
  const settled = await Promise.allSettled(waits);
  assert.ok(!settled.some(r => r.status === 'rejected'),
    'no cron task may reject: one bad job must not take down the sweep');
});

await t('an UNDELIVERED security alert is not reported as sent', async () => {
  // deliver() returns { delivered:false, error } instead of throwing, so the
  // empty catch around it meant an alert that never left the building looked
  // exactly like one that did. Of every email here, this is the one whose
  // silent non-delivery matters most: it is the alert about things being broken.
  const { runSecurityCheck: run } = await import('../worker/src/security-check.js');
  const kv = new Map();
  const st = {
    get: async (k, o) => { const v = kv.get(k); if (v == null) return null; const j = o === 'json' || (o && o.type === 'json'); return j ? JSON.parse(v) : v; },
    put: async (k, v) => { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    delete: async (k) => kv.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => (String(u).includes('resend')
    ? new Response('{"message":"API key is invalid"}', { status: 401 })
    : new Response('{}', { status: 200 }));
  try {
    const env = { CYBERSYGN_DOCS: st, RESEND_API_KEY: 're_bad', CYBERSYGN_OWNER_EMAIL: 'o@e.com', CYBERSYGN_FROM: 'h@e.com' };
    const r = await run(env, async () => ({ ok: false, status: 503 }));
    assert.ok(r.failures.length > 0, 'the run must have something to alert about');
    assert.equal(r.alertDelivered, false, 'a refused send must be reported as undelivered');
    const ring = await getRecentErrors(env);
    const list = ring.errors || ring || [];
    assert.ok(list.some(e => String(e.where || '').includes('security-check-alert')),
      'and must land in the error ring where a human can see it');
  } finally { globalThis.fetch = real; }
});

console.log(out.join('\n'));
console.log(`\nobservability: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
