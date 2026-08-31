/**
 * Daily KV backup to R2 (slice 100).
 *
 * Runs once per day from the scheduled handler. Streams every key matching
 * the configured prefixes (subs, docs, brands, webhook configs, free-tier
 * records) into a single newline-delimited JSON object and writes it to
 * R2 at `backups/YYYY-MM-DD.ndjson`.
 *
 * R2 not configured (no env.CYBERSYGN_BACKUPS binding) → a LOUD, REPORTED
 * failure, not a no-op. wrangler.jsonc declares no r2_buckets, so as shipped
 * this job writes nothing, and it announced that to nobody: the scheduled
 * handler drops the return value. Every run now logs its outcome and stores it
 * at meta:kv-backup:latest, so "we have backups" is a checkable claim instead
 * of an assumption.
 *
 * Restore: download the latest .ndjson, parse each line, push back via
 * `wrangler kv key put` (single bash script wraps it).
 *
 * Why R2: KV is the source of truth; R2 is the backup. Putting backups
 * INTO KV creates a circular failure mode (if KV is corrupted, the
 * backup is too). R2 is independent storage, byte-cheap, and worker-
 * native.
 */

const BACKUP_PREFIXES = [
  'sub:',
  'doc:',
  'brand:',
  'webhook:',
  'free:',
  'drip:',
  'tpl:',
  'tpl-priv:',
  'origin-member:',
  'meta:',
];

const PAGE_LIMIT = 1000;
const HARD_KEY_CAP = 50_000;  // worst-case fan-out guard

const RESULT_KEY = 'meta:kv-backup:latest';
const RESULT_TTL_SECONDS = 60 * 60 * 24 * 40;

/**
 * Log the outcome and store it where the owner panel can read it. Returning a
 * structured result is not enough on its own: the cron call site discards it,
 * so an outcome nobody records is an outcome nobody has.
 */
async function report(env, outcome) {
  const rec = { ...outcome, ranAt: new Date().toISOString() };
  if (rec.ok) console.log('[kv-backup]', JSON.stringify(rec));
  else console.error('[kv-backup] FAILED', JSON.stringify(rec));
  try {
    if (env && env.CYBERSYGN_DOCS) {
      await env.CYBERSYGN_DOCS.put(RESULT_KEY, JSON.stringify(rec), { expirationTtl: RESULT_TTL_SECONDS });
    }
  } catch (e) { /* the log line above is still the record of what happened */ }
  return rec;
}

/** Last stored backup outcome, or null if this job has never reported one. */
export async function getLatestKvBackup(env) {
  try {
    if (!env || !env.CYBERSYGN_DOCS) return null;
    const raw = await env.CYBERSYGN_DOCS.get(RESULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

export async function runDailyKvBackup(env) {
  if (!env || !env.CYBERSYGN_DOCS) {
    // Nowhere to record this one; the console line is the whole report.
    console.error('[kv-backup] FAILED: no CYBERSYGN_DOCS binding, nothing to back up');
    return { ok: false, reason: 'kv_unavailable', ranAt: new Date().toISOString() };
  }
  const r2 = env.CYBERSYGN_BACKUPS;
  if (!r2 || typeof r2.put !== 'function') {
    return report(env, {
      ok: false,
      reason: 'r2_unbound',
      note: 'No CYBERSYGN_BACKUPS R2 binding, so NO backup exists. Bind an R2 bucket in wrangler.jsonc to enable.',
    });
  }

  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const objectKey = `backups/${dayKey}.ndjson`;

  // Idempotency: if the backup for today already exists, skip.
  try {
    const existing = await r2.head(objectKey);
    if (existing) return report(env, { ok: true, reason: 'already_exists', objectKey });
  } catch (e) {}

  let written = 0;
  let skipped = 0;
  let lines = '';
  // A prefix that fails to list is a HOLE in the backup, not a detail. The
  // old bare `break` produced a file that looked complete and silently held
  // none of, say, the subscription records.
  const errors = [];
  for (const prefix of BACKUP_PREFIXES) {
    let cursor = undefined;
    while (true) {
      let listed;
      try {
        listed = await env.CYBERSYGN_DOCS.list({ prefix, limit: PAGE_LIMIT, cursor });
      } catch (e) {
        errors.push(`list_failed:${prefix}:${(e && e.message) || 'unknown'}`);
        break;
      }
      for (const entry of listed.keys) {
        if (written >= HARD_KEY_CAP) break;
        try {
          const raw = await env.CYBERSYGN_DOCS.get(entry.name);
          if (raw === null) continue;
          lines += JSON.stringify({ k: entry.name, v: raw }) + '\n';
          written += 1;
        } catch (e) {
          skipped += 1;
          if (errors.length < 20) errors.push(`read_failed:${entry.name}:${(e && e.message) || 'unknown'}`);
        }
      }
      if (written >= HARD_KEY_CAP) break;
      if (listed.list_complete || !listed.cursor) break;
      cursor = listed.cursor;
    }
  }
  if (written >= HARD_KEY_CAP) errors.push(`hard_key_cap_hit:${HARD_KEY_CAP}`);

  try {
    await r2.put(objectKey, lines, {
      httpMetadata: { contentType: 'application/x-ndjson' },
      customMetadata: { date: dayKey, keyCount: String(written) },
    });
  } catch (e) {
    return report(env, { ok: false, reason: 'r2_put_failed', error: (e && e.message) || 'unknown', objectKey, keyCount: written, errors });
  }
  // A backup with holes in it is not a green run: say so, and keep the object,
  // since a partial backup still beats none when it is labelled partial.
  return report(env, {
    ok: errors.length === 0,
    reason: errors.length ? 'partial' : undefined,
    objectKey,
    keyCount: written,
    skipped,
    errors,
  });
}

/**
 * Should we run the backup right now? Fire at 03:00 UTC daily, off-peak
 * for all US/EU timezones, won't compete with the drip campaign (14:00)
 * or the monthly owner report (1st @ 00:00).
 */
/**
 * Delete backups older than RETENTION_DAYS.
 *
 * Without this, backups accumulate forever and a self-serve erasure becomes a
 * half-truth: the personal data is gone from KV but still sitting in every
 * daily snapshot ever taken. A bounded window is what makes deletion actually
 * propagate, and it is what /erase/ tells people (up to 35 days).
 *
 * 35 days, not 30: it leaves a few days of slack so a run that fails for a
 * week does not leave us with no usable backup at all.
 */
export const BACKUP_RETENTION_DAYS = 35;

export async function pruneOldBackups(env, now = new Date()) {
  const r2 = env && env.CYBERSYGN_BACKUPS;
  if (!r2 || typeof r2.list !== 'function') return { ok: false, reason: 'r2_unbound', pruned: 0 };
  const cutoff = new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86400000)
    .toISOString().slice(0, 10);
  let pruned = 0;
  const errors = [];
  try {
    let cursor;
    do {
      const page = await r2.list({ prefix: 'backups/', cursor });
      for (const obj of (page.objects || [])) {
        // backups/YYYY-MM-DD.ndjson -> lexical compare is a date compare.
        const m = /^backups\/(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(obj.key);
        if (!m) continue;
        if (m[1] < cutoff) {
          try { await r2.delete(obj.key); pruned++; }
          catch (e) { errors.push(obj.key); }
        }
      }
      cursor = page.truncated ? page.cursor : null;
    } while (cursor);
  } catch (e) {
    return { ok: false, reason: 'list_failed', pruned, errors };
  }
  return { ok: true, pruned, cutoff, errors };
}

export function shouldRunKvBackup(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    return now.getUTCHours() === 3;
  } catch (e) { return false; }
}
