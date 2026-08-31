/**
 * Uptime tracking (slice 99).
 *
 * runUptimeProbe records one sample. Handed the in-process dispatcher
 * (index.js selfDispatch, the same one the security self-check uses,
 * because a Worker cannot fetch its own public hostname from
 * scheduled() without Cloudflare timing the self-subrequest out at
 * 522), it dispatches a real GET /api/health and records that verdict.
 * Without a dispatcher it degrades to a KV round trip, which proves
 * only that the binding answers, and the day record says which of the
 * two produced the sample.
 *
 * WHAT THIS NUMBER IS, EXACTLY. It is "when the cron ran, the worker
 * answered its own health endpoint", which covers the worker, its KV
 * binding, and its routing. It is NOT an outside-in measurement of
 * cybersygn.io: a DNS failure, an edge outage, a bad TLS cert, or a
 * deploy that never went live cannot be seen from in here, because the
 * same broken deploy is not running this probe either. Nothing that
 * renders this number may call it third-party or external monitoring.
 *
 * The window is readable at GET /api/status/uptime. As of today no page
 * renders it; the /status/ page shows live subsystem state from
 * /api/status instead.
 *
 * Storage shape:
 *   uptime:day:YYYY-MM-DD   →   { date, ok, fail, lastProbeAt, lastProbeVia }
 *
 * KV writes are idempotent, each day's record updates in place as the
 * day's probes accumulate.
 */

const KEY_PREFIX = 'uptime:day:';
const RETAIN_DAYS = 60;  // store more than we display so we have window flexibility

/**
 * Record a single probe sample for the current UTC day. Called from
 * the scheduled handler each run.
 */
export async function recordUptimeProbe(env, isOk, meta = {}) {
  if (!env || !env.CYBERSYGN_DOCS) return;
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const k = KEY_PREFIX + dayKey;
  let rec = null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(k);
    if (raw) rec = JSON.parse(raw);
  } catch (e) {}
  if (!rec || typeof rec !== 'object') {
    rec = { date: dayKey, ok: 0, fail: 0, lastProbeAt: null };
  }
  if (isOk) rec.ok = (rec.ok || 0) + 1;
  else      rec.fail = (rec.fail || 0) + 1;
  rec.lastProbeAt = now.toISOString();
  // Which probe produced the day's most recent sample, so a day measured by
  // the weaker KV fallback is not silently reported as a health-check day.
  if (meta && meta.via) rec.lastProbeVia = meta.via;
  try {
    await env.CYBERSYGN_DOCS.put(k, JSON.stringify(rec), {
      expirationTtl: 60 * 60 * 24 * RETAIN_DAYS,
    });
  } catch (e) { /* tolerated */ }
}

/**
 * Run one probe and record it. Pass `dispatch` (index.js selfDispatch) to
 * measure the real GET /api/health handler; without one this degrades to a KV
 * round trip, which only proves the binding answers.
 *
 * Returns { ok, via, status } so the caller can log what was actually measured.
 */
export async function runUptimeProbe(env, { dispatch, origin } = {}) {
  const base = (origin || (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io').replace(/\/$/, '');
  let ok = false;
  let via = 'kv';
  let status = null;

  if (typeof dispatch === 'function') {
    via = 'health';
    try {
      const res = await dispatch(new Request(`${base}/api/health`, {
        method: 'GET',
        headers: { 'user-agent': 'cybersygn-uptime-probe' },
      }));
      status = res ? res.status : null;
      // handleHealth answers 200 when KV round-trips and 503 when it does not.
      ok = status === 200;
    } catch (e) {
      ok = false;
    }
  } else {
    try {
      if (env && env.CYBERSYGN_DOCS) {
        const probeKey = `uptime:probe:${Date.now()}`;
        await env.CYBERSYGN_DOCS.put(probeKey, '1', { expirationTtl: 60 });
        ok = (await env.CYBERSYGN_DOCS.get(probeKey)) === '1';
      }
    } catch (e) { ok = false; }
  }

  await recordUptimeProbe(env, ok, { via });
  return { ok, via, status };
}

/**
 * Read the last N days of uptime records and compute the headline
 * uptime percentage + per-day records.
 *
 * Returns:
 *   { windowDays, uptimePct, daysOk, daysDegraded, days: [{date, ok, fail, status}] }
 */
export async function readUptimeWindow(env, windowDays = 30) {
  const days = [];
  if (!env || !env.CYBERSYGN_DOCS) {
    /* No data source is "unknown", not "perfect". Asserting 100% here put a
       fabricated headline uptime on the public status page whenever the KV
       binding was absent (misconfig, stripped env, preview deploy). Match the
       empty-KV branch below and report null so the page renders "no data". */
    return { windowDays, uptimePct: null, daysOk: 0, daysDegraded: 0, days };
  }
  const now = new Date();
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    try {
      const raw = await env.CYBERSYGN_DOCS.get(KEY_PREFIX + dayKey);
      if (raw) {
        const rec = JSON.parse(raw);
        const total = (rec.ok || 0) + (rec.fail || 0);
        let status = 'unknown';
        if (total > 0) {
          const pct = (rec.ok || 0) / total;
          if (pct >= 0.99) status = 'ok';
          else if (pct >= 0.90) status = 'degraded';
          else status = 'down';
        }
        days.push({ date: dayKey, ok: rec.ok || 0, fail: rec.fail || 0, status });
      } else {
        days.push({ date: dayKey, ok: 0, fail: 0, status: 'unknown' });
      }
    } catch (e) {
      days.push({ date: dayKey, ok: 0, fail: 0, status: 'unknown' });
    }
  }
  const knownDays = days.filter(d => d.status !== 'unknown');
  const daysOk = days.filter(d => d.status === 'ok').length;
  const daysDegraded = days.filter(d => d.status === 'degraded' || d.status === 'down').length;
  // Uptime = sum(ok probes) / sum(total probes) across the window. Days
  // with no data are excluded from the denominator.
  let totalOk = 0, total = 0;
  for (const d of knownDays) { totalOk += d.ok; total += d.ok + d.fail; }
  const uptimePct = total > 0 ? (totalOk / total) * 100 : null;
  return { windowDays, uptimePct, daysOk, daysDegraded, days };
}
