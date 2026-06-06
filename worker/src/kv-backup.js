/**
 * Daily KV backup to R2 (slice 100).
 *
 * Runs once per day from the scheduled handler. Streams every key matching
 * the configured prefixes (subs, docs, brands, webhook configs, free-tier
 * records) into a single newline-delimited JSON object and writes it to
 * R2 at `backups/YYYY-MM-DD.ndjson`.
 *
 * R2 not configured (no env.CYBERSYGN_BACKUPS binding) → no-op.
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

export async function runDailyKvBackup(env) {
  if (!env || !env.CYBERSYGN_DOCS) {
    return { ok: false, reason: 'kv_unavailable' };
  }
  const r2 = env.CYBERSYGN_BACKUPS;
  if (!r2 || typeof r2.put !== 'function') {
    return { ok: false, reason: 'r2_unbound', note: 'Set CYBERSYGN_BACKUPS R2 binding in wrangler.jsonc to enable.' };
  }

  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const objectKey = `backups/${dayKey}.ndjson`;

  // Idempotency: if the backup for today already exists, skip.
  try {
    const existing = await r2.head(objectKey);
    if (existing) return { ok: true, skipped: 'already_exists', objectKey };
  } catch (e) {}

  let written = 0;
  let lines = '';
  for (const prefix of BACKUP_PREFIXES) {
    let cursor = undefined;
    while (true) {
      let listed;
      try {
        listed = await env.CYBERSYGN_DOCS.list({ prefix, limit: PAGE_LIMIT, cursor });
      } catch (e) { break; }
      for (const entry of listed.keys) {
        if (written >= HARD_KEY_CAP) break;
        try {
          const raw = await env.CYBERSYGN_DOCS.get(entry.name);
          if (raw === null) continue;
          lines += JSON.stringify({ k: entry.name, v: raw }) + '\n';
          written += 1;
        } catch (e) { /* skip individual key */ }
      }
      if (written >= HARD_KEY_CAP) break;
      if (listed.list_complete || !listed.cursor) break;
      cursor = listed.cursor;
    }
  }

  try {
    await r2.put(objectKey, lines, {
      httpMetadata: { contentType: 'application/x-ndjson' },
      customMetadata: { date: dayKey, keyCount: String(written) },
    });
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
  return { ok: true, objectKey, keyCount: written };
}

/**
 * Should we run the backup right now? Fire at 03:00 UTC daily — off-peak
 * for all US/EU timezones, won't compete with the drip campaign (14:00)
 * or the monthly owner report (1st @ 00:00).
 */
export function shouldRunKvBackup(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    return now.getUTCHours() === 3;
  } catch (e) { return false; }
}
