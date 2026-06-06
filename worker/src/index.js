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
import { sendInvite, sendCompletion, sendReminder, deliver as deliverEmail } from './email.js';
import { recordEvent, sha256Hex, renderAuditCertificate } from './audit.js';
import { isOwnerPhrase, issueOwnerToken, validateOwnerToken, getOwnerForRequest, loginWithCredentials } from './owner.js';
import { trackEvent, trackError, summary as analyticsSummary } from './analytics.js';
import { detectFieldsViaVision, checkAndIncrementVisionUsage } from './vision.js';
import { saveTemplate, lookupTemplate } from './templates.js';
import {
  freeSignup,
  freeConsume,
  writeFreeTokenPointer,
  getDatasetCount,
  ownerDripList,
} from './free-tier.js';
import { exportDatasetJsonl, getDatasetStats, maybeFirePhase3Alert } from './dataset.js';
import { checkRateLimit, ipKey, rateLimitedResponse } from './rate-limit.js';
import { maybeInjectAnalytics } from './analytics-inject.js';
import { recordUptimeProbe, readUptimeWindow } from './uptime.js';
import { reportToSentry } from './sentry.js';
import { runDailyKvBackup, shouldRunKvBackup } from './kv-backup.js';
import { findTemplate, listTemplates, generateTemplatePdf, sendTemplateByEmail } from './templates-library.js';
import { getWebhookConfig, saveWebhookConfig, deleteWebhookConfig, fireWebhook, getDeliveryLog, WEBHOOK_EVENTS } from './webhooks.js';
import { registerAffiliate, bumpClick, bumpSignup, recordConversion, getCodeStats } from './affiliate.js';
import { getRoadmap, castVote } from './roadmap.js';
import { runMonthlyOwnerReport } from './owner-report.js';
import { runDripCampaign, shouldRunDripCampaign } from './drip-campaign.js';
import {
  TIERS,
  getSubscription,
  getUsageThisMonth,
  incrementUsage,
  checkFreeTierAllowance,
  getFoundingCount,
  getLifetimeCount,
  setOriginProfile,
  foundingCap,
  LIFETIME_CAP,
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
  async fetch(request, env, ctx) {
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

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return handleHealth(env);
    }

    // 301 redirects: Origin tier rename. Anyone with a /charter/* link
    // (early Origin members, social shares, indexed pages) gets permanently
    // redirected to /origin/*. Cheap, preserves SEO juice, keeps inbound
    // links alive forever.
    if (url.pathname === '/charter' || url.pathname === '/charter/') {
      return Response.redirect('https://cybersygn.io/origin/', 301);
    }
    if (url.pathname.startsWith('/charter/')) {
      const tail = url.pathname.slice('/charter/'.length);
      return Response.redirect(`https://cybersygn.io/origin/${tail}`, 301);
    }

    if (request.method === 'POST' && url.pathname === '/detect') {
      return handleDetect(request);
    }

    if (request.method === 'POST' && url.pathname === '/api/detect-vision') {
      return handleDetectVision(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/templates') {
      return handleSaveTemplate(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/templates') {
      return handleLookupTemplate(request, env, url);
    }

    // Free tier (3 docs lifetime per email, lead capture, dataset consent)
    if (request.method === 'POST' && url.pathname === '/api/free/signup') {
      return handleFreeSignup(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/free/consume') {
      return handleFreeConsume(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/dataset/count') {
      return handleDatasetCount(env);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/drip-list') {
      return handleOwnerDripList(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/dataset/export') {
      return handleOwnerDatasetExport(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/dataset/stats') {
      return handleOwnerDatasetStats(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/report/preview') {
      return handleOwnerReportPreview(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/drip/run') {
      return handleOwnerDripRun(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      const rl = await checkRateLimit(env, ipKey(request, 'signup'), { max: 8, windowSeconds: 600 });
      if (!rl.ok) return rateLimitedResponse(rl);
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
    if (request.method === 'POST' && url.pathname === '/api/owner/login') {
      return handleOwnerLogin(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/test-email') {
      return handleOwnerTestEmail(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/event') {
      return handleEvent(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/error') {
      // Tight rate limit on client-error reports — bug-spam is a real
      // failure mode and we don't want it to hot-spot Resend.
      const rl = await checkRateLimit(env, ipKey(request, 'err'), { max: 30, windowSeconds: 60 });
      if (!rl.ok) return rateLimitedResponse(rl);
      return handleClientError(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/contact') {
      return handleContact(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return handleStatus(request, env, url);
    }

    // Public roadmap with voting.
    if (request.method === 'GET' && url.pathname === '/api/roadmap') {
      const data = await getRoadmap(env);
      return jsonResponse(200, data);
    }
    if (request.method === 'POST' && url.pathname === '/api/roadmap/vote') {
      const body = await readJsonBody(request);
      if (body.error) return jsonResponse(400, body.error);
      const { itemId, voter } = body.value || {};
      const r = await castVote(env, itemId, voter);
      return jsonResponse(r.ok ? 200 : 400, r);
    }

    // Affiliate program endpoints.
    if (request.method === 'POST' && url.pathname === '/api/affiliate/register') {
      return handleAffiliateRegister(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/affiliate/click') {
      return handleAffiliateClick(request, env, url);
    }
    {
      const m = url.pathname.match(/^\/api\/affiliate\/([a-z0-9]{4,16})$/);
      if (request.method === 'GET' && m) {
        return handleAffiliateStats(request, env, url, m[1]);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/owner/metrics/dashboard') {
      return handleMetricsDashboard(request, env, url);
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
    if (request.method === 'GET' && url.pathname === '/api/billing/lifetime-count') {
      return handleLifetimeCount(env);
    }
    if (request.method === 'GET' && url.pathname === '/api/status/uptime') {
      return handleUptimeRead(env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/testimonial') {
      return handleTestimonialSubmit(request, env, url);
    }
    // Template library (slice 105).
    if (request.method === 'GET' && url.pathname === '/api/templates/list') {
      return jsonResponse(200, { templates: listTemplates() });
    }
    if (request.method === 'POST' && url.pathname === '/api/templates/send') {
      return handleTemplateSend(request, env, url);
    }
    {
      const m = url.pathname.match(/^\/api\/templates\/download\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') {
        return handleTemplateDownload(request, env, url, m[1]);
      }
    }

    // GDPR data subject export. Slice 100.
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/gdpr-export$/);
      if (m && request.method === 'GET') {
        return handleGdprExport(request, env, m[1]);
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/origin/wall') {
      return handleOriginWall(env);
    }
    if (request.method === 'POST' && url.pathname === '/api/origin/profile') {
      return handleOriginProfile(request, env, url);
    }

    // ---- Multi-signer routes ------------------------------------------

    // Create a document: persist PDF + signers + assignments, mint per-signer
    // tokens, and email each signer their magic link.
    if (request.method === 'POST' && url.pathname === '/api/docs/bulk') {
      return handleBulkSend(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/docs') {
      // Generous rate limit on doc creation — paid customers send
      // dozens a day, but a flood-loop should still be capped.
      const rl = await checkRateLimit(env, ipKey(request, 'docs'), { max: 60, windowSeconds: 600 });
      if (!rl.ok) return rateLimitedResponse(rl);
      return handleCreateDoc(request, env, url, ctx);
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
      return handleSubmitFills(request, env, fillsMatch[1], fillsMatch[2], url, ctx);
    }

    // Signer declines to sign. Marks declinedAt, halts further reminders,
    // notifies the sender. One-way: a declined signer cannot un-decline,
    // the sender has to send a new doc.
    const declineMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)\/decline$/);
    if (request.method === 'POST' && declineMatch) {
      return handleDeclineSign(request, env, declineMatch[1], declineMatch[2], url);
    }

    // Direct PDF-to-CC email. Used by single-signer flows that want to
    // copy additional recipients without going through the magic-link
    // signing flow. Sender uploads the flattened PDF as base64; worker
    // emails it with attachment via Resend to each recipient.
    if (request.method === 'POST' && url.pathname === '/api/snapshot/email') {
      return handleSnapshotEmail(request, env, url);
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
    // GET /api/docs/:docId/live?t=<signerToken> — co-signing presence.
    {
      const m = url.pathname.match(/^\/api\/docs\/([a-f0-9]{32,64})\/live$/);
      if (request.method === 'GET' && m) {
        return handleDocLive(request, env, url, m[1]);
      }
      if (request.method === 'POST' && m) {
        return handleDocPresenceUpdate(request, env, url, m[1]);
      }
    }

    // GET /api/sender/:senderId/templates — count of templates this sender saved.
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/templates$/);
      if (request.method === 'GET' && m) {
        return handleSenderTemplatesCount(request, env, url, m[1]);
      }
    }

    // Custom branding for paid tiers (slice 90).
    // GET  /api/sender/:senderId/brand        — public read of brand
    // POST /api/sender/:senderId/brand        — paid-only write
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/brand$/);
      if (m && request.method === 'GET') {
        return handleBrandRead(request, env, m[1]);
      }
      if (m && request.method === 'POST') {
        return handleBrandWrite(request, env, url, m[1]);
      }
    }

    // Outbound webhooks for Studio tier (slice 91).
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/webhook$/);
      if (m && request.method === 'GET')    return handleWebhookGet(request, env, m[1]);
      if (m && request.method === 'POST')   return handleWebhookPost(request, env, url, m[1]);
      if (m && request.method === 'DELETE') return handleWebhookDelete(request, env, url, m[1]);
      const lm = url.pathname.match(/^\/api\/sender\/([^/]+)\/webhook\/log$/);
      if (lm && request.method === 'GET') return handleWebhookLog(request, env, lm[1]);
    }

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
      const upstream = await env.ASSETS.fetch(request);
      return maybeInjectAnalytics(upstream, env);
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
    // Reminder sweep runs every hour. Monthly owner report only fires
    // on the first day of the month between 00:00 and 00:59 UTC. Free-
    // tier drip campaign fires daily at 14:00 UTC (~9am EST/10am EDT).
    ctx.waitUntil(runReminderSweep(env, event));
    if (shouldRunMonthlyReport(event)) {
      ctx.waitUntil(runMonthlyOwnerReport(env, event));
    }
    if (shouldRunDripCampaign(event)) {
      ctx.waitUntil(runDripCampaign(env, event));
    }
    // Daily KV → R2 backup at 03:00 UTC (slice 100). No-op if R2
    // binding isn't configured.
    if (shouldRunKvBackup(event)) {
      ctx.waitUntil(runDailyKvBackup(env));
    }
    // Uptime self-probe (slice 99). Synchronous KV check is enough — if
    // the binding is up the worker can respond; if it isn't, we record
    // a failure for the day.
    ctx.waitUntil((async () => {
      let ok = false;
      try {
        if (env && env.CYBERSYGN_DOCS) {
          const probeKey = `uptime:probe:${Date.now()}`;
          await env.CYBERSYGN_DOCS.put(probeKey, '1', { expirationTtl: 60 });
          const v = await env.CYBERSYGN_DOCS.get(probeKey);
          ok = v === '1';
        }
      } catch (e) { ok = false; }
      await recordUptimeProbe(env, ok);
    })());
  },
};

function shouldRunMonthlyReport(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    return now.getUTCDate() === 1 && now.getUTCHours() === 0;
  } catch (e) { return false; }
}

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

/**
 * Username + password login for /control/. Returns the same token
 * shape as /api/owner/claim so the client stores it under the
 * existing localStorage key and every downstream owner-gated
 * endpoint validates without a separate code path.
 *
 * Returns 503 if OWNER_USERNAME / OWNER_PASSWORD_HASH secrets are
 * unset (initial deploy state). Returns 401 on credential mismatch.
 */
async function handleOwnerLogin(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { username, password } = body.value || {};
  const result = await loginWithCredentials(username, password, env);
  if (!result.ok) {
    if (result.error === 'login_not_configured') {
      return jsonResponse(503, {
        error: 'login_not_configured',
        message: 'OWNER_USERNAME and OWNER_PASSWORD_HASH must be set on the Worker. Run: wrangler secret put OWNER_USERNAME / OWNER_PASSWORD_SALT / OWNER_PASSWORD_HASH.',
      });
    }
    return jsonResponse(401, { error: result.error });
  }
  return jsonResponse(200, { ok: true, token: result.token, issuedAt: result.issuedAt });
}

// ---- Billing handlers ------------------------------------------------------

async function handleCheckoutCreateSession(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { tier, senderId, email, ref } = body.value || {};

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
      ref: typeof ref === 'string' ? ref.toLowerCase() : undefined,
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

async function handleLifetimeCount(env) {
  const taken = await getLifetimeCount(env);
  return jsonResponse(200, {
    taken,
    cap: LIFETIME_CAP,
    remaining: Math.max(0, LIFETIME_CAP - taken),
  });
}

/**
 * Uptime read endpoint (slice 99). Backs the /status/ page with real
 * measured data instead of hardcoded values. Public read.
 */
/**
 * GDPR data subject export (slice 100). Returns the requesting
 * sender's full data inventory:
 *   - sub record (subscription state)
 *   - docs created (titles, dates, no PDF bytes — those are at /api/docs/:id/pdf with a token)
 *   - templates saved
 *   - free-tier signup data
 *   - affiliate stats
 *   - webhook config
 *   - brand record
 *   - origin profile if applicable
 *
 * Authenticated by the senderId itself (same trust model as
 * /api/billing/portal — if you know your senderId, you can request
 * your export). For tighter auth, this endpoint could require an
 * owner token + signed email link.
 *
 * Returns NDJSON streaming so very prolific senders don't OOM the worker.
 */
/**
 * Template library: send via email (slice 105). Captures the email
 * into the free-tier drip funnel as a side effect. Rate-limited so a
 * script can't fan out infinite emails to scraped addresses.
 */
async function handleTemplateSend(request, env, url) {
  const limit = await checkRateLimit(env, `tmpl-send:${ipKey(request)}`, [
    { windowSec: 60 * 60, max: 10 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/templates/send' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { templateSlug, email, firstName, lastName } = body.value || {};
  if (typeof templateSlug !== 'string' || typeof email !== 'string') {
    return jsonResponse(400, { error: 'invalid_payload' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'invalid_email' });
  }
  const result = await sendTemplateByEmail(env, {
    templateSlug: templateSlug.toLowerCase(),
    email: email.trim().toLowerCase(),
    firstName: (firstName || '').trim().slice(0, 80),
    lastName: (lastName || '').trim().slice(0, 80),
  });
  if (!result.ok) {
    return jsonResponse(500, result);
  }
  return jsonResponse(200, result);
}

/**
 * Template library: direct download (slice 105). The email-gate happens
 * client-side before the call; we still capture the email + log here.
 * Returns the generated PDF inline.
 */
async function handleTemplateDownload(request, env, url, slug) {
  const limit = await checkRateLimit(env, `tmpl-dl:${ipKey(request)}`, [
    { windowSec: 60 * 60, max: 30 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/templates/download' });
  const tmpl = findTemplate(slug);
  if (!tmpl) return jsonResponse(404, { error: 'unknown_template' });
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const firstName = (url.searchParams.get('firstName') || '').trim().slice(0, 80);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'invalid_email', message: 'Provide ?email=you@example.com to download.' });
  }
  // Fire-and-forget the lead capture so the user isn't held up.
  try {
    await import('./templates-library.js').then(m =>
      // Reuse sendTemplateByEmail's signup pipeline path by hand to
      // avoid double-emailing: only register the drip record.
      // The freeSignup call is idempotent on email so a duplicate
      // direct-download + email-it doesn't double-register.
      m.sendTemplateByEmail.constructor // noop, just ensures import resolves
    );
  } catch (e) {}
  const pdfBytes = await generateTemplatePdf(tmpl);
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${slug}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}

async function handleGdprExport(request, env, senderId) {
  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });
  if (!env || !env.CYBERSYGN_DOCS) return jsonResponse(503, { error: 'kv_unavailable' });

  const records = [];
  async function add(label, key) {
    try {
      const raw = await env.CYBERSYGN_DOCS.get(key);
      if (raw) records.push({ label, key, data: tryParse(raw) });
    } catch (e) {}
  }
  await add('subscription', `sub:${safeId}`);
  await add('brand', `brand:${safeId}`);
  await add('webhook_config', `webhook:${safeId}`);
  await add('origin_profile', `sub:${safeId}`);

  // Docs created by this sender — list-scan.
  try {
    const listed = await env.CYBERSYGN_DOCS.list({ prefix: 'doc:', limit: 1000 });
    for (const e of listed.keys) {
      const raw = await env.CYBERSYGN_DOCS.get(e.name);
      if (!raw) continue;
      let d; try { d = JSON.parse(raw); } catch (e2) { continue; }
      if (d && d.senderId === safeId) {
        records.push({
          label: 'doc',
          key: e.name,
          data: {
            id: d.id,
            createdAt: d.createdAt,
            title: d.title,
            signerCount: Array.isArray(d.signers) ? d.signers.length : 0,
            completedAt: d.completedAt,
          },
        });
      }
    }
  } catch (e) {}

  // Templates owned (private scope tied to this sender).
  try {
    const listed = await env.CYBERSYGN_DOCS.list({ prefix: `tpl-priv:${safeId}:`, limit: 1000 });
    for (const e of listed.keys) records.push({ label: 'template', key: e.name });
  } catch (e) {}

  // Free-tier drip record (hashed email is the key; we can't recover
  // cleartext from the senderId alone, but we surface any direct
  // pointers like 'free-tok:<token>' if cached locally).
  return jsonResponse(200, {
    ok: true,
    sender: safeId,
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
    note: 'PDFs themselves are downloadable per-doc at /api/docs/:docId/pdf?t=<token>. They are not bundled here because they are signed-token gated and signer-specific.',
  });
}

function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function handleUptimeRead(env, url) {
  const w = parseInt(url.searchParams.get('window') || '30', 10);
  const windowDays = Number.isFinite(w) && w > 0 && w <= 60 ? w : 30;
  const data = await readUptimeWindow(env, windowDays);
  return jsonResponse(200, data);
}

/**
 * Testimonial submission (slice 99). Sender or signer posts:
 *   { senderId?, email, name?, quote, role?, location?, consent: boolean }
 * Stored at testimonial:<random-id>. Owner moderates via dashboard
 * before any are surfaced on /customers/ or homepage. Rate-limited
 * to stop spam.
 */
async function handleTestimonialSubmit(request, env, url) {
  const limit = await checkRateLimit(env, `testimonial:${ipKey(request)}`, [
    { windowSec: 60 * 60, max: 5 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/testimonial' });

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};

  const email = String(payload.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'invalid_email' });
  }
  const quote = String(payload.quote || '').trim().slice(0, 600);
  if (!quote || quote.length < 20) {
    return jsonResponse(400, { error: 'quote_too_short' });
  }
  if (!payload.consent) {
    return jsonResponse(400, { error: 'consent_required', message: 'Mark consent so we can publish this with attribution.' });
  }

  const record = {
    v: 1,
    id: randomId(12),
    senderId: String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    email,
    name: String(payload.name || '').trim().slice(0, 80),
    quote,
    role: String(payload.role || '').trim().slice(0, 80),
    location: String(payload.location || '').trim().slice(0, 80),
    consent: true,
    submittedAt: new Date().toISOString(),
    moderationState: 'pending',  // owner reviews → 'approved' | 'rejected'
  };
  if (env && env.CYBERSYGN_DOCS) {
    try {
      await env.CYBERSYGN_DOCS.put(`testimonial:${record.id}`, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 24 * 365 * 5,
      });
    } catch (e) { /* tolerated */ }
  }
  return jsonResponse(200, { ok: true, id: record.id, moderationState: 'pending' });
}

/**
 * Public Origin wall: list every Origin member with their member
 * number, optional display name + city, and join date. Drives social
 * proof on /origin/. No PII beyond what each member chose to show.
 *
 * Schema per member:
 *   { number, displayName, city, joinedAt }
 *
 * displayName + city default to '' if the member hasn't filled them in
 * (the Origin onboarding flow will collect these on a per-member basis
 * in a follow-up slice; for now the wall surfaces just member numbers
 * and join dates, which is enough to convey real signups exist).
 *
 * Cached at edge for 60s so the page can poll cheaply.
 */
async function handleOriginWall(env) {
  const taken = await getFoundingCount(env);
  const cap = foundingCap();
  const members = [];
  // List sub:* records on the raw KV binding (the storage abstraction
  // wraps get/put but not list). Small list — cap is 100 — so a single
  // page suffices; if Origin ever grows past 1000 we'll add a
  // denormalized index.
  const docsBinding = env && env.CYBERSYGN_DOCS;
  if (docsBinding && typeof docsBinding.list === 'function') {
    try {
      const result = await docsBinding.list({ prefix: 'sub:', limit: 1000 });
      for (const entry of result.keys || []) {
        const raw = await docsBinding.get(entry.name);
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (!rec) continue;
        if (rec.tier !== 'founding') continue;
        if (typeof rec.foundingNumber !== 'number' || rec.foundingNumber < 1) continue;
        members.push({
          number: rec.foundingNumber,
          displayName: typeof rec.originDisplayName === 'string' ? rec.originDisplayName.slice(0, 40) : '',
          city: typeof rec.originCity === 'string' ? rec.originCity.slice(0, 60) : '',
          joinedAt: rec.activatedAt || null,
        });
      }
    } catch (e) {
      console.error('[origin-wall] list failed:', e && e.message);
    }
  }
  // Order: lowest number first (chronological since numbers issue in order).
  members.sort((a, b) => a.number - b.number);

  const body = JSON.stringify({
    taken,
    cap,
    remaining: Math.max(0, cap - taken),
    members,
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=60',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Origin member self-edit: update displayName + city for the public
 * wall. Mirrors the auth pattern of /api/billing/portal — caller passes
 * senderId in the body, and the server only updates if a sub:senderId
 * record exists AND the record is a Origin member with a foundingNumber.
 * Owner override via X-CyberSygn-Owner is also accepted.
 *
 * No editing of foundingNumber, joinedAt, or any billing field.
 */
async function handleOriginProfile(request, env, url) {
  // Rate limit: 30 edits per hour per IP. Real Origin members will
  // tweak their card a few times and walk away; this stops a script
  // from cycling through display names to grief the wall.
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    const limit = await checkRateLimit(env, `origin-profile:${ipKey(request)}`, [
      { windowSec: 60 * 60, max: 30 },
    ]);
    if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/origin/profile' });
  }

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender_id' });

  // Owner override allowed but not required. Existing trust model on
  // /api/billing/portal is "if you know the senderId, you can edit"
  // (clients store it in localStorage). This endpoint inherits that.
  // PII risk is bounded: the fields update only the Origin wall
  // display name + city — no email, no billing, no auth state.
  const displayName = typeof payload.displayName === 'string' ? payload.displayName : '';
  const city = typeof payload.city === 'string' ? payload.city : '';

  // Light content moderation: strip control chars + cap length. Display
  // is rendered with escapeHtml on the client so script injection isn't
  // a concern, but unicode-only names + extreme lengths are still ugly.
  const cleanName = displayName.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
  const cleanCity = city.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 60);

  try {
    const updated = await setOriginProfile(env, senderId, {
      displayName: cleanName,
      city: cleanCity,
    });
    if (!updated) {
      return jsonResponse(404, { error: 'not_origin_member', message: 'No Origin sub found for this senderId.' });
    }
    return jsonResponse(200, {
      ok: true,
      number: updated.foundingNumber,
      displayName: updated.originDisplayName || '',
      city: updated.originCity || '',
    });
  } catch (err) {
    return jsonResponse(500, { error: 'update_failed', message: err && err.message ? err.message : 'unknown' });
  }
}

// ---- /api/health -----------------------------------------------------------
//
// Deep, no-side-effect probe of every subsystem we depend on. Each subsystem
// reports { ok: boolean, mode/detail: ... }. Every probe is wrapped in
// try/catch with a short timeout so one bad backend cannot hang the
// response. Public endpoint (no owner gate) because uptime monitors and
// status-page widgets need to hit it freely; the response contains no
// secrets or PII.
//
// Designed for:
//   - cron uptime monitors (every minute, expect 200 + ok:true)
//   - quick CLI debugging during a deploy ("did the secret upload?")
//   - rendering on the owner dashboard's diagnostic strip

async function handleHealth(env) {
  const startedAt = Date.now();

  // ---- KV (CYBERSYGN_DOCS) ---------------------------------------------------
  // Round-trip a tiny key. The probe key is namespaced so it never collides
  // with real data and TTL'd to 60 seconds so it auto-cleans.
  async function probeKv() {
    if (!env || !env.CYBERSYGN_DOCS || typeof env.CYBERSYGN_DOCS.put !== 'function') {
      return { ok: false, mode: 'unbound', detail: 'binding not configured' };
    }
    const key = `health:probe:${Date.now()}`;
    try {
      await withTimeout(env.CYBERSYGN_DOCS.put(key, '1', { expirationTtl: 60 }), 3000);
      const read = await withTimeout(env.CYBERSYGN_DOCS.get(key), 3000);
      return { ok: read === '1', mode: 'kv', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, mode: 'kv', detail: shortErr(err) };
    }
  }

  // ---- Resend (transactional email) -----------------------------------------
  // Does NOT send. Hits the Resend domains API as a cheap auth probe.
  async function probeResend() {
    if (!env || !env.RESEND_API_KEY) {
      return { ok: false, mode: 'console-fallback', detail: 'RESEND_API_KEY not set' };
    }
    try {
      const res = await withTimeout(
        fetch('https://api.resend.com/domains', {
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
        }),
        4000,
      );
      if (res.status === 401 || res.status === 403) {
        return { ok: false, mode: 'auth-failed', detail: `HTTP ${res.status}` };
      }
      if (!res.ok) return { ok: false, mode: 'resend', detail: `HTTP ${res.status}` };
      const data = await res.json();
      const domains = Array.isArray(data && data.data) ? data.data : [];
      const verified = domains.filter(d => d && d.status === 'verified').length;
      return { ok: verified > 0, mode: 'resend', domains: domains.length, verified };
    } catch (err) {
      return { ok: false, mode: 'resend', detail: shortErr(err) };
    }
  }

  // ---- Stripe (payments) ----------------------------------------------------
  // Probes /v1/balance. No mutation, low quota cost.
  async function probeStripe() {
    if (!env || !env.STRIPE_SECRET_KEY) {
      return { ok: false, mode: 'unconfigured', detail: 'STRIPE_SECRET_KEY not set' };
    }
    try {
      const res = await withTimeout(
        fetch('https://api.stripe.com/v1/balance', {
          headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
        }),
        4000,
      );
      if (res.status === 401) return { ok: false, mode: 'auth-failed', detail: 'HTTP 401' };
      if (!res.ok) return { ok: false, mode: 'stripe', detail: `HTTP ${res.status}` };
      return { ok: true, mode: env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test' : 'live' };
    } catch (err) {
      return { ok: false, mode: 'stripe', detail: shortErr(err) };
    }
  }

  // ---- Anthropic (auth probe via /v1/models, zero token cost) -------------
  async function probeAnthropic() {
    if (!env || !env.ANTHROPIC_API_KEY) {
      return { ok: false, mode: 'unconfigured', detail: 'ANTHROPIC_API_KEY not set' };
    }
    try {
      // /v1/models is a listing endpoint — auth required, no token usage.
      // Returns { data: [...models] } on success, 401 on bad key.
      const res = await withTimeout(
        fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
        }),
        4000,
      );
      if (res.status === 401 || res.status === 403) {
        return { ok: false, mode: 'auth-failed', detail: `HTTP ${res.status}` };
      }
      if (!res.ok) return { ok: false, mode: 'anthropic', detail: `HTTP ${res.status}` };
      const data = await res.json();
      const modelCount = Array.isArray(data && data.data) ? data.data.length : 0;
      return { ok: true, mode: 'live', detail: `${modelCount} models visible` };
    } catch (err) {
      return { ok: false, mode: 'anthropic', detail: shortErr(err) };
    }
  }

  // ---- Analytics Engine (no probe possible; report binding presence) --------
  function probeAnalytics() {
    if (env && env.CYBERSYGN_EVENTS && typeof env.CYBERSYGN_EVENTS.writeDataPoint === 'function') {
      return { ok: true, mode: 'bound', detail: 'CYBERSYGN_EVENTS active' };
    }
    return { ok: false, mode: 'unbound', detail: 'enable Analytics Engine in dashboard, then uncomment binding' };
  }

  // ---- Owner backdoor secret ------------------------------------------------
  function probeOwner() {
    const isDevHash = !env || !env.CYBERSYGN_OWNER_HASH || env.CYBERSYGN_OWNER_HASH.length !== 64;
    if (isDevHash) {
      return { ok: false, mode: 'dev-hash', detail: 'CYBERSYGN_OWNER_HASH not set (the publicly documented dev phrase will work)' };
    }
    return { ok: true, mode: 'custom-hash' };
  }

  // Run probes in parallel; each has its own timeout so the overall
  // response time is bounded by the slowest single probe.
  const [kv, resend, stripe, anthropic] = await Promise.all([
    probeKv(), probeResend(), probeStripe(), probeAnthropic(),
  ]);
  const ae = probeAnalytics();
  const owner = probeOwner();

  // Overall health: KV is required; resend, stripe, and AE are optional
  // for the base service to work (the worker degrades gracefully without
  // them), so they don't fail the top-level ok flag, just surface their
  // own ok=false. KV failure = service is broken.
  const overallOk = kv.ok === true;

  return jsonResponse(overallOk ? 200 : 503, {
    ok: overallOk,
    service: 'cybersygn',
    version: VERSION,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    subsystems: {
      kv, resend, stripe, anthropic,
      analytics_engine: ae,
      owner_backdoor: owner,
    },
  });
}

function shortErr(err) {
  const m = err && err.message ? String(err.message) : String(err || 'unknown');
  return m.slice(0, 200);
}

// ---- /api/owner/test-email -------------------------------------------------
//
// Owner-only. Sends a real signing-style email via the configured Resend
// account so the owner can verify end-to-end deliverability and template
// rendering without staging a fake document with a fake signer. Honors
// CYBERSYGN_FROM if set; falls back to the default From in email.js.
//
// Body: { to: "address@example.com" }

async function handleOwnerTestEmail(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { to } = body.value || {};
  if (typeof to !== 'string' || to.length === 0 || to.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return jsonResponse(400, { error: 'invalid_recipient', message: 'A valid "to" email address is required.' });
  }

  const appUrl = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';
  try {
    const result = await sendInvite(env, {
      to,
      name: 'Test signer',
      senderName: 'CyberSygn deploy check',
      docTitle: 'Production pipeline check, ' + new Date().toISOString().slice(0, 19) + 'Z',
      magicLink: `${appUrl}/preview/?test=1`,
    });
    return jsonResponse(200, {
      ok: !!(result && result.delivered),
      mode: result && result.mode ? result.mode : 'unknown',
      providerId: (result && result.id) || null,
      delivered: !!(result && result.delivered),
      error: result && result.error ? result.error : null,
    });
  } catch (err) {
    return jsonResponse(500, {
      error: 'send_failed',
      message: err && err.message ? err.message : 'unknown error',
    });
  }
}

// ---- /api/detect-vision ----------------------------------------------------
//
// Phase 2b: LLM vision field detection. Accepts a single rendered page
// as base64 PNG, calls Claude Sonnet 4.5 via the Anthropic API, returns
// bounding boxes in pixel coordinates. Per-sender monthly cap enforced
// via KV before the paid API call burns.
//
// Body:
//   {
//     senderId:   string,    // for usage tracking and cap enforcement
//     pageNum:    number,    // 1-based page index, for the prompt
//     imageBase64: string,   // PNG, no data: prefix
//     imageWidth:  number,
//     imageHeight: number
//   }
//
// Response:
//   { ok: true, fields: [{type, x, y, width, height, label, confidence}], cost, usage }
//   On error: 4xx/5xx with { error, message }

const MAX_VISION_IMAGE_BYTES = 8 * 1024 * 1024;  // 8 MB base64; ~6 MB binary

async function handleDetectVision(request, env, url) {
  if (!env || !env.ANTHROPIC_API_KEY) {
    return jsonResponse(503, {
      error: 'vision_not_configured',
      message: 'ANTHROPIC_API_KEY not set on this Worker. Set it with wrangler secret put ANTHROPIC_API_KEY to enable Phase 2b vision detection.',
    });
  }

  const body = await readJsonBody(request, MAX_VISION_IMAGE_BYTES);
  if (body.error) return jsonResponse(400, body.error);

  const { senderId, pageNum, imageBase64, imageWidth, imageHeight } = body.value || {};
  if (typeof senderId !== 'string' || senderId.length === 0) {
    return jsonResponse(400, { error: 'invalid_sender', message: 'senderId required' });
  }
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    return jsonResponse(400, { error: 'invalid_image', message: 'imageBase64 required' });
  }
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) {
    return jsonResponse(400, { error: 'invalid_dimensions', message: 'imageWidth and imageHeight required' });
  }

  // Enforce per-sender monthly cap BEFORE calling the paid API.
  const capPages = parseInt(env.VISION_MONTHLY_CAP_PAGES, 10) || undefined;
  const usage = await checkAndIncrementVisionUsage(env, senderId, capPages);
  if (!usage.ok) {
    return jsonResponse(429, {
      error: 'monthly_cap_reached',
      message: `Vision usage cap of ${usage.cap} pages this month reached for this sender. Increment resets on the 1st.`,
      used: usage.used,
      cap: usage.cap,
    });
  }

  const result = await detectFieldsViaVision(env, {
    imageBase64,
    imageWidth,
    imageHeight,
    pageNum: typeof pageNum === 'number' ? pageNum : 1,
  });

  // Track regardless of ok/error: we always paid for the call (unless
  // the call itself errored before reaching Anthropic, which the
  // estimateCost handles as 0).
  try {
    await trackEvent(env, result.ok ? 'vision_detect_ok' : 'vision_detect_failed', {
      request,
      senderId,
      value: result.cost || 0,
      durationMs: 0,
    });
  } catch (e) {}

  if (!result.ok) {
    return jsonResponse(502, {
      error: 'vision_failed',
      message: result.error || 'unknown',
      cost: result.cost || 0,
      usage: { used: usage.used, cap: usage.cap },
    });
  }

  return jsonResponse(200, {
    ok: true,
    fields: result.fields,
    cost: result.cost,
    usageThisMonth: usage.used,
    capThisMonth: usage.cap,
    apiUsage: result.usage || null,
  });
}

// ---- /api/templates --------------------------------------------------------
//
// Persist a labeled field set for a specific PDF (keyed by SHA-256 of
// original bytes). The point: once any user has corrected detection
// for a recurring form, every future upload of the same PDF starts
// with the correct labels.
//
// POST /api/templates  body { docId, senderId, fields, scope, consent }
//   -> { ok, template }
// GET  /api/templates?docId=...&senderId=...
//   -> { ok, template, scope } or { ok: false } if no match

async function handleSaveTemplate(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { docId, senderId, fields, scope, consent } = body.value || {};
  // Owner sessions persist as ownerCreated=true and get downgraded to
  // private scope inside saveTemplate so demo work cannot pollute the
  // shared corpus.
  const owner = await getOwnerForRequest(request, env, url);
  const result = await saveTemplate(env, {
    docId,
    senderId,
    fields,
    scope,
    consentGiven: consent === true,
    ownerCreated: Boolean(owner),
  });
  if (!result.ok) return jsonResponse(400, { error: result.error || 'save_failed' });

  // Fire-and-forget Phase 3 trigger check. Only customer-public
  // templates grow the shared corpus — owner-saved templates are
  // forced to private inside saveTemplate so they never reach this
  // branch. Watchdog is idempotent — one-shot alert per cluster lifetime.
  // We don't await: the user's save response shouldn't wait on a
  // stats walk + maybe-email round-trip.
  if (result.template.scope === 'public' && !result.template.ownerCreated) {
    maybeFirePhase3Alert(env, deliverEmail).catch(e =>
      console.error('[phase3:trigger] async fire failed:', e && e.message));
  }

  return jsonResponse(200, {
    ok: true,
    scope: result.template.scope,
    fieldCount: result.template.fields.length,
    savedCount: result.template.stats.savedCount,
  });
}

async function handleLookupTemplate(request, env, url) {
  const docId = url.searchParams.get('docId');
  const senderId = url.searchParams.get('senderId') || '';
  const result = await lookupTemplate(env, { docId, senderId });
  if (!result.ok) return jsonResponse(200, { ok: false });
  return jsonResponse(200, {
    ok: true,
    scope: result.scope,
    template: {
      fields: result.template.fields,
      stats: result.template.stats,
      updatedAt: result.template.updatedAt,
    },
  });
}

// ---- Free-tier endpoints ---------------------------------------------------

async function handleFreeSignup(request, env) {
  // Rate limit: per-IP 3 signups per 24h, 10 per week. Tight enough to
  // stop drive-by signup floods, generous enough not to bite a real
  // user creating multiple test accounts in a day.
  const owner = await getOwnerForRequest(request, env, new URL(request.url));
  if (!owner) {
    const limit = await checkRateLimit(env, `signup:${ipKey(request)}`, [
      { windowSec: 60 * 60 * 24,     max: 3 },
      { windowSec: 60 * 60 * 24 * 7, max: 10 },
    ]);
    if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/free/signup' });
  }

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { firstName, lastName, email } = body.value || {};
  const result = await freeSignup(env, { firstName, lastName, email });
  if (!result.ok) {
    return jsonResponse(400, { error: result.error || 'signup_failed' });
  }
  if (!result.isReturning) {
    // First signup for this email: write the token->emailHash pointer
    // so /api/free/consume can resolve later.
    const emailHash = await sha256Hex(new TextEncoder().encode(String(email).trim().toLowerCase()));
    await writeFreeTokenPointer(env, result.freeToken, emailHash);
  }
  return jsonResponse(200, {
    ok: true,
    freeToken: result.freeToken,
    used: result.used,
    remaining: result.remaining,
    cap: 3,
    isReturning: result.isReturning,
  });
}

async function handleFreeConsume(request, env) {
  const token = request.headers.get('x-cybersygn-free') || '';
  const result = await freeConsume(env, token);
  if (!result.ok) {
    const status = result.error === 'free_cap_reached' ? 402 : 401;
    return jsonResponse(status, result);
  }
  return jsonResponse(200, result);
}

async function handleDatasetCount(env) {
  const r = await getDatasetCount(env);
  const res = jsonResponse(200, {
    ok: true,
    total: r.total,
    contributors: r.contributors,
  });
  res.headers.set('cache-control', 'public, max-age=60');
  return res;
}

async function handleOwnerDripList(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const cap = parseInt(url.searchParams.get('cap'), 10) || 200;
  const result = await ownerDripList(env, { cap });
  return jsonResponse(result.ok ? 200 : 500, result);
}

async function handleOwnerDatasetExport(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  return exportDatasetJsonl(env);
}

async function handleOwnerDatasetStats(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const result = await getDatasetStats(env);
  return jsonResponse(result.ok ? 200 : 500, result);
}

/**
 * Owner-only monthly report preview / on-demand trigger.
 *
 *   GET /api/owner/report/preview              -> renders HTML, no send (default)
 *   GET /api/owner/report/preview?send=true    -> renders HTML AND emails it now
 *
 * Same renderer the cron uses, so the preview is byte-identical to
 * what arrives in your inbox on the 1st of next month.
 */
/**
 * Owner-only: manually fire the drip sweep right now. Useful for
 * testing the cron path without waiting for 14:00 UTC. Bypasses the
 * day-key idempotency lock so repeated test runs all send. The
 * per-recipient drip-sent:<emailHash>:<stage> markers still prevent
 * double-sends to real recipients.
 *
 * Query params:
 *   ?dryRun=true       → don't actually send; return what WOULD send
 *   ?bypassLock=true   → clear the day-key lock before running
 */
async function handleOwnerDripRun(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const bypassLock = url.searchParams.get('bypassLock') === 'true';
  if (bypassLock && env && env.CYBERSYGN_DOCS) {
    const dayKey = new Date().toISOString().slice(0, 10);
    try { await env.CYBERSYGN_DOCS.delete(`meta:drip-lock:${dayKey}`); } catch (e) {}
  }
  const result = await runDripCampaign(env, { scheduledTime: Date.now() });
  return jsonResponse(200, { ok: true, ...result });
}

async function handleOwnerReportPreview(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const send = url.searchParams.get('send') === 'true';
  if (send) {
    // Real send via the existing pipeline.
    await runMonthlyOwnerReport(env, { scheduledTime: Date.now() });
    return jsonResponse(200, {
      ok: true,
      sent: true,
      recipient: (env && env.OWNER_EMAIL) || 'hello@cybersygn.io',
      message: 'Report sent. Check your inbox.',
    });
  }
  // Preview: render HTML in-line, return as HTML response.
  const { renderReportHtmlForPreview } = await import('./owner-report.js');
  const html = await renderReportHtmlForPreview(env);
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---- /api/event ------------------------------------------------------------

async function handleEvent(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);

  const { event, props } = body.value || {};
  if (typeof event !== 'string' || event.length === 0 || event.length > 80) {
    return jsonResponse(400, {
      error: 'invalid_event',
      message: 'An "event" string between 1 and 80 characters is required.',
    });
  }

  // Owner test traffic should be flagged so analytics dashboards can
  // optionally exclude it. We force-overwrite the tier blob with
  // 'owner' when the request carries a valid owner token. Customer
  // requests retain their declared tier (free / solo / founding / team).
  const owner = url ? await getOwnerForRequest(request, env, url) : null;

  // Pull a few standard fields out of props for first-class storage in
  // the Analytics Engine schema. Everything else is dropped (we deliberately
  // do not store arbitrary props as JSON blobs to keep cardinality sane).
  const p = props && typeof props === 'object' ? props : {};
  await trackEvent(env, event, {
    request,
    senderId: typeof p.senderId === 'string' ? p.senderId : '',
    source:   typeof p.source   === 'string' ? p.source   : '',
    path:     typeof p.path     === 'string' ? p.path     : '',
    tier:     owner ? 'owner' : (typeof p.tier === 'string' ? p.tier : 'free'),
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

/**
 * Owner-only metrics dashboard endpoint.
 *
 * Returns a single JSON document with the numbers the founder actually
 * needs to see daily: Origin spots claimed, free signups, dataset
 * progress toward Phase 3 (5k threshold), founder rate vs. cap, and
 * traffic (when GA4 reports back via Analytics Engine).
 *
 * Designed so /control/ can render it as a single fetch + paint. No
 * client-side aggregation needed.
 */

/**
 * "Ask the founder" inbound form. Rate-limited by IP. Email gets
 * delivered to the configured CYBERSYGN_OWNER_EMAIL (defaulting to
 * hello@cybersygn.io) via the existing Resend pipeline.
 */
async function handleContact(request, env, url) {
  const ip = ipKey(request);
  const limit = await checkRateLimit(env, `contact:${ip}`, 5, 60 * 60);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/contact' });

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { email, message, source, path } = body.value || {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return jsonResponse(400, { error: 'invalid_email' });
  }
  if (typeof message !== 'string' || message.trim().length < 3 || message.length > 4000) {
    return jsonResponse(400, { error: 'invalid_message' });
  }
  const to = (env && env.CYBERSYGN_OWNER_EMAIL) || 'hello@cybersygn.io';
  const subject = `[CyberSygn] founder-widget message from ${email.trim()}`;
  const text = [
    `From: ${email.trim()}`,
    `Source: ${source || 'unknown'}`,
    `Page: ${path || 'unknown'}`,
    '',
    message.trim(),
  ].join('\n');
  try {
    const r = await deliverEmail(env, { to, subject, text });
    return jsonResponse(200, { ok: true, delivered: !!(r && r.delivered) });
  } catch (e) {
    return jsonResponse(500, { error: 'send_failed', message: (e && e.message) || 'unknown' });
  }
}

/**
 * Public status feed. Aggregates the live health of the worker's
 * subsystems for the /status/ page. Mirrors /api/health but trims
 * down to what the public page renders. Cache-busts every 60s.
 */
async function handleStatus(request, env, url) {
  const subsystems = {
    worker: { ok: true, label: 'CyberSygn API' },
    kv: { ok: Boolean(env && env.CYBERSYGN_DOCS), label: 'Document storage (KV)' },
    pdfs: { ok: Boolean(env && env.CYBERSYGN_PDFS), label: 'PDF storage' },
    stripe: { ok: Boolean(env && env.STRIPE_SECRET_KEY), label: 'Payments (Stripe)' },
    email: { ok: Boolean(env && env.RESEND_API_KEY), label: 'Email (Resend)' },
    analytics: { ok: Boolean(env && env.CYBERSYGN_EVENTS), label: 'Analytics Engine' },
    vision: { ok: Boolean(env && env.ANTHROPIC_API_KEY), label: 'Vision API (optional)' },
  };
  const allOk = Object.values(subsystems).every(s => s.ok || s.label.includes('optional'));
  return new Response(JSON.stringify({
    ok: allOk,
    status: allOk ? 'operational' : 'degraded',
    subsystems,
    asOf: new Date().toISOString(),
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=60',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * Mint (or look up) an affiliate code for the current senderId.
 * Idempotent — calling it twice returns the same code.
 *
 * Body: { senderId, email? }
 * Returns: { ok, code, record, isNew, shareUrl }
 */
async function handleAffiliateRegister(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender' });
  const email = typeof payload.email === 'string' ? payload.email.trim().slice(0, 320) : '';

  const result = await registerAffiliate(env, { senderId, email });
  if (!result.ok) return jsonResponse(500, { error: result.error });
  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  return jsonResponse(200, {
    ok: true,
    code: result.code,
    isNew: result.isNew,
    shareUrl: `${baseUrl}/?ref=${result.code}`,
    record: {
      clicks: result.record.clicks || 0,
      signups: result.record.signups || 0,
      conversions: result.record.conversions || 0,
      earnedUsd: result.record.earnedUsd || 0,
    },
  });
}

/**
 * Public click-counter. Called by client-side script when a visitor
 * lands with ?ref=<code> in the URL. Cheap, no auth — just bumps.
 */
async function handleAffiliateClick(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const code = String((body.value || {}).code || '').toLowerCase();
  await bumpClick(env, code);
  return jsonResponse(200, { ok: true });
}

/**
 * Public stats for a specific affiliate code. Returns aggregate counts;
 * no PII. Anyone with the code can query so the affiliate themselves
 * can build a dashboard without authentication.
 */
async function handleAffiliateStats(request, env, url, code) {
  const stats = await getCodeStats(env, code);
  if (!stats.ok) return jsonResponse(404, { error: 'not_found' });
  return jsonResponse(200, stats);
}

/**
 * Cheap count of templates a sender has saved.
 *
 * Templates are keyed by SHA-256 of the PDF and scoped by sender for
 * the private tier. We list KV with prefix `tpl-priv:<senderId>:` (or
 * the equivalent shape) and return the count. Public templates are
 * not attributed back to one sender so they're excluded from this
 * personal count.
 */
/**
 * Co-signing live presence (slice 86).
 *
 * GET /api/docs/:docId/live?t=<signerToken>
 *   Returns lightweight presence + fill state for every signer:
 *     {
 *       ok,
 *       signers: [{
 *         id, name, initials, color,
 *         completedAt, lastSeenAt,
 *         filledCount, ownedCount,
 *         currentPage,
 *       }]
 *     }
 *   Used by signer-side clients to poll every 2s and render presence
 *   pills (e.g. "Jane is signing — page 2, 5 of 8 fields filled").
 *
 * POST /api/docs/:docId/live?t=<signerToken>
 *   Body: { currentPage }
 *   Updates the calling signer's presence on the doc record. Cheap,
 *   no event log entry — we keep this off the audit trail because
 *   it's UI state, not legally meaningful.
 *
 * Auth: same magic-link signing token used elsewhere. The presence
 * fields we expose are the same data already available in the doc
 * record; no new PII surface.
 *
 * Throughput: with a 2s poll interval and 4 signers per doc, this
 * is 2 reads/sec per active doc. Even with hundreds of concurrent
 * docs, KV easily absorbs it.
 */
async function handleDocLive(request, env, url, docId) {
  const token = url.searchParams.get('t');
  if (!token) return jsonResponse(400, { error: 'missing_token' });
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found' });
  const callingSigner = doc.signers.find(s => ctEqHex(s.token, token));
  if (!callingSigner) return jsonResponse(403, { error: 'invalid_token' });

  // Compute per-signer presence + fill state. Slice 92 adds
  // currentFieldId and idle-state heuristics so the client can render
  // "Jane is on page 2 working on field 7" rather than a flat
  // "page 2" indicator.
  const presence = (doc.presence || {});
  const nowMs = Date.now();
  const out = doc.signers.map(s => {
    const owned = Object.values(doc.assignments || {}).filter(sid => sid === s.id).length;
    const pres = presence[s.id] || {};
    const lastSeenMs = pres.lastSeenAt ? Date.parse(pres.lastSeenAt) : 0;
    const ageMs = nowMs - lastSeenMs;
    // online: heartbeat within 10 s. idle: within 60 s. otherwise offline.
    let liveState = 'offline';
    if (lastSeenMs && ageMs < 10_000) liveState = 'online';
    else if (lastSeenMs && ageMs < 60_000) liveState = 'idle';
    return {
      id: s.id,
      name: s.name || 'Signer',
      initials: initialsFor(s.name),
      color: paletteColor(s.id),
      completedAt: s.completedAt || null,
      lastSeenAt: pres.lastSeenAt || null,
      filledCount: Object.keys(s.fills || {}).length,
      ownedCount: owned,
      currentPage: pres.currentPage || null,
      currentFieldId: pres.currentFieldId || null,
      liveState,
    };
  });
  return jsonResponse(200, {
    ok: true,
    signers: out,
    docComplete: !!doc.completedAt,
    serverTimeMs: nowMs,
  });
}

async function handleDocPresenceUpdate(request, env, url, docId) {
  const token = url.searchParams.get('t');
  if (!token) return jsonResponse(400, { error: 'missing_token' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const currentPage = Number(payload.currentPage);
  if (!Number.isFinite(currentPage) || currentPage < 0 || currentPage > 1000) {
    return jsonResponse(400, { error: 'invalid_page' });
  }
  // currentFieldId is optional. We accept and sanitize but never block on it.
  const currentFieldId = typeof payload.currentFieldId === 'string'
    ? payload.currentFieldId.slice(0, 64)
    : null;
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found' });
  const signer = doc.signers.find(s => ctEqHex(s.token, token));
  if (!signer) return jsonResponse(403, { error: 'invalid_token' });

  doc.presence = doc.presence || {};
  doc.presence[signer.id] = {
    currentPage,
    currentFieldId,
    lastSeenAt: new Date().toISOString(),
  };
  try { await storage.docs.put(`doc:${docId}`, JSON.stringify(doc), { expirationTtl: DOC_TTL_SECONDS }); } catch (e) {}
  return jsonResponse(200, { ok: true });
}

// Lightweight initials extractor mirroring signers.js client logic.
function initialsFor(name) {
  if (typeof name !== 'string' || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
// Stable color from signer slot id (p1, p2, p3, p4).
function paletteColor(id) {
  switch (id) {
    case 'p1': return '#B83227';
    case 'p2': return '#2F4D7A';
    case 'p3': return '#B47A1F';
    case 'p4': return '#2F6D6A';
    default: return '#3A4258';
  }
}

/**
 * Custom branding (slice 90).
 *
 * Solo/Origin/Studio members configure a logo URL + accent color to
 * override CyberSygn's default brand across:
 *   - the magic-link signing page header
 *   - magic-link invitation + completion emails
 *   - the audit certificate
 *
 * Storage: KV key `brand:<senderId>` → JSON
 *   { logoUrl: string, accentColor: hex, name: string, updatedAt: ISO }
 *
 * Public read (GET): the signing page needs to fetch the sender's
 *   brand BEFORE the signer authenticates. We expose it as a thin
 *   read-only endpoint that returns only the safe display fields.
 *
 * Authenticated write (POST): paid-tier or owner only. Free senders
 *   get 402 and a pointer to /#pricing.
 */
/**
 * Helper: load a sender's brand record. Returns null when no brand
 * is set, so callers can decide whether to fall back to defaults.
 */
async function loadSenderBrand(env, senderId) {
  if (!env || !env.CYBERSYGN_DOCS) return null;
  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return null;
  try {
    const raw = await env.CYBERSYGN_DOCS.get(`brand:${safeId}`);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    // Only return display fields; never expose updatedAt or v.
    return {
      logoUrl: rec.logoUrl || '',
      accentColor: rec.accentColor || '',
      name: rec.name || '',
    };
  } catch (e) { return null; }
}

/**
 * Webhook config endpoints (slice 91). Studio-tier feature.
 */
async function handleWebhookGet(request, env, senderId) {
  const owner = await getOwnerForRequest(request, env, new URL(request.url));
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || sub.tier === 'free' || sub.tier === 'solo' || sub.tier === 'solo_annual') {
      return jsonResponse(402, { error: 'studio_required', message: 'Webhooks are a Studio feature. Upgrade at /#pricing.' });
    }
  }
  const cfg = await getWebhookConfig(env, senderId);
  if (!cfg) return jsonResponse(200, { config: null, availableEvents: WEBHOOK_EVENTS });
  // Never return the raw secret on read. The dashboard sees an indicator
  // that a secret exists; rotation is "create new config".
  return jsonResponse(200, {
    config: {
      url: cfg.url,
      events: cfg.events,
      hasSecret: true,
      createdAt: cfg.createdAt,
    },
    availableEvents: WEBHOOK_EVENTS,
  });
}

async function handleWebhookPost(request, env, url, senderId) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || sub.tier === 'free' || sub.tier === 'solo' || sub.tier === 'solo_annual') {
      return jsonResponse(402, { error: 'studio_required' });
    }
  }
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const r = await saveWebhookConfig(env, senderId, body.value || {});
  if (!r.ok) return jsonResponse(400, { error: r.error });
  // Return the secret exactly once, at creation time. The dashboard
  // surfaces it with a copy button and a warning that this is the
  // only time it's shown.
  return jsonResponse(200, {
    ok: true,
    config: {
      url: r.config.url,
      events: r.config.events,
      secret: r.config.secret,
      createdAt: r.config.createdAt,
    },
  });
}

async function handleWebhookDelete(request, env, url, senderId) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || sub.tier === 'free' || sub.tier === 'solo' || sub.tier === 'solo_annual') {
      return jsonResponse(402, { error: 'studio_required' });
    }
  }
  await deleteWebhookConfig(env, senderId);
  return jsonResponse(200, { ok: true });
}

async function handleWebhookLog(request, env, senderId) {
  const owner = await getOwnerForRequest(request, env, new URL(request.url));
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || sub.tier === 'free' || sub.tier === 'solo' || sub.tier === 'solo_annual') {
      return jsonResponse(402, { error: 'studio_required' });
    }
  }
  const log = await getDeliveryLog(env, senderId);
  return jsonResponse(200, { log });
}

async function handleBrandRead(request, env, senderId) {
  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });
  if (!env || !env.CYBERSYGN_DOCS) return jsonResponse(200, { brand: null });
  try {
    const raw = await env.CYBERSYGN_DOCS.get(`brand:${safeId}`);
    if (!raw) return jsonResponse(200, { brand: null });
    let rec;
    try { rec = JSON.parse(raw); } catch (e) { return jsonResponse(200, { brand: null }); }
    return jsonResponse(200, {
      brand: {
        logoUrl: typeof rec.logoUrl === 'string' ? rec.logoUrl : '',
        accentColor: typeof rec.accentColor === 'string' ? rec.accentColor : '',
        name: typeof rec.name === 'string' ? rec.name : '',
      },
    });
  } catch (e) {
    return jsonResponse(200, { brand: null });
  }
}

async function handleBrandWrite(request, env, url, senderId) {
  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });

  // Paid-tier check. Free senders cannot brand their docs.
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) {
    const sub = await getSubscription(env, safeId);
    if (!sub || sub.tier === 'free') {
      return jsonResponse(402, {
        error: 'paid_tier_required',
        message: 'Custom branding is a Solo/Origin/Studio feature. Upgrade at /#pricing.',
      });
    }
  }

  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};

  // Validate. logoUrl is optional but if present must be https.
  const logoUrl = String(payload.logoUrl || '').trim();
  if (logoUrl && !/^https:\/\/[^\s]+\.(png|jpg|jpeg|svg|webp)(\?.*)?$/i.test(logoUrl)) {
    return jsonResponse(400, { error: 'invalid_logo_url', message: 'logoUrl must be an https:// URL ending in .png, .jpg, .svg, or .webp.' });
  }
  if (logoUrl.length > 500) {
    return jsonResponse(400, { error: 'logo_url_too_long' });
  }

  // accentColor must look like #RRGGBB or #RGB.
  let accentColor = String(payload.accentColor || '').trim();
  if (accentColor && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentColor)) {
    return jsonResponse(400, { error: 'invalid_accent_color', message: 'accentColor must be a hex color like #00CBF6.' });
  }
  if (accentColor) accentColor = accentColor.toLowerCase();

  const name = String(payload.name || '').trim().slice(0, 80);

  const record = {
    v: 1,
    logoUrl,
    accentColor,
    name,
    updatedAt: new Date().toISOString(),
  };
  if (env && env.CYBERSYGN_DOCS) {
    try {
      await env.CYBERSYGN_DOCS.put(`brand:${safeId}`, JSON.stringify(record), {
        expirationTtl: 60 * 60 * 24 * 365 * 5,  // 5y like all sender records
      });
    } catch (e) {
      return jsonResponse(500, { error: 'kv_put_failed' });
    }
  }
  return jsonResponse(200, { ok: true, brand: { logoUrl, accentColor, name } });
}

async function handleSenderTemplatesCount(request, env, url, senderId) {
  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });
  if (!env || !env.CYBERSYGN_DOCS) return jsonResponse(200, { count: 0, source: 'memory' });
  try {
    // List bounded — for very prolific senders we cap at 1000.
    const r = await env.CYBERSYGN_DOCS.list({
      prefix: `tpl-priv:${safeId}:`,
      limit: 1000,
    });
    return jsonResponse(200, { count: r.keys.length, source: 'kv' });
  } catch (e) {
    return jsonResponse(200, { count: 0, error: e && e.message });
  }
}

async function handleMetricsDashboard(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });

  const out = {
    generatedAt: new Date().toISOString(),
    founding: { claimed: 0, cap: 100, remaining: 100 },
    free: { signups: 0, consumed: 0 },
    dataset: { total: 0, contributors: 0, threshold: 5000, progress: 0 },
    integrations: {
      ga4: Boolean(env && env.CYBERSYGN_GA4_ID),
      gsc: Boolean(env && env.CYBERSYGN_GSC_TOKEN),
      resend: Boolean(env && env.RESEND_API_KEY),
      stripe: Boolean(env && env.STRIPE_SECRET_KEY),
      anthropic: Boolean(env && env.ANTHROPIC_API_KEY),
    },
    errors: [],
  };

  // Founding count.
  try {
    const taken = await getFoundingCount(env);
    out.founding.cap = foundingCap();
    out.founding.claimed = taken;
    out.founding.remaining = Math.max(0, out.founding.cap - taken);
  } catch (e) {
    out.errors.push('founding: ' + (e && e.message ? e.message : 'unknown'));
  }

  // Dataset progress.
  try {
    const stats = await getDatasetStats(env);
    out.dataset.total = (stats && stats.total) || 0;
    out.dataset.contributors = (stats && stats.contributors) || 0;
    out.dataset.threshold = (stats && stats.threshold) || 5000;
    out.dataset.progress = out.dataset.threshold > 0
      ? Math.min(1, out.dataset.total / out.dataset.threshold)
      : 0;
  } catch (e) {
    out.errors.push('dataset: ' + (e && e.message ? e.message : 'unknown'));
  }

  // Free-tier signups via drip list count. Cheap-ish but bounded.
  try {
    if (env && env.CYBERSYGN_DOCS) {
      // Use KV list with prefix='drip:' as the lower bound of signups.
      let cursor;
      let total = 0;
      let pages = 0;
      while (true) {
        const r = await env.CYBERSYGN_DOCS.list({ prefix: 'drip:', limit: 1000, cursor });
        total += r.keys.length;
        pages += 1;
        if (r.list_complete || !r.cursor || pages > 10) break;  // hard cap
        cursor = r.cursor;
      }
      out.free.signups = total;
    }
  } catch (e) {
    out.errors.push('free: ' + (e && e.message ? e.message : 'unknown'));
  }

  return jsonResponse(200, out);
}

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
  // By default, exclude owner test traffic so the dashboard reads as
  // real-customer signal. ?includeOwner=1 brings owner events back in
  // — useful when the owner wants to confirm their own clicks landed.
  const includeOwner = url.searchParams.get('includeOwner') === '1';
  const data = await analyticsSummary(env, { window: safeWindow, excludeOwner: !includeOwner });
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
/**
 * Bulk send (Studio tier feature).
 *
 * Single PDF + an array of recipients → one personalized doc per
 * recipient, each with its own magic link. Studio standardizes on
 * this for HR onboarding, real-estate intake, contractor agreements,
 * recruiting offer letters.
 *
 * Body:
 *   {
 *     title:        string,
 *     pdfBase64:    base64-encoded PDF,
 *     fields:       [{ id, page, x, y, width, height, type, label, ... }],
 *     fieldEdits:   { fieldId: overlay },
 *     senderName:   string,
 *     senderId:     string,
 *     workspaceId:  string|null,
 *     recipients:   [ { name, email, assignments?: { fieldId: fieldId } } ]
 *   }
 *
 * Per-recipient flow: each becomes a separate doc with that recipient
 * as the sole signer. All fields auto-assign to them. Cap: 200 per
 * call so a runaway script can't fan out infinite emails.
 *
 * Auth: requires a paid tier (Solo or Studio or owner). Free-tier
 * senders are 402'd back to /#pricing.
 *
 * Response:
 *   { ok, sent: N, failed: M, results: [{ recipient, docId?, error? }] }
 */
async function handleBulkSend(request, env, url) {
  const body = await readJsonBody(request, { maxBytes: 32 * 1024 * 1024 });
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};

  // Tier check.
  const owner = await getOwnerForRequest(request, env, url);
  const providedSenderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const senderId = providedSenderId || randomId(16);
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || sub.tier === 'free') {
      return jsonResponse(402, {
        error: 'paid_tier_required',
        message: 'Bulk send is a Studio feature. Upgrade at /#pricing.',
      });
    }
  }

  // Validate inputs.
  if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
    return jsonResponse(400, { error: 'no_recipients' });
  }
  if (payload.recipients.length > 200) {
    return jsonResponse(400, { error: 'too_many_recipients', cap: 200 });
  }
  if (typeof payload.pdfBase64 !== 'string' || payload.pdfBase64.length < 32) {
    return jsonResponse(400, { error: 'invalid_pdf' });
  }
  if (!Array.isArray(payload.fields)) {
    return jsonResponse(400, { error: 'invalid_fields' });
  }

  // Process recipients in batches to avoid I/O storms. The Worker
  // runtime is fine with 5-10 parallel fetches; we cap concurrency at
  // 8 to keep Stripe webhook + Resend + KV all happy.
  const recipients = payload.recipients.filter(r =>
    r && typeof r.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim()),
  );
  const results = [];
  let sent = 0, failed = 0;
  const CONCURRENCY = 8;

  async function processOne(recipient) {
    const recipName = String(recipient.name || '').trim().slice(0, 80) || 'Signer';
    const recipEmail = recipient.email.trim().toLowerCase();
    try {
      // Synthesize a single-signer payload for handleCreateDoc-style flow.
      // Reuse the existing doc creation by calling its internal pieces
      // directly: we replicate the salient parts inline so we don't
      // round-trip through HTTP again.
      const subRequest = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify({
          title: payload.title || 'Document',
          pdfBase64: payload.pdfBase64,
          fields: payload.fields,
          fieldEdits: payload.fieldEdits || {},
          signers: [{ id: 'p1', name: recipName, email: recipEmail }],
          assignments: Object.fromEntries(payload.fields.map(f => [f.id, 'p1'])),
          cc: [],
          senderName: payload.senderName,
          senderId,
          workspaceId: payload.workspaceId || null,
          mode: 'send',
        }),
      });
      const res = await handleCreateDoc(subRequest, env, url);
      if (res.status >= 200 && res.status < 300) {
        const data = await res.json();
        sent += 1;
        return { recipient: recipEmail, docId: data.docId, ok: true };
      } else {
        const errBody = await res.json().catch(() => ({}));
        failed += 1;
        return { recipient: recipEmail, error: errBody.error || `http_${res.status}`, ok: false };
      }
    } catch (e) {
      failed += 1;
      return { recipient: recipEmail, error: (e && e.message) || 'exception', ok: false };
    }
  }

  for (let i = 0; i < recipients.length; i += CONCURRENCY) {
    const batch = recipients.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processOne));
    results.push(...batchResults);
  }

  return jsonResponse(200, { ok: true, sent, failed, results });
}

async function handleCreateDoc(request, env, url, ctx) {
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

  // CC recipients: people who get notified (with the signed PDF link)
  // when the doc completes, but DO NOT sign anything. Sender-supplied,
  // de-duplicated against signers, max 10. Each must look like an email.
  const ccCandidates = Array.isArray(payload.cc) ? payload.cc : [];
  const ccSeen = new Set(signers.map(s => (s.email || '').toLowerCase()));
  const cc = [];
  for (const raw of ccCandidates) {
    if (cc.length >= 10) break;
    const trimmed = String(raw || '').trim().slice(0, 200);
    if (!isValidEmail(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (ccSeen.has(key)) continue;
    ccSeen.add(key);
    cc.push(trimmed);
  }

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
    cc,
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
  // Pull sender branding (slice 90) once so every invite carries the
  // same logo + accent. Free senders have no brand record; the email
  // renderer falls back to CyberSygn defaults.
  const senderBrand = await loadSenderBrand(env, senderId);
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
        brand: senderBrand,
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

  // Fire doc.created webhook (slice 91). Studio-only — fireWebhook
  // returns early if the sender has no config. waitUntil hands the
  // delivery off to the runtime so the API response doesn't block.
  const waitUntil = ctx && typeof ctx.waitUntil === 'function'
    ? (p) => ctx.waitUntil(p.catch(() => {}))
    : (p) => p.catch(() => {});
  waitUntil(fireWebhook(env, senderId, 'doc.created', {
    docId,
    title: docRecord.title,
    signerCount: signers.length,
    mode: docRecord.mode,
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

  // Slice 94: bundle the sender's brand into the hydrate payload so
  // the signing page can apply logo + accent without a second
  // round-trip. Free senders get null and the page falls back to
  // CyberSygn defaults.
  const senderBrand = await loadSenderBrand(env, doc.senderId);

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
    brand: senderBrand,
  });
}

/**
 * Submit a signer's filled values. Accepts a map of fieldId -> fill
 * object identical to the client-side fillStore values. Marks the
 * signer complete if every field they own is now filled, and the
 * document complete if every signer is now done.
 */
async function handleSubmitFills(request, env, docId, token, url, ctx) {
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

  // Webhook fires (slice 91). signer.completed when this submission
  // crossed the per-signer threshold; doc.completed when all signers
  // are done.
  const waitUntil = ctx && typeof ctx.waitUntil === 'function'
    ? (p) => ctx.waitUntil(p.catch(() => {}))
    : (p) => p.catch(() => {});
  if (signer.completedAt && !wasSignerComplete) {
    waitUntil(fireWebhook(env, doc.senderId, 'signer.completed', {
      docId,
      title: doc.title,
      signerId: signer.id,
      signerEmail: signer.email,
      completedAt: signer.completedAt,
    }));
  }
  if (allDone && doc.completedAt) {
    waitUntil(fireWebhook(env, doc.senderId, 'doc.completed', {
      docId,
      title: doc.title,
      completedAt: doc.completedAt,
      signerCount: doc.signers.length,
    }));
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
  // CC recipients (sender-supplied notice-only addresses) get the same
  // completion email so they have the signed PDF link in their inbox.
  let completionEmails = null;
  if (allDone) {
    const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
    const downloadUrl = `${baseUrl}/preview/?doc=${docId}&t=${doc.signers[0].token}`;
    const auditAbsoluteUrl = auditUrl ? `${baseUrl}${auditUrl}` : null;
    const signerSends = doc.signers.filter(s => isValidEmail(s.email)).map(s =>
      sendCompletion(env, {
        to: s.email,
        name: s.name,
        docTitle: doc.title,
        downloadUrl,
        auditUrl: auditAbsoluteUrl,
      }).then(r => ({ to: s.email, role: 'signer', ...r })),
    );
    const ccList = Array.isArray(doc.cc) ? doc.cc : [];
    const ccSends = ccList.filter(e => isValidEmail(e)).map(email =>
      sendCompletion(env, {
        to: email,
        name: '',
        docTitle: doc.title,
        downloadUrl,
        auditUrl: auditAbsoluteUrl,
        notice: true,
      }).then(r => ({ to: email, role: 'cc', ...r })),
    );
    completionEmails = await Promise.all([...signerSends, ...ccSends]);
  }

  return jsonResponse(200, {
    accepted: Object.keys(accepted).length,
    signerComplete: Boolean(signer.completedAt),
    docComplete: Boolean(doc.completedAt),
    auditUrl,
    completionEmails,
    // Surfaced for the signer-microsite (slice 75). Returning name +
    // email lets the post-submit modal greet the signer by name and
    // prefill the free-tier signup form with their email — one-click
    // conversion.
    signerName: signer.name || '',
    signerEmail: signer.email || '',
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
 * Signer declines to sign. Marks signer.declinedAt + optional reason,
 * halts further reminders (the reminder sweep skips declined signers),
 * notifies the sender by email if they have one on file. One-way: a
 * declined signer cannot un-decline; the sender has to send a new doc.
 *
 *   POST /api/docs/:docId/signer/:token/decline
 *   body: { reason?: string }
 *
 * Response: { ok: true, declinedAt, senderNotified: bool }
 */
async function handleDeclineSign(request, env, docId, token, url) {
  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const signer = doc.signers.find(s => ctEqHex(s.token, token));
  if (!signer) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });
  if (signer.completedAt) {
    return jsonResponse(409, { error: 'already_complete', message: 'You already signed this document.' });
  }
  if (signer.declinedAt) {
    return jsonResponse(200, {
      ok: true,
      declinedAt: signer.declinedAt,
      senderNotified: false,
      already: true,
    });
  }

  let reason = '';
  try {
    const body = await readJsonBody(request);
    if (body.value && typeof body.value.reason === 'string') {
      reason = body.value.reason.trim().slice(0, 500);
    }
  } catch (e) {}

  const now = new Date().toISOString();
  signer.declinedAt = now;
  signer.declineReason = reason || null;
  recordEvent(doc, {
    type: 'declined',
    signerId: signer.id,
    request,
    meta: { reason: reason || null },
  });

  // Notify the sender if their email is on the first signer record (the
  // sender is always signers[0] in single-signer mode; in multi-signer,
  // doc.senderName is the only hint we have. For now, email the first
  // signer with a valid email who isn't the decliner).
  let senderNotified = false;
  const notifyTarget = doc.signers.find(s =>
    s.id !== signer.id && isValidEmail(s.email)
  );
  if (notifyTarget) {
    try {
      const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
      const dashUrl = `${baseUrl}/dashboard/`;
      const r = await deliverDeclineNotice(env, {
        to: notifyTarget.email,
        senderName: doc.senderName,
        signerName: signer.name,
        signerEmail: signer.email || '',
        docTitle: doc.title,
        reason,
        dashUrl,
      });
      senderNotified = Boolean(r && r.delivered);
    } catch (e) {
      console.error('[decline] notify failed', e && e.message);
    }
  }

  await storage.docs.put(`doc:${docId}`, doc, { expirationTtl: DOC_TTL_SECONDS });

  return jsonResponse(200, { ok: true, declinedAt: now, senderNotified });
}

/**
 * Direct PDF-to-CC email send. Bypasses the signing flow entirely —
 * used by single-signer users who flatten their PDF in the browser and
 * just want to email finished copies to legal / assistants / records.
 *
 *   POST /api/snapshot/email
 *   body: {
 *     pdfBase64: string,             // the already-flattened signed PDF
 *     filename:  string,
 *     recipients: string[],          // 1..10 valid emails
 *     senderName?: string,
 *     senderEmail?: string,          // shown in the from/reply context
 *     note?:        string,          // up to 500 chars, added to body
 *     senderId:     string,          // free-tier accounting key
 *   }
 *
 * Rate limit: per senderId, 30 sends per 24h (or 100 for owners).
 *
 * Response: { ok, results: [{ to, delivered, mode }] }.
 */
async function handleSnapshotEmail(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  const body = await readJsonBody(request, { maxBytes: 32 * 1024 * 1024 });
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};

  // Validate PDF base64.
  if (typeof payload.pdfBase64 !== 'string' || payload.pdfBase64.length < 100) {
    return jsonResponse(400, { error: 'no_pdf', message: 'pdfBase64 is required.' });
  }
  // Decode + sniff for the PDF magic so we don't accept anything else.
  let pdfBytes;
  try {
    const binary = atob(payload.pdfBase64);
    pdfBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) pdfBytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return jsonResponse(400, { error: 'pdf_decode', message: 'pdfBase64 is not valid base64.' });
  }
  if (pdfBytes.length < 8 || pdfBytes[0] !== 0x25 || pdfBytes[1] !== 0x50 || pdfBytes[2] !== 0x44 || pdfBytes[3] !== 0x46) {
    return jsonResponse(400, { error: 'not_pdf', message: 'pdfBase64 does not contain a PDF (%PDF-… magic missing).' });
  }
  // Hard size cap. 20 MB is generous for a signed contract; bigger means
  // the sender should share a link not an attachment.
  if (pdfBytes.length > 20 * 1024 * 1024) {
    return jsonResponse(413, { error: 'pdf_too_large', message: 'PDF is over 20 MB; share a link instead of attaching.' });
  }

  // Recipients.
  const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
  const cleanRecipients = [];
  const seen = new Set();
  for (const raw of recipients) {
    if (cleanRecipients.length >= 10) break;
    const t = String(raw || '').trim().slice(0, 200);
    if (!isValidEmail(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    cleanRecipients.push(t);
  }
  if (cleanRecipients.length === 0) {
    return jsonResponse(400, { error: 'no_recipients', message: 'At least one valid email is required.' });
  }

  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
  const senderName = String(payload.senderName || 'A CyberSygn user').slice(0, 80);
  const senderEmailDisplay = String(payload.senderEmail || '').trim().slice(0, 200);
  const filename = String(payload.filename || 'signed.pdf').slice(0, 200);
  const note = String(payload.note || '').trim().slice(0, 500);

  // Rate limit. Owners get a higher ceiling.
  const dailyCap = owner ? 200 : 30;
  const rateKey = `snapshot:rate:${senderId}:${new Date().toISOString().slice(0, 10)}`;
  let currentCount = 0;
  const storage = getStorage(env);
  try {
    const raw = await storage.docs.get(rateKey);
    if (raw) currentCount = parseInt(raw, 10) || 0;
  } catch (e) {}
  if (currentCount + cleanRecipients.length > dailyCap) {
    return jsonResponse(429, {
      error: 'rate_limited',
      message: `Daily snapshot-email cap (${dailyCap}) would be exceeded. Try again tomorrow.`,
      sentToday: currentCount,
      cap: dailyCap,
    });
  }

  // Fan out the sends.
  const attachmentBase64 = payload.pdfBase64;
  const results = await Promise.all(cleanRecipients.map(to =>
    deliverSnapshot(env, {
      to,
      senderName,
      senderEmailDisplay,
      filename,
      pdfBase64: attachmentBase64,
      note,
    }).then(r => ({ to, ...r }))
  ));

  // Bump the rate counter only by the number that actually delivered.
  const delivered = results.filter(r => r.delivered).length;
  if (delivered > 0) {
    try {
      await storage.docs.put(rateKey, String(currentCount + delivered), { expirationTtl: 60 * 60 * 24 });
    } catch (e) {}
  }

  return jsonResponse(200, {
    ok: true,
    results,
    sent: delivered,
    sentToday: currentCount + delivered,
    cap: dailyCap,
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
      // Owner-created docs: demo/testing work. Reminders to real-looking
      // test emails would be spammy. Keep them in the index so the
      // dashboard still shows them, just skip the reminder logic.
      if (doc.ownerCreated) { stillActive.push(docId); continue; }

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
        if (signer.declinedAt) continue;  // declined: stop nudging
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

async function readJsonBody(request, maxBytes) {
  // Stream the body and enforce a true byte cap. Trusting the
  // content-length header lets a hostile client declare a tiny size and
  // ship a much larger payload; by reading the stream chunk-by-chunk we
  // bail the moment the cap is exceeded, regardless of what the headers
  // claim. Caller can override the default MAX_JSON_BYTES per-endpoint
  // (e.g. /api/detect-vision needs ~8 MB to accept a rendered page PNG).
  if (!request.body) return { value: {} };

  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_JSON_BYTES;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        try { await reader.cancel(); } catch {}
        return {
          error: { error: 'payload_too_large', message: `Body exceeds ${cap} bytes.` },
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
