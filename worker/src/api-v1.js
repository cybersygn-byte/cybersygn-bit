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
 * doc.completed) — configure it in the dashboard or via the worker webhook API.
 *
 * This module owns NO storage schema of its own — it composes the existing
 * doc/signing/detection/template machinery, injected as `deps` from index.js
 * so there is one source of truth for how a document is created and served.
 */

import { authenticateApiKey, createApiKey, listApiKeysByPartner, revokePartnerKey } from './apikeys.js';
import { detectFields } from './detect.js';
import { getStorage } from './storage.js';
import { listTemplates } from './templates-library.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

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

  // Fields: caller-supplied, or auto-detected from the PDF.
  let fields = Array.isArray(body.fields) && body.fields.length ? body.fields : null;
  if (!fields) {
    try {
      const result = await detectFields(pdfBytes);
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
  if (!assignments) {
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
  return kind === 'audit'
    ? deps.handleGetAudit(request, env, docId, u)
    : deps.handleGetPdf(request, env, docId, u);
}

async function voidDocument(env, url, docId, auth, deps) {
  const { doc, storage, error } = await loadOwnedDoc(env, docId, auth, deps);
  if (error) return error;
  if (doc.completedAt) return err(409, 'already_completed', 'A completed document cannot be voided.');
  if (doc.voidedAt) return json(200, publicDoc(doc, url.origin));
  doc.voidedAt = new Date().toISOString();
  try { await storage.docs.put(`doc:${docId}`, doc); } catch { /* best effort */ }
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
  const senderId = `p-${partnerId}-${tenantId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
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
    warning: 'Store this key now — it is shown only once.',
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
  return json(okRevoke ? 200 : 404, { revoked: okRevoke });
}

// ---- router ----------------------------------------------------------------

/**
 * Entry point. Returns a Response for any /api/v1/* path, or null if the path
 * is not a v1 path (so index.js can fall through to its other routes).
 * `deps` = { handleCreateDoc, handleGetPdf, handleGetAudit } from index.js.
 */
export async function routeApiV1(request, env, url, ctx, deps) {
  const path = url.pathname;
  if (!path.startsWith('/api/v1/') && path !== '/api/v1') return null;

  // Everything under v1 requires a valid API key.
  const auth = await authenticateApiKey(request, env);
  if (!auth) {
    return err(401, 'unauthorized', 'Provide a valid API key as `Authorization: Bearer cs_live_…` or `X-API-Key`.');
  }

  const method = request.method;

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
