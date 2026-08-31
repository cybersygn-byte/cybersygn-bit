/**
 * fuzz-cron.mjs -- a full simulated YEAR of hourly cron ticks against the real
 * worker/src/index.js scheduled() handler with a mocked env.
 *
 * LOCAL ONLY. Nothing here touches production: KV is in-memory, R2 is
 * in-memory, global fetch is hard-blocked, and RESEND_API_KEY is deliberately
 * unset so email.js takes its console branch and never reaches Resend.
 *
 * Run:  node scripts/fuzz-cron.mjs
 */

// ---------------------------------------------------------------- time shim
const RealDate = Date;
let SIM_NOW = RealDate.now();
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(SIM_NOW); else super(...a); }
  static now() { return SIM_NOW; }
}
globalThis.Date = FakeDate;
function setNow(ms) { SIM_NOW = ms; }

// ------------------------------------------------------------ console sink
const REAL_LOG = console.log, REAL_ERR = console.error;
const LOG_SINK = [];
function quiet() { console.log = (...a) => LOG_SINK.push(a); console.error = (...a) => LOG_SINK.push(a); }
function loud() { console.log = REAL_LOG; console.error = REAL_ERR; }
quiet();

// ---------------------------------------------------------------- fetch trap
let NETWORK_CALLS = [];
globalThis.fetch = async (input) => {
  const u = typeof input === 'string' ? input : (input && input.url) || String(input);
  NETWORK_CALLS.push(u);
  throw new Error('NETWORK BLOCKED in harness: ' + u);
};

// ---------------------------------------------------------------- KV mock
function makeKV(tap, opts = {}) {
  const map = new Map();
  const fail = opts.fail || (() => false);
  const kv = {
    _map: map,
    async get(key, o) {
      tap && tap({ op: 'get', key });
      if (fail('get', key)) throw new Error('KV get failed (injected)');
      const v = map.has(key) ? map.get(key) : null;
      if (v === null) return null;
      if (o && (o === 'json' || o.type === 'json' || o.json === true)) {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, val, o) {
      tap && tap({ op: 'put', key });
      if (fail('put', key)) throw new Error('KV put failed (injected)');
      map.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },
    async delete(key) { tap && tap({ op: 'delete', key }); map.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      tap && tap({ op: 'list', key: prefix });
      if (fail('list', prefix)) throw new Error('KV list failed (injected)');
      const all = [...map.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const page = all.slice(start, start + limit);
      const last = page[page.length - 1];
      const complete = start + limit >= all.length;
      return { keys: page.map(name => ({ name })), list_complete: complete, cursor: complete ? undefined : last };
    },
  };
  return kv;
}

function makeR2(tap) {
  const map = new Map();
  return {
    _map: map,
    async head(k) { tap && tap({ op: 'r2head', key: k }); return map.has(k) ? { key: k } : null; },
    async put(k, v) { tap && tap({ op: 'r2put', key: k }); map.set(k, v); return { key: k }; },
  };
}

// ------------------------------------------------------- job classification
// Each cron job is identified by a KV/R2 operation that ONLY that job performs.
const SIGNATURES = [
  ['reminder_sweep',       o => o.op === 'get' && o.key === 'index:active'],
  ['monthly_owner_report', o => o.op === 'put' && o.key.startsWith('meta:monthly-report:')],
  ['drip_campaign',        o => o.op === 'put' && o.key.startsWith('meta:drip-lock:')],
  ['ambassador_sweep',     o => o.op === 'list' && o.key === 'affiliate:code:'],
  ['kv_backup',            o => o.op === 'r2head'],
  ['webhook_sweep',        o => o.op === 'list' && o.key === 'webhook-queue:'],
  ['security_check',       o => o.op === 'put' && o.key === 'meta:security-check:latest'],
  ['uptime_probe',         o => o.op === 'put' && o.key.startsWith('uptime:probe:')],
];

function classify(o) {
  for (const [name, m] of SIGNATURES) { if (m(o)) return name; }
  return null;
}

// ---------------------------------------------------------------- env
function makeEnv(tap, kvOpts) {
  const docs = makeKV(tap, kvOpts);
  return {
    CYBERSYGN_DOCS: docs,
    CYBERSYGN_PDFS: makeKV(null),
    CYBERSYGN_BACKUPS: makeR2(tap),
    CYBERSYGN_APP_URL: 'https://example.invalid',
    OWNER_EMAIL: 'owner@example.invalid',
    // RESEND_API_KEY deliberately UNSET -> email.js console branch, no network.
    ASSETS: { fetch: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
  };
}

function makeCtx(collected) {
  return {
    waitUntil(p) { collected.push(Promise.resolve(p).then(() => null, e => e)); },
    passThroughOnException() {},
  };
}

// ---------------------------------------------------------------- runner
const { default: worker } = await import('../worker/src/index.js');

async function tick(env, scheduledTime, { swallow = true } = {}) {
  setNow(scheduledTime);
  const promises = [];
  const ctx = makeCtx(promises);
  let syncError = null;
  try {
    await worker.scheduled({ scheduledTime, cron: '0 * * * *' }, env, ctx);
  } catch (e) { syncError = e; if (!swallow) throw e; }
  const results = await Promise.all(promises);
  return { syncError, jobErrors: results.filter(Boolean) };
}

const HOUR = 3600 * 1000;

// ================================================================ TEST 1
// A full simulated year of hourly ticks: exact fire count per job.
async function test1_yearOfTicks(year, label) {
  const counts = Object.create(null);
  const seen = new Set();
  let dupWarnings = [];
  const tap = (o) => {
    const j = classify(o);
    if (j) { counts[j] = (counts[j] || 0) + 1; }
  };
  const env = makeEnv(tap);
  const start = RealDate.UTC(year, 0, 1, 0, 0, 0);
  const end = RealDate.UTC(year + 1, 0, 1, 0, 0, 0);
  const ticks = (end - start) / HOUR;
  let sinkErrors = [];
  for (let t = start; t < end; t += HOUR) {
    const r = await tick(env, t);
    if (r.syncError) sinkErrors.push({ t, e: String(r.syncError.message) });
    for (const e of r.jobErrors) sinkErrors.push({ t, e: String(e && e.message) });
  }
  return { label, year, ticks, counts, sinkErrors };
}

// ================================================================ TEST 2
// DST: the Denver-gated security check across both 2026 transitions.
async function test2_dst() {
  const out = {};
  for (const [name, from, to] of [
    ['spring_forward_2026_03_08', RealDate.UTC(2026, 2, 6), RealDate.UTC(2026, 2, 11)],
    ['fall_back_2026_11_01',      RealDate.UTC(2026, 9, 30), RealDate.UTC(2026, 10, 4)],
  ]) {
    const perDenverDay = Object.create(null);
    const tap = (o) => {
      if (classify(o) === 'security_check') {
        const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(SIM_NOW));
        perDenverDay[d] = (perDenverDay[d] || 0) + 1;
      }
    };
    const env = makeEnv(tap);
    for (let t = from; t < to; t += HOUR) await tick(env, t);
    out[name] = perDenverDay;
  }
  return out;
}

// ================================================================ TEST 3
// at-most-once guard in ambassador-email.js under duplicate fires + flaky KV.
async function test3_guards() {
  const amb = await import('../worker/src/ambassador-email.js');
  const results = {};

  // 3a. duplicate SEQUENTIAL fire -> must send once.
  {
    const env = makeEnv(null);
    const sends = [];
    const r1 = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w10', sales: 2, earned: 20, dashUrl: 'u' });
    const r2 = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w10', sales: 2, earned: 20, dashUrl: 'u' });
    results.sequential_duplicate = { first: r1.delivered, second: r2.delivered, secondReason: r2.reason };
  }

  // 3b. CONCURRENT duplicate fire (two cron invocations racing) -> must send once.
  {
    const env = makeEnv(null);
    const [r1, r2] = await Promise.all([
      amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w10', sales: 2, earned: 20, dashUrl: 'u' }),
      amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w10', sales: 2, earned: 20, dashUrl: 'u' }),
    ]);
    results.concurrent_duplicate = { first: r1.delivered, second: r2.delivered, bothSent: !!(r1.delivered && r2.delivered) };
  }

  // 3c. KV get FAILS -> must NOT send.
  {
    const env = makeEnv(null, { fail: (op, key) => op === 'get' && String(key).startsWith('ambmail:') });
    const r = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w11', sales: 1, earned: 5, dashUrl: 'u' });
    results.kv_get_fails = { delivered: r.delivered, reason: r.reason };
  }

  // 3d. KV put FAILS (get works, claim write fails) -> must NOT send.
  {
    const env = makeEnv(null, { fail: (op, key) => op === 'put' && String(key).startsWith('ambmail:') });
    const r = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w12', sales: 1, earned: 5, dashUrl: 'u' });
    results.kv_put_fails = { delivered: r.delivered, reason: r.reason };
  }

  // 3e. NO KV BINDING -> claimGuard returns true; duplicate fires both send.
  {
    const env = { CYBERSYGN_APP_URL: 'https://example.invalid' };
    const r1 = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w13', sales: 1, earned: 5, dashUrl: 'u' });
    const r2 = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'abc', weekKey: '2026-w13', sales: 1, earned: 5, dashUrl: 'u' });
    results.no_kv_binding = { first: r1.delivered, second: r2.delivered, bothSent: !!(r1.delivered && r2.delivered) };
  }

  // 3f. owner TEST send (redirectTo) must not burn the real weekly guard.
  {
    const env = makeEnv(null);
    const test = await amb.sendWeeklyDigest(env, { to: 'owner@example.invalid', code: 'abc', weekKey: '2026-w20', sales: 1, earned: 5, dashUrl: 'u' });
    const real = await amb.sendWeeklyDigest(env, { to: 'real@x.invalid', code: 'abc', weekKey: '2026-w20', sales: 1, earned: 5, dashUrl: 'u' });
    results.weekly_test_burns_real_guard = { testSend: test.delivered, realSendAfter: real.delivered, realReason: real.reason };
  }

  // 3g. monthly redirect mode: recipient must ALWAYS be the redirect target.
  {
    const env = makeEnv(null);
    const seen = [];
    const prev = console.log;
    console.log = (...a) => { if (String(a[0]) === '[cybersygn:email:dev]') seen.push(JSON.parse(a[1])); };
    await amb.sendMonthlyScoreboard(env, { to: 'realambassador@x.invalid', redirectTo: 'owner@example.invalid', code: 'abc', monthKey: '2026-07', clicks: 1, sales: 0, earned: 0, earnedYtd: 0, dashUrl: 'u', shareUrl: 's' });
    console.log = prev;
    results.monthly_redirect_recipient = seen.map(s => s.to);
  }

  return results;
}

// ================================================================ TEST 4
// Failure isolation: make each job's first KV touch throw, in turn, and verify
// the OTHER jobs still ran on that same tick.
async function test4_isolation() {
  // A tick where every job is due: Jan 1 (1st), Monday, hour picked per job.
  // 2029-01-01 is a Monday. Use each due hour and poison one job at a time.
  const POISON = {
    reminder_sweep:       (op, key) => key === 'index:active',
    monthly_owner_report: (op, key) => String(key).startsWith('meta:monthly-report:'),
    drip_campaign:        (op, key) => String(key).startsWith('meta:drip-lock:'),
    ambassador_sweep:     (op, key) => key === 'affiliate:code:',
    webhook_sweep:        (op, key) => key === 'webhook-queue:',
    uptime_probe:         (op, key) => String(key).startsWith('uptime:probe:'),
    security_check:       (op, key) => key === 'meta:security-check:latest',
  };
  const HOURS = { 0: 'monthly+ambassador-monthly', 3: 'kv-backup', 14: 'drip', 15: 'ambassador-weekly' };
  const out = {};
  for (const [victim, pred] of Object.entries(POISON)) {
    const counts = Object.create(null);
    const tap = (o) => { const j = classify(o); if (j) counts[j] = (counts[j] || 0) + 1; };
    const env = makeEnv(tap, { fail: pred });
    // run every due hour of 2029-01-01 (Monday, 1st of month)
    for (const h of [0, 3, 14, 15]) {
      await tick(env, RealDate.UTC(2029, 0, 1, h));
    }
    out[victim] = counts;
  }
  return out;
}

// ================================================================ TEST 5
// Month/year boundaries + leap year.
async function test5_boundaries() {
  const out = {};
  // Leap year 2028: full year fire counts.
  out.leap_2028 = (await test1_yearOfTicks(2028, 'leap')).counts;
  // Dec 31 -> Jan 1 rollover: monthly must fire exactly once.
  {
    let fires = [];
    const tap = (o) => { if (classify(o) === 'monthly_owner_report') fires.push(new RealDate(SIM_NOW).toISOString()); };
    const env = makeEnv(tap);
    for (let t = RealDate.UTC(2026, 11, 30); t < RealDate.UTC(2027, 0, 3); t += HOUR) await tick(env, t);
    out.year_rollover_monthly_fires = fires;
  }
  // Feb 28/29 rollover in a leap year and a non-leap year.
  for (const [name, y] of [['feb_2028_leap', 2028], ['feb_2027_common', 2027]]) {
    let fires = [];
    const tap = (o) => { if (classify(o) === 'monthly_owner_report') fires.push(new RealDate(SIM_NOW).toISOString()); };
    const env = makeEnv(tap);
    for (let t = RealDate.UTC(y, 1, 26); t < RealDate.UTC(y, 2, 3); t += HOUR) await tick(env, t);
    out[name] = fires;
  }
  return out;
}

// ================================================================ TEST 6
// Drip campaign fan-out: PER_RUN_CAP counts SCANNED keys, not SENT.
async function test6_dripCap() {
  const { runDripCampaign } = await import('../worker/src/drip-campaign.js');
  const env = makeEnv(null);
  const kv = env.CYBERSYGN_DOCS;
  // 400 old signups (all three stages long since marked sent) + 1 brand-new
  // signup due for day 1, whose hash sorts LAST.
  const oldCreated = new RealDate(RealDate.UTC(2020, 0, 1)).toISOString();
  for (let i = 0; i < 400; i++) {
    const h = String(i).padStart(4, '0');
    await kv.put(`drip:0${h}`, JSON.stringify({ email: `old${i}@x.invalid`, createdAt: oldCreated }));
    await kv.put(`drip-sent:0${h}:7`, 'x');
  }
  await kv.put('drip:zzzz-new', JSON.stringify({ email: 'brandnew@x.invalid', createdAt: new RealDate(RealDate.UTC(2026, 5, 1)).toISOString() }));
  setNow(RealDate.UTC(2026, 5, 3, 14));
  const r = await runDripCampaign(env, { scheduledTime: RealDate.UTC(2026, 5, 3, 14) });
  const newUserMarked = await kv.get('drip-sent:zzzz-new:1');
  return { scanned: r.scanned, day1Sent: r.day1Sent, totalDripRecords: 401, newSignupReached: !!newUserMarked, errors: r.errors };
}

// ================================================================ TEST 7
// Drip stage skipping when a sweep is missed.
async function test7_dripStageSkip() {
  const { runDripCampaign } = await import('../worker/src/drip-campaign.js');
  const env = makeEnv(null);
  const kv = env.CYBERSYGN_DOCS;
  const created = RealDate.UTC(2026, 5, 1, 12);
  await kv.put('drip:aaaa', JSON.stringify({ email: 'late@x.invalid', createdAt: new RealDate(created).toISOString() }));
  // Cron is down for 8 days; first sweep after recovery.
  const t = RealDate.UTC(2026, 5, 9, 14);
  setNow(t);
  const r = await runDripCampaign(env, { scheduledTime: t });
  const stages = [];
  for (const s of [1, 3, 7]) if (await kv.get(`drip-sent:aaaa:${s}`)) stages.push(s);
  // run the next 6 daily sweeps to see if it ever catches up
  for (let d = 1; d <= 6; d++) {
    const tt = t + d * 24 * HOUR;
    setNow(tt);
    await runDripCampaign(env, { scheduledTime: tt });
  }
  const stagesAfter = [];
  for (const s of [1, 3, 7]) if (await kv.get(`drip-sent:aaaa:${s}`)) stagesAfter.push(s);
  return { stagesAfterFirstSweep: stages, stagesAfterAWeekMore: stagesAfter, result: { day1: r.day1Sent, day3: r.day3Sent, day7: r.day7Sent } };
}

// ================================================================ TEST 8
// Drip day-lock is written BEFORE the sweep: a mid-sweep failure loses the day.
async function test8_dripLockPoison() {
  const { runDripCampaign } = await import('../worker/src/drip-campaign.js');
  let allowList = false;
  const env = makeEnv(null, { fail: (op, key) => op === 'list' && !allowList });
  const kv = env.CYBERSYGN_DOCS;
  await kv.put('drip:bbbb', JSON.stringify({ email: 'due@x.invalid', createdAt: new RealDate(RealDate.UTC(2026, 5, 1)).toISOString() }));
  const t = RealDate.UTC(2026, 5, 3, 14);
  setNow(t);
  const first = await runDripCampaign(env, { scheduledTime: t });
  allowList = true;                       // KV recovers one hour later
  const t2 = t + HOUR;
  setNow(t2);
  const second = await runDripCampaign(env, { scheduledTime: t2 });
  const sent = await kv.get('drip-sent:bbbb:1');
  return { firstRun: first, retryAfterRecovery: second, everSent: !!sent };
}

// ================================================================ main
const report = {};
REAL_ERR('running year 2026...');
report.year_2026 = await test1_yearOfTicks(2026, 'common');
REAL_ERR('running year 2027 (starts Friday)...');
report.year_2027 = await test1_yearOfTicks(2027, 'common');
REAL_ERR('running DST...');
report.dst = await test2_dst();
REAL_ERR('running guards...');
report.guards = await test3_guards();
REAL_ERR('running isolation...');
report.isolation = await test4_isolation();
REAL_ERR('running boundaries...');
report.boundaries = await test5_boundaries();
REAL_ERR('running drip cap...');
report.drip_cap = await test6_dripCap();
report.drip_stage_skip = await test7_dripStageSkip();
report.drip_lock_poison = await test8_dripLockPoison();
report.network_calls_attempted = NETWORK_CALLS.length;

loud();
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

// ================================================================ TEST 9
// Eventually-consistent KV (the real Cloudflare model: a put is not visible to
// a read in another colo for up to 60s). Two cron fires 30s apart.
async function test9_eventualConsistency() {
  quiet();
  const amb = await import('../worker/src/ambassador-email.js');
  const visible = new Map(); const pending = [];
  const kv = {
    async get(k) { const p = pending.find(p => p.k === k && p.at <= SIM_NOW); if (p) visible.set(k, p.v); return visible.has(k) ? visible.get(k) : null; },
    async put(k, v) { pending.push({ k, v, at: SIM_NOW + 60_000 }); },
    async delete() {}, async list() { return { keys: [], list_complete: true }; },
  };
  const env = { CYBERSYGN_DOCS: kv, CYBERSYGN_APP_URL: 'https://example.invalid' };
  setNow(RealDate.UTC(2026, 5, 1, 15, 0, 0));
  const a = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'ec', weekKey: '2026-w22', sales: 1, earned: 5, dashUrl: 'u' });
  setNow(RealDate.UTC(2026, 5, 1, 15, 0, 30));   // duplicate cron fire, +30s
  const b = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'ec', weekKey: '2026-w22', sales: 1, earned: 5, dashUrl: 'u' });
  setNow(RealDate.UTC(2026, 5, 1, 15, 2, 0));    // +2min, guard now visible
  const c = await amb.sendWeeklyDigest(env, { to: 'a@x.invalid', code: 'ec', weekKey: '2026-w22', sales: 1, earned: 5, dashUrl: 'u' });
  return { fire_t0: a.delivered, fire_t30s: b.delivered, fire_t2min: c.delivered, doubleSent: !!(a.delivered && b.delivered) };
}

// ================================================================ TEST 10
// Weekly digest arithmetic with a mid-week refund reversal.
async function test10_refundWeek() {
  const amb = await import('../worker/src/ambassador-email.js');
  const env = makeEnv(null);
  const kv = env.CYBERSYGN_DOCS;
  setNow(RealDate.UTC(2026, 5, 1, 15));
  await kv.put('affiliate:code:ref1', JSON.stringify({
    code: 'ref1', email: 'amb@x.invalid', status: 'active', conversions: 1,
    ledger: [
      { at: new RealDate(RealDate.UTC(2026, 4, 29)).toISOString(), type: 'bounty', amount: 5 },
      { at: new RealDate(RealDate.UTC(2026, 4, 30)).toISOString(), type: 'reversal', amount: -25 },
    ],
  }));
  const seen = []; const prev = console.log;
  console.log = (...a) => { if (String(a[0]) === '[cybersygn:email:dev]') seen.push(JSON.parse(a[1])); };
  const out = await amb.runWeeklyDigest(env, {});
  console.log = prev;
  return { out, subjects: seen.map(s => s.subject) };
}

report.eventual_consistency = await test9_eventualConsistency();
report.refund_week = await test10_refundWeek();
loud();
process.stdout.write(JSON.stringify({ eventual_consistency: report.eventual_consistency, refund_week: report.refund_week }, null, 2) + '\n');
