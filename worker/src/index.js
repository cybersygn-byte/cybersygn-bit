/**
 * CyberSygn detection worker.
 *
 * POST /detect
 *   body: PDF binary (application/pdf) or multipart/form-data with a "file" part
 *   returns: { pageCount, fields: [...] }
 *
 * POST /api/signup
 *   body: { email, context?, source? }
 *   returns: { ok: true, message }
 *   Persists when a KV binding (env.SIGNUPS) is configured; otherwise logs
 *   for development and still returns ok so the UX is not blocked.
 *
 * POST /api/event
 *   body: { event, props? }
 *   returns: { ok: true }
 *   Self-hosted analytics sink. Stores nothing by default; intended as
 *   the binding point for a Workers Analytics Engine dataset.
 *
 * GET /api/status
 *   returns: { ok: true, service: "cybersygn-detect", version }
 *
 * Per Section 1.9, every external read has a timeout, every JSON.parse is
 * guarded, and every error path returns a useful error response.
 */

import { detectFields } from './detect.js';
import { getStorage } from './storage.js';
import { sendInvite, sendCompletion, sendReminder } from './email.js';
import { recordEvent, sha256Hex, renderAuditCertificate } from './audit.js';
import { isOwnerPhrase, issueOwnerToken, validateOwnerToken, getOwnerForRequest } from './owner.js';
import { trackEvent, trackError, summary as analyticsSummary } from './analytics.js';
import {
  TIERS,
  getSubscription,
  getUsageThisMonth,
  incrementUsage,
  checkFreeTierAllowance,
  getFoundingCount,
  foundingCap,
  createCheckoutSession,
  createBillingPortalSession,
  verifyStripeSignature,
  applyStripeEvent,
} from './stripe.js';

const VERSION = '0.2.0';
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB ceiling for Phase 1
const DETECTION_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 256 * 1024; // larger now: doc creation payload includes signers + assignments
const DOC_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const storage = getStorage(env);
      return jsonResponse(200, {
        ok: true,
        service: 'cybersygn',
        version: VERSION,
        storage: storage.mode,
        email: env && env.RESEND_API_KEY ? 'resend' : 'console',
      });
    }

    if (request.method === 'POST' && url.pathname === '/detect') {
      return handleDetect(request);
    }

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      return handleSignup(request, env);
    }

    // ---- Owner backdoor ------------------------------------------------
    // POST /api/owner/claim  body: { phrase: "..." } -> { ok, token } or 401
    // GET  /api/owner/verify  with X-CyberSygn-Owner header -> { ok, owner }
    if (request.method === 'POST' && url.pathname === '/api/owner/claim') {
      return handleOwnerClaim(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/verify') {
      return handleOwnerVerify(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/event') {
      return handleEvent(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/error') {
      return handleClientError(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/analytics/summary') {
      return handleAnalyticsSummary(request, env, url);
    }

    // ---- Billing -------------------------------------------------------
    // POST /api/checkout/create-session  body: { tier, senderId, email? } -> { url }
    // POST /api/stripe/webhook            raw Stripe event body
    // GET  /api/billing/portal?senderId=...                            -> { url }
    // GET  /api/billing/subscription?senderId=...                      -> { tier, status, usage, founding }
    // GET  /api/billing/founding-count                                 -> { taken, cap, remaining }
    if (request.method === 'POST' && url.pathname === '/api/checkout/create-session') {
      return handleCheckoutCreateSession(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') {
      return handleStripeWebhook(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/portal') {
      return handleBillingPortal(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/subscription') {
      return handleBillingSubscription(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/founding-count') {
      return handleFoundingCount(env);
    }

    // ---- Multi-signer routes ------------------------------------------

    // Create a document: persist PDF + signers + assignments, mint per-signer
    // tokens, and email each signer their magic link.
    if (request.method === 'POST' && url.pathname === '/api/docs') {
      return handleCreateDoc(request, env, url);
    }

    // Per-signer hydration: GET /api/docs/:docId/signer/:token
    // Returns the signer's name, the fields they own, and a presigned
    // pointer to the original PDF.
    const signerMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)$/);
    if (request.method === 'GET' && signerMatch) {
      return handleHydrateSigner(request, env, signerMatch[1], signerMatch[2]);
    }

    // Signer submits their fills.
    const fillsMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)\/fills$/);
    if (request.method === 'POST' && fillsMatch) {
      return handleSubmitFills(request, env, fillsMatch[1], fillsMatch[2], url);
    }

    // Fetch the original PDF for an authenticated signer.
    const pdfMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/pdf$/);
    if (request.method === 'GET' && pdfMatch) {
      return handleGetPdf(request, env, pdfMatch[1], url);
    }

    // Fetch the audit-certificate PDF. Same token auth as the PDF
    // endpoint, so any signer can pull the certificate; in production
    // the sender's account would also unlock it.
    const auditMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/audit$/);
    if (request.method === 'GET' && auditMatch) {
      return handleGetAudit(request, env, auditMatch[1], url);
    }

    // ---- Workspaces ----------------------------------------------------

    // Create a workspace. POST /api/workspaces  -> { workspaceId, workspaceToken, adminMemberId }
    if (request.method === 'POST' && url.pathname === '/api/workspaces') {
      return handleCreateWorkspace(request, env);
    }

    // Workspace doc list. GET /api/workspaces/:wsId/docs?w=workspaceToken
    const wsDocsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/docs$/);
    if (request.method === 'GET' && wsDocsMatch) {
      return handleListWorkspaceDocs(env, wsDocsMatch[1], url);
    }

    // Member list. GET /api/workspaces/:wsId/members?w=workspaceToken
    const wsMembersMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members$/);
    if (request.method === 'GET' && wsMembersMatch) {
      return handleListWorkspaceMembers(env, wsMembersMatch[1], url);
    }

    // Create an invite. POST /api/workspaces/:wsId/invites?w=workspaceToken
    //   body: { email?, name? }
    //   returns: { inviteId, inviteUrl }
    const wsInviteMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/invites$/);
    if (request.method === 'POST' && wsInviteMatch) {
      return handleCreateInvite(request, env, wsInviteMatch[1], url);
    }

    // Accept an invite. POST /api/invites/:inviteId
    //   body: { senderId, name?, email? }
    //   returns: { workspaceId, workspaceToken, memberId, name }
    const acceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
    if (request.method === 'POST' && acceptMatch) {
      return handleAcceptInvite(request, env, acceptMatch[1]);
    }

    // Read an invite (so the join page can render workspace name).
    // GET /api/invites/:inviteId
    if (request.method === 'GET' && acceptMatch) {
      return handleGetInvite(env, acceptMatch[1]);
    }

    // Sender dashboard: list every doc this sender has created.
    // GET /api/sender/:senderId/docs
    const senderListMatch = url.pathname.match(/^\/api\/sender\/([^/]+)\/docs$/);
    if (request.method === 'GET' && senderListMatch) {
      return handleListSenderDocs(env, senderListMatch[1]);
    }

    // Sender-triggered reminder for a specific signer.
    // POST /api/docs/:docId/remind/:signerId
    const remindMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/remind\/([^/]+)$/);
    if (request.method === 'POST' && remindMatch) {
      return handleRemind(request, env, remindMatch[1], remindMatch[2], url);
    }

    // Sender's view of progress for one of their docs (no auth in
    // Phase 1; in production this is keyed on the sender's account).
    const docMatch = url.pathname.match(/^\/api\/docs\/([^/]+)$/);
    if (request.method === 'GET' && docMatch) {
      return handleGetDocProgress(env, docMatch[1], url);
    }

    // ---- Static assets fall-through ----------------------------------
    // The Worker handles /api/*. Everything else (HTML, CSS, JS, fonts,
    // images) is served by the static assets binding configured in
    // wrangler.jsonc. This is what makes CyberSygn a single deployment:
    // one Worker, one domain, one custom URL.
    //
    // In local dev without `env.ASSETS` (e.g. node-based test harness),
    // we still need to return *something* for API misses, so we 404 only
    // for /api/* paths and surface a clear message for everything else.
    if (url.pathname.startsWith('/api/')) {
      return jsonResponse(404, {
        error: 'not_found',
        message: 'No route matches this URL.',
      });
    }
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  /**
   * Scheduled handler. Wired to a Cloudflare cron trigger in wrangler.toml
   * (every hour). Walks every active doc and sends reminders to pending
   * signers whose backoff window has elapsed:
   *
   *    first reminder  at 24 hours after invite (or last reminder)
   *    second reminder at 72 hours
   *    final reminder  at 7 days
   *
   * Each signer's lastReminderAt and reminderCount are bumped so we
   * never double-send within a window. Documents older than 14 days are
   * skipped (their KV record will expire on its 30-day TTL anyway).
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderSweep(env, event));
  },
};

async function handleDetect(request) {
  // 1. Pull the PDF bytes out of the request body.
  let pdfBytes;
  try {
    pdfBytes = await readPdfBody(request);
  } catch (e) {
    return jsonResponse(400, {
      error: 'bad_request',
      message: e.message,
    });
  }

  if (pdfBytes.byteLength === 0) {
    return jsonResponse(400, {
      error: 'empty_body',
      message: 'No PDF data found in the request.',
    });
  }
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    return jsonResponse(413, {
      error: 'too_large',
      message: `Document is over the ${MAX_PDF_BYTES / 1024 / 1024} MB limit for detection.`,
    });
  }

  // 2. Run detection with a hard timeout.
  let result;
  try {
    result = await withTimeout(detectFields(pdfBytes), DETECTION_TIMEOUT_MS);
  } catch (e) {
    const code = e && e.name === 'TimeoutError' ? 504 : 422;
    return jsonResponse(code, {
      error: code === 504 ? 'detection_timeout' : 'detection_failed',
      message:
        code === 504
          ? 'Detection took longer than expected. Try a smaller document.'
          : `Could not read this document: ${e && e.message ? e.message : 'unknown error'}.`,
    });
  }

  return jsonResponse(200, result);
}

// ---- Body parsing -----------------------------------------------------------

async function readPdfBody(request) {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();

  if (contentType.startsWith('application/pdf')) {
    const buf = await request.arrayBuffer();
    return new Uint8Array(buf);
  }

  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new Error('multipart form missing a "file" part with PDF data.');
    }
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  if (contentType.startsWith('application/octet-stream') || contentType === '') {
    // Treat as raw PDF bytes; the magic header check below will catch non-PDFs.
    const buf = await request.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.length < 4 || !looksLikePdf(bytes)) {
      throw new Error('Body does not appear to be a PDF (missing %PDF header).');
    }
    return bytes;
  }

  throw new Error(
    `Unsupported content-type "${contentType}". Send application/pdf or multipart/form-data.`,
  );
}

function looksLikePdf(bytes) {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

// ---- Helpers ---------------------------------------------------------------

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      const err = new Error(`Operation timed out after ${ms} ms.`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    promise.then(
      v => {
        clearTimeout(id);
        resolve(v);
      },
      e => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

// ---- /api/signup -----------------------------------------------------------

async function handleSignup(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const { email, context, source } = body.value || {};
  if (!isValidEmail(email)) {
    return jsonResponse(400, {
      error: 'invalid_email',
      message: 'A valid email address is required.',
    });
  }

  const record = {
    email: email.trim().toLowerCase(),
    context: typeof context === 'string' ? context.slice(0, 500) : null,
    source: typeof source === 'string' ? source.slice(0, 80) : 'unknown',
    receivedAt: new Date().toISOString(),
    userAgent: (request.headers.get('user-agent') || '').slice(0, 200),
    ip: request.headers.get('cf-connecting-ip') || null,
  };

  // Persist if a KV binding is configured (set up in wrangler.toml as
  // SIGNUPS = kv_namespace). If not, log and continue. We never block the
  // user on storage we have not yet provisioned.
  try {
    if (env && env.SIGNUPS && typeof env.SIGNUPS.put === 'function') {
      const key = `${record.receivedAt}-${record.email}`;
      await env.SIGNUPS.put(key, JSON.stringify(record));
    } else {
      console.log('[signup]', JSON.stringify(record));
    }
  } catch (err) {
    console.error('[signup] persist failed:', err);
    // Still return ok. Losing one signup is better than visibly failing.
  }

  return jsonResponse(200, {
    ok: true,
    message: 'You are on the founding list. We will email you when there is something worth saying.',
  });
}

// ---- /api/owner/claim, /api/owner/verify ----------------------------------

async function handleOwnerClaim(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const phrase = typeof body.value?.phrase === 'string' ? body.value.phrase.trim() : '';
  if (!phrase) {
    return jsonResponse(400, { error: 'missing_phrase', message: 'Phrase is required.' });
  }
  const ok = await isOwnerPhrase(phrase, env);
  if (!ok) {
    // Same response shape and similar timing as success to keep the
    // backdoor unobservable from response timing alone.
    await new Promise((resolve) => setTimeout(resolve, 80));
    return jsonResponse(401, { error: 'invalid_phrase', message: 'That phrase does not match.' });
  }
  const record = await issueOwnerToken(env);
  return jsonResponse(200, {
    ok: true,
    token: record.token,
    issuedAt: record.issuedAt,
    role: record.role,
    unmetered: record.unmetered,
  });
}

async function handleOwnerVerify(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    return jsonResponse(401, { ok: false, owner: null });
  }
  return jsonResponse(200, {
    ok: true,
    owner: {
      role: owner.role,
      unmetered: owner.unmetered,
      issuedAt: owner.issuedAt,
    },
  });
}

// ---- Billing handlers ------------------------------------------------------

async function handleCheckoutCreateSession(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { tier, senderId, email } = body.value || {};

  if (!tier || !TIERS[tier] || tier === 'free') {
    return jsonResponse(400, {
      error: 'invalid_tier',
      message: 'Pick one of: solo, founding, team.',
    });
  }
  if (!senderId || typeof senderId !== 'string') {
    return jsonResponse(400, {
      error: 'missing_sender',
      message: 'A senderId is required so we can match payment to your account.',
    });
  }
  const safeSenderId = senderId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeSenderId) {
    return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });
  }

  // Owner mode short-circuit: owners do not pay. Return a synthetic URL
  // that the client treats as "already entitled, redirect to dashboard."
  const owner = await getOwnerForRequest(request, env, url);
  if (owner) {
    return jsonResponse(200, {
      url: `${url.protocol}//${url.host}/dashboard/?checkout=owner&tier=${tier}`,
      owner: true,
    });
  }

  const origin = `${url.protocol}//${url.host}`;
  try {
    const session = await createCheckoutSession(env, {
      tier,
      senderId: safeSenderId,
      email: typeof email === 'string' ? email.trim() : undefined,
      origin,
    });
    return jsonResponse(200, { url: session.url, sessionId: session.sessionId });
  } catch (err) {
    const code = err && err.code || 'checkout_failed';
    const status = code === 'founding_full' ? 409
                 : code === 'not_configured' || code === 'missing_price' ? 503
                 : code === 'invalid_tier' ? 400
                 : 502;
    return jsonResponse(status, {
      error: code,
      message: err && err.message || 'Could not start checkout.',
    });
  }
}

async function handleStripeWebhook(request, env) {
  if (!env || typeof env.STRIPE_WEBHOOK_SECRET !== 'string' || !env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse(503, {
      error: 'webhook_not_configured',
      message: 'STRIPE_WEBHOOK_SECRET is not set.',
    });
  }
  const sigHeader = request.headers.get('stripe-signature');
  let payload;
  try {
    payload = await request.text();
  } catch {
    return jsonResponse(400, { error: 'bad_body', message: 'Could not read webhook body.' });
  }
  if (payload.length > 1024 * 1024) {
    return jsonResponse(413, { error: 'too_large', message: 'Webhook payload exceeds 1 MB.' });
  }

  const verified = await verifyStripeSignature({
    payload,
    header: sigHeader,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  if (!verified) {
    return jsonResponse(401, { error: 'invalid_signature', message: 'Webhook signature did not verify.' });
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return jsonResponse(400, { error: 'invalid_json', message: 'Webhook body is not JSON.' });
  }

  try {
    const result = await applyStripeEvent(env, event);
    return jsonResponse(200, { received: true, ...result });
  } catch (err) {
    console.error('[stripe:webhook]', err && err.message);
    // Return 200 so Stripe does not endlessly retry on a logic bug we
    // can fix in the next deploy. The event is already marked seen so
    // the next retry would also be a no-op.
    return jsonResponse(200, { received: true, applied: false, error: err && err.message });
  }
}

async function handleBillingPortal(request, env, url) {
  const senderId = url.searchParams.get('senderId');
  if (!senderId) {
    return jsonResponse(400, { error: 'missing_sender', message: 'senderId is required.' });
  }
  const safeSenderId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

  const owner = await getOwnerForRequest(request, env, url);
  if (owner) {
    return jsonResponse(200, {
      url: `${url.protocol}//${url.host}/dashboard/?portal=owner`,
      owner: true,
    });
  }

  const returnUrl = `${url.protocol}//${url.host}/dashboard/`;
  try {
    const session = await createBillingPortalSession(env, { senderId: safeSenderId, returnUrl });
    return jsonResponse(200, { url: session.url });
  } catch (err) {
    const code = err && err.code || 'portal_failed';
    const status = code === 'no_customer' ? 404
                 : code === 'not_configured' ? 503
                 : 502;
    return jsonResponse(status, {
      error: code,
      message: err && err.message || 'Could not open the billing portal.',
    });
  }
}

async function handleBillingSubscription(request, env, url) {
  const senderId = url.searchParams.get('senderId') || '';
  const safeSenderId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

  const owner = await getOwnerForRequest(request, env, url);
  if (owner) {
    return jsonResponse(200, {
      tier: 'owner',
      status: 'active',
      unmetered: true,
      usage: { used: 0, cap: null, remaining: null, month: null },
    });
  }

  const sub = await getSubscription(env, safeSenderId);
  const used = await getUsageThisMonth(env, safeSenderId);
  const cap = TIERS[sub.tier]?.docs ?? TIERS.free.docs;
  return jsonResponse(200, {
    tier: sub.tier,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    foundingNumber: sub.foundingNumber || null,
    usage: {
      used,
      cap: cap === Infinity ? null : cap,
      remaining: cap === Infinity ? null : Math.max(0, cap - used),
      month: new Date().toISOString().slice(0, 7),
    },
  });
}

async function handleFoundingCount(env) {
  const taken = await getFoundingCount(env);
  const cap = foundingCap();
  return jsonResponse(200, {
    taken,
    cap,
    remaining: Math.max(0, cap - taken),
  });
}

// ---- /api/event ------------------------------------------------------------

async function handleEvent(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const { event, props } = body.value || {};
  if (typeof event !== 'string' || event.length === 0 || event.length > 80) {
    return jsonResponse(400, {
      error: 'invalid_event',
      message: 'An "event" string between 1 and 80 characters is required.',
    });
  }

  // Pull a few standard fields out of props for first-class storage in
  // the Analytics Engine schema. Everything else is dropped (we deliberately
  // do not store arbitrary props as JSON blobs to keep cardinality sane).
  const p = props && typeof props === 'object' ? props : {};
  await trackEvent(env, event, {
    request,
    senderId: typeof p.senderId === 'string' ? p.senderId : '',
    source:   typeof p.source   === 'string' ? p.source   : '',
    path:     typeof p.path     === 'string' ? p.path     : '',
    tier:     typeof p.tier     === 'string' ? p.tier     : 'free',
    value:    typeof p.value    === 'number' ? p.value    : 0,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
  });

  return jsonResponse(200, { ok: true });
}

// ---- /api/error ------------------------------------------------------------

async function handleClientError(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const { context, message, name, stack, props } = body.value || {};
  if (typeof context !== 'string' || context.length === 0 || context.length > 80) {
    return jsonResponse(400, {
      error: 'invalid_error',
      message: 'A "context" string between 1 and 80 characters is required.',
    });
  }
  const fakeErr = new Error(typeof message === 'string' ? message : 'unknown');
  fakeErr.name = typeof name === 'string' ? name : 'ClientError';
  if (typeof stack === 'string') fakeErr.stack = stack;

  const p = props && typeof props === 'object' ? props : {};
  await trackError(env, context, fakeErr, {
    request,
    senderId: typeof p.senderId === 'string' ? p.senderId : '',
    source:   typeof p.source   === 'string' ? p.source   : '',
    path:     typeof p.path     === 'string' ? p.path     : '',
    tier:     typeof p.tier     === 'string' ? p.tier     : 'free',
  });
  return jsonResponse(200, { ok: true });
}

// ---- /api/analytics/summary ------------------------------------------------

async function handleAnalyticsSummary(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    return jsonResponse(401, {
      error: 'unauthorized',
      message: 'Owner mode required to query the analytics summary.',
    });
  }
  const windowParam = url.searchParams.get('window');
  const safeWindow = /^INTERVAL\s+'\d{1,3}'\s+(MINUTE|HOUR|DAY)$/i.test(windowParam || '')
    ? windowParam
    : "INTERVAL '7' DAY";
  const data = await analyticsSummary(env, { window: safeWindow });
  return jsonResponse(200, { ok: true, ...data });
}

// ---- Multi-signer handlers -------------------------------------------------

/**
 * Create a new document for signing.
 *
 * Request body:
 *   {
 *     title?: string,                       // optional, for emails
 *     pdfBase64: string,                    // base64-encoded original PDF
 *     senderName?: string,
 *     fields: [{ id, page, x, y, width, height, type, label, confidence }],
 *     signers: [{ id, name, email }],
 *     assignments: { [fieldId]: signerId },
 *   }
 *
 * Response:
 *   {
 *     docId,
 *     signerLinks: [{ signerId, name, email, token, magicLink, sent: bool }],
 *     storage: 'kv' | 'memory',
 *     email:   'resend' | 'console',
 *   }
 *
 * Side effects: PDF stored, doc record persisted, one invite email sent per
 * signer with a valid email address.
 */
async function handleCreateDoc(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value;

  // Owner check: when set, the doc gets stamped unmetered and bypasses
  // any tier-limit checks. The owner token comes from the
  // X-CyberSygn-Owner header (preferred) or ?owner= query param.
  const owner = await getOwnerForRequest(request, env, url);

  // Resolve the canonical senderId early so the free-tier gate can read
  // the right usage counter. Anonymous creators (no senderId) are
  // synthesized below; gating them is what stops the obvious bypass
  // ("just don't send a senderId"). We synthesize one *before* the gate
  // and re-use that same id for the rest of the function.
  const providedSenderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const senderId = providedSenderId || randomId(16);

  // Free-tier gate. Owners always bypass. Paid tiers (solo / founding /
  // team with status=active) bypass. Free tier is capped at TIERS.free.docs
  // documents per UTC calendar month per senderId. We check before we
  // do any expensive work (PDF decode, KV writes, email dispatch).
  if (!owner) {
    const gate = await checkFreeTierAllowance(env, senderId);
    if (!gate.allowed) {
      return jsonResponse(402, {
        error: 'free_tier_limit',
        message: `You have used all ${gate.cap} free documents this month. Upgrade to keep signing.`,
        usage: { used: gate.used, cap: gate.cap, remaining: 0 },
        upgrade: { tiers: ['solo', 'founding', 'team'] },
      });
    }
  }

  // Validation. Bail early with a useful message rather than half-creating a doc.
  if (!payload.pdfBase64 || typeof payload.pdfBase64 !== 'string') {
    return jsonResponse(400, { error: 'missing_pdf', message: 'pdfBase64 is required.' });
  }
  if (!Array.isArray(payload.fields) || payload.fields.length === 0) {
    return jsonResponse(400, { error: 'missing_fields', message: 'fields array is required.' });
  }
  if (!Array.isArray(payload.signers) || payload.signers.length === 0) {
    return jsonResponse(400, { error: 'missing_signers', message: 'At least one signer is required.' });
  }
  if (!payload.assignments || typeof payload.assignments !== 'object') {
    return jsonResponse(400, { error: 'missing_assignments', message: 'assignments map is required.' });
  }

  // Decode the PDF (base64 has ~33% overhead so the raw bytes may still
  // exceed our 25 MB ceiling).
  let pdfBytes;
  try {
    pdfBytes = base64ToBytes(payload.pdfBase64);
  } catch {
    return jsonResponse(400, { error: 'invalid_pdf', message: 'pdfBase64 did not decode to bytes.' });
  }
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    return jsonResponse(413, {
      error: 'payload_too_large',
      message: `PDF must be under ${MAX_PDF_BYTES} bytes.`,
    });
  }

  const docId = randomId(16);
  const senderToken = randomId(32);
  // senderId is computed above for the free-tier gate; reused here so
  // the doc, the usage counter, and the gate decision agree on the same
  // identity.
  //
  // Optional workspace: when present, the doc is also indexed under
  // workspace:<id>:docs so every member of the workspace can see it.
  const workspaceId = String(payload.workspaceId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null;
  const storage = getStorage(env);

  // Build the doc record. Each signer gets a fresh random token so the
  // magic-link URL is unguessable.
  const signers = payload.signers.map(s => ({
    id: String(s.id),
    name: String(s.name || '').trim() || 'Signer',
    email: String(s.email || '').trim(),
    token: randomId(32),
    fills: {}, // populated as the signer submits
    completedAt: null,
  }));

  const docRecord = {
    id: docId,
    createdAt: new Date().toISOString(),
    title: String(payload.title || 'Document').slice(0, 200),
    senderName: String(payload.senderName || 'A CyberSygn sender').slice(0, 80),
    senderId,
    senderToken,
    workspaceId,
    fields: payload.fields,
    // Sender field edits made in the preview UI before send.
    // Shape: { [fieldId]: { type?, primary?, deleted?, lastSnapshot?, history? } }
    // Replayed by the audit certificate renderer so the cert reflects
    // what the sender actually decided.
    fieldEdits: (payload.fieldEdits && typeof payload.fieldEdits === 'object')
      ? payload.fieldEdits
      : {},
    assignments: payload.assignments,
    signers,
    completedAt: null,
    events: [],
    pdfSha256: await sha256Hex(pdfBytes),
    ownerCreated: owner ? true : false,
    mode: typeof payload.mode === 'string' && payload.mode === 'in-person' ? 'in-person' : 'send',
  };

  if (owner) {
    recordEvent(docRecord, { type: 'owner-mode', request, meta: { role: owner.role } });
  }

  recordEvent(docRecord, { type: 'created', request, meta: { signerCount: signers.length, fieldCount: payload.fields.length } });

  // If the sender made edits in the preview UI, log a single roll-up event
  // so the event log records that automatic detection was overridden.
  const editCount = Object.keys(docRecord.fieldEdits).length;
  if (editCount > 0) {
    let typeChanges = 0, deletions = 0, primaryChanges = 0;
    for (const overlay of Object.values(docRecord.fieldEdits)) {
      if (overlay.deleted) deletions++;
      else {
        if (typeof overlay.type === 'string') typeChanges++;
        if (typeof overlay.primary === 'boolean') primaryChanges++;
      }
    }
    recordEvent(docRecord, {
      type: 'sender-edits',
      request,
      meta: { editCount, typeChanges, deletions, primaryChanges },
    });
  }

  await storage.docs.put(`doc:${docId}`, docRecord, { expirationTtl: DOC_TTL_SECONDS });
  await storage.pdfs.put(`pdf:${docId}`, pdfBytes.buffer, { expirationTtl: DOC_TTL_SECONDS });
  await addToActiveIndex(storage, docId);
  await addToSenderIndex(storage, senderId, docId);
  if (workspaceId) {
    await addToWorkspaceIndex(storage, workspaceId, docId);
  }

  // Meter free-tier docs against this month's counter. Owner-created docs
  // and docs from paid senders are never metered. Best-effort: a missed
  // increment is preferable to refusing a doc the user already created.
  if (!owner) {
    const subForMeter = await getSubscription(env, senderId);
    if (!(subForMeter.status === 'active' && subForMeter.tier !== 'free')) {
      await incrementUsage(env, senderId);
    }
  }

  // Build magic links and dispatch invites in parallel.
  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  const signerLinks = await Promise.all(signers.map(async s => {
    const magicLink = `${baseUrl}/preview/?doc=${docId}&t=${s.token}`;
    let sent = false;
    let error = null;
    if (isValidEmail(s.email)) {
      const result = await sendInvite(env, {
        to: s.email,
        name: s.name,
        docTitle: docRecord.title,
        magicLink,
        senderName: docRecord.senderName,
      });
      sent = !!result.delivered;
      if (!sent) error = result.error || 'send failed';
    }
    return {
      signerId: s.id,
      name: s.name,
      email: s.email,
      token: s.token,
      magicLink,
      sent,
      error,
    };
  }));

  return jsonResponse(201, {
    docId,
    senderId,
    senderToken,
    signerLinks,
    storage: storage.mode,
    email: env && env.RESEND_API_KEY ? 'resend' : 'console',
  });
}

/**
 * Hydrate a signer's view. Returns only what that signer needs: their
 * name, the fields they own, and a presigned URL for the original PDF.
 * Tokens are validated against the persisted signer record.
 */
async function handleHydrateSigner(request, env, docId, token) {
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signer = doc.signers.find(s => ctEqHex(s.token, token));
  if (!signer) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });

  // Record a 'viewed' event. We deduplicate within a short window so a
  // signer hitting refresh does not pollute the log; the meaningful
  // event is the first view per session.
  const last = (doc.events || []).slice().reverse().find(e => e.signerId === signer.id && e.type === 'viewed');
  const dedupeWindowMs = 5 * 60 * 1000;
  if (!last || (Date.now() - new Date(last.at).getTime()) > dedupeWindowMs) {
    recordEvent(doc, { type: 'viewed', signerId: signer.id, request });
    await storage.docs.put(`doc:${docId}`, doc, { expirationTtl: DOC_TTL_SECONDS });
  }

  const ownedFieldIds = new Set(
    Object.entries(doc.assignments)
      .filter(([, sId]) => sId === signer.id)
      .map(([fId]) => fId),
  );
  const ownedFields = doc.fields.filter(f => ownedFieldIds.has(f.id));

  return jsonResponse(200, {
    docId,
    title: doc.title,
    senderName: doc.senderName,
    signer: { id: signer.id, name: signer.name, email: signer.email },
    fields: ownedFields,
    pdfUrl: `/api/docs/${docId}/pdf?t=${token}`,
    fills: signer.fills,
    completed: !!signer.completedAt,
    allComplete: !!doc.completedAt,
  });
}

/**
 * Submit a signer's filled values. Accepts a map of fieldId -> fill
 * object identical to the client-side fillStore values. Marks the
 * signer complete if every field they own is now filled, and the
 * document complete if every signer is now done.
 */
async function handleSubmitFills(request, env, docId, token, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signerIdx = doc.signers.findIndex(s => ctEqHex(s.token, token));
  if (signerIdx < 0) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });
  const signer = doc.signers[signerIdx];

  const fills = (body.value && body.value.fills) || {};
  if (typeof fills !== 'object' || Array.isArray(fills)) {
    return jsonResponse(400, { error: 'invalid_fills', message: 'fills must be an object.' });
  }

  // Only accept fills for fields this signer owns.
  const ownedSet = new Set(
    Object.entries(doc.assignments)
      .filter(([, sId]) => sId === signer.id)
      .map(([fId]) => fId),
  );

  const accepted = {};
  for (const [fid, value] of Object.entries(fills)) {
    if (!ownedSet.has(fid)) continue;
    if (!value || typeof value !== 'object') continue;
    accepted[fid] = value;
  }

  signer.fills = { ...signer.fills, ...accepted };

  const ownedCount = ownedSet.size;
  const filledCount = Object.keys(signer.fills).length;
  const wasSignerComplete = Boolean(signer.completedAt);
  if (ownedCount > 0 && filledCount >= ownedCount) {
    signer.completedAt = new Date().toISOString();
  }

  // Record one 'signed' event per submission so the audit log shows
  // each progressive save the signer made.
  if (Object.keys(accepted).length > 0) {
    recordEvent(doc, {
      type: 'signed',
      signerId: signer.id,
      request,
      meta: {
        fillCount: Object.keys(accepted).length,
        completed: Boolean(signer.completedAt) && !wasSignerComplete,
      },
    });
  }

  // Check whether every signer is now complete.
  const allDone = doc.signers.every(s => {
    const ownedForS = Object.values(doc.assignments).filter(sId => sId === s.id).length;
    if (ownedForS === 0) return true; // a signer with no fields is trivially complete
    return Boolean(s.completedAt);
  });
  if (allDone && !doc.completedAt) {
    doc.completedAt = new Date().toISOString();
    recordEvent(doc, { type: 'completed', request });
  }

  doc.signers[signerIdx] = signer;
  await storage.docs.put(`doc:${docId}`, doc, { expirationTtl: DOC_TTL_SECONDS });
  if (allDone) await removeFromActiveIndex(storage, docId);

  // On full completion: generate the audit certificate and persist it
  // so download requests do not need to re-render. Best-effort; if
  // rendering fails, the doc is still complete and the certificate can
  // be regenerated on demand.
  let auditUrl = null;
  if (allDone) {
    try {
      const certBytes = await renderAuditCertificate({ doc, pdfSha256: doc.pdfSha256 });
      await storage.pdfs.put(`audit:${docId}`, certBytes.buffer, { expirationTtl: DOC_TTL_SECONDS });
      auditUrl = `/api/docs/${docId}/audit?t=${doc.signers[0].token}`;
    } catch (err) {
      console.error('[audit] render failed:', err && err.message);
    }
  }

  // Fire completion emails to every signer when the whole doc is done.
  let completionEmails = null;
  if (allDone) {
    const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
    const downloadUrl = `${baseUrl}/preview/?doc=${docId}&t=${doc.signers[0].token}`;
    const auditAbsoluteUrl = auditUrl ? `${baseUrl}${auditUrl}` : null;
    completionEmails = await Promise.all(doc.signers.filter(s => isValidEmail(s.email)).map(s =>
      sendCompletion(env, {
        to: s.email,
        name: s.name,
        docTitle: doc.title,
        downloadUrl,
        auditUrl: auditAbsoluteUrl,
      }).then(r => ({ to: s.email, ...r })),
    ));
  }

  return jsonResponse(200, {
    accepted: Object.keys(accepted).length,
    signerComplete: Boolean(signer.completedAt),
    docComplete: Boolean(doc.completedAt),
    auditUrl,
    completionEmails,
  });
}

/**
 * Stream the original PDF back to an authenticated signer.
 * Validates the token against the persisted doc.
 */
async function handleGetPdf(request, env, docId, url) {
  const token = url.searchParams.get('t');
  if (!token) return jsonResponse(400, { error: 'missing_token', message: 'A signing token is required.' });

  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signer = doc.signers.find(s => ctEqHex(s.token, token));
  if (!signer) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });

  const pdf = await storage.pdfs.get(`pdf:${docId}`, { arrayBuffer: true });
  if (!pdf) return jsonResponse(404, { error: 'pdf_missing', message: 'Original PDF not found in storage.' });

  return new Response(pdf, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, no-store',
    },
  });
}

/**
 * Stream the audit-certificate PDF back to an authenticated signer.
 * If the certificate has not been cached yet (e.g. the doc completed
 * before this code shipped), render it on demand.
 */
async function handleGetAudit(request, env, docId, url) {
  const token = url.searchParams.get('t');
  if (!token) return jsonResponse(400, { error: 'missing_token', message: 'A signing token is required.' });

  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signer = doc.signers.find(s => ctEqHex(s.token, token));
  if (!signer) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });

  let cert = await storage.pdfs.get(`audit:${docId}`, { arrayBuffer: true });
  if (!cert) {
    // Generate on demand. Use the persisted SHA-256 if present;
    // otherwise compute it from the stored PDF bytes.
    let pdfSha = doc.pdfSha256;
    if (!pdfSha) {
      const original = await storage.pdfs.get(`pdf:${docId}`, { arrayBuffer: true });
      if (original) pdfSha = await sha256Hex(original);
    }
    try {
      const bytes = await renderAuditCertificate({ doc, pdfSha256: pdfSha || '(unavailable)' });
      cert = bytes.buffer;
      await storage.pdfs.put(`audit:${docId}`, cert, { expirationTtl: DOC_TTL_SECONDS });
    } catch (err) {
      console.error('[audit] on-demand render failed:', err && err.message);
      return jsonResponse(500, { error: 'render_failed', message: 'Could not render the audit certificate.' });
    }
  }

  const filename = `cybersygn-audit-${docId.slice(0, 8)}.pdf`;
  return new Response(cert, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'private, no-store',
    },
  });
}

/**
 * Sender's view of a document's progress. Returns per-signer
 * completion status without exposing individual signer tokens.
 */
/**
 * Sender's view of a document's progress.
 *
 * Without a senderToken: returns the public progress shape (status per
 * signer, no tokens). Anyone with the docId can hit this; the doc id
 * is itself a 128-bit secret, so it's authoritative enough for the
 * sender to bookmark, but it never reveals signer tokens.
 *
 * With a valid senderToken (?s=): also includes per-signer magicLink
 * and the audit URL when the doc is complete. This is what the
 * dashboard uses to render the "Copy link" and "Download audit"
 * buttons after the fact.
 */
async function handleGetDocProgress(env, docId, url) {
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const senderToken = url && url.searchParams.get('s');
  const isSender = senderToken && doc.senderToken && ctEqHex(senderToken, doc.senderToken);
  const baseUrl = (url && `${url.protocol}//${url.host}`) || '';

  const progress = doc.signers.map(s => {
    const owned = Object.values(doc.assignments).filter(sId => sId === s.id).length;
    const filled = Object.keys(s.fills || {}).length;
    const row = {
      signerId: s.id,
      name: s.name,
      email: s.email,
      owned,
      filled,
      complete: !!s.completedAt,
      reminderCount: s.reminderCount || 0,
      lastReminderAt: s.lastReminderAt || null,
    };
    if (isSender) {
      row.magicLink = `${baseUrl}/preview/?doc=${docId}&t=${s.token}`;
    }
    return row;
  });

  const response = {
    docId,
    title: doc.title,
    createdAt: doc.createdAt,
    completedAt: doc.completedAt,
    progress,
    doc: {
      id: docId,
      title: doc.title,
      createdAt: doc.createdAt,
      completedAt: doc.completedAt,
      mode: doc.mode || 'send',
      ownerCreated: !!doc.ownerCreated,
    },
  };
  if (isSender && doc.completedAt) {
    response.auditUrl = `${baseUrl}/api/docs/${docId}/audit?t=${doc.signers[0].token}`;
    response.signedPdfUrl = `${baseUrl}/api/docs/${docId}/pdf?t=${doc.signers[0].token}`;
  }
  return jsonResponse(200, response);
}

// ---- Reminders -------------------------------------------------------------

const REMINDER_SCHEDULE = [
  // hoursSinceLast, tone, marker
  { afterHours: 24,  tone: 'first',  marker: 'r1' },
  { afterHours: 72,  tone: 'second', marker: 'r2' },
  { afterHours: 168, tone: 'final',  marker: 'r3' }, // 7 days
];

const REMINDER_HARD_CAP = 3;       // never more than 3 reminders per signer
const DOC_SWEEP_MAX_AGE_HOURS = 14 * 24; // skip docs older than 14 days

// Best-effort lock to prevent overlapping cron triggers from double-
// sending reminders. The TTL needs to be longer than any plausible
// sweep duration but short enough that a crashed sweep does not
// silently block the next window.
const REMINDER_LOCK_KEY = 'lock:reminder-sweep';
const REMINDER_LOCK_TTL_SECONDS = 10 * 60;          // 10 minutes
const REMINDER_LOCK_STALE_MS = REMINDER_LOCK_TTL_SECONDS * 1000;

/**
 * Sender-triggered reminder for a single pending signer.
 *
 * Anyone with the docId can hit this endpoint in Phase 1; in production
 * this is gated by the sender's session. We rate-limit by signer:
 * one manual reminder per hour, regardless of the cron schedule.
 */
async function handleRemind(request, env, docId, signerId, url) {
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signer = doc.signers.find(s => s.id === signerId);
  if (!signer) return jsonResponse(404, { error: 'no_signer', message: 'Signer not found on this document.' });
  if (signer.completedAt) return jsonResponse(409, { error: 'already_complete', message: 'This signer is already done.' });
  if (!isValidEmail(signer.email)) {
    return jsonResponse(400, { error: 'no_email', message: 'This signer has no email on file. Copy the magic link manually.' });
  }

  // Manual rate limit: one minute apart. Hours-based limit applies for
  // auto reminders only; manual is intentionally permissive so a sender
  // can re-nudge after a phone call without waiting.
  const lastAt = signer.lastReminderAt ? new Date(signer.lastReminderAt).getTime() : 0;
  if (Date.now() - lastAt < 60 * 1000) {
    return jsonResponse(429, {
      error: 'too_soon',
      message: 'Please wait a minute before sending another reminder.',
    });
  }

  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  const magicLink = `${baseUrl}/preview/?doc=${docId}&t=${signer.token}`;
  const tone = (signer.reminderCount || 0) >= 2 ? 'final'
              : (signer.reminderCount || 0) >= 1 ? 'second'
              : 'first';

  const result = await sendReminder(env, {
    to: signer.email,
    name: signer.name,
    docTitle: doc.title,
    magicLink,
    senderName: doc.senderName,
    tone,
  });

  if (result.delivered) {
    signer.lastReminderAt = new Date().toISOString();
    signer.reminderCount = (signer.reminderCount || 0) + 1;
    recordEvent(doc, {
      type: 'reminder',
      signerId: signer.id,
      request,
      meta: { tone, source: 'manual', count: signer.reminderCount },
    });
    await storage.docs.put(`doc:${docId}`, doc, { expirationTtl: DOC_TTL_SECONDS });
  }

  return jsonResponse(result.delivered ? 200 : 502, {
    delivered: result.delivered,
    tone,
    reminderCount: signer.reminderCount,
    mode: result.mode,
    error: result.error,
  });
}

/**
 * Walk every active doc and send overdue reminders. Called from
 * scheduled() on the cron schedule defined in wrangler.toml.
 *
 * A best-effort KV lock prevents overlapping cron triggers from double-
 * sending reminders (Cloudflare can occasionally fire the same cron on
 * two edge locations in quick succession). The lock is advisory: if KV
 * is unavailable we proceed anyway, on the theory that occasionally
 * double-sending a reminder is less bad than silently skipping a sweep
 * because the lock primitive is broken.
 *
 * Returns { docsScanned, remindersSent, errors, skipped? }.
 */
export async function runReminderSweep(env) {
  const storage = getStorage(env);

  // ---- Acquire the lock (best-effort) ------------------------------------
  let lockAcquired = false;
  try {
    const existing = await storage.docs.get(REMINDER_LOCK_KEY, { json: true });
    if (existing && typeof existing.heldAt === 'number'
        && (Date.now() - existing.heldAt) < REMINDER_LOCK_STALE_MS) {
      console.log('[cybersygn:reminder-sweep] skipped: lock held by another instance');
      return { docsScanned: 0, remindersSent: 0, errors: [], skipped: true };
    }
    await storage.docs.put(
      REMINDER_LOCK_KEY,
      { heldAt: Date.now() },
      { expirationTtl: REMINDER_LOCK_TTL_SECONDS },
    );
    lockAcquired = true;
  } catch (err) {
    console.log(
      '[cybersygn:reminder-sweep] lock unavailable, proceeding:',
      String(err && err.message || err),
    );
  }

  try {
    const index = (await storage.docs.get('index:active', { json: true })) || { docs: [] };

    const results = { docsScanned: 0, remindersSent: 0, errors: [] };
    const nowMs = Date.now();
    const baseUrl = (env && env.CYBERSYGN_APP_URL) || 'http://localhost:8787';
    const stillActive = [];

    for (const docId of index.docs) {
      const doc = await storage.docs.get(`doc:${docId}`, { json: true });
      if (!doc) continue; // expired or deleted; drop from index
      if (doc.completedAt) continue; // completed; drop from index

      // Skip docs past the sweep horizon.
      const createdMs = new Date(doc.createdAt).getTime();
      const ageHours = (nowMs - createdMs) / (3600 * 1000);
      if (ageHours > DOC_SWEEP_MAX_AGE_HOURS) {
        stillActive.push(docId);
        continue;
      }

      results.docsScanned++;
      let mutated = false;

      for (const signer of doc.signers) {
        if (signer.completedAt) continue;
        if (!isValidEmail(signer.email)) continue;
        if ((signer.reminderCount || 0) >= REMINDER_HARD_CAP) continue;

        const ownedForS = Object.values(doc.assignments).filter(sId => sId === signer.id).length;
        if (ownedForS === 0) continue; // nothing to remind about

        const lastRef = signer.lastReminderAt
          ? new Date(signer.lastReminderAt).getTime()
          : new Date(doc.createdAt).getTime();
        const hoursSinceLast = (nowMs - lastRef) / (3600 * 1000);
        const nextStep = REMINDER_SCHEDULE[signer.reminderCount || 0];
        if (!nextStep) continue;
        if (hoursSinceLast < nextStep.afterHours) continue;

        const magicLink = `${baseUrl}/preview/?doc=${doc.id}&t=${signer.token}`;
        try {
          const r = await sendReminder(env, {
            to: signer.email,
            name: signer.name,
            docTitle: doc.title,
            magicLink,
            senderName: doc.senderName,
            tone: nextStep.tone,
          });
          if (r.delivered) {
            signer.lastReminderAt = new Date().toISOString();
            signer.reminderCount = (signer.reminderCount || 0) + 1;
            recordEvent(doc, {
              type: 'reminder',
              signerId: signer.id,
              meta: { tone: nextStep.tone, source: 'cron', count: signer.reminderCount },
            });
            mutated = true;
            results.remindersSent++;
          } else {
            results.errors.push({ docId, signerId: signer.id, error: r.error || 'send failed' });
          }
        } catch (err) {
          results.errors.push({ docId, signerId: signer.id, error: String(err && err.message || err) });
        }
      }

      if (mutated) {
        await storage.docs.put(`doc:${docId}`, doc, { expirationTtl: DOC_TTL_SECONDS });
      }
      stillActive.push(docId);
    }

    // Rewrite the index with only still-active docs.
    await storage.docs.put('index:active', { docs: stillActive });
    console.log('[cybersygn:reminder-sweep]', JSON.stringify(results));
    return results;
  } finally {
    // ---- Release the lock (best-effort) ----------------------------------
    if (lockAcquired) {
      try { await storage.docs.delete(REMINDER_LOCK_KEY); } catch {}
    }
  }
}

// ---- Workspaces -----------------------------------------------------------

const INVITE_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const MEMBER_HARD_CAP = 25;

/**
 * Create a new workspace.
 *
 * Body:
 *   {
 *     name?: string,
 *     adminSenderId: string,        // localStorage senderId of the creator
 *     adminName?: string,
 *     adminEmail?: string,
 *   }
 *
 * Response:
 *   {
 *     workspaceId,
 *     workspaceToken,   // member-shared token, opens read access
 *     adminMemberId,
 *   }
 *
 * The workspaceToken is shared by every member of the workspace. It
 * lives in localStorage on each member's device, alongside the
 * senderId. In production an account would replace this.
 */
async function handleCreateWorkspace(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value;

  const adminSenderId = String(payload.adminSenderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!adminSenderId) {
    return jsonResponse(400, { error: 'missing_sender', message: 'adminSenderId is required.' });
  }

  const workspaceId = randomId(16);
  const workspaceToken = randomId(32);
  const adminMemberId = randomId(12);

  const workspace = {
    id: workspaceId,
    name: String(payload.name || 'Untitled workspace').slice(0, 80),
    token: workspaceToken,
    createdAt: new Date().toISOString(),
    members: [{
      memberId: adminMemberId,
      senderId: adminSenderId,
      name: String(payload.adminName || 'Owner').slice(0, 80),
      email: String(payload.adminEmail || '').trim().slice(0, 200),
      role: 'admin',
      joinedAt: new Date().toISOString(),
    }],
  };

  const storage = getStorage(env);
  await storage.docs.put(`workspace:${workspaceId}`, workspace);
  await storage.docs.put(`workspace:${workspaceId}:docs`, { docs: [] });

  return jsonResponse(201, {
    workspaceId,
    workspaceToken,
    adminMemberId,
    name: workspace.name,
  });
}

/**
 * List docs visible to the workspace. Anyone holding the workspaceToken
 * sees the aggregated list (every doc any member sent, plus enough
 * sender context to know who created it).
 */
async function handleListWorkspaceDocs(env, workspaceId, url) {
  const storage = getStorage(env);
  const ws = await storage.docs.get(`workspace:${workspaceId}`, { json: true });
  if (!ws) return jsonResponse(200, { workspaceId, docs: [], members: [] });

  const token = url.searchParams.get('w');
  if (!token || !ctEqHex(token, ws.token)) {
    return jsonResponse(403, { error: 'invalid_token', message: 'Workspace token required.' });
  }

  const index = (await storage.docs.get(`workspace:${workspaceId}:docs`, { json: true })) || { docs: [] };
  const rows = [];
  const expired = [];
  for (const docId of index.docs) {
    const doc = await storage.docs.get(`doc:${docId}`, { json: true });
    if (!doc) { expired.push(docId); continue; }

    let totalOwned = 0;
    let totalFilled = 0;
    let signersComplete = 0;
    for (const s of doc.signers) {
      const owned = Object.values(doc.assignments).filter(sId => sId === s.id).length;
      totalOwned += owned;
      totalFilled += Object.keys(s.fills || {}).length;
      if (s.completedAt) signersComplete++;
    }

    // Resolve the member who created this doc, by senderId.
    const member = (ws.members || []).find(m => m.senderId === doc.senderId);

    rows.push({
      docId: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      completedAt: doc.completedAt,
      senderToken: doc.senderToken,
      createdBy: member
        ? { memberId: member.memberId, name: member.name, email: member.email }
        : { memberId: null, name: doc.senderName || 'Unknown member', email: '' },
      signers: doc.signers.length,
      signersComplete,
      totalOwned,
      totalFilled,
      lastEventAt: (doc.events && doc.events.length) ? doc.events[doc.events.length - 1].at : doc.createdAt,
    });
  }

  if (expired.length > 0) {
    const next = { docs: index.docs.filter(id => !expired.includes(id)) };
    await storage.docs.put(`workspace:${workspaceId}:docs`, next);
  }

  return jsonResponse(200, {
    workspaceId: ws.id,
    name: ws.name,
    docs: rows,
    members: ws.members.map(m => ({
      memberId: m.memberId,
      name: m.name,
      email: m.email,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
  });
}

/**
 * Lightweight member list. Same auth shape as docs.
 */
async function handleListWorkspaceMembers(env, workspaceId, url) {
  const storage = getStorage(env);
  const ws = await storage.docs.get(`workspace:${workspaceId}`, { json: true });
  if (!ws) return jsonResponse(404, { error: 'not_found', message: 'Workspace not found.' });
  const token = url.searchParams.get('w');
  if (!token || !ctEqHex(token, ws.token)) {
    return jsonResponse(403, { error: 'invalid_token', message: 'Workspace token required.' });
  }
  return jsonResponse(200, {
    workspaceId: ws.id,
    name: ws.name,
    members: ws.members.map(m => ({
      memberId: m.memberId,
      name: m.name,
      email: m.email,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
  });
}

/**
 * Create an invite to join this workspace. Token auth is the
 * workspaceToken (any member can invite; in production this is
 * narrowed to the admin role).
 *
 * The returned inviteId is a one-time-use token that expires in 14
 * days. The accept call consumes it.
 */
async function handleCreateInvite(request, env, workspaceId, url) {
  const storage = getStorage(env);
  const ws = await storage.docs.get(`workspace:${workspaceId}`, { json: true });
  if (!ws) return jsonResponse(404, { error: 'not_found', message: 'Workspace not found.' });
  const token = url.searchParams.get('w');
  if (!token || !ctEqHex(token, ws.token)) {
    return jsonResponse(403, { error: 'invalid_token', message: 'Workspace token required.' });
  }
  if ((ws.members || []).length >= MEMBER_HARD_CAP) {
    return jsonResponse(409, { error: 'workspace_full', message: `This workspace has reached the ${MEMBER_HARD_CAP}-member limit.` });
  }

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const inviteId = randomId(20);
  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  const invite = {
    id: inviteId,
    workspaceId,
    workspaceName: ws.name,
    invitedEmail: String(body.value.email || '').trim().slice(0, 200),
    invitedName: String(body.value.name || '').trim().slice(0, 80),
    createdAt: new Date().toISOString(),
    consumed: false,
  };
  await storage.docs.put(`invite:${inviteId}`, invite, { expirationTtl: INVITE_TTL_SECONDS });

  const inviteUrl = `${baseUrl}/dashboard/join.html?invite=${inviteId}`;

  // Best-effort email. We reuse the existing invite-style email
  // template but with workspace context. If no email is on the invite,
  // the caller gets the URL only.
  let delivered = false;
  if (isValidEmail(invite.invitedEmail)) {
    const result = await sendInvite(env, {
      to: invite.invitedEmail,
      name: invite.invitedName || 'Hello',
      docTitle: `Join ${ws.name} on CyberSygn`,
      magicLink: inviteUrl,
      senderName: ws.name,
    });
    delivered = !!result.delivered;
  }

  return jsonResponse(201, { inviteId, inviteUrl, delivered });
}

async function handleGetInvite(env, inviteId) {
  const storage = getStorage(env);
  const invite = await storage.docs.get(`invite:${inviteId}`, { json: true });
  if (!invite) return jsonResponse(404, { error: 'not_found', message: 'Invite not found or expired.' });
  if (invite.consumed) return jsonResponse(410, { error: 'already_used', message: 'This invite has already been used.' });
  return jsonResponse(200, {
    inviteId,
    workspaceName: invite.workspaceName,
    invitedName: invite.invitedName,
    invitedEmail: invite.invitedEmail,
  });
}

/**
 * Accept an invite, joining the workspace.
 *
 * Body: { senderId, name?, email? }
 * Returns: { workspaceId, workspaceToken, memberId, name }
 */
async function handleAcceptInvite(request, env, inviteId) {
  const storage = getStorage(env);
  const invite = await storage.docs.get(`invite:${inviteId}`, { json: true });
  if (!invite) return jsonResponse(404, { error: 'not_found', message: 'Invite not found or expired.' });
  if (invite.consumed) return jsonResponse(410, { error: 'already_used', message: 'This invite has already been used.' });

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const senderId = String(body.value.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender', message: 'senderId is required.' });

  const ws = await storage.docs.get(`workspace:${invite.workspaceId}`, { json: true });
  if (!ws) return jsonResponse(404, { error: 'not_found', message: 'Workspace no longer exists.' });

  // If the senderId is already a member (re-clicking the same invite),
  // just return their existing membership rather than duplicating.
  let member = (ws.members || []).find(m => m.senderId === senderId);
  if (!member) {
    if ((ws.members || []).length >= MEMBER_HARD_CAP) {
      return jsonResponse(409, { error: 'workspace_full', message: 'This workspace is full.' });
    }
    member = {
      memberId: randomId(12),
      senderId,
      name: String(body.value.name || invite.invitedName || 'Member').slice(0, 80),
      email: String(body.value.email || invite.invitedEmail || '').trim().slice(0, 200),
      role: 'member',
      joinedAt: new Date().toISOString(),
    };
    ws.members.push(member);
    await storage.docs.put(`workspace:${invite.workspaceId}`, ws);
  }

  // Consume the invite. We persist consumed: true rather than deleting
  // so a refresh of the join page shows a clear "already used" message.
  invite.consumed = true;
  invite.consumedAt = new Date().toISOString();
  invite.consumedBy = member.memberId;
  await storage.docs.put(`invite:${inviteId}`, invite, { expirationTtl: INVITE_TTL_SECONDS });

  return jsonResponse(200, {
    workspaceId: ws.id,
    workspaceToken: ws.token,
    workspaceName: ws.name,
    memberId: member.memberId,
    name: member.name,
  });
}

async function addToWorkspaceIndex(storage, workspaceId, docId) {
  const key = `workspace:${workspaceId}:docs`;
  const index = (await storage.docs.get(key, { json: true })) || { docs: [] };
  if (!index.docs.includes(docId)) {
    index.docs.unshift(docId);
    if (index.docs.length > 500) index.docs.length = 500;
    await storage.docs.put(key, index);
  }
}

// ---- Active + sender indexes (existing) -----------------------------------

async function addToActiveIndex(storage, docId) {
  const index = (await storage.docs.get('index:active', { json: true })) || { docs: [] };
  if (!index.docs.includes(docId)) {
    index.docs.push(docId);
    await storage.docs.put('index:active', index);
  }
}

async function removeFromActiveIndex(storage, docId) {
  const index = (await storage.docs.get('index:active', { json: true })) || { docs: [] };
  const next = { docs: index.docs.filter(id => id !== docId) };
  if (next.docs.length !== index.docs.length) {
    await storage.docs.put('index:active', next);
  }
}

async function addToSenderIndex(storage, senderId, docId) {
  const key = `sender:${senderId}:docs`;
  const index = (await storage.docs.get(key, { json: true })) || { docs: [] };
  if (!index.docs.includes(docId)) {
    // Newest first.
    index.docs.unshift(docId);
    // Cap to a reasonable size; KV value limits and sender ergonomics
    // both reward keeping this small. 200 docs is far beyond any
    // founding-member's near-term usage.
    if (index.docs.length > 200) index.docs.length = 200;
    await storage.docs.put(key, index);
  }
}

/**
 * Sender dashboard list. Returns every doc this senderId has created,
 * newest first, with summary status. No authentication beyond the
 * senderId itself: the senderId is a 256-bit random token stored in
 * the sender's localStorage and never transmitted in URLs by the
 * client (always passed as a path segment), so guessing one is on
 * the same difficulty curve as guessing a doc id.
 *
 * In production this would be replaced by a real session-bound list;
 * the same endpoint signature works for both.
 */
async function handleListSenderDocs(env, senderId) {
  const storage = getStorage(env);
  const safeId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });

  const index = (await storage.docs.get(`sender:${safeId}:docs`, { json: true })) || { docs: [] };
  const rows = [];
  const expiredDocIds = [];
  for (const docId of index.docs) {
    const doc = await storage.docs.get(`doc:${docId}`, { json: true });
    if (!doc) { expiredDocIds.push(docId); continue; }

    let totalOwned = 0;
    let totalFilled = 0;
    let signersComplete = 0;
    for (const s of doc.signers) {
      const owned = Object.values(doc.assignments).filter(sId => sId === s.id).length;
      totalOwned += owned;
      totalFilled += Object.keys(s.fills || {}).length;
      if (s.completedAt) signersComplete++;
    }
    rows.push({
      docId: doc.id,
      title: doc.title,
      createdAt: doc.createdAt,
      completedAt: doc.completedAt,
      senderToken: doc.senderToken, // we already validated the sender owns this index entry
      signers: doc.signers.length,
      signersComplete,
      totalOwned,
      totalFilled,
      lastEventAt: (doc.events && doc.events.length) ? doc.events[doc.events.length - 1].at : doc.createdAt,
    });
  }

  // Clean the index if any docs expired.
  if (expiredDocIds.length > 0) {
    const next = { docs: index.docs.filter(id => !expiredDocIds.includes(id)) };
    await storage.docs.put(`sender:${safeId}:docs`, next);
  }

  return jsonResponse(200, { senderId: safeId, docs: rows });
}

// ---- Crypto helpers --------------------------------------------------------

function randomId(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time equality compare for lowercase hex strings (signer,
 * sender, and workspace tokens are all 64-char hex from randomId(32)).
 *
 * The length-mismatch early return leaks length only — fine here because
 * the expected length is fixed and known. Past the length check, the XOR
 * accumulator runs the full string and returns based on the OR'd diff,
 * so the time taken does not depend on where the first mismatching byte
 * sits. Avoids timing-side-channel signal on token validation.
 */
function ctEqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64ToBytes(b64) {
  // atob is available in Workers. Strip data URL prefix if present.
  const raw = b64.includes(',') ? b64.split(',')[1] : b64;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- JSON body parsing -----------------------------------------------------

async function readJsonBody(request) {
  // Stream the body and enforce a true byte cap. Trusting the
  // content-length header lets a hostile client declare a tiny size and
  // ship a much larger payload; by reading the stream chunk-by-chunk we
  // bail the moment the cap is exceeded, regardless of what the headers
  // claim.
  if (!request.body) return { value: {} };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        try { await reader.cancel(); } catch {}
        return {
          error: { error: 'payload_too_large', message: `Body exceeds ${MAX_JSON_BYTES} bytes.` },
        };
      }
      chunks.push(value);
    }
  } catch {
    return { error: { error: 'bad_request', message: 'Could not read request body.' } };
  }

  if (total === 0) return { value: {} };

  // Concatenate then UTF-8 decode.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  } catch {
    return { error: { error: 'bad_request', message: 'Could not decode request body.' } };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: { error: 'invalid_json', message: 'Request body is not valid JSON.' } };
  }
  if (!value || typeof value !== 'object') {
    return { error: { error: 'invalid_json', message: 'Request body must be a JSON object.' } };
  }
  return { value };
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
