/**
 * Document templates: persisted field labels keyed by the document's
 * SHA-256 hash.
 *
 * Insight: the same PDF gets uploaded many times across CyberSygn's
 * user base. A roofing company sends its contingency contract hundreds
 * of times. NDAs, vendor agreements, loan apps, insurance claim forms
 * are all recurring. Heuristic detection runs on every upload, but
 * once any user has manually corrected the field set for a specific
 * PDF, that corrected set IS the right answer for every future upload
 * of the same bytes.
 *
 * Schema (KV value at key `tpl:<docId>`):
 *   {
 *     v: 1,                          // schema version
 *     docId: string,                 // SHA-256 hex of original PDF bytes
 *     createdAt: ISO timestamp,
 *     updatedAt: ISO timestamp,
 *     scope: 'private' | 'public',   // private = only saver can read; public = anyone with matching docId
 *     savedBy: string,               // senderId (truncated, no PII)
 *     fields: [                      // PDF-space field coords + types
 *       { type, page, x, y, width, height, label, primary, source }
 *     ],
 *     // Optional aggregate stats. Helpful for showing "trusted by N people"
 *     // on the apply prompt and for ranking when two templates collide.
 *     stats: {
 *       savedCount: integer,         // increments each save by a different sender
 *       lastSeenAt: ISO timestamp,   // last lookup that returned a match
 *       lookupCount: integer,
 *     }
 *   }
 *
 * Privacy: the saved fields contain NO document content. Only positions
 * and types. The label string is the LABEL TEXT NEAR EACH FIELD
 * (e.g. "Client Signature"), not the signer's filled-in value. We never
 * store filled-in signatures, names, addresses, dates, etc. in a
 * template; those live in the per-document fillStore and are flattened
 * into the signed PDF, not into the template KV.
 *
 * Privacy default: `scope: 'private'`. Public sharing requires the
 * user's AI training consent flag to be true. Without it, the template
 * is keyed by `tpl:<docId>:private:<senderId>` and only that sender's
 * future uploads of the same doc can apply it.
 *
 * Per CONSTITUTION 1.9: every storage op is try/catched; if KV is
 * unavailable, lookup returns null and save returns ok=false rather
 * than throwing.
 */

const KV_PREFIX_PUBLIC = 'tpl:';
const KV_PREFIX_PRIVATE = 'tpl-priv:';
const SCHEMA_VERSION = 1;
const MAX_FIELDS_PER_TEMPLATE = 500;     // hard cap; protects KV value-size limits
const MAX_LABEL_LEN = 160;
const KV_VALUE_BUDGET_BYTES = 25 * 1024; // KV value limit is 25 MB but we stay tiny on principle
const TEMPLATE_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year; templates re-bump TTL on lookup/save

/**
 * Save a template. Returns { ok, template } or { ok:false, error }.
 *
 * @param env Worker env with CYBERSYGN_DOCS KV
 * @param opts
 *   docId        SHA-256 hex of the original PDF
 *   senderId     who is saving (required for privacy scoping)
 *   fields       array of field objects (validated + sanitized)
 *   scope        'private' (default) | 'public'
 *   consentGiven user opted in to AI training; required for scope='public'
 *   ownerCreated true if the active session is the owner doing demo /
 *                testing work. Owner public-saves get downgraded to
 *                private so demo work cannot pollute the shared corpus;
 *                if the caller explicitly persists ownerCreated=true on
 *                the stored record, dataset stats and export both skip it.
 */
export async function saveTemplate(env, opts) {
  if (!env || !env.CYBERSYGN_DOCS) {
    return { ok: false, error: 'kv_unavailable' };
  }
  const docId = sanitizeDocId(opts && opts.docId);
  if (!docId) return { ok: false, error: 'invalid_docId' };
  const senderId = String((opts && opts.senderId) || '').slice(0, 64);
  if (!senderId) return { ok: false, error: 'invalid_senderId' };

  const fields = Array.isArray(opts.fields) ? sanitizeFields(opts.fields) : [];
  if (fields.length === 0) return { ok: false, error: 'no_fields' };

  let scope = opts.scope === 'public' ? 'public' : 'private';
  if (scope === 'public' && !opts.consentGiven) {
    // Fall back to private rather than reject; the caller will see
    // the scope in the response and can prompt the user appropriately.
    scope = 'private';
  }
  // Owner-test isolation: an active owner session writing a public
  // template is doing demo work, not contributing real customer data.
  // Downgrade to private so the public-corpus stays clean. The owner
  // can still verify the save round-trip — it just lives under
  // tpl-priv:<docId>:<senderId> instead of polluting tpl:<docId>.
  const ownerCreated = Boolean(opts && opts.ownerCreated);
  if (ownerCreated && scope === 'public') {
    scope = 'private';
  }

  // Merge with any existing template for this docId+scope. For public,
  // merging across senders rather than overwriting prevents one bad
  // contributor from wiping the existing labels (we keep the union of
  // unique field positions, weighted by save count).
  const key = templateKey(docId, scope, senderId);
  const now = new Date().toISOString();

  let existing = null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(key);
    if (raw) existing = JSON.parse(raw);
  } catch (e) {}

  const merged = mergeFields(existing && existing.fields, fields);
  const stats = (existing && existing.stats) || { savedCount: 0, lookupCount: 0, lastSeenAt: null };
  stats.savedCount = (stats.savedCount || 0) + 1;

  const template = {
    v: SCHEMA_VERSION,
    docId,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    scope,
    savedBy: senderId.slice(0, 12),  // truncate so it's not a unique ID we keep
    fields: merged.slice(0, MAX_FIELDS_PER_TEMPLATE),
    stats,
    // Owner-created records persist this flag so downstream aggregates
    // (dataset stats, export, public-template lookups) can skip them.
    // Inherits from prior record if the same template was previously
    // saved as owner-created — owner status is a property of the
    // template record itself, not the moment of write.
    ownerCreated: ownerCreated || (existing && existing.ownerCreated) || false,
  };

  const serialized = JSON.stringify(template);
  if (serialized.length > KV_VALUE_BUDGET_BYTES) {
    return { ok: false, error: 'template_too_large' };
  }
  try {
    await env.CYBERSYGN_DOCS.put(key, serialized, { expirationTtl: TEMPLATE_TTL_SECONDS });
  } catch (e) {
    return { ok: false, error: 'kv_put_failed: ' + (e && e.message ? e.message : 'unknown') };
  }
  return { ok: true, template };
}

/**
 * Look up a template. Tries public first (anyone can apply), then
 * falls back to this sender's private template. Returns { ok, template, scope }
 * or { ok: false } if no match.
 */
export async function lookupTemplate(env, opts) {
  if (!env || !env.CYBERSYGN_DOCS) return { ok: false };
  const docId = sanitizeDocId(opts && opts.docId);
  if (!docId) return { ok: false };
  const senderId = String((opts && opts.senderId) || '').slice(0, 64);

  // 1. Public template by exact docId.
  const publicKey = templateKey(docId, 'public', '');
  try {
    const raw = await env.CYBERSYGN_DOCS.get(publicKey);
    if (raw) {
      const t = JSON.parse(raw);
      if (t && Array.isArray(t.fields) && t.fields.length > 0) {
        // bump lookupCount + lastSeenAt asynchronously; don't block response
        bumpStats(env, publicKey, t).catch(() => {});
        return { ok: true, template: t, scope: 'public' };
      }
    }
  } catch (e) {}

  // 2. Private template scoped to this sender.
  if (senderId) {
    const privKey = templateKey(docId, 'private', senderId);
    try {
      const raw = await env.CYBERSYGN_DOCS.get(privKey);
      if (raw) {
        const t = JSON.parse(raw);
        if (t && Array.isArray(t.fields) && t.fields.length > 0) {
          bumpStats(env, privKey, t).catch(() => {});
          return { ok: true, template: t, scope: 'private' };
        }
      }
    } catch (e) {}
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function templateKey(docId, scope, senderId) {
  if (scope === 'public') return KV_PREFIX_PUBLIC + docId;
  return KV_PREFIX_PRIVATE + docId + ':' + senderId.slice(0, 32);
}

function sanitizeDocId(s) {
  if (typeof s !== 'string') return null;
  // Accept 64-char hex (SHA-256 hex).
  if (!/^[a-f0-9]{64}$/.test(s)) return null;
  return s;
}

function sanitizeFields(arr) {
  const ALLOWED_TYPES = new Set(['signature', 'initial', 'date', 'checkbox', 'text']);
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    if (!ALLOWED_TYPES.has(f.type)) continue;
    const page = Number(f.page);
    const x = Number(f.x);
    const y = Number(f.y);
    const w = Number(f.width);
    const h = Number(f.height);
    if (!Number.isFinite(page) || page < 1 || page > 200) continue;
    if (![x, y, w, h].every(n => Number.isFinite(n) && n >= 0)) continue;
    if (w < 1 || h < 1 || w > 5000 || h > 5000) continue;
    const confidence = typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1
      ? f.confidence
      : 1.0;  // human-verified template fields are 100% by definition
    out.push({
      type: f.type,
      page,
      x, y, width: w, height: h,
      label: typeof f.label === 'string' ? f.label.slice(0, MAX_LABEL_LEN) : '',
      primary: f.primary === false ? false : true,
      source: typeof f.source === 'string' ? f.source.slice(0, 32) : 'user-saved',
      confidence,
    });
    if (out.length >= MAX_FIELDS_PER_TEMPLATE) break;
  }
  return out;
}

/**
 * Merge previous fields with newly-saved fields. Dedupe by position +
 * type using box-overlap > 0.7. New fields win on a conflict so users
 * can correct templates that were wrong. Returns the unioned list.
 */
function mergeFields(prev, next) {
  if (!Array.isArray(prev) || prev.length === 0) return next;
  const result = [...next];
  for (const p of prev) {
    if (!next.some(n => sameishField(n, p))) {
      result.push(p);
    }
  }
  return result;
}

function sameishField(a, b) {
  if (!a || !b) return false;
  if (a.page !== b.page) return false;
  // Box-overlap > 0.7 = treat as same field.
  const overlap = boxIou(a, b);
  return overlap > 0.7 && a.type === b.type;
}

function boxIou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = iw * ih;
  const area = (a.width * a.height) + (b.width * b.height) - inter;
  return area > 0 ? inter / area : 0;
}

async function bumpStats(env, key, template) {
  try {
    template.stats = template.stats || { savedCount: 1, lookupCount: 0, lastSeenAt: null };
    template.stats.lookupCount = (template.stats.lookupCount || 0) + 1;
    template.stats.lastSeenAt = new Date().toISOString();
    await env.CYBERSYGN_DOCS.put(key, JSON.stringify(template), { expirationTtl: TEMPLATE_TTL_SECONDS });
  } catch (e) {}
}
