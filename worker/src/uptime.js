/**
 * Real uptime tracking (slice 99).
 *
 * The cron handler probes /api/health every run, records pass/fail in a
 * compact KV blob keyed by day. The /status/ page fetches a 30-day
 * window via GET /api/status/uptime and renders the actual measured
 * record instead of hardcoded values.
 *
 * Storage shape:
 *   uptime:day:YYYY-MM-DD   →   { date, ok, fail, lastProbeAt }
 *
 * The probe is internal (the worker calls its own /api/health), so it
 * costs zero outbound bandwidth and zero auth. KV writes are
 * idempotent — each day's record updates in place as the day's probes
 * accumulate.
 */

const KEY_PREFIX = 'uptime:day:';
const RETAIN_DAYS = 60;  // store more than we display so we have window flexibility

/**
 * Record a single probe sample for the current UTC day. Called from
 * the scheduled handler each run.
 */
export async function recordUptimeProbe(env, isOk) {
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
  try {
    await env.CYBERSYGN_DOCS.put(k, JSON.stringify(rec), {
      expirationTtl: 60 * 60 * 24 * RETAIN_DAYS,
    });
  } catch (e) { /* tolerated */ }
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
    return { windowDays, uptimePct: 100, daysOk: 0, daysDegraded: 0, days };
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
