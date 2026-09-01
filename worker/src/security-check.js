/**
 * Automated security self-check.
 *
 * Runs twice daily from the hourly cron in index.js scheduled(), gated to
 * 12:00 and 00:00 UTC, which is 06:00 and 18:00 America/Denver during MDT
 * (UTC-6). It verifies deployment posture in three ways:
 *
 *   1. Config / secrets, the critical secrets are set, Stripe is a LIVE key,
 *                           owner login is configured, the dev backdoor is closed.
 *   2. KV reachability, the doc store answers.
 *   3. Live auth behavior, self-probes the running site: protected endpoints
 *                            must reject unauthenticated callers (401/403), and
 *                            responses must carry the baseline security headers.
 *
 * The result is stored at meta:security-check:latest (readable by the owner
 * panel via GET /api/owner/security-check) and the owner is emailed ONLY when a
 * check fails, a green run is silent, so there is no twice-daily inbox noise.
 *
 * Every branch is wrapped so this can never throw into the cron handler.
 */

import { getStorage } from './storage.js';
import { deliver } from './email.js';
import { KNOWN_DEV_OWNER_HASH } from './owner.js';

const RESULT_KEY = 'meta:security-check:latest';

/**
 * @param {object} env
 * @param {{ origin?: string, trigger?: string }} [opts]
 * @returns {Promise<object>} the result record
 */
export async function runSecurityCheck(env, opts = {}) {
  const checks = [];
  const add = (name, pass, detail = '', severity = 'high', advisory = false) =>
    checks.push({ name, pass: !!pass, detail, severity, advisory });

  const has = (k) => typeof (env && env[k]) === 'string' && env[k].length > 0;

  // ---- 1. config / secrets --------------------------------------------------
  add('stripe_secret_set', has('STRIPE_SECRET_KEY'), 'STRIPE_SECRET_KEY missing', 'critical');
  add('stripe_secret_is_live',
    !has('STRIPE_SECRET_KEY') || env.STRIPE_SECRET_KEY.startsWith('sk_live'),
    'a TEST Stripe key is deployed to production', 'critical');
  add('stripe_webhook_secret_set', has('STRIPE_WEBHOOK_SECRET'),
    'STRIPE_WEBHOOK_SECRET missing, webhooks cannot be verified', 'critical');
  add('resend_key_set', has('RESEND_API_KEY'), 'RESEND_API_KEY missing, email disabled', 'medium');

  let ownerConfigured = has('OWNER_USERNAME') && has('OWNER_PASSWORD_HASH');
  if (!ownerConfigured) {
    try {
      const raw = await getStorage(env).docs.get('owner:cred');
      ownerConfigured = !!(raw && JSON.parse(raw).hash);
    } catch { /* leave false */ }
  }
  add('owner_login_configured', ownerConfigured,
    'owner login not configured (no username/hash and no KV credential)', 'critical');
  // The owner hash must be present, a well-formed 64-hex SHA-256, AND not the
  // world-readable dev value. A malformed secret now fails CLOSED in owner.js,
  // but this still catches an operator who set it to the wrong shape or to the
  // published dev hash (the repo is public), which would leave owner unusable
  // or trivially claimable respectively.
  const ownerHashRaw = (env && typeof env.CYBERSYGN_OWNER_HASH === 'string') ? env.CYBERSYGN_OWNER_HASH.trim().toLowerCase() : '';
  const ownerHashValid = /^[a-f0-9]{64}$/.test(ownerHashRaw) && ownerHashRaw !== KNOWN_DEV_OWNER_HASH;
  add('owner_backdoor_closed', ownerHashValid,
    !ownerHashRaw ? 'CYBERSYGN_OWNER_HASH unset, owner claim disabled (fail-closed)'
      : ownerHashRaw === KNOWN_DEV_OWNER_HASH ? 'CYBERSYGN_OWNER_HASH is the PUBLIC dev value, rotate immediately'
      : 'CYBERSYGN_OWNER_HASH is not a valid 64-hex SHA-256', 'critical');

  // ---- 1b. Configuration that is legally or operationally required ---------
  //
  // These were invisible. Four secrets were unset for the entire build and
  // nothing anywhere said so, which is the same silence problem as a test that
  // does not run: the capability is simply absent and the system looks fine.
  //
  // CAN-SPAM is the one with legal teeth. 15 U.S.C. 7704(a)(5) requires a valid
  // physical postal address in every commercial email. email-html.js renders one
  // ONLY when CYBERSYGN_BUSINESS_ADDRESS is set, so with it unset every drip and
  // marketing email that goes out is non-compliant. That is a real exposure, not
  // a nice-to-have, so it is flagged critical rather than left to a punch list.
  add('can_spam_address_set', has('CYBERSYGN_BUSINESS_ADDRESS'),
    'CYBERSYGN_BUSINESS_ADDRESS unset: commercial email ships with no physical postal address, which CAN-SPAM requires', 'critical', true);

  // Observability. Without a DSN an uncaught worker error reaches console.error
  // and nothing else, so a production failure is invisible to the one person
  // running this. Not a security hole, but the reason a security hole would go
  // unnoticed.
  add('error_reporting_configured', has('SENTRY_DSN'),
    'SENTRY_DSN unset: uncaught worker errors are not reported anywhere a human will see them', 'medium', true);

  // Measurement. Both are the difference between knowing and guessing whether
  // anyone is using the product.
  add('analytics_configured', has('CYBERSYGN_GA4_ID'),
    'CYBERSYGN_GA4_ID unset: no analytics beyond first-party counters', 'low', true);
  add('search_console_configured', has('CYBERSYGN_GSC_TOKEN'),
    'CYBERSYGN_GSC_TOKEN unset: Search Console unverified, so indexing problems are invisible', 'low', true);

  // ---- 2. KV reachability ---------------------------------------------------
  let kvOk = false;
  try { await getStorage(env).docs.get(RESULT_KEY); kvOk = true; } catch { /* fail */ }
  add('kv_reachable', kvOk, 'CYBERSYGN_DOCS did not answer', 'high');

  // ---- 3. live auth behavior (self-probe) -----------------------------------
  // Dispatch in-process when a handler is supplied (opts.dispatch). A Worker
  // cannot fetch its own public hostname from a scheduled() or request
  // context: the self-subrequest re-enters the same zone and Cloudflare
  // times it out (HTTP 522), which used to fail every probe at once. The
  // in-process dispatcher runs the identical routing + auth + headers with
  // no network hop. Network fetch remains the fallback for callers (tests,
  // external monitors) that pass no dispatcher.
  const base = (opts.origin || (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io').replace(/\/$/, '');
  const send = typeof opts.dispatch === 'function' ? opts.dispatch : (req) => fetch(req);
  await probe(add, send, 'v1_requires_key', `${base}/api/v1/me`, { expect: [401] });
  await probe(add, send, 'v1_create_requires_key', `${base}/api/v1/documents`, { method: 'POST', body: '{}', expect: [401] });
  await probe(add, send, 'owner_apikeys_requires_auth', `${base}/api/owner/apikeys`, { method: 'POST', body: '{}', expect: [401, 403] });
  await probe(add, send, 'owner_metrics_requires_auth', `${base}/api/owner/metrics/dashboard`, { expect: [401, 403] });
  await probe(add, send, 'health_responds', `${base}/api/health`, { belowServerError: true });
  await probeHeaders(add, send, `${base}/`);

  // SECURITY failures versus CONFIGURATION advisories.
  //
  // The four config checks report things that are OFF and need an account
  // action (a GA4 property, a Sentry project, a postal address). They can never
  // pass on their own, so counting them as failures would make the twice-daily
  // alert fire forever and bury a real security regression in noise. The
  // contract this file documents, "a passing run sends no email", only means
  // something if a passing run is reachable.
  //
  // Advisories are still recorded, still returned, and still shown in the owner
  // panel. They just do not page anyone twice a day about a decision already
  // made.
  const failures = checks.filter((c) => !c.pass && !c.advisory);
  const advisories = checks.filter((c) => !c.pass && c.advisory);
  const result = {
    ranAt: new Date().toISOString(),
    trigger: opts.trigger || 'cron',
    ok: failures.length === 0,
    passed: checks.length - failures.length,
    total: checks.length,
    failures: failures.map((f) => ({ name: f.name, detail: f.detail, severity: f.severity })),
    advisories: advisories.map((f) => ({ name: f.name, detail: f.detail, severity: f.severity })),
    checks,
  };

  // persist latest (40-day TTL so a stale record self-expires)
  try {
    await getStorage(env).docs.put(RESULT_KEY, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 40 });
  } catch { /* non-fatal */ }

  // alert owner ONLY on failure
  if (!result.ok) {
    const to = (env && (env.OWNER_EMAIL || env.CYBERSYGN_OWNER_EMAIL)) || null;
    if (to) {
      const lines = result.failures
        .map((f) => `- [${f.severity}] ${f.name}${f.detail ? ': ' + f.detail : ''}`)
        .join('\n');
      const advLines = result.advisories.length
        ? `\n\nAlso unconfigured (these do not trigger this email):\n` + result.advisories
            .map((f) => `- [${f.severity}] ${f.name}${f.detail ? ': ' + f.detail : ''}`).join('\n')
        : '';
      try {
        await deliver(env, {
          to,
          subject: `CyberSygn security check: ${result.failures.length} issue(s)`,
          text: `The twice-daily security self-check found issues at ${result.ranAt}:\n\n${lines}${advLines}\n\nFull report: ${base}/control/\n\nThis is automated; a passing run sends no email.`,
        });
      } catch { /* email best-effort */ }
    }
  }
  return result;
}

/** Read the last stored result (for the owner panel / on-demand endpoint). */
export async function getLatestSecurityCheck(env) {
  try {
    const raw = await getStorage(env).docs.get(RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---- helpers ---------------------------------------------------------------

async function probe(add, send, name, url, opts = {}) {
  try {
    const req = new Request(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body,
      redirect: 'manual',
    });
    const res = await send(req);
    if (opts.belowServerError) {
      add(name, res.status < 500, `HTTP ${res.status}`, 'medium');
      return;
    }
    add(name, opts.expect.includes(res.status), `HTTP ${res.status} (expected ${opts.expect.join('/')})`);
  } catch (e) {
    add(name, false, 'probe failed: ' + (e && e.message ? e.message : String(e)));
  }
}

async function probeHeaders(add, send, url) {
  try {
    const res = await send(new Request(url, { redirect: 'manual' }));
    const h = res.headers;
    add('header_nosniff', (h.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
      'X-Content-Type-Options: nosniff missing', 'medium');
    add('header_frame_protect',
      !!(h.get('x-frame-options') || (h.get('content-security-policy') || '').includes('frame-ancestors')),
      'no X-Frame-Options / CSP frame-ancestors (clickjacking)', 'medium');
    add('header_referrer_policy', !!h.get('referrer-policy'),
      'Referrer-Policy missing', 'low');
  } catch (e) {
    add('header_probe', false, String(e && e.message ? e.message : e), 'medium');
  }
}
