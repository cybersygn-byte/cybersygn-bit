/**
 * Free-tier email drip campaign.
 *
 * Three brand-voice emails sent at increasing intervals after free
 * signup, each calibrated to where the user actually is in their
 * relationship with the product:
 *
 *   Day 1 (24h after signup):
 *     Welcome + "Drop your first contract." Establishes the
 *     reciprocity primer, we already gave you 3 free, here's how
 *     to extract maximum value from the first one. No selling.
 *
 *   Day 3 (72h after signup):
 *     Templates tip. The lock-in mechanic. "Save your contract as a
 *     template and every repeat upload auto-applies your fields."
 *     Habit formation; gives the user a reason to come back.
 *
 *   Day 7 (168h after signup):
 *     Conversion ask. Now they understand the product. Pitch Origin
 *     ($9 locked for life, scarcity-anchored to 100 spots) as the
 *     no-brainer. Solo as the secondary path.
 *
 * Architecture:
 *   - Cron-triggered daily at 14:00 UTC (about 9am EST / 10am EDT,
 *     a global-friendly send time across US timezones)
 *   - Sweeps drip:<emailHash> records via KV list, resuming from the
 *     cursor the previous sweep stored at meta:drip-cursor
 *   - For each, computes days since createdAt
 *   - Idempotency: writes drip-sent:<emailHash>:<stage> KV marker
 *     before sending, so a retry can't double-send
 *   - Failures are logged but don't block the rest of the sweep
 *
 * Two caps bound one sweep, and they are different things. SCAN_CAP
 * bounds KV reads (every record costs a get, and a Worker invocation
 * has a subrequest ceiling). SEND_CAP bounds outbound email. Counting
 * scans against the send cap is what silently killed this campaign:
 * once 200 lifetime drip records existed, the sweep spent its whole
 * budget re-reading old records that had nothing left to send and
 * never reached the signups from yesterday. Whichever cap trips, the
 * cursor is persisted so the next run picks up where this one stopped
 * instead of restarting at the top of the keyspace.
 *
 * Per CONSTITUTION 1.9 (storage tolerance) and 1.7 (truth before
 * completion): the function returns a result summary so callers
 * (manual preview endpoint, monthly report) can show what actually
 * fired vs. what was skipped, and reports ok:false when the sweep
 * aborted rather than completed.
 */

import { sendDripDay1, sendDripDay3, sendDripDay7 } from './email.js';

const KV_PREFIX_DRIP = 'drip:';
const KV_PREFIX_SENT = 'drip-sent:';
const KV_KEY_CURSOR = 'meta:drip-cursor';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SENT_MARKER_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;  // 5 years
const CURSOR_TTL_SECONDS = 60 * 60 * 24 * 30;  // a cursor older than this is worthless
const PER_RUN_SEND_CAP = 200;   // emails actually sent in one sweep
const PER_RUN_SCAN_CAP = 500;   // records inspected in one sweep

// Lowest stage first. A late sweep must walk a user forward one stage per
// run; picking the highest eligible stage skips the welcome and the
// templates tip entirely and opens with the conversion ask.
const STAGES = [1, 3, 7];

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
 * Returns: { ok, scanned, day1Sent, day3Sent, day7Sent, sent, resumed, cursorSaved, errors }
 */
export async function runDripCampaign(env, event) {
  const result = {
    ok: true, scanned: 0, sent: 0,
    day1Sent: 0, day3Sent: 0, day7Sent: 0,
    resumed: false, cursorSaved: false, errors: [],
  };
  if (!env || !env.CYBERSYGN_DOCS) {
    result.ok = false;
    result.errors.push('kv_unavailable');
    return result;
  }
  const kv = env.CYBERSYGN_DOCS;

  const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  const nowMs = now.getTime();

  // Lock so multiple invocations in the same hour can't both fire the
  // sweep. Day-level lock, drip:lock:YYYY-MM-DD.
  const dayKey = now.toISOString().slice(0, 10);
  const lockKey = `meta:drip-lock:${dayKey}`;
  let lockAcquired = false;
  try {
    const existing = await kv.get(lockKey);
    if (existing) {
      result.ok = true;
      result.scanned = 0;
      result.errors.push(`already_ran_today:${existing}`);
      return result;
    }
    await kv.put(lockKey, new Date().toISOString(), {
      expirationTtl: 60 * 60 * 25,
    });
    lockAcquired = true;
  } catch (e) {
    result.errors.push('lock_error: ' + (e && e.message ? e.message : 'unknown'));
  }

  // Resume point from the previous sweep. Without this, a run that hit its
  // cap restarted at the top of the keyspace on the next fire and never
  // advanced past the first page.
  let pageCursor;
  try {
    const saved = await kv.get(KV_KEY_CURSOR);
    if (saved) { pageCursor = saved; result.resumed = true; }
  } catch (e) { /* a missing resume point just means "start at the top" */ }

  let scanned = 0;
  let sent = 0;
  let aborted = false;
  let capped = false;
  let retriedFromStart = false;

  try {
    outer: while (true) {
      let listResult;
      try {
        listResult = await kv.list({
          prefix: KV_PREFIX_DRIP,
          limit: 200,
          cursor: pageCursor,
        });
      } catch (e) {
        // A stored cursor can go stale (KV cursors are not eternal). If the
        // very first list fails while resuming, drop the cursor and sweep from
        // the top once rather than wedging the campaign until someone notices.
        if (pageCursor && !retriedFromStart) {
          retriedFromStart = true;
          result.errors.push('cursor_stale, restarting from top');
          pageCursor = undefined;
          result.resumed = false;
          continue;
        }
        result.errors.push('list_failed: ' + (e && e.message ? e.message : 'unknown'));
        aborted = true;
        break;
      }

      for (const entry of listResult.keys) {
        if (sent >= PER_RUN_SEND_CAP || scanned >= PER_RUN_SCAN_CAP) { capped = true; break outer; }
        scanned += 1;
        result.scanned = scanned;

        const emailHash = entry.name.slice(KV_PREFIX_DRIP.length);
        const raw = await kv.get(entry.name).catch(() => null);
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (!rec || !rec.email || !rec.createdAt) continue;

        const createdMs = Date.parse(rec.createdAt);
        if (!Number.isFinite(createdMs)) continue;
        const daysSince = Math.floor((nowMs - createdMs) / MS_PER_DAY);

        // Decide stage: the LOWEST eligible stage this user has not been
        // sent yet. A user who is 9 days old with nothing sent gets day 1
        // today, day 3 tomorrow, day 7 the day after. The old highest-first
        // scan sent them the conversion ask and nothing else, ever.
        let stage = null;
        let markerError = null;
        for (const s of STAGES) {
          if (daysSince < s) break;
          try {
            const marker = await kv.get(`${KV_PREFIX_SENT}${emailHash}:${s}`);
            if (!marker) { stage = s; break; }
          } catch (e) {
            // Cannot prove this stage was not already sent, so do not send it.
            markerError = e && e.message ? e.message : 'unknown';
            break;
          }
        }
        if (markerError) {
          result.errors.push(`marker_read_failed:${emailHash}:${markerError}`);
          continue;
        }
        if (stage === null) continue;

        // Past the already-sent check, so this record WILL consume a send.
        // The cap counts here, never at the top of the loop.
        sent += 1;

        // Send → mark sent. Mark BEFORE sending so a retry on a transient
        // Resend failure doesn't loop forever. If send fails, surface in
        // errors but accept the marker (user can re-send manually via
        // owner endpoint).
        const sentKey = `${KV_PREFIX_SENT}${emailHash}:${stage}`;
        try {
          await kv.put(sentKey, new Date().toISOString(), {
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
        pageCursor = listResult.cursor;
      } else {
        pageCursor = undefined;
        break;
      }
    }
  } finally {
    result.sent = sent;
    // Where the next sweep starts. A cap hit mid-page re-lists the SAME page
    // (KV cursors are per-page, not per-key), which is safe because the
    // drip-sent markers make a re-scan a no-op for anyone already handled.
    try {
      if (capped && pageCursor) {
        await kv.put(KV_KEY_CURSOR, pageCursor, { expirationTtl: CURSOR_TTL_SECONDS });
        result.cursorSaved = true;
      } else if (capped && !pageCursor) {
        // Capped on the first page: the next run starts at the top anyway.
        await kv.delete(KV_KEY_CURSOR);
      } else if (!aborted) {
        // Swept the whole keyspace, so the next run starts fresh.
        await kv.delete(KV_KEY_CURSOR);
      }
    } catch (e) {
      result.errors.push('cursor_save_failed: ' + (e && e.message ? e.message : 'unknown'));
    }

    // Release the day lock when the sweep did NOT complete, the way
    // runReminderSweep releases its lock. Holding the lock after an aborted
    // sweep burned the entire day: one KV list hiccup at 14:00 meant nobody
    // got a drip email until tomorrow.
    if (aborted && lockAcquired) {
      try { await kv.delete(lockKey); } catch (e) {}
    }
  }

  if (aborted) result.ok = false;
  return result;
}
