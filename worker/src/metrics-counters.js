/**
 * Rolling metrics counters.
 *
 * The /api/metrics endpoint used to answer every poll by scanning ALL
 * sub:* and doc:* keys with a GET per key. That is an N+1 that grows
 * with lifetime doc volume and eventually trips the 1000-subrequest
 * limit. Instead, counts are maintained AT WRITE TIME:
 *
 *   metrics:day:<YYYY-MM-DD>   { sent, completed }  bumped on doc
 *                              creation / completion; read by summing
 *                              the days in the requested window (one
 *                              GET per day, max 92).
 *   metrics:subs               { [senderId]: { tier, status } } updated
 *                              alongside every sub:<senderId> write; one
 *                              GET answers operators + MRR.
 *
 * Both migrate lazily: the first /api/metrics call after deploy seeds
 * the registry and day buckets from one final legacy scan, then never
 * scans again.
 *
 * KV has no atomic increment, so concurrent bumps can drop a count.
 * These are dashboard metrics, not billing; the occasional lost bump is
 * an accepted trade for O(1) reads. Every operation is guarded and
 * best-effort (CONSTITUTION 1.9).
 */

import { getStorage } from './storage.js';

const DAY_PREFIX = 'metrics:day:';
const SUBS_KEY = 'metrics:subs';
const BACKFILL_FLAG = 'meta:metrics-backfilled';
const SUBS_SEEDED_FLAG = 'meta:metrics-subs-seeded';
const DAY_TTL = 60 * 60 * 24 * 400; // window queries cap at 92 days
const MAX_WINDOW_DAYS = 92;

function dayKeyFor(ms) {
  return DAY_PREFIX + new Date(ms).toISOString().slice(0, 10);
}

/** Bump today's counter. kind: 'sent' | 'completed'. Best-effort. */
export async function bumpDailyMetric(env, kind, atMs) {
  if (kind !== 'sent' && kind !== 'completed') return;
  try {
    const store = getStorage(env).docs;
    const key = dayKeyFor(typeof atMs === 'number' ? atMs : Date.now());
    const cur = (await store.get(key, { json: true })) || { sent: 0, completed: 0 };
    cur[kind] = (cur[kind] || 0) + 1;
    await store.put(key, cur, { expirationTtl: DAY_TTL });
  } catch (e) { /* metrics must never break the write path */ }
}

/** Sum the day buckets covering [fromMs, toMs] (UTC days, capped). */
export async function readDailyMetrics(env, fromMs, toMs) {
  const out = { docsSent: 0, docsCompleted: 0 };
  try {
    const store = getStorage(env).docs;
    const dayMs = 24 * 60 * 60 * 1000;
    let start = Math.min(fromMs, toMs);
    const end = Math.max(fromMs, toMs);
    if (end - start > MAX_WINDOW_DAYS * dayMs) start = end - MAX_WINDOW_DAYS * dayMs;
    const keys = [];
    for (let t = Date.UTC(
      new Date(start).getUTCFullYear(),
      new Date(start).getUTCMonth(),
      new Date(start).getUTCDate(),
    ); t <= end; t += dayMs) {
      keys.push(dayKeyFor(t));
    }
    const buckets = await Promise.all(keys.map(k => store.get(k, { json: true }).catch(() => null)));
    for (const b of buckets) {
      if (!b) continue;
      out.docsSent += b.sent || 0;
      out.docsCompleted += b.completed || 0;
    }
  } catch (e) { /* degrade to whatever was counted */ }
  return out;
}

/**
 * Mirror a subscription write into the registry. Called next to every
 * sub:<senderId> put in stripe.js, so the registry tracks the same
 * lifecycle Stripe drives (checkout, upgrade, cancel).
 */
export async function recordSubForMetrics(env, senderId, rec) {
  if (!senderId) return;
  try {
    const store = getStorage(env).docs;
    const registry = (await store.get(SUBS_KEY, { json: true })) || {};
    const prior = registry[senderId] || {};
    registry[senderId] = {
      tier: (rec && typeof rec.tier === 'string') ? rec.tier : 'free',
      status: (rec && typeof rec.status === 'string') ? rec.status : '',
      // First-touch attribution: a later event (renewal, upgrade) with no
      // source must not erase the channel that drove the original sale.
      source: (rec && typeof rec.source === 'string' && rec.source)
        ? rec.source.slice(0, 40)
        : (typeof prior.source === 'string' ? prior.source : ''),
    };
    await store.put(SUBS_KEY, registry);
  } catch (e) { /* best-effort */ }
}

/** Read the registry; null means it has never been written. */
export async function readSubsRegistry(env) {
  try {
    return await getStorage(env).docs.get(SUBS_KEY, { json: true });
  } catch (e) {
    return null;
  }
}

/**
 * One-time lazy migration for the subs registry, guarded by its OWN flag
 * (SUBS_SEEDED_FLAG) rather than by "registry is empty". recordSubForMetrics
 * writes a one-entry registry the moment any subscription webhook fires, so
 * an "is the registry null" check would let a single live write permanently
 * skip the legacy scan and drop every pre-deploy subscriber. The flag makes
 * the seed independent of live writes.
 *
 * The scan seeds a base of legacy sub:* records, then overlays whatever the
 * registry already holds (live writes are fresher, so they win). The flag is
 * set ONLY after a clean scan, so a transient KV error retries next time
 * instead of freezing a partial registry forever.
 */
export async function ensureSubsBackfill(env) {
  const store = getStorage(env).docs;
  try {
    if (await store.get(SUBS_SEEDED_FLAG)) return;
  } catch (e) { return; }

  const kv = env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.list === 'function'
    ? env.CYBERSYGN_DOCS
    : null;

  let clean = true;
  const scanned = {};
  if (kv) {
    try {
      let cursor;
      let pages = 0;
      while (true) {
        const r = await kv.list({ prefix: 'sub:', limit: 1000, cursor });
        for (const k of r.keys) {
          let rec;
          try { rec = await kv.get(k.name, 'json'); } catch (e) { continue; }
          if (!rec || typeof rec !== 'object') continue;
          scanned[k.name.slice(4)] = {
            tier: typeof rec.tier === 'string' ? rec.tier : 'free',
            status: typeof rec.status === 'string' ? rec.status : '',
          };
        }
        pages += 1;
        if (r.list_complete || !r.cursor || pages > 20) break;
        cursor = r.cursor;
      }
    } catch (e) { clean = false; }
  }

  try {
    const live = (await store.get(SUBS_KEY, { json: true })) || {};
    const merged = { ...scanned, ...live }; // live entries win
    await store.put(SUBS_KEY, merged);
    if (clean) await store.put(SUBS_SEEDED_FLAG, new Date().toISOString());
  } catch (e) { /* retry next call */ }
}

/**
 * One-time lazy migration for the day buckets: scan doc:* once, bucket
 * every createdAt/completedAt by UTC day, persist, set the flag. On
 * memory mode (no list()) the flag is set without a scan; live bumps
 * are the whole truth there.
 */
export async function ensureDailyBackfill(env) {
  const store = getStorage(env).docs;
  try {
    if (await store.get(BACKFILL_FLAG)) return;
  } catch (e) { return; }

  const kv = env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.list === 'function'
    ? env.CYBERSYGN_DOCS
    : null;

  // Memory mode (no list): nothing to backfill; live bumps are the whole
  // truth, so mark it seeded and move on.
  if (!kv) {
    try { await store.put(BACKFILL_FLAG, new Date().toISOString()); } catch (e) {}
    return;
  }

  const buckets = {};
  const bump = (iso, kind) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    const key = dayKeyFor(ms);
    buckets[key] = buckets[key] || { sent: 0, completed: 0 };
    buckets[key][kind] += 1;
  };
  let clean = true;
  try {
    let cursor;
    let pages = 0;
    while (true) {
      const r = await kv.list({ prefix: 'doc:', limit: 1000, cursor });
      for (const k of r.keys) {
        let d;
        try { d = await kv.get(k.name, 'json'); } catch (e) { continue; }
        if (!d || typeof d !== 'object') continue;
        if (d.createdAt) bump(d.createdAt, 'sent');
        if (d.completedAt) bump(d.completedAt, 'completed');
      }
      pages += 1;
      if (r.list_complete || !r.cursor || pages > 50) break;
      cursor = r.cursor;
    }
  } catch (e) { clean = false; }

  // Write scanned buckets as authoritative: every doc lives under doc:*, so
  // the scan already counts any doc a live bump could have touched in the
  // deploy-to-first-poll window; adding them would double-count. Set the
  // flag ONLY on a clean scan so a transient KV error retries next call
  // instead of permanently truncating historical counts.
  try {
    for (const [key, val] of Object.entries(buckets)) {
      await store.put(key, val, { expirationTtl: DAY_TTL });
    }
    if (clean) await store.put(BACKFILL_FLAG, new Date().toISOString());
  } catch (e) { /* retry next call */ }
}
