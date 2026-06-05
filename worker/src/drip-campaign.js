/**
 * Free-tier email drip campaign.
 *
 * Three brand-voice emails sent at increasing intervals after free
 * signup, each calibrated to where the user actually is in their
 * relationship with the product:
 *
 *   Day 1 (24h after signup):
 *     Welcome + "Drop your first contract." Establishes the
 *     reciprocity primer — we already gave you 3 free, here's how
 *     to extract maximum value from the first one. No selling.
 *
 *   Day 3 (72h after signup):
 *     Templates tip. The lock-in mechanic. "Save your contract as a
 *     template and every repeat upload auto-applies your fields."
 *     Habit formation; gives the user a reason to come back.
 *
 *   Day 7 (168h after signup):
 *     Conversion ask. Now they understand the product. Pitch Charter
 *     ($9 locked for life, scarcity-anchored to 100 spots) as the
 *     no-brainer. Solo as the secondary path.
 *
 * Architecture:
 *   - Cron-triggered daily at 14:00 UTC (about 9am EST / 10am EDT,
 *     a global-friendly send time across US timezones)
 *   - Sweeps all drip:<emailHash> records via KV list
 *   - For each, computes days since createdAt
 *   - Idempotency: writes drip-sent:<emailHash>:<stage> KV marker
 *     before sending, so a retry can't double-send
 *   - Failures are logged but don't block the rest of the sweep
 *
 * Per CONSTITUTION 1.9 (storage tolerance) and 1.7 (truth before
 * completion): the function returns a result summary so callers
 * (manual preview endpoint, monthly report) can show what actually
 * fired vs. what was skipped.
 */

import { sendDripDay1, sendDripDay3, sendDripDay7 } from './email.js';

const KV_PREFIX_DRIP = 'drip:';
const KV_PREFIX_SENT = 'drip-sent:';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SENT_MARKER_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;  // 5 years
const PER_RUN_CAP = 200;  // cap to keep one sweep's fan-out bounded

/**
 * Return true only at the canonical daily slot (14:00 UTC). The cron
 * runs every hour; this gate ensures we send once per day even if the
 * scheduled handler fires multiple times in the hour.
 */
export function shouldRunDripCampaign(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    return now.getUTCHours() === 14;
  } catch (e) { return false; }
}

/**
 * Sweep the drip:<emailHash> records and send any due drip stage.
 * Returns: { ok, scanned, day1Sent, day3Sent, day7Sent, errors }
 */
export async function runDripCampaign(env, event) {
  const result = { ok: true, scanned: 0, day1Sent: 0, day3Sent: 0, day7Sent: 0, errors: [] };
  if (!env || !env.CYBERSYGN_DOCS) {
    result.ok = false;
    result.errors.push('kv_unavailable');
    return result;
  }

  const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  const nowMs = now.getTime();

  // Lock so multiple invocations in the same hour can't both fire the
  // sweep. Day-level lock — drip:lock:YYYY-MM-DD.
  const dayKey = now.toISOString().slice(0, 10);
  const lockKey = `meta:drip-lock:${dayKey}`;
  try {
    const existing = await env.CYBERSYGN_DOCS.get(lockKey);
    if (existing) {
      result.ok = true;
      result.scanned = 0;
      result.errors.push(`already_ran_today:${existing}`);
      return result;
    }
    await env.CYBERSYGN_DOCS.put(lockKey, new Date().toISOString(), {
      expirationTtl: 60 * 60 * 25,
    });
  } catch (e) {
    result.errors.push('lock_error: ' + (e && e.message ? e.message : 'unknown'));
  }

  // Page through drip records. KV list returns up to 1000 keys per page;
  // PER_RUN_CAP keeps us from sending more than 200 emails in a single
  // sweep (a load-shaping guardrail; total drip throughput is daily-bounded
  // by the natural cadence of new signups anyway).
  let cursor = undefined;
  let processed = 0;
  outer: while (true) {
    let listResult;
    try {
      listResult = await env.CYBERSYGN_DOCS.list({
        prefix: KV_PREFIX_DRIP,
        limit: 200,
        cursor,
      });
    } catch (e) {
      result.errors.push('list_failed: ' + (e && e.message ? e.message : 'unknown'));
      break;
    }

    for (const entry of listResult.keys) {
      if (processed >= PER_RUN_CAP) break outer;
      processed += 1;
      result.scanned += 1;

      const emailHash = entry.name.slice(KV_PREFIX_DRIP.length);
      const raw = await env.CYBERSYGN_DOCS.get(entry.name).catch(() => null);
      if (!raw) continue;
      let rec;
      try { rec = JSON.parse(raw); } catch (e) { continue; }
      if (!rec || !rec.email || !rec.createdAt) continue;

      const createdMs = Date.parse(rec.createdAt);
      if (!Number.isFinite(createdMs)) continue;
      const daysSince = Math.floor((nowMs - createdMs) / MS_PER_DAY);

      // Decide stage. Each stage fires once: when the user crosses
      // into the window and the per-stage idempotency marker is absent.
      // We use >= so a sweep that runs a day late still catches the
      // user up rather than skipping ahead.
      let stage = null;
      if (daysSince >= 7) stage = 7;
      else if (daysSince >= 3) stage = 3;
      else if (daysSince >= 1) stage = 1;
      if (stage === null) continue;

      const sentKey = `${KV_PREFIX_SENT}${emailHash}:${stage}`;
      let alreadySent = false;
      try {
        const marker = await env.CYBERSYGN_DOCS.get(sentKey);
        alreadySent = Boolean(marker);
      } catch (e) {}
      if (alreadySent) continue;

      // Send → mark sent. Mark BEFORE sending so a retry on a transient
      // Resend failure doesn't loop forever. If send fails, surface in
      // errors but accept the marker (user can re-send manually via
      // owner endpoint).
      try {
        await env.CYBERSYGN_DOCS.put(sentKey, new Date().toISOString(), {
          expirationTtl: SENT_MARKER_TTL_SECONDS,
        });
      } catch (e) {}

      const sendFn = stage === 7 ? sendDripDay7
                  : stage === 3 ? sendDripDay3
                  : sendDripDay1;
      try {
        const r = await sendFn(env, {
          to: rec.email,
          name: rec.firstName || '',
          appUrl: env.CYBERSYGN_APP_URL || 'https://cybersygn.io',
        });
        if (r && r.delivered) {
          if (stage === 1) result.day1Sent += 1;
          if (stage === 3) result.day3Sent += 1;
          if (stage === 7) result.day7Sent += 1;
        } else {
          result.errors.push(`send_${stage}_failed:${rec.email}:${(r && r.error) || 'unknown'}`);
        }
      } catch (e) {
        result.errors.push(`send_${stage}_threw:${rec.email}:${(e && e.message) || 'unknown'}`);
      }
    }

    if (!listResult.list_complete && listResult.cursor) {
      cursor = listResult.cursor;
    } else {
      break;
    }
  }

  return result;
}
