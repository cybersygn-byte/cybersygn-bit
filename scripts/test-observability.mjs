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

console.log(out.join('\n'));
console.log(`\nobservability: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
