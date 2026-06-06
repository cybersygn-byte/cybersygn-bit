/**
 * Webhook delivery with retry queue (slice 100).
 *
 * Replaces the synchronous-only delivery in slice 91. Failed POSTs
 * (HTTP 5xx, network timeout) get queued to KV with an exponential
 * backoff schedule. The scheduled handler sweeps the queue every
 * hour and retries due deliveries.
 *
 * Queue shape:
 *   webhook-queue:<retryAt>:<id> → JSON of pending delivery
 *
 * Retry policy:
 *   attempts 1,2,3,4,5,6
 *   delays   immediate, 1m, 5m, 30m, 2h, 6h
 *   After 6 failed attempts the delivery is moved to
 *   webhook-dead:<senderId>:<id> for the dashboard log.
 */

const QUEUE_PREFIX = 'webhook-queue:';
const DEAD_PREFIX = 'webhook-dead:';
const RETRY_SCHEDULE_MIN = [0, 1, 5, 30, 120, 360];

/**
 * Enqueue a webhook delivery for later retry.
 */
export async function enqueueWebhookRetry(env, payload, attemptNum) {
  if (!env || !env.CYBERSYGN_DOCS) return;
  const delayMin = RETRY_SCHEDULE_MIN[Math.min(attemptNum, RETRY_SCHEDULE_MIN.length - 1)];
  if (attemptNum >= RETRY_SCHEDULE_MIN.length) {
    // Out of retries — dead-letter.
    try {
      await env.CYBERSYGN_DOCS.put(
        `${DEAD_PREFIX}${payload.senderId || 'unknown'}:${payload.deliveryId}`,
        JSON.stringify({ ...payload, deadAt: new Date().toISOString(), attempts: attemptNum }),
        { expirationTtl: 60 * 60 * 24 * 30 },
      );
    } catch (e) {}
    return;
  }
  const retryAt = Date.now() + delayMin * 60 * 1000;
  const id = payload.deliveryId || randomHex(12);
  try {
    await env.CYBERSYGN_DOCS.put(
      `${QUEUE_PREFIX}${retryAt}:${id}`,
      JSON.stringify({ ...payload, deliveryId: id, attemptNum, retryAt }),
      { expirationTtl: 60 * 60 * 24 * 7 },  // 7-day queue retention
    );
  } catch (e) {}
}

/**
 * Sweep the queue every hour from the scheduled handler. Process any
 * delivery whose retryAt is in the past.
 */
export async function sweepWebhookQueue(env, deliverFn) {
  if (!env || !env.CYBERSYGN_DOCS) return { swept: 0, sent: 0, requeued: 0 };
  const result = { swept: 0, sent: 0, requeued: 0, errors: [] };
  const nowMs = Date.now();
  let cursor;
  while (true) {
    let listed;
    try {
      listed = await env.CYBERSYGN_DOCS.list({ prefix: QUEUE_PREFIX, limit: 200, cursor });
    } catch (e) { result.errors.push(e && e.message); break; }
    for (const entry of listed.keys) {
      const parts = entry.name.split(':');
      // webhook-queue:<retryAt>:<id>
      const retryAt = parseInt(parts[1], 10);
      if (!Number.isFinite(retryAt) || retryAt > nowMs) continue;
      result.swept += 1;
      try {
        const raw = await env.CYBERSYGN_DOCS.get(entry.name);
        if (!raw) continue;
        const payload = JSON.parse(raw);
        await env.CYBERSYGN_DOCS.delete(entry.name);
        const ok = await deliverFn(env, payload);
        if (ok) {
          result.sent += 1;
        } else {
          result.requeued += 1;
          await enqueueWebhookRetry(env, payload, (payload.attemptNum || 0) + 1);
        }
      } catch (e) {
        result.errors.push(e && e.message);
      }
    }
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return result;
}

function randomHex(n) {
  const buf = new Uint8Array(n / 2);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
