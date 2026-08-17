/**
 * Funnel instrument tests (worker/src/events.js).
 *
 * Plain node asserts with an in-memory KV mock, same pattern as
 * scripts/test-payout.mjs. Covers:
 *  - the 11-name whitelist (unknown names dropped with 204, no writes)
 *  - lifetime + dated-bucket counter increments
 *  - day bucketing under the UTC date stamp
 *  - getFunnel shape (absent keys read as honest zeros)
 *  - crawler classification (Googlebot, an AI crawler from robots.txt,
 *    and a normal browser that must count nothing)
 *  - handleEvent never throwing, even for garbage input
 *  - the per-IP rate limit dropping silently (204, never 4xx)
 *  - handleOwnerFunnel auth gate + row shape
 */
import assert from 'node:assert/strict';
import {
  handleEvent, getFunnel, countCrawler, classifyCrawler,
  handleOwnerFunnel, CANONICAL_EVENTS, COUNTING_SINCE,
} from '../worker/src/events.js';

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push(`OK   ${name}`); }
  catch (e) { fail++; results.push(`FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
}

/** In-memory KV + Analytics Engine mock. */
function makeEnv(seed = {}) {
  const kv = new Map(Object.entries(seed));
  const points = [];
  return {
    _kv: kv,
    _points: points,
    CYBERSYGN_DOCS: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
      list: async () => ({ keys: [...kv.keys()].map((name) => ({ name })), list_complete: true }),
    },
    CYBERSYGN_EVENTS: {
      writeDataPoint: (p) => { points.push(p); },
    },
  };
}

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot';

function req(body, { ip = '203.0.113.7', ua = UA_BROWSER } = {}) {
  return new Request('https://cybersygn.io/api/e', {
    method: 'POST',
    body,
    headers: { 'content-type': 'text/plain', 'user-agent': ua, 'cf-connecting-ip': ip },
  });
}

const today = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- whitelist
await t('there are exactly 11 canonical events, in funnel order', () => {
  assert.equal(CANONICAL_EVENTS.length, 11);
  assert.equal(CANONICAL_EVENTS[0], 'app_open');
  assert.equal(CANONICAL_EVENTS[10], 'cert_verified');
});

await t('a canonical event returns 204 and increments both counters', async () => {
  const env = makeEnv();
  const res = await handleEvent(req(JSON.stringify({ e: 'app_open' })), env);
  assert.equal(res.status, 204);
  assert.equal(env._kv.get('e:life:app_open'), '1');
  assert.equal(env._kv.get(`e:day:${today}:app_open`), '1');
});

await t('an unknown event name is dropped with 204 and writes nothing', async () => {
  const env = makeEnv();
  const res = await handleEvent(req(JSON.stringify({ e: 'signup_completed' })), env);
  assert.equal(res.status, 204, 'reject quietly, never 4xx noise');
  const eventKeys = [...env._kv.keys()].filter((k) => k.startsWith('e:'));
  assert.deepEqual(eventKeys, [], 'no counter may be written for a non-canonical name');
  assert.equal(env._points.length, 0, 'no Analytics Engine point either');
});

// ---------------------------------------------------------------- increments
await t('repeat events accumulate: 3 hits reads back as 3', async () => {
  const env = makeEnv();
  for (let i = 0; i < 3; i++) await handleEvent(req(JSON.stringify({ e: 'pdf_loaded', p: { source: 'upload' } })), env);
  assert.equal(env._kv.get('e:life:pdf_loaded'), '3');
  assert.equal(env._kv.get(`e:day:${today}:pdf_loaded`), '3');
});

await t('the dated bucket uses the UTC YYYY-MM-DD stamp', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'doc_created' })), env);
  const dayKeys = [...env._kv.keys()].filter((k) => k.startsWith('e:day:'));
  assert.equal(dayKeys.length, 1);
  assert.match(dayKeys[0], /^e:day:\d{4}-\d{2}-\d{2}:doc_created$/);
  assert.equal(dayKeys[0], `e:day:${today}:doc_created`);
});

await t('detect_done {count} lands in the Analytics Engine value double', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'detect_done', p: { count: 7 } })), env);
  assert.equal(env._points.length, 1);
  assert.equal(env._points[0].blobs[0], 'detect_done');
  assert.equal(env._points[0].doubles[0], 7);
});

// ---------------------------------------------------------------- getFunnel
await t('getFunnel returns the full shape with honest zeros for absent keys', async () => {
  const env = makeEnv({ 'e:life:app_open': '5', [`e:day:${today}:app_open`]: '2' });
  const f = await getFunnel(env, 7);
  assert.equal(f.since, COUNTING_SINCE);
  assert.equal(f.days, 7);
  assert.deepEqual(Object.keys(f.lifetime).sort(), [...CANONICAL_EVENTS].sort(), 'all 11 events, always');
  assert.equal(f.lifetime.app_open, 5);
  assert.equal(f.lifetime.cert_verified, 0, 'absent key is 0, never a placeholder');
  assert.equal(f.daily.length, 7);
  assert.equal(f.daily[0].date, today);
  assert.equal(f.daily[0].counts.app_open, 2);
  assert.equal(f.daily[1].counts.app_open, 0);
  assert.ok(f.crawlers && typeof f.crawlers.lifetime === 'object');
});

await t('getFunnel survives a missing KV binding with all zeros', async () => {
  const f = await getFunnel({}, 7);
  assert.equal(f.lifetime.app_open, 0);
  assert.equal(f.daily.length, 7);
});

// ---------------------------------------------------------------- crawlers
await t('a Googlebot UA is classified and counted', async () => {
  const env = makeEnv();
  const r = new Request('https://cybersygn.io/', { headers: { 'user-agent': UA_GOOGLEBOT } });
  const slug = await countCrawler(env, r);
  assert.equal(slug, 'googlebot');
  assert.equal(env._kv.get('e:life:crawler:googlebot'), '1');
  assert.equal(env._kv.get(`e:day:${today}:crawler:googlebot`), '1');
});

await t('an AI crawler from robots.txt (GPTBot) is counted', async () => {
  const env = makeEnv();
  const r = new Request('https://cybersygn.io/blog/', { headers: { 'user-agent': UA_GPTBOT } });
  const slug = await countCrawler(env, r);
  assert.equal(slug, 'gptbot');
  assert.equal(env._kv.get('e:life:crawler:gptbot'), '1');
});

await t('a normal browser UA counts nothing', async () => {
  const env = makeEnv();
  const r = new Request('https://cybersygn.io/', { headers: { 'user-agent': UA_BROWSER } });
  const slug = await countCrawler(env, r);
  assert.equal(slug, null);
  const crawlerKeys = [...env._kv.keys()].filter((k) => k.includes('crawler'));
  assert.deepEqual(crawlerKeys, []);
});

await t('classifyCrawler covers ClaudeBot vs Claude-Web distinctly', () => {
  assert.equal(classifyCrawler('Mozilla/5.0; ClaudeBot/1.0; +claudebot@anthropic.com'), 'claudebot');
  assert.equal(classifyCrawler('Mozilla/5.0 (compatible; Claude-Web/1.0)'), 'claude-web');
  assert.equal(classifyCrawler(''), null);
  assert.equal(classifyCrawler(null), null);
});

await t('countCrawler never throws, even with a broken request', async () => {
  const env = makeEnv();
  assert.equal(await countCrawler(env, null), null);
  assert.equal(await countCrawler(env, {}), null);
  assert.equal(await countCrawler(null, null), null);
});

// ---------------------------------------------------------------- resilience
await t('handleEvent never throws and always 204s on garbage input', async () => {
  const env = makeEnv();
  const garbage = [
    '', 'not json at all', '{"e":', '42', 'null', '[]', '"app_open"',
    JSON.stringify({ nope: true }), JSON.stringify({ e: 42 }),
    JSON.stringify({ e: 'app_open', p: 'not-an-object' }),
    JSON.stringify({ e: 'app_open', p: [1, 2, 3] }),
  ];
  for (const body of garbage) {
    const res = await handleEvent(req(body), env);
    assert.equal(res.status, 204, `body ${JSON.stringify(body).slice(0, 30)} must 204`);
  }
  // The two structurally-valid app_open payloads above still count.
  assert.equal(env._kv.get('e:life:app_open'), '2');
});

await t('handleEvent 204s even when request.text() itself throws', async () => {
  const env = makeEnv();
  const broken = { text: async () => { throw new Error('boom'); }, headers: new Headers() };
  const res = await handleEvent(broken, env);
  assert.equal(res.status, 204);
});

await t('handleEvent 204s with no KV and no Analytics binding at all', async () => {
  const res = await handleEvent(req(JSON.stringify({ e: 'app_open' })), {});
  assert.equal(res.status, 204);
});

await t('the per-IP rate limit drops silently: all 204, cap enforced', async () => {
  const env = makeEnv();
  for (let i = 0; i < 130; i++) {
    const res = await handleEvent(req(JSON.stringify({ e: 'sign_link_opened' }), { ip: '198.51.100.9' }), env);
    assert.equal(res.status, 204, 'a rate-limited event must still 204');
  }
  const counted = Number.parseInt(env._kv.get('e:life:sign_link_opened'), 10);
  assert.equal(counted, 120, 'the 120/min policy must cap the counter');
});

// ---------------------------------------------------------------- owner gate
const OWNER_TOKEN = 'a'.repeat(64);
function ownerSeed() {
  return { [`owner:token:${OWNER_TOKEN}`]: JSON.stringify({ role: 'owner', unmetered: true }) };
}
function ownerReq(token) {
  const headers = token ? { 'X-CyberSygn-Owner': token } : {};
  return new Request('https://cybersygn.io/api/owner/funnel', { headers });
}

await t('handleOwnerFunnel rejects a request with no owner token', async () => {
  const env = makeEnv(ownerSeed());
  const res = await handleOwnerFunnel(ownerReq(null), env, new URL('https://cybersygn.io/api/owner/funnel'));
  assert.equal(res.status, 401);
});

await t('handleOwnerFunnel returns 11 ordered rows + crawler rows for the owner', async () => {
  const env = makeEnv({
    ...ownerSeed(),
    'e:life:app_open': '9',
    [`e:day:${today}:app_open`]: '4',
    'e:life:crawler:googlebot': '3',
    [`e:day:${today}:crawler:googlebot`]: '3',
  });
  const res = await handleOwnerFunnel(ownerReq(OWNER_TOKEN), env, new URL('https://cybersygn.io/api/owner/funnel'));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.countingSince, COUNTING_SINCE);
  assert.equal(d.rows.length, 11);
  assert.deepEqual(d.rows.map((r) => r.name), [...CANONICAL_EVENTS], 'rows come back in funnel order');
  const open = d.rows[0];
  assert.equal(open.lifetime, 9);
  assert.equal(open.last7, 4);
  assert.equal(open.last30, 4);
  const zero = d.rows.find((r) => r.name === 'cert_verified');
  assert.deepEqual({ lifetime: zero.lifetime, last7: zero.last7, last30: zero.last30 }, { lifetime: 0, last7: 0, last30: 0 });
  assert.equal(d.crawlers.length, 1, 'only crawlers actually seen get a row');
  assert.equal(d.crawlers[0].name, 'googlebot');
  assert.equal(d.crawlers[0].lifetime, 3);
});

// ------------------------------------------------- bot + owner exclusion
// The permanent KV counters are the evidence base for the HANDOFF kill
// criteria ("10+ documents sent by humans who are not Nathan"). They are
// aggregates that can never be re-filtered after the fact, so bot and owner
// traffic has to be kept out at WRITE time or the number is worthless.

await t('crawler traffic never touches the permanent counters', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'doc_created' }), { ua: UA_GOOGLEBOT, ip: '203.0.113.21' }), env);
  await handleEvent(req(JSON.stringify({ e: 'doc_created' }), { ua: UA_GPTBOT, ip: '203.0.113.22' }), env);
  assert.equal(await env.CYBERSYGN_DOCS.get('e:life:doc_created'), null, 'a bot must not increment the human counter');
});

await t('a generic unnamed bot is excluded too', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'app_open' }), { ua: 'curl/8.4.0', ip: '203.0.113.23' }), env);
  await handleEvent(req(JSON.stringify({ e: 'app_open' }), { ua: 'some-random-spider/1.0', ip: '203.0.113.24' }), env);
  assert.equal(await env.CYBERSYGN_DOCS.get('e:life:app_open'), null);
});

await t('owner traffic is segregated, not mixed into the human count', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'doc_created', p: { tier: 'owner' } }), { ip: '203.0.113.25' }), env);
  await handleEvent(req(JSON.stringify({ e: 'doc_created', p: { tier: 'free' } }), { ip: '203.0.113.26' }), env);
  assert.equal(await env.CYBERSYGN_DOCS.get('e:life:doc_created'), '1', 'exactly one human doc_created');
  assert.equal(await env.CYBERSYGN_DOCS.get('e:life:owner:doc_created'), '1', 'owner counted separately');
});

await t('excluded traffic still reaches Analytics Engine', async () => {
  const env = makeEnv();
  await handleEvent(req(JSON.stringify({ e: 'app_open' }), { ua: UA_GOOGLEBOT, ip: '203.0.113.27' }), env);
  assert.equal(env._points.length, 1, 'AE keeps the full record; only the permanent counters are filtered');
});

console.log(results.join('\n'));
console.log(`\nfunnel instrument: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
