/**
 * Outbound webhooks (slice 91).
 *
 * Studio members configure a webhook URL + secret. The worker POSTs
 * signed JSON payloads on three events:
 *
 *   doc.created, new doc minted; signers notified
 *   signer.completed, a single signer submitted their fills
 *   doc.completed, every signer is done; signed PDF available
 *
 * Each delivery is signed with HMAC-SHA256 over the JSON body using
 * the sender's webhook secret. The signature is sent as
 *   X-CyberSygn-Signature: t=<unix>,v1=<hex>
 * which mirrors Stripe's webhook signature convention. Receivers
 * verify by reconstructing the HMAC over `t.<body>` with their secret.
 *
 * Storage:
 *   webhook:<senderId>      -> { url, secret, events[], createdAt }
 *   webhook-log:<senderId>:<event-id> -> { event, deliveredAt, status, attempts }
 *
 * Reliability:
 *   - Deliveries fire-and-forget through ctx.waitUntil so the API
 *     response doesn't wait on remote 5xx.
 *   - 2-attempt retry with 1s backoff on non-2xx responses.
 *   - Per-sender 1MB log cap (auto-pruned on next write).
 *
 * Security:
 *   - URLs must be https.
 *   - Signing secret is randomly generated server-side, never
 *     reflected back to the client after creation. Rotate by
 *     re-creating the webhook config.
 */

import { enqueueWebhookRetry } from './webhook-retry.js';

const KV_PREFIX = 'webhook:';
const KV_LOG_PREFIX = 'webhook-log:';
const TTL_SECONDS = 60 * 60 * 24 * 365 * 5;  // 5y, matches all sender records
const LOG_RETAIN = 100;  // last 100 deliveries per sender

export const WEBHOOK_EVENTS = [
  'doc.created',
  'signer.completed',
  'doc.completed',
];

export async function getWebhookConfig(env, senderId) {
  if (!env || !env.CYBERSYGN_DOCS) return null;
  const safe = sanitizeId(senderId);
  if (!safe) return null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(KV_PREFIX + safe);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// Defense in depth against SSRF: reject webhook targets that point at
// loopback, private, link-local, or internal hosts (including IPv6 and
// IPv6-mapped IPv4 forms). Cloudflare Workers cannot reach a cloud metadata
// endpoint or a private LAN, but validating here keeps the product from being
// pointed at anything internal and blocks the obvious abuse shapes.
function isPublicWebhookHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (e) { return false; }
  if (!host) return false;
  host = host.replace(/^\[|\]$/g, ''); // strip any IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : null);
  if (v4) {
    const p = v4.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = p;
    if (a === 0 || a === 127 || a === 10) return false;          // this-network, loopback, private
    if (a === 169 && b === 254) return false;                    // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false;           // private
    if (a === 192 && b === 168) return false;                    // private
    if (a === 100 && b >= 64 && b <= 127) return false;          // CGNAT
    return true;
  }
  // Require a dotted FQDN for named hosts (blocks bare internal names).
  if (!host.includes('.')) return false;
  return true;
}

export async function saveWebhookConfig(env, senderId, opts) {
  const safe = sanitizeId(senderId);
  if (!safe) return { ok: false, error: 'invalid_sender' };
  const url = String((opts && opts.url) || '').trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, error: 'invalid_url' };
  if (url.length > 500) return { ok: false, error: 'url_too_long' };
  if (!isPublicWebhookHost(url)) return { ok: false, error: 'private_url_blocked' };
  let events = Array.isArray(opts && opts.events) ? opts.events : WEBHOOK_EVENTS.slice();
  events = events.filter(e => WEBHOOK_EVENTS.includes(e));
  if (events.length === 0) events = WEBHOOK_EVENTS.slice();

  // Mint a new secret. Rotation = re-create the config.
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = Array.from(secretBytes, b => b.toString(16).padStart(2, '0')).join('');

  const record = {
    v: 1,
    url,
    secret,
    events,
    createdAt: new Date().toISOString(),
  };
  if (env && env.CYBERSYGN_DOCS) {
    try {
      await env.CYBERSYGN_DOCS.put(KV_PREFIX + safe, JSON.stringify(record), {
        expirationTtl: TTL_SECONDS,
      });
    } catch (e) {
      return { ok: false, error: 'kv_put_failed' };
    }
  }
  return { ok: true, config: record };
}

export async function deleteWebhookConfig(env, senderId) {
  const safe = sanitizeId(senderId);
  if (!safe) return { ok: false, error: 'invalid_sender' };
  if (env && env.CYBERSYGN_DOCS) {
    try { await env.CYBERSYGN_DOCS.delete(KV_PREFIX + safe); } catch (e) {}
  }
  return { ok: true };
}

/**
 * Fire a webhook delivery to a sender. Background-safe; designed to be
 * invoked via ctx.waitUntil() from the calling route so the API
 * response doesn't block on the remote endpoint.
 */
export async function fireWebhook(env, senderId, event, payload) {
  const cfg = await getWebhookConfig(env, senderId);
  if (!cfg || !cfg.url) return { ok: false, reason: 'no_config' };
  if (!cfg.events.includes(event)) return { ok: false, reason: 'event_not_subscribed' };

  const body = JSON.stringify({
    id: 'evt_' + randomHex(16),
    event,
    senderId,
    createdAt: new Date().toISOString(),
    data: payload,
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(cfg.secret, t + '.' + body);
  const headers = {
    'content-type': 'application/json',
    'x-cybersygn-signature': `t=${t},v1=${sig}`,
    'x-cybersygn-event': event,
    'user-agent': 'CyberSygn-Webhook/1.0',
  };

  let lastStatus = 0;
  let attempts = 0;
  let deliveredAt = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts = attempt + 1;
    try {
      const res = await fetch(cfg.url, { method: 'POST', headers, body });
      lastStatus = res.status;
      if (res.ok) {
        deliveredAt = new Date().toISOString();
        break;
      }
      // Backoff before retry.
      if (attempt === 0) await sleep(1000);
    } catch (e) {
      lastStatus = -1;
      if (attempt === 0) await sleep(1000);
    }
  }

  // Log the outcome for the dashboard.
  await logDelivery(env, senderId, {
    event,
    deliveredAt,
    status: lastStatus,
    attempts,
    url: cfg.url,
  });

  // If both inline attempts failed, hand the delivery to the durable retry
  // queue (swept hourly from scheduled()) instead of dropping it.
  if (!deliveredAt) {
    await enqueueWebhookRetry(env, { senderId, event, data: payload }, 1);
  }

  return { ok: lastStatus >= 200 && lastStatus < 300, status: lastStatus, attempts };
}

/**
 * Single-attempt redelivery of a queued webhook payload. Re-reads the current
 * config and re-signs (the secret may have rotated since it was queued).
 * Returns true only on a 2xx. Used by sweepWebhookQueue.
 */
export async function redeliverWebhook(env, queued) {
  const senderId = queued && queued.senderId;
  const event = queued && queued.event;
  if (!senderId || !event) return true; // malformed, drop it
  const cfg = await getWebhookConfig(env, senderId);
  if (!cfg || !cfg.url || !cfg.events.includes(event)) return true; // config gone, stop retrying
  const body = JSON.stringify({
    id: 'evt_' + randomHex(16),
    event,
    senderId,
    createdAt: new Date().toISOString(),
    data: queued.data,
    redelivery: true,
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(cfg.secret, t + '.' + body);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cybersygn-signature': `t=${t},v1=${sig}`,
        'x-cybersygn-event': event,
        'user-agent': 'CyberSygn-Webhook/1.0',
      },
      body,
    });
    if (res.ok) { await logDelivery(env, senderId, { event, deliveredAt: new Date().toISOString(), status: res.status, attempts: 1, url: cfg.url, redelivery: true }); return true; }
    return false;
  } catch (e) {
    return false;
  }
}

async function logDelivery(env, senderId, entry) {
  if (!env || !env.CYBERSYGN_DOCS) return;
  const safe = sanitizeId(senderId);
  if (!safe) return;
  const key = KV_LOG_PREFIX + safe;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(key);
    let log = [];
    if (raw) {
      try { log = JSON.parse(raw); } catch (e) { log = []; }
    }
    log.unshift({ ...entry, ts: new Date().toISOString() });
    if (log.length > LOG_RETAIN) log = log.slice(0, LOG_RETAIN);
    await env.CYBERSYGN_DOCS.put(key, JSON.stringify(log), { expirationTtl: TTL_SECONDS });
  } catch (e) {}
}

export async function getDeliveryLog(env, senderId) {
  if (!env || !env.CYBERSYGN_DOCS) return [];
  const safe = sanitizeId(senderId);
  if (!safe) return [];
  try {
    const raw = await env.CYBERSYGN_DOCS.get(KV_LOG_PREFIX + safe);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch (e) { return []; }
}

// ---- helpers ----------------------------------------------------------------

function sanitizeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
