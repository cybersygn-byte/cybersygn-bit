/**
 * Public CyberSygn API, v1 (/api/v1/*).
 *
 * Lets an external tool (e.g. Vyan) drive the full signing lifecycle
 * server-to-server with an API key:
 *
 *   POST   /api/v1/documents            create + send a document for signature
 *   GET    /api/v1/documents/:id        status + per-signer state
 *   GET    /api/v1/documents/:id/download   the document PDF (when completed)
 *   GET    /api/v1/documents/:id/audit  the tamper-evident audit certificate
 *   POST   /api/v1/documents/:id/void   cancel an in-flight document
 *   GET    /api/v1/templates            list the owned template library
 *   POST   /api/v1/detect               field-detection only (no signing)
 *   GET    /api/v1/me                   sanity-check the key + see the account
 *
 * Auth: Authorization: Bearer cs_live_…  (or X-API-Key). The key resolves to a
 * senderId; every document is created and read as that account, so plan limits,
 * branding, and webhook config all apply. Completion events are delivered via
 * the account's existing webhook config (doc.created / signer.completed /
 * doc.completed), configure it in the dashboard or via the worker webhook API.
 *
 * This module owns NO storage schema of its own, it composes the existing
 * doc/signing/detection/template machinery, injected as `deps` from index.js
 * so there is one source of truth for how a document is created and served.
 */

import { authenticateApiKey, createApiKey, listApiKeysByPartner, revokePartnerKey } from './apikeys.js';
import { detectFields } from './detect-server.js';
import { checkRateLimit, ipKey } from './rate-limit.js';
import { getStorage } from './storage.js';
import { listTemplates } from './templates-library.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

// ---- Rate limiting -----------------------------------------------------------
//
// /api/v1/* ran with no ceiling of any kind. That was survivable only while
// server-side detection was broken and every parse failed instantly. It now
// works, so POST /documents and POST /detect each run a real pdf.js parse,
// and one key could drive them flat out.
//
// SUBJECT: auth.senderId, not the key id and not the IP.
//   - Per IP is wrong for a server-to-server API. One customer behind one
//     egress address would throttle themselves, and a distributed caller
//     would not be limited at all.
//   - Per key id would let one account mint more keys to buy more budget.
//   - senderId is the account, and it already isolates partner tenants: each
//     tenant key is provisioned under its own `p-<partner>-<tenant>` namespace
//     (see provisionTenantKey below), so one tenant cannot spend another's.
//
// UNMETERED KEYS ARE STILL LIMITED, at a higher ceiling. `unmetered` is a
// BILLING flag ("this partner is not charged per document"), not a statement
// about capacity. An unmetered key that runs away burns exactly the same CPU
// and would degrade the Worker for every other account, so exempting it would
// aim the limiter away from the only keys allowed unlimited volume.
//
// Budgets are cost-weighted, because the routes are not equally expensive.
const RL_HEAVY = 'heavy';   // full pdf.js parse, roughly half a CPU second
const RL_MEDIUM = 'medium'; // reads stored bytes, may render an audit PDF
const RL_LIGHT = 'light';   // a KV read or a static list

const RL_POLICIES = {
  [RL_HEAVY]:  { metered: [{ windowSec: 60, max: 20 },  { windowSec: 3600, max: 300 }],
                 unmetered: [{ windowSec: 60, max: 60 },  { windowSec: 3600, max: 1500 }] },
  [RL_MEDIUM]: { metered: [{ windowSec: 60, max: 60 },  { windowSec: 3600, max: 600 }],
                 unmetered: [{ windowSec: 60, max: 180 }, { windowSec: 3600, max: 3000 }] },
  [RL_LIGHT]:  { metered: [{ windowSec: 60, max: 120 }, { windowSec: 3600, max: 2000 }],
                 unmetered: [{ windowSec: 60, max: 360 }, { windowSec: 3600, max: 6000 }] },
};

// Failed auth gets its own per-IP ceiling. A well-formed but wrong key costs a
// hash plus a KV read, so an unauthenticated flood is still work we pay for.
// A malformed key is rejected by a regex before any KV read (apikeys.js), so
// this only has to cover the well-formed-but-wrong case.
const RL_AUTHFAIL = [{ windowSec: 60, max: 30 }, { windowSec: 3600, max: 200 }];

function costTier(method, path) {
  if (method === 'POST' && (path === '/api/v1/documents' || path === '/api/v1/detect')) return RL_HEAVY;
  if (method === 'GET' && /^\/api\/v1\/documents\/[a-zA-Z0-9_-]+\/(download|audit)$/.test(path)) return RL_MEDIUM;
  return RL_LIGHT;
}

// Same body shape as rateLimitedResponse in rate-limit.js so a client sees one
// error contract across the whole product, but routed through this module's
// json() so the v1 security headers ride along too.
function rateLimited(verdict, endpoint) {
  return json(429, {
    error: 'rate_limited',
    message: `Too many requests${endpoint ? ` to ${endpoint}` : ''}. Try again in ${verdict.retryAfterSec} seconds.`,
    retryAfterSec: verdict.retryAfterSec,
  }, verdict.headers);
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Same baseline security headers as the main jsonResponse: this is a
      // public JSON API surface, never framed, never sniffed.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      ...(extraHeaders || {}),
    },
  });
}
function err(status, code, message) {
  return json(status, { error: code, message });
}

async function readBody(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return { __invalid: true };
  }
}

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function docStatus(doc) {
  if (!doc) return 'unknown';
  if (doc.voidedAt) return 'voided';
  if (doc.completedAt) return 'completed';
  const anySigned = Array.isArray(doc.signers) && doc.signers.some(s => s.completedAt);
  return anySigned ? 'partially_signed' : 'sent';
}

function publicDoc(doc, origin) {
  const status = docStatus(doc);
  return {
    id: doc.id,
    status,
    title: doc.title || 'Document',
    created_at: doc.createdAt || null,
    completed_at: doc.completedAt || null,
    voided_at: doc.voidedAt || null,
    signers: (doc.signers || []).map(s => ({
      id: s.id,
      name: s.name || null,
      email: s.email || null,
      status: s.completedAt ? 'signed' : (s.declinedAt ? 'declined' : 'pending'),
      signed_at: s.completedAt || null,
      order: s.order,
    })),
    download_url: status === 'completed' ? `${origin}/api/v1/documents/${doc.id}/download` : null,
    audit_url: status === 'completed' ? `${origin}/api/v1/documents/${doc.id}/audit` : null,
  };
}

async function loadOwnedDoc(env, docId, auth, deps) {
  const storage = getStorage(env);
  // Prefer the merged read (deps.loadDocMerged) so the paying API customer
  // sees signer ink/completion that the shared doc record may have lost to
  // a concurrent-write race but the per-signer subkey preserved. Falls back
  // to a raw read if the dependency was not injected.
  const doc = (deps && typeof deps.loadDocMerged === 'function')
    ? await deps.loadDocMerged(storage, docId)
    : await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return { error: err(404, 'not_found', 'Document not found.') };
  if (doc.senderId && auth.senderId && doc.senderId !== auth.senderId) {
    // Tenant isolation: a key may only see documents its own account created.
    return { error: err(403, 'forbidden', 'This document belongs to a different account.') };
  }
  return { doc, storage };
}

// ---- handlers --------------------------------------------------------------

async function createDocument(request, env, url, ctx, auth, deps) {
  const body = await readBody(request);
  if (body.__invalid) return err(400, 'invalid_json', 'Request body must be valid JSON.');

  // Resolve the source PDF: either an inline base64 PDF or a template slug.
  let pdfBytes = null;
  let pdfBase64 = null;
  if (body.pdf_base64) {
    try { pdfBytes = base64ToBytes(body.pdf_base64); }
    catch { return err(400, 'invalid_pdf', 'pdf_base64 did not decode to bytes.'); }
    pdfBase64 = String(body.pdf_base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  } else if (body.template) {
    const slug = String(body.template).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
    if (!slug) return err(400, 'invalid_template', 'template must be a valid slug.');
    const assetUrl = new URL(`/templates-pdf/${slug}.pdf`, url.origin).toString();
    let res = null;
    try { res = env.ASSETS ? await env.ASSETS.fetch(new Request(assetUrl)) : null; } catch { res = null; }
    if (!res || res.status !== 200) return err(404, 'template_not_found', `No template "${slug}".`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return err(404, 'template_not_found', `Template "${slug}" is empty.`);
    pdfBytes = buf;
    pdfBase64 = bytesToBase64(buf);
  } else {
    return err(400, 'missing_source', 'Provide either pdf_base64 or template.');
  }

  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    return err(413, 'payload_too_large', `PDF must be under ${MAX_PDF_BYTES} bytes.`);
  }

  // Signers.
  if (!Array.isArray(body.signers) || body.signers.length === 0) {
    return err(400, 'missing_signers', 'At least one signer { name, email } is required.');
  }
  if (body.signers.length > 20) return err(400, 'too_many_signers', 'Max 20 signers per document.');
  const signers = body.signers.map((s, i) => ({
    id: String(s.id || `s${i + 1}`),
    name: String(s.name || '').trim() || `Signer ${i + 1}`,
    email: String(s.email || '').trim(),
    order: Number.isFinite(s.order) ? s.order : i,
  }));
  for (const s of signers) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) {
      return err(400, 'invalid_signer_email', `Signer "${s.name}" needs a valid email.`);
    }
  }
  // Signer ids must be unique. The document model keys each signer's fills by
  // id, so two signers sharing one id wrote into the same slot and the document
  // reported itself fully executed after a single signature: a two-party
  // contract complete with one party's mark on it. This needs no malicious
  // caller either, since an explicit id of "s2" collides with the default
  // handed to the second signer.
  const seenSignerIds = new Set();
  for (const s of signers) {
    if (seenSignerIds.has(s.id)) {
      return err(400, 'duplicate_signer_id',
        `Two signers share the id "${s.id}". Signer ids must be unique within a document.`);
    }
    seenSignerIds.add(s.id);
  }

  // Fields: caller-supplied, or auto-detected from the PDF.
  let fields = Array.isArray(body.fields) && body.fields.length ? body.fields : null;
  if (!fields) {
    try {
      const result = await detectFields(pdfBytes);
      // "Could not read the PDF" and "read it, found nothing" are different
      // answers and the caller acts on them differently. detectFields RESOLVES
      // with { fields: [], error } rather than throwing, so treating a parse
      // failure as an empty result told an integrator their contract contains
      // no signature fields when the truth is we never parsed it.
      if (result && result.error) {
        return err(503, 'detection_unavailable',
          `Field detection could not read this PDF server-side (${String(result.error).slice(0, 120)}). Pass an explicit \`fields\` array to place them yourself.`);
      }
      fields = (result && result.fields) || [];
    } catch (e) {
      return err(422, 'detection_failed', 'Could not read fields from the PDF.');
    }
  }
  // Ensure every field has a stable id (the doc model keys assignments by it).
  fields = fields.map((f, i) => ({ ...f, id: String(f.id || `f${i + 1}`) }));
  if (fields.length === 0) {
    return err(422, 'no_fields_detected', 'No signature fields were found in this PDF. Pass an explicit `fields` array to place them yourself.');
  }

  // Assignments: caller-supplied (fieldId -> signerId), or default every field
  // to the first signer. Multi-party routing should pass explicit assignments.
  let assignments = (body.assignments && typeof body.assignments === 'object') ? body.assignments : null;
  if (assignments) {
    // `typeof [] === 'object'`, so an array used to be accepted here and then
    // silently routed nothing. Values were never checked against the signer list
    // either, so a typo in a signer id produced a document whose fields belonged
    // to nobody: it could never reach allDone and so never completed, with no
    // error at any point to say why.
    if (Array.isArray(assignments)) {
      return err(400, 'invalid_assignments',
        'assignments must be an object mapping field id to signer id, not an array.');
    }
    const fieldIds = new Set(fields.map(f => f.id));
    for (const [fieldId, signerId] of Object.entries(assignments)) {
      if (!fieldIds.has(fieldId)) {
        return err(400, 'invalid_assignments',
          `assignments references a field id that is not in this document: "${fieldId}".`);
      }
      if (!seenSignerIds.has(String(signerId))) {
        return err(400, 'invalid_assignments',
          `assignments routes field "${fieldId}" to an unknown signer id: "${signerId}".`);
      }
    }
  } else {
    assignments = {};
    for (const f of fields) assignments[f.id] = signers[0].id;
  }

  // CC + signing order pass straight through to the canonical creator.
  const internalPayload = {
    senderId: auth.senderId,
    pdfBase64,
    fields,
    signers,
    assignments,
    cc: Array.isArray(body.cc) ? body.cc : [],
    signingOrder: body.signing_order === 'sequential' ? 'sequential' : 'parallel',
    title: String(body.title || 'Document').slice(0, 200),
  };

  // Compose the existing, fully-tested creator. We give the synthetic request
  // the REAL origin so the magic links it builds resolve correctly, and JSON
  // content-type so readJsonBody parses it.
  const synthetic = new Request(`${url.origin}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(internalPayload),
  });
  // apiKeyed: the caller authenticated with an owner/partner-minted API key,
  // so the senderId is bound to the key and cannot be rotated. The free-tier
  // email-token requirement is a browser-flow control and does not apply;
  // the per-sender monthly cap still binds sub-less keys.
  const res = await deps.handleCreateDoc(synthetic, env, new URL(synthetic.url), ctx, { unmetered: !!auth.unmetered, apiKeyed: true });
  let created = null;
  try { created = await res.clone().json(); } catch { created = null; }
  if (res.status >= 400 || !created || !created.docId) {
    // Pass the upstream error through unchanged where possible.
    return json(res.status >= 400 ? res.status : 502, created || { error: 'create_failed', message: 'Document creation failed.' });
  }

  const v1signers = (created.signerLinks || []).map(s => ({
    id: s.id,
    name: s.name || null,
    email: s.email || null,
    status: 'pending',
    signing_url: s.magicLink || null,
  }));

  return json(201, {
    id: created.docId,
    status: internalPayload.signingOrder === 'sequential' ? 'sent' : 'sent',
    title: internalPayload.title,
    signing_order: internalPayload.signingOrder,
    field_count: fields.length,
    detected_fields: !body.fields,
    signers: v1signers,
    created_at: new Date().toISOString(),
    status_url: `${url.origin}/api/v1/documents/${created.docId}`,
    webhook_note: 'Subscribe to doc.completed via your account webhook to be notified when all signers finish.',
  });
}

async function getDocument(env, url, docId, auth, deps) {
  const { doc, error } = await loadOwnedDoc(env, docId, auth, deps);
  if (error) return error;
  return json(200, publicDoc(doc, url.origin));
}

async function downloadDocument(request, env, url, docId, auth, deps, kind) {
  const { doc, error } = await loadOwnedDoc(env, docId, auth, deps);
  if (error) return error;
  if (!doc.completedAt) {
    return err(409, 'not_completed', 'The document is not fully signed yet.');
  }
  const token = doc.signers && doc.signers[0] && doc.signers[0].token;
  if (!token) return err(500, 'no_token', 'Document has no signer token.');
  const u = new URL(`${url.origin}/x`);
  u.searchParams.set('t', token);
  // Reuse the token-gated handlers verbatim so the bytes + headers match
  // exactly what a signer would receive.
  //
  // /download MUST serve the flattened SIGNED document. It used to call
  // handleGetPdf, which reads `pdf:<id>`, the ORIGINAL uploaded bytes. So a
  // paying integrator polled until completed, downloaded what the docs call
  // "the flattened, signed PDF bytes, the same document a signer receives",
  // and got back the blank unsigned original. For an e-signature API that is
  // the product's core deliverable being wrong, not a cosmetic mismatch.
  // handleGetSignedPdf accepts the same ?t= signer token built above.
  return kind === 'audit'
    ? deps.handleGetAudit(request, env, docId, u)
    : deps.handleGetSignedPdf(request, env, docId, u);
}

async function voidDocument(env, url, docId, auth, deps) {
  const { doc, storage, error } = await loadOwnedDoc(env, docId, auth, deps);
  if (error) return error;
  if (doc.completedAt) return err(409, 'already_completed', 'A completed document cannot be voided.');
  if (doc.voidedAt) return json(200, publicDoc(doc, url.origin));
  doc.voidedAt = new Date().toISOString();
  try { await storage.docs.put(`doc:${docId}`, doc); } catch { /* best effort */ }
  // Drop it from the active index now rather than waiting for the hourly sweep
  // to notice. The sweep skips voided documents too, so this is belt and
  // braces: without either, cancelling a document stopped no reminders at all.
  if (deps && typeof deps.removeFromActiveIndex === 'function') {
    try { await deps.removeFromActiveIndex(storage, docId); } catch { /* best effort */ }
  }
  return json(200, publicDoc(doc, url.origin));
}

async function listTemplatesV1(env, url) {
  let items = [];
  try { items = await listTemplates(env); } catch { items = []; }
  const list = (items || []).map(t => ({
    slug: t.slug, title: t.title, group: t.group || t.groupLabel || null,
  }));
  return json(200, { count: list.length, templates: list });
}

async function detectOnly(request, env) {
  const body = await readBody(request);
  if (body.__invalid) return err(400, 'invalid_json', 'Request body must be valid JSON.');
  if (!body.pdf_base64) return err(400, 'missing_pdf', 'pdf_base64 is required.');
  let bytes;
  try { bytes = base64ToBytes(body.pdf_base64); }
  catch { return err(400, 'invalid_pdf', 'pdf_base64 did not decode to bytes.'); }
  if (bytes.byteLength > MAX_PDF_BYTES) return err(413, 'payload_too_large', 'PDF too large.');
  let result;
  try { result = await detectFields(bytes); }
  catch { return err(422, 'detection_failed', 'Could not read the PDF.'); }
  // detectFields RESOLVES with { fields: [], error } for an unreadable PDF, it
  // does not throw, so the catch above never sees that case. Without this the
  // endpoint answered 200 {"count": 0} for a document it could not open, which
  // reads as "this PDF has no fields" and is the exact misreport that hid
  // server-side detection being broken in the first place.
  if (result && result.error) {
    return err(503, 'detection_unavailable',
      `Field detection could not read this PDF server-side (${String(result.error).slice(0, 120)}).`);
  }
  const fields = (result && result.fields) || [];
  return json(200, {
    count: fields.length,
    fields: fields.map((f, i) => ({
      id: String(f.id || `f${i + 1}`),
      type: f.type, page: f.page,
      x: f.x, y: f.y, width: f.width, height: f.height,
      confidence: f.confidence, label: f.label || null,
    })),
  });
}

// ---- partner key provisioning (canProvision keys only) ---------------------

async function provisionTenantKey(request, env, auth) {
  if (!auth.canProvision) {
    return err(403, 'forbidden', 'This key cannot provision tenant keys. Use your partner master key.');
  }
  const body = await readBody(request);
  if (body.__invalid) return err(400, 'invalid_json', 'Request body must be valid JSON.');
  const tenantId = String(body.tenant_id || body.tenantId || '').trim();
  if (!tenantId) return err(400, 'missing_tenant', 'tenant_id is required (your end-customer id).');
  const partnerId = auth.partnerId || 'partner';
  // Each tenant gets its own senderId namespace so its documents stay isolated.
  //
  // That isolation was the opposite of what the code did. Stripping every
  // character outside [A-Za-z0-9_-] collapsed distinct tenants onto one
  // namespace: "acme:eu", "acme.eu", "acme eu", "acme/eu" and "acmeeu" all
  // became p-<partner>-acmeeu. Ownership in this API is checked by senderId,
  // so those tenants could read and void each other's documents. The 64
  // character truncation did the same to any two ids sharing a long prefix.
  //
  // Reject rather than mangle. A partner gets a clear 400 naming the rule
  // instead of a silently shared namespace they cannot detect.
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(tenantId)) {
    return err(400, 'invalid_tenant',
      'tenant_id must be 1 to 48 characters of letters, digits, underscore, or hyphen. ' +
      'Other characters were previously stripped, which could silently merge two tenants ' +
      'into one account namespace.');
  }
  const senderId = `p-${partnerId}-${tenantId}`;
  const made = await createApiKey(env, senderId, {
    label: String(body.label || `${partnerId}:${tenantId}`).slice(0, 80),
    unmetered: true,     // partner-issued tenant keys get full open access
    canProvision: false, // tenants cannot mint further keys
    partnerId, tenantId,
  });
  if (!made) return err(500, 'mint_failed', 'Could not provision a tenant key.');
  return json(201, {
    key: made.key,        // shown once
    key_id: made.id,
    tenant_id: tenantId,
    account: senderId,
    unmetered: true,
    created_at: made.createdAt,
    warning: 'Store this key now, it is shown only once.',
  });
}

async function listTenantKeys(env, auth) {
  if (!auth.canProvision) return err(403, 'forbidden', 'This key cannot list tenant keys.');
  const keys = await listApiKeysByPartner(env, auth.partnerId || 'partner');
  return json(200, { count: keys.length, keys });
}

async function revokeTenantKey(request, env, auth) {
  if (!auth.canProvision) return err(403, 'forbidden', 'This key cannot revoke tenant keys.');
  const body = await readBody(request);
  if (body.__invalid) return err(400, 'invalid_json', 'Request body must be valid JSON.');
  const keyId = String(body.key_id || body.keyId || '').trim();
  if (!keyId) return err(400, 'missing_key_id', 'key_id is required.');
  const okRevoke = await revokePartnerKey(env, auth.partnerId || 'partner', keyId);
  // The 404 carries the standard error envelope. This endpoint used to answer
  // an unknown key_id with `{ "revoked": false }` and no `error` field, so a
  // client switching on `error` (which is the documented contract for every
  // other route) read undefined and could not tell a miss from a success.
  // The status was always 404, so status-based handling is unaffected.
  //
  // DELIBERATE: `revoked: false` is NOT kept alongside the error fields for
  // backward compatibility. An error body carrying a success-shaped field is
  // how the confusion started: a caller reads `revoked` and never notices
  // there is an `error` next to it. Dropping it makes the two shapes
  // disjoint, so a failure cannot be mistaken for a quiet no-op. The blast
  // radius is one integrator at most: this route is partner-master-only
  // (canProvision, checked above) and keys are issued by hand.
  if (!okRevoke) {
    return err(404, 'key_not_found', `No tenant key with key_id "${keyId.slice(0, 80)}".`);
  }
  return json(200, { revoked: true });
}

// ---- router ----------------------------------------------------------------

/**
 * Entry point. Returns a Response for any /api/v1/* path, or null if the path
 * is not a v1 path (so index.js can fall through to its other routes).
 * `deps` = { handleCreateDoc, handleGetPdf, handleGetAudit, handleGetSignedPdf }
 * from index.js.
 */
export async function routeApiV1(request, env, url, ctx, deps) {
  const path = url.pathname;
  if (!path.startsWith('/api/v1/') && path !== '/api/v1') return null;

  // Everything under v1 requires a valid API key.
  const auth = await authenticateApiKey(request, env);
  if (!auth) {
    // Throttle the failure path per IP. Without this an attacker can spend our
    // KV read budget forever on well-formed keys that resolve to nothing.
    const bad = await checkRateLimit(env, `v1auth:${ipKey(request)}`, RL_AUTHFAIL);
    if (!bad.ok) return rateLimited(bad, '/api/v1');
    return err(401, 'unauthorized', 'Provide a valid API key as `Authorization: Bearer cs_live_…` or `X-API-Key`.');
  }

  const method = request.method;

  // Cost-weighted ceiling, charged to the account behind the key. Runs before
  // any route dispatch so the expensive work is never started, and buckets per
  // tier so a burst of cheap status polls cannot lock out a document send.
  const tier = costTier(method, path);
  const rl = await checkRateLimit(
    env,
    `v1:${tier}:${auth.senderId}`,
    RL_POLICIES[tier][auth.unmetered ? 'unmetered' : 'metered'],
  );
  if (!rl.ok) return rateLimited(rl, path);

  if (path === '/api/v1/me' && method === 'GET') {
    return json(200, { ok: true, account: auth.senderId, key_id: auth.keyId, mode: auth.mode });
  }
  if (path === '/api/v1/documents' && method === 'POST') {
    return createDocument(request, env, url, ctx, auth, deps);
  }
  if (path === '/api/v1/templates' && method === 'GET') {
    return listTemplatesV1(env, url);
  }
  if (path === '/api/v1/detect' && method === 'POST') {
    return detectOnly(request, env);
  }

  // Partner provisioning: mint/list/revoke individualized unmetered tenant keys.
  // Only a key with canProvision (the partner master, held server-side by e.g.
  // Vyan) may use these. Tenant keys it issues are unmetered but cannot provision.
  if (path === '/api/v1/keys') {
    if (method === 'POST') return provisionTenantKey(request, env, auth);
    if (method === 'GET') return listTenantKeys(env, auth);
    if (method === 'DELETE') return revokeTenantKey(request, env, auth);
    return err(405, 'method_not_allowed', `${method} is not allowed on ${path}.`);
  }

  const docMatch = path.match(/^\/api\/v1\/documents\/([a-zA-Z0-9_-]+)(\/(download|audit|void))?$/);
  if (docMatch) {
    const docId = docMatch[1];
    const action = docMatch[3] || null;
    if (!action && method === 'GET') return getDocument(env, url, docId, auth, deps);
    if (action === 'download' && method === 'GET') return downloadDocument(request, env, url, docId, auth, deps, 'pdf');
    if (action === 'audit' && method === 'GET') return downloadDocument(request, env, url, docId, auth, deps, 'audit');
    if (action === 'void' && method === 'POST') return voidDocument(env, url, docId, auth, deps);
    return err(405, 'method_not_allowed', `${method} is not allowed on ${path}.`);
  }

  return err(404, 'not_found', `No v1 route for ${method} ${path}.`);
}
