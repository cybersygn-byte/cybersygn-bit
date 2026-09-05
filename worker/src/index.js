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
 * GET /api/metrics
 *   auth: Authorization: Bearer <VYAN_METRICS_KEY> (house key); 401 if unset/mismatch
 *   returns: { product, period: { from, to }, activeOperators,
 *              usage: { docsSent, docsCompleted }, revenueCents, health: { ok } }
 *   Standardized so Vyan Control polls CyberSygn like every other product
 *   (spine CONTRACT section 6).
 *
 * Per Section 1.9, every external read has a timeout, every JSON.parse is
 * guarded, and every error path returns a useful error response.
 */

import { detectFields, pdfWorkerReady } from './detect-server.js';
import { getStorage } from './storage.js';
import { sendInvite, sendCompletion, sendReminder, deliverDeclineNotice, deliverSnapshot, deliver as deliverEmail } from './email.js';
import { setEmailBusinessAddress, renderErasureHtml } from './email-html.js';
import { recordEvent, sha256Hex, renderAuditCertificate } from './audit.js';
import { isOwnerPhrase, issueOwnerToken, validateOwnerToken, getOwnerForRequest, loginWithCredentials, createResetToken, consumeResetToken, setOwnerCredential, ownerEmail } from './owner.js';
import { trackEvent, trackError, summary as analyticsSummary } from './analytics.js';
import { detectFieldsViaVision, checkAndIncrementVisionUsage } from './vision.js';
import { generateDraft } from './ai-draft.js';
import { generateSummary, mergeSignerFills } from './ai-summary.js';
import { writeVerifyRecord, getVerifyRecord, isValidFingerprint } from './verify.js';
import { ensureSignedPdf, signedPdfKey } from './signed-pdf.js';
import { handleRequestLink, handleVerifyLink } from './auth.js';
import { listContacts, upsertContact, upsertContacts, removeContact, sanitizeSenderId, isValidContactEmail } from './contacts.js';
import { saveTemplate, lookupTemplate } from './templates.js';
import {
  freeSignup,
  freeConsume,
  freePeek,
  freeRefund,
  writeFreeTokenPointer,
  getDatasetCount,
  ownerDripList,
  dripEmailForHash,
} from './free-tier.js';
import { exportDatasetJsonl, getDatasetStats, maybeFirePhase3Alert } from './dataset.js';
import { checkRateLimit, ipKey, rateLimitedResponse } from './rate-limit.js';
import { maybeInjectAnalytics } from './analytics-inject.js';
import { runUptimeProbe, readUptimeWindow } from './uptime.js';
import { reportToSentry, recordError, getRecentErrors } from './sentry.js';
import { runDailyKvBackup, shouldRunKvBackup, getLatestKvBackup, getLatestKvPrune, pruneOldBackups, backupSignedArtifacts } from './kv-backup.js';
import { findTemplate, listTemplates, generateTemplatePdf, sendTemplateByEmail, fetchStaticTemplatePdf, sanitizeSlug } from './templates-library.js';
import { getWebhookConfig, saveWebhookConfig, deleteWebhookConfig, fireWebhook, getDeliveryLog, WEBHOOK_EVENTS, redeliverWebhook } from './webhooks.js';
import { sweepWebhookQueue } from './webhook-retry.js';
import { routeApiV1 } from './api-v1.js';
import { createApiKey, listApiKeys, revokeApiKey } from './apikeys.js';
import { registerAffiliate, bumpClick, bumpSignup, recordConversion, getCodeStats } from './affiliate.js';
import { getRoadmap, castVote } from './roadmap.js';
import { runMonthlyOwnerReport } from './owner-report.js';
import { runDripCampaign, shouldRunDripCampaign } from './drip-campaign.js';
import { runSecurityCheck, getLatestSecurityCheck } from './security-check.js';
import { bumpDailyMetric, readDailyMetrics, readSubsRegistry, ensureSubsBackfill, ensureDailyBackfill } from './metrics-counters.js';
// Funnel instrument. Aliased because index.js already declares its own
// handleEvent for the legacy /api/event queue endpoint below.
import { handleEvent as handleFunnelEvent, handleOwnerFunnel, countCrawler } from './events.js';
import { AtomicCounter } from './atomic-do.js';
import { mintErasureToken, consumeErasureToken, eraseIdentity, writeErasureReceipt, normalizeEmail, emailHashOf,
  backfillOwnershipIndex,
} from './erasure.js';
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
  purchasableTiers,
  tierIncludesAi,
} from './stripe.js';

const VERSION = '0.2.0';

// Monthly recurring revenue, in integer cents, per paid tier. Used by the
// Vyan Control metrics endpoint to attribute MRR. Annual plans are normalized
// to their monthly-equivalent cents; lifetime is one-time so it contributes 0
// to recurring MRR. Free contributes 0. Keep in step with stripe.js TIERS and
// the public pricing page. (solo $12, founding/Origin $9, team/Studio $29.)
const TIER_MRR_CENTS = {
  solo: 1200,
  solo_annual: 1000, // $120/yr ~ $10/mo
  pro: 1900,
  pro_annual: 1500, // $180/yr ~ $15/mo
  founding: 900,
  founding_annual: 750, // $90/yr ~ $7.50/mo
  team: 2900,
  team_annual: 2300, // $276/yr = $23/mo (Studio annual, two months free)
  business: 7900,
  business_annual: 6500, // $780/yr ~ $65/mo
  whitelabel: 1900, // recurring add-on
  seat: 900, // per seat, per month (multiply by quantity at attribution)
  lifetime: 0, // one-time, not recurring
  free: 0,
};

// Hostnames that serve the owner /control/ panel. control.cybersygn.io is the
// original; admin/owner.cybersygn.io are convenience aliases. All are still
// gated by the owner login (owner token is per-origin, so each host logs in on
// its own). Keep in sync with the "routes" custom_domain list in wrangler.jsonc.
const OWNER_PANEL_HOSTS = new Set([
  'control.cybersygn.io', 'www.control.cybersygn.io',
  'admin.cybersygn.io', 'www.admin.cybersygn.io',
  'owner.cybersygn.io', 'www.owner.cybersygn.io',
]);

const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB ceiling for Phase 1
const DETECTION_TIMEOUT_MS = 15000;
const MAX_JSON_BYTES = 256 * 1024; // default for small JSON endpoints
// Doc-creation / bulk-send / snapshot-email carry a base64 PDF in the body. A
// 25MB PDF base64-encodes to ~34MB; add headroom for fields/signers/assignments.
// (This cap must be a NUMBER, readJsonBody(request, maxBytes) ignores objects.)
const MAX_DOC_JSON_BYTES = 36 * 1024 * 1024;
const DOC_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Retention policy for a document record.
 *
 * IN FLIGHT: 30 days. An abandoned draft that nobody ever signed should not
 * live forever, and expiring it is good hygiene rather than a broken promise.
 *
 * COMPLETED: kept, no TTL. The audit certificate we hand every signer states
 * "CyberSygn retains an immutable copy of the signed document for the life of
 * your account." The 30 day expiry silently broke that promise on day 31, in
 * the one artifact a counterparty relies on as evidence. For a signature
 * product that is the worst possible failure: the proof of a contract vanishes
 * exactly when a dispute is most likely to surface.
 *
 * Retention is deliberately NOT tier-aware. The promise is made to the SIGNER,
 * who never chose our plan and may not even know which one the sender is on.
 * A free-tier sender's counterparty received the same certificate and the same
 * words, so they get the same guarantee.
 */
function docRetention(doc) {
  return (doc && doc.completedAt) ? {} : { expirationTtl: DOC_TTL_SECONDS };
}

/**
 * Run one cron job so its failure is VISIBLE.
 *
 * Every scheduled job used to end in console.error or a bare .catch(() => {}).
 * Cloudflare does not retain console output and nobody tails it, so a cron that
 * had been failing every hour for a month looked exactly like one that had
 * never failed. The error ring that /api/owner/errors reads was wired only into
 * fetch, so the entire scheduled side of the worker was invisible.
 *
 * Swallowing stays deliberate in one respect: one failing job must not prevent
 * the others from running, so this never rethrows.
 */
function cronTask(env, name, work) {
  return Promise.resolve()
    .then(() => (typeof work === 'function' ? work() : work))
    .catch(async (err) => {
      console.error(`[cron:${name}] failed:`, (err && err.stack) || err);
      try { await recordError(env, err, { where: `cron:${name}` }); } catch (_) {}
      try { await reportToSentry(env, err, { where: `cron:${name}` }); } catch (_) {}
    });
}

const worker = {
  async fetch(request, env, ctx) {
   try {
    // CAN-SPAM physical address for email footers, configured per invocation
    // so every email path (invite, drip, reports) picks it up when set.
    setEmailBusinessAddress(env && env.CYBERSYGN_BUSINESS_ADDRESS);
    const url = new URL(request.url);

    // Dedicated owner-panel hosts. control/admin/owner.cybersygn.io all serve
    // the same /control/ panel: their root and ./control.js map into the
    // /control/ asset subtree. Everything else the panel loads (/styles.css,
    // /brand/*, /api/owner/*) uses absolute root paths and resolves normally on
    // any worker-bound host, so only the two panel-specific paths need
    // remapping. Access is still gated by the owner login on each host (owner
    // token is per-origin), so extra hostnames add convenience, not privilege.
    if (OWNER_PANEL_HOSTS.has(url.hostname)) {
      let mapped = null;
      if (url.pathname === '/' || url.pathname === '') mapped = '/control/';
      else if (url.pathname === '/control.js') mapped = '/control/control.js';
      if (mapped && env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const assetUrl = new URL(request.url);
        assetUrl.pathname = mapped;
        let resp = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
        // ASSETS may 30x-normalize (e.g. /control/index.html -> /control/). Follow once
        // and return the final body so the visible URL on control.cybersygn.io stays clean.
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (loc) {
            const next = new URL(loc, assetUrl);
            resp = await env.ASSETS.fetch(new Request(next.toString(), { method: 'GET', headers: request.headers }));
          }
        }
        return hardenAssetHeaders(resp, url.pathname);
      }
    }

    // Canonical host consolidation. www serves the site 200 today with only a
    // rel=canonical hint; a real 301 consolidates link equity and crawl budget
    // on the apex. Only the marketing www alias redirects; control/www.control
    // are handled above and API traffic never uses www.
    if (url.hostname === 'www.cybersygn.io') {
      return Response.redirect('https://cybersygn.io' + url.pathname + url.search, 301);
    }
    // The workers.dev preview host mirrors the whole site as a crawlable
    // duplicate origin. Keep it usable for debugging but tell crawlers it is
    // not the canonical site: serve a Disallow-all robots.txt and stamp
    // X-Robots-Tag: noindex on everything else from that host.
    const isPreviewHost = url.hostname.endsWith('.workers.dev');
    if (isPreviewHost && url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' },
      });
    }

    // /api/status is handled by handleStatus (subsystem shape + liveness
    // fields). A second registration below routes it; do not add a shadowing
    // handler here or the status page shows a false "degraded".

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return await handleHealth(env);
    }

    // 301 redirects: Origin tier rename. Anyone with a /charter/* link
    // (early Origin members, social shares, indexed pages) gets permanently
    // redirected to /origin/*. Cheap, preserves SEO juice, keeps inbound
    // links alive forever.
    if (url.pathname === '/charter' || url.pathname === '/charter/') {
      return Response.redirect('https://cybersygn.io/origin/', 301);
    }
    // Campaign-friendly pricing URL: /pricing is the natural link people type
    // into ads, emails, and posts, but pricing lives on the homepage anchor.
    if (url.pathname === '/pricing' || url.pathname === '/pricing/') {
      return Response.redirect('https://cybersygn.io/#pricing', 301);
    }
    if (url.pathname.startsWith('/charter/')) {
      const tail = url.pathname.slice('/charter/'.length);
      return Response.redirect(`https://cybersygn.io/origin/${tail}`, 301);
    }

    // /api/detect as well as /detect. Everything under /api/* already runs the
    // Worker first, so the aliased path works without any routing config, and
    // /detect itself is now listed in run_worker_first: without that the asset
    // layer answered 405 before the Worker ever saw the request, so the
    // endpoint this module's own header documents was unreachable in
    // production.
    if (request.method === 'POST' && (url.pathname === '/detect' || url.pathname === '/api/detect')) {
      // /detect is unauthenticated and runs the heaviest compute in the worker
      // (full PDF parse on up to 25MB of attacker-controlled bytes). Throttle
      // it like /api/docs so a single IP cannot exhaust CPU/duration. Generous
      // enough for the live homepage demo, which detects once per dropped file.
      const rl = await checkRateLimit(env, `detect:${ipKey(request)}`, [
        { windowSec: 60, max: 20 },
        { windowSec: 3600, max: 200 },
      ]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/detect' });
      return await handleDetect(request);
    }

    if (request.method === 'POST' && url.pathname === '/api/detect-vision') {
      return await handleDetectVision(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/templates') {
      const rl = await checkRateLimit(env, `tpl-save:${ipKey(request)}`, [{ windowSec: 600, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/templates' });
      return await handleSaveTemplate(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/templates') {
      return await handleLookupTemplate(request, env, url);
    }

    // Free tier (3 docs lifetime per email, lead capture, dataset consent)
    if (request.method === 'POST' && url.pathname === '/api/free/signup') {
      return await handleFreeSignup(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/free/consume') {
      return await handleFreeConsume(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/free/email-signed-pdf') {
      return await handleEmailSignedPdf(request, env);
    }

    // Cross-device sign-in: email magic link (the sign-in key path is
    // client-side only). See worker/src/auth.js + docs/STANDALONE-APP.md.
    if (request.method === 'POST' && url.pathname === '/api/auth/request-link') {
      return await handleRequestLink(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
      return await handleVerifyLink(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/dataset/count') {
      return await handleDatasetCount(env);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/drip-list') {
      return await handleOwnerDripList(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/dataset/export') {
      return await handleOwnerDatasetExport(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/dataset/stats') {
      return await handleOwnerDatasetStats(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/report/preview') {
      return await handleOwnerReportPreview(request, env, url);
    }
    if (url.pathname === '/api/owner/security-check') {
      return await handleOwnerSecurityCheck(request, env, url, ctx);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/drip/run') {
      return await handleOwnerDripRun(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      const rl = await checkRateLimit(env, `signup:${ipKey(request)}`, [{ windowSec: 600, max: 8 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/signup' });
      return await handleSignup(request, env);
    }

    // ---- Owner backdoor ------------------------------------------------
    // POST /api/owner/claim  body: { phrase: "..." } -> { ok, token } or 401
    // GET  /api/owner/verify  with X-CyberSygn-Owner header -> { ok, owner }
    if (request.method === 'POST' && url.pathname === '/api/owner/claim') {
      return await handleOwnerClaim(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/verify') {
      return await handleOwnerVerify(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/login') {
      return await handleOwnerLogin(request, env);
    }
    // Email-gated owner password reset. request -> emails a one-time link ONLY
    // to the configured OWNER_EMAIL; confirm -> sets a new KV-stored credential.
    if (request.method === 'POST' && url.pathname === '/api/owner/reset/request') {
      return await handleOwnerResetRequest(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/reset/confirm') {
      return await handleOwnerResetConfirm(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/test-email') {
      return await handleOwnerTestEmail(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/event') {
      return await handleEvent(request, env, url);
    }
    // The canonical 11-step funnel. Separate from /api/event: this one also
    // writes permanent KV counters that outlive the Analytics Engine window.
    if (request.method === 'POST' && url.pathname === '/api/e') {
      return await handleFunnelEvent(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/error') {
      // Tight rate limit on client-error reports, bug-spam is a real
      // failure mode and we don't want it to hot-spot Resend.
      const rl = await checkRateLimit(env, `err:${ipKey(request)}`, [{ windowSec: 60, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/error' });
      return await handleClientError(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/contact') {
      return await handleContact(request, env, url);
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      return await handleStatus(request, env, url);
    }

    // Public roadmap with voting.
    if (request.method === 'GET' && url.pathname === '/api/roadmap') {
      const data = await getRoadmap(env);
      return jsonResponse(200, data);
    }
    if (request.method === 'POST' && url.pathname === '/api/roadmap/vote') {
      const rl = await checkRateLimit(env, `roadmap-vote:${ipKey(request)}`, [{ windowSec: 3600, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/roadmap/vote' });
      const body = await readJsonBody(request);
      if (body.error) return jsonResponse(400, body.error);
      const { itemId, voter } = body.value || {};
      const r = await castVote(env, itemId, voter);
      return jsonResponse(r.ok ? 200 : 400, r);
    }

    // Affiliate program endpoints.
    if (request.method === 'POST' && url.pathname === '/api/affiliate/register') {
      const rl = await checkRateLimit(env, `aff-reg:${ipKey(request)}`, [{ windowSec: 3600, max: 10 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/affiliate/register' });
      return await handleAffiliateRegister(request, env, url);
    }
    // Ambassador dashboard payload: everything the page needs in one response.
    if (request.method === 'GET' && url.pathname === '/api/ambassador/me') {
      const rl = await checkRateLimit(env, `ambme:${ipKey(request)}`, [{ windowSec: 60, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/ambassador/me' });
      return await handleAmbassadorMe(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/ambassador/learn') {
      const rl = await checkRateLimit(env, `amblearn:${ipKey(request)}`, [{ windowSec: 60, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/ambassador/learn' });
      return await handleAmbassadorLearn(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/ambassador/accept-terms') {
      const rl = await checkRateLimit(env, `ambterms:${ipKey(request)}`, [{ windowSec: 60, max: 20 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/ambassador/accept-terms' });
      return await handleAmbassadorAcceptTerms(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/affiliate/click') {
      const rl = await checkRateLimit(env, `aff-click:${ipKey(request)}`, [{ windowSec: 60, max: 30 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/affiliate/click' });
      return await handleAffiliateClick(request, env, url);
    }
    {
      const m = url.pathname.match(/^\/api\/affiliate\/([a-z0-9]{4,16})$/);
      if (request.method === 'GET' && m) {
        return await handleAffiliateStats(request, env, url, m[1]);
      }
    }

    // ---- Self-serve erasure (GDPR Art. 17) ---------------------------
    //
    // Two steps on purpose. Step one proves control of the mailbox, step two
    // does the destroying. senderId identifies but does not authenticate (it
    // is a localStorage value sent on ordinary calls), so it can never be the
    // thing that authorizes an irreversible delete.
    if (request.method === 'POST' && url.pathname === '/api/erase/request') {
      const rl = await checkRateLimit(env, `erasereq:${ipKey(request)}`, [
        { windowSec: 60 * 15, max: 5 },
        { windowSec: 60 * 60 * 24, max: 20 },
      ]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/erase/request' });

      const body = await readJsonBody(request, 4096);
      if (body.error) return jsonResponse(400, body.error);
      const email = normalizeEmail(body.value && body.value.email);
      const scope = (body.value && body.value.scope) === 'documents' ? 'documents' : 'account';
      if (!email || email.length > 200 || !email.includes('@')) {
        return jsonResponse(400, { error: 'invalid_email' });
      }

      // Always the same answer, whether or not this email owns anything.
      // Otherwise the endpoint becomes an account-existence oracle.
      // Per-EMAIL limit as well as per-IP. Without it, anyone who knows an
      // address can have deletion emails sent to that person from a rotating
      // set of IPs. auth.js already does this for magic links and says why.
      // Keyed on the hash so no address is written into a rate-limit key.
      const emailKey = (await emailHashOf(email)).slice(0, 32);
      const perEmail = await checkRateLimit(env, `erasemail:${emailKey}`, [
        { windowSec: 60 * 15, max: 3 },
        { windowSec: 60 * 60 * 24, max: 8 },
      ]);
      // Answer identically whether the limit tripped or not: a distinguishable
      // 429 would reveal that this address has been targeted, which is itself
      // a signal about whether the account exists.
      const token = perEmail.ok
        ? await mintErasureToken(env, email, scope).catch(() => null)
        : null;
      if (token) {
        const base = (env.CYBERSYGN_APP_URL || 'https://cybersygn.io').replace(/\/+$/, '');
        const link = `${base}/erase/?token=${token}`;
        // A discarded outcome here is the difference between "your link is on
        // the way" and silence. deliverEmail RETURNS { delivered:false, error }
        // rather than throwing, so the old .catch(() => {}) was not even the
        // mechanism that lost it: the result was simply never read. If the one
        // email standing between a person and their Article 17 request fails,
        // that has to be visible to the owner.
        ctx.waitUntil((async () => {
          let r;
          try {
            r = await deliverEmail(env, {
              to: email,
              subject: 'Confirm you want your CyberSygn data deleted',
              html: renderErasureHtml({ link, scope }),
            });
          } catch (e) { r = { delivered: false, error: (e && e.message) || String(e) }; }
          if (!r || !r.delivered) {
            console.error('[erase] confirmation email NOT delivered:', (r && r.error) || 'unknown');
            try { await recordError(env, new Error(`erasure confirmation not delivered: ${(r && r.error) || 'unknown'}`), { where: 'erase-confirm-email' }); } catch (e) {}
          }
        })());
      }
      return jsonResponse(200, {
        ok: true,
        message: 'If that address has data with us, a confirmation link is on its way. It expires in 30 minutes.',
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/erase/confirm') {
      const rl = await checkRateLimit(env, `erasecfm:${ipKey(request)}`, [{ windowSec: 60 * 15, max: 10 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/erase/confirm' });

      const body = await readJsonBody(request, 4096);
      if (body.error) return jsonResponse(400, body.error);
      const claim = await consumeErasureToken(env, String((body.value && body.value.token) || ''));
      if (!claim) return jsonResponse(400, { error: 'invalid_or_expired' });

      const tally = await eraseIdentity(env, claim);  // claim carries emailHash + senderIds + scope
      const receipt = await writeErasureReceipt(env, {
        emailHash: claim.emailHash, scope: claim.scope, tally,
      });
      // Report partial failure honestly. Telling someone their data is gone
      // when some of it is not is the one outcome this feature must never
      // produce, so any delete error or an incomplete scan downgrades the
      // answer instead of being swallowed by a blanket ok:true.
      const clean = tally.errors.length === 0 && tally.scanComplete !== false;
      return jsonResponse(200, {
        ok: true,
        complete: clean,
        scope: claim.scope,
        documentsDeleted: tally.documents,
        verifyRecordsKept: tally.keptVerifyRecords,
        incompleteReason: clean ? null : 'Some records could not be removed. Contact hello@cybersygn.io with your receipt id and we will finish it by hand.',
        receiptId: receipt.id,
        note: 'Verification records are anonymous fingerprints with no personal data. They are kept so anyone holding a copy of a signed document can still prove it is genuine.',
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/owner/funnel') {
      return await handleOwnerFunnel(request, env, url);
    }

    // Recent worker errors, PII-free, for when no Sentry DSN is configured.
    if (request.method === 'GET' && url.pathname === '/api/owner/errors') {
      const owner = await getOwnerForRequest(request, env, url);
      if (!owner) return jsonResponse(401, { error: 'unauthorized' });
      return jsonResponse(200, { errors: await getRecentErrors(env) });
    }

    // Freeze or unfreeze an ambassador's payouts.
    //
    // The freeze was fully ENFORCED before it was reachable: payoutState
    // reports owner_freeze and recordPayout refuses with payout_frozen, but
    // setPayoutBlock had no caller, so the control could never be applied.
    // A safety control that cannot be invoked is not a safety control.
    if (request.method === 'POST' && url.pathname === '/api/owner/ambassadors/freeze') {
      const owner = await getOwnerForRequest(request, env, url);
      if (!owner) return jsonResponse(401, { error: 'unauthorized' });
      const body = await readJsonBody(request, 4096);
      if (body.error) return jsonResponse(400, body.error);
      const { setPayoutBlock } = await import('./ambassador.js');
      const code = String((body.value && body.value.code) || '').trim();
      const blocked = body.value ? body.value.blocked !== false : true;
      const r = await setPayoutBlock(env, code, blocked, (body.value && body.value.reason) || '');
      return jsonResponse(r.ok ? 200 : 400, r);
    }

    // Run the KV backup on demand, and read the last result. The backup fires
    // from a daily cron, so without this a failure stays invisible for a day
    // and "we have backups" is an assumption rather than a checked fact. It
    // shipped for months with no R2 binding at all: it wrote nothing, every
    // single day, and reported that to nobody.
    if (request.method === 'POST' && url.pathname === '/api/owner/backup/run') {
      const owner = await getOwnerForRequest(request, env, url);
      if (!owner) return jsonResponse(401, { error: 'unauthorized' });
      const result = await runDailyKvBackup(env);
      return jsonResponse(result && result.ok ? 200 : 500, result);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/backup') {
      const owner = await getOwnerForRequest(request, env, url);
      if (!owner) return jsonResponse(401, { error: 'unauthorized' });
      // The prune's outcome too. Deleting snapshots on schedule is the half of
      // the retention promise a user actually cares about, and it was the half
      // with no record at all.
      return jsonResponse(200, {
        latest: await getLatestKvBackup(env),
        prune: await getLatestKvPrune(env),
      });
    }

    // ---- Ambassador program, owner only ------------------------------
    if (request.method === 'GET' && url.pathname === '/api/owner/ambassadors') {
      return await handleOwnerAmbassadors(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ambassadors/payout') {
      return await handleOwnerAmbassadorPayout(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ambassadors/taxdoc') {
      return await handleOwnerAmbassadorTaxDoc(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ambassadors/revoke') {
      return await handleOwnerAmbassadorRevoke(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/owner/ambassadors/test-email') {
      return await handleOwnerAmbassadorTestEmail(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/owner/metrics/dashboard') {
      return await handleMetricsDashboard(request, env, url);
    }

    // ---- Vyan Control metrics (spine CONTRACT §6) ----------------------
    // Standardized, house-key-authenticated read so Vyan Control can poll
    // CyberSygn the same way it polls every other product in the portfolio.
    // 401 when no key is configured or the bearer token does not match.
    if (request.method === 'GET' && url.pathname === '/api/metrics') {
      if (!metricsAuthorized(request, env)) {
        return jsonResponse(401, { error: 'unauthorized', message: 'House key required (Authorization: Bearer <VYAN_METRICS_KEY>).' });
      }
      return await handleMetrics(env, url);
    }

    // ---- Public-API keys (owner-only): mint / list / revoke -------------
    //   POST   /api/owner/apikeys   { senderId, label } -> { id, key (once), last4 }
    //   GET    /api/owner/apikeys?senderId=...           -> { keys: [...] }
    //   DELETE /api/owner/apikeys   { senderId, keyId }  -> { revoked }
    // The key acts AS `senderId`, inheriting that account's plan + webhooks.
    if (url.pathname === '/api/owner/apikeys') {
      const ownerCtx = await getOwnerForRequest(request, env, url);
      if (!ownerCtx) return jsonResponse(401, { error: 'unauthorized', message: 'Owner auth required.' });
      if (request.method === 'POST') {
        const b = await readJsonBody(request);
        if (b.error) return jsonResponse(400, b.error);
        const sid = String((b.value && b.value.senderId) || '').trim();
        if (!sid) return jsonResponse(400, { error: 'missing_senderId', message: 'senderId is required (the account the key acts as).' });
        const made = await createApiKey(env, sid, {
          label: (b.value && b.value.label) || 'default',
          mode: (b.value && b.value.mode) || 'live',
          unmetered: !!(b.value && b.value.unmetered),
          canProvision: !!(b.value && b.value.canProvision),
          partnerId: (b.value && b.value.partnerId) || null,
        });
        if (!made) return jsonResponse(500, { error: 'mint_failed', message: 'Could not mint key.' });
        return jsonResponse(201, { ok: true, ...made, warning: 'Store this key now, it is shown only once.' });
      }
      if (request.method === 'GET') {
        return jsonResponse(200, { keys: await listApiKeys(env, url.searchParams.get('senderId') || '') });
      }
      if (request.method === 'DELETE') {
        const b = await readJsonBody(request);
        if (b.error) return jsonResponse(400, b.error);
        const ok = await revokeApiKey(env, (b.value && b.value.senderId) || '', (b.value && b.value.keyId) || '');
        return jsonResponse(ok ? 200 : 404, { revoked: ok });
      }
      return jsonResponse(405, { error: 'method_not_allowed', message: 'Use GET, POST, or DELETE.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/analytics/summary') {
      return await handleAnalyticsSummary(request, env, url);
    }

    // ---- Billing -------------------------------------------------------
    // POST /api/checkout/create-session  body: { tier, senderId, email? } -> { url }
    // POST /api/stripe/webhook            raw Stripe event body
    // GET  /api/billing/portal?senderId=...                            -> { url }
    // GET  /api/billing/subscription?senderId=...                      -> { tier, status, usage, founding }
    // GET  /api/billing/founding-count                                 -> { taken, cap, remaining }
    if (request.method === 'POST' && url.pathname === '/api/checkout/create-session') {
      return await handleCheckoutCreateSession(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') {
      return await handleStripeWebhook(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/portal') {
      return await handleBillingPortal(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/subscription') {
      return await handleBillingSubscription(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/founding-count') {
      return await handleFoundingCount(env);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/lifetime-count') {
      return await handleLifetimeCount(env);
    }
    if (request.method === 'GET' && url.pathname === '/api/billing/config') {
      return jsonResponse(200, { purchasable: purchasableTiers(env) }, { 'cache-control': 'public, max-age=120' });
    }
    if (request.method === 'GET' && url.pathname === '/api/status/uptime') {
      return await handleUptimeRead(env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/testimonial') {
      return await handleTestimonialSubmit(request, env, url);
    }
    if (request.method === 'GET' && url.pathname === '/api/testimonials') {
      return await handleTestimonialsList(env);
    }
    if (request.method === 'POST' && url.pathname === '/api/draft/generate') {
      return await handleDraftGenerate(request, env, url);
    }
    // Template library (slice 105).
    if (request.method === 'GET' && url.pathname === '/api/templates/list') {
      return jsonResponse(200, { templates: listTemplates() });
    }
    if (request.method === 'POST' && url.pathname === '/api/templates/send') {
      return await handleTemplateSend(request, env, url);
    }
    {
      const m = url.pathname.match(/^\/api\/templates\/download\/([a-z0-9-]+)$/);
      if (m && request.method === 'GET') {
        return await handleTemplateDownload(request, env, url, m[1]);
      }
    }

    // GDPR data subject export. Slice 100; email-confirmation auth added
    // in the hardening follow-up. Two-step: request a code to the email
    // bound to the sender, then confirm the code to receive the export.
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/gdpr-export(\/request|\/confirm)?$/);
      if (m) {
        if (request.method === 'POST' && m[2] === '/request') {
          return await handleGdprExportRequest(request, env, m[1]);
        }
        if (request.method === 'POST' && m[2] === '/confirm') {
          return await handleGdprExportConfirm(request, env, m[1]);
        }
        if (request.method === 'GET' && !m[2]) {
          // The old single-GET export is gone: it authenticated with the
          // senderId alone. Point callers at the confirmed flow.
          return jsonResponse(410, {
            error: 'flow_upgraded',
            message: 'Data export now requires email confirmation. POST /api/sender/:id/gdpr-export/request with {"email"} (the email you signed up or subscribed with), then POST .../gdpr-export/confirm with the emailed {"code"}.',
          });
        }
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/origin/wall') {
      // Public but expensive: one call lists up to 1000 sub:* keys and gets
      // each. Throttle per-IP so it cannot be used as a KV read-amplification
      // lever. Generous because the homepage polls it for the founder counter.
      const rl = await checkRateLimit(env, `originwall:${ipKey(request)}`, [
        { windowSec: 60, max: 30 },
        { windowSec: 3600, max: 300 },
      ]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/origin/wall' });
      return await handleOriginWall(env);
    }
    if (request.method === 'POST' && url.pathname === '/api/origin/profile') {
      return await handleOriginProfile(request, env, url);
    }

    // ---- Multi-signer routes ------------------------------------------

    // Create a document: persist PDF + signers + assignments, mint per-signer
    // tokens, and email each signer their magic link.
    if (request.method === 'POST' && url.pathname === '/api/docs/bulk') {
      return await handleBulkSend(request, env, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/docs') {
      // Generous rate limit on doc creation, paid customers send
      // dozens a day, but a flood-loop should still be capped.
      const rl = await checkRateLimit(env, `docs:${ipKey(request)}`, [{ windowSec: 600, max: 60 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/docs' });
      return await handleCreateDoc(request, env, url, ctx);
    }

    // Per-signer hydration: GET /api/docs/:docId/signer/:token
    // Returns the signer's name, the fields they own, and a presigned
    // pointer to the original PDF.
    const signerMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)$/);
    if (request.method === 'GET' && signerMatch) {
      return await handleHydrateSigner(request, env, signerMatch[1], signerMatch[2]);
    }

    // Signer submits their fills.
    const fillsMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)\/fills$/);
    if (request.method === 'POST' && fillsMatch) {
      return await handleSubmitFills(request, env, fillsMatch[1], fillsMatch[2], url, ctx);
    }

    // Signer declines to sign. Marks declinedAt, halts further reminders,
    // notifies the sender. One-way: a declined signer cannot un-decline,
    // the sender has to send a new doc.
    const declineMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signer\/([^/]+)\/decline$/);
    if (request.method === 'POST' && declineMatch) {
      return await handleDeclineSign(request, env, declineMatch[1], declineMatch[2], url);
    }

    // Direct PDF-to-CC email. Used by single-signer flows that want to
    // copy additional recipients without going through the magic-link
    // signing flow. Sender uploads the flattened PDF as base64; worker
    // emails it with attachment via Resend to each recipient.
    if (request.method === 'POST' && url.pathname === '/api/snapshot/email') {
      return await handleSnapshotEmail(request, env, url);
    }

    // Fetch the original PDF for an authenticated signer.
    const pdfMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/pdf$/);
    if (request.method === 'GET' && pdfMatch) {
      return await handleGetPdf(request, env, pdfMatch[1], url);
    }

    // Fetch the CANONICAL SIGNED document. Separate from /pdf on purpose:
    // /pdf must keep returning the ORIGINAL because the signing canvas loads
    // those bytes and draws live field boxes over them. Returning flattened
    // bytes there would render baked signatures underneath live inputs and
    // double-draw on download.
    const signedMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/signed$/);
    if (request.method === 'GET' && signedMatch) {
      return await handleGetSignedPdf(request, env, signedMatch[1], url);
    }

    // Fetch the audit-certificate PDF. Same token auth as the PDF
    // endpoint, so any signer can pull the certificate; in production
    // the sender's account would also unlock it.
    const auditMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/audit$/);
    if (request.method === 'GET' && auditMatch) {
      return await handleGetAudit(request, env, auditMatch[1], url);
    }

    // ---- Workspaces ----------------------------------------------------

    // Create a workspace. POST /api/workspaces  -> { workspaceId, workspaceToken, adminMemberId }
    if (request.method === 'POST' && url.pathname === '/api/workspaces') {
      const rl = await checkRateLimit(env, `ws-create:${ipKey(request)}`, [{ windowSec: 3600, max: 10 }]);
      if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/workspaces' });
      return await handleCreateWorkspace(request, env);
    }

    // Workspace doc list. GET /api/workspaces/:wsId/docs?w=workspaceToken
    const wsDocsMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/docs$/);
    if (request.method === 'GET' && wsDocsMatch) {
      return await handleListWorkspaceDocs(env, wsDocsMatch[1], url);
    }

    // Member list. GET /api/workspaces/:wsId/members?w=workspaceToken
    const wsMembersMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/members$/);
    if (request.method === 'GET' && wsMembersMatch) {
      return await handleListWorkspaceMembers(env, wsMembersMatch[1], url);
    }

    // Create an invite. POST /api/workspaces/:wsId/invites?w=workspaceToken
    //   body: { email?, name? }
    //   returns: { inviteId, inviteUrl }
    const wsInviteMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/invites$/);
    if (request.method === 'POST' && wsInviteMatch) {
      return await handleCreateInvite(request, env, wsInviteMatch[1], url);
    }

    // Accept an invite. POST /api/invites/:inviteId
    //   body: { senderId, name?, email? }
    //   returns: { workspaceId, workspaceToken, memberId, name }
    const acceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
    if (request.method === 'POST' && acceptMatch) {
      return await handleAcceptInvite(request, env, acceptMatch[1]);
    }

    // Read an invite (so the join page can render workspace name).
    // GET /api/invites/:inviteId
    if (request.method === 'GET' && acceptMatch) {
      return await handleGetInvite(env, acceptMatch[1]);
    }

    // Sender dashboard: list every doc this sender has created.
    // GET /api/docs/:docId/live?t=<signerToken>, co-signing presence.
    {
      const m = url.pathname.match(/^\/api\/docs\/([a-f0-9]{32,64})\/live$/);
      if (request.method === 'GET' && m) {
        return await handleDocLive(request, env, url, m[1]);
      }
      if (request.method === 'POST' && m) {
        return await handleDocPresenceUpdate(request, env, url, m[1]);
      }
    }

    // GET /api/sender/:senderId/templates, count of templates this sender saved.
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/templates$/);
      if (request.method === 'GET' && m) {
        return await handleSenderTemplatesCount(request, env, url, m[1]);
      }
    }

    // Custom branding for paid tiers (slice 90).
    // GET  /api/sender/:senderId/brand, public read of brand
    // POST /api/sender/:senderId/brand, paid-only write
    {
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/brand$/);
      if (m && request.method === 'GET') {
        return await handleBrandRead(request, env, m[1]);
      }
      if (m && request.method === 'POST') {
        return await handleBrandWrite(request, env, url, m[1]);
      }
    }

    // Outbound webhooks for Studio tier (slice 91).
    {
      // AWAITED. `return somePromise` inside this try block returns before the
      // promise settles, so a rejection never reaches the top-level catch and
      // escapes as a raw Cloudflare 1101 instead of the clean 500 that catch
      // exists to produce. Every other arm in this router awaits.
      const m = url.pathname.match(/^\/api\/sender\/([^/]+)\/webhook$/);
      if (m && request.method === 'GET')    return await handleWebhookGet(request, env, m[1]);
      if (m && request.method === 'POST')   return await handleWebhookPost(request, env, url, m[1]);
      if (m && request.method === 'DELETE') return await handleWebhookDelete(request, env, url, m[1]);
      const lm = url.pathname.match(/^\/api\/sender\/([^/]+)\/webhook\/log$/);
      if (lm && request.method === 'GET') return await handleWebhookLog(request, env, lm[1]);
    }

    // GET /api/sender/:senderId/docs
    const senderListMatch = url.pathname.match(/^\/api\/sender\/([^/]+)\/docs$/);
    if (request.method === 'GET' && senderListMatch) {
      return await handleListSenderDocs(env, senderListMatch[1]);
    }

    // F5 saved contacts. Same senderId-capability posture as /docs above:
    // possession of the senderId (a 256-bit localStorage token passed only
    // as a path segment) is the authorization.
    // GET / POST / DELETE /api/sender/:senderId/contacts
    const contactsMatch = url.pathname.match(/^\/api\/sender\/([^/]+)\/contacts$/);
    if (contactsMatch) {
      if (request.method === 'GET')    return handleListContacts(env, contactsMatch[1]);
      if (request.method === 'POST')   return handleUpsertContact(request, env, contactsMatch[1]);
      if (request.method === 'DELETE') return handleRemoveContact(request, env, contactsMatch[1]);
    }

    // F4 public verification. GET /api/verify/:hash: PII-free, cache 300s.
    const verifyMatch = url.pathname.match(/^\/api\/verify\/([^/]+)$/);
    if (request.method === 'GET' && verifyMatch) {
      return await handleVerify(env, verifyMatch[1]);
    }

    // F3 AI summary of a completed doc. POST /api/docs/:id/summary?t=<senderToken>
    const summaryMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/summary$/);
    if (request.method === 'POST' && summaryMatch) {
      return await handleDocSummary(request, env, summaryMatch[1], url);
    }

    // Sender-triggered reminder for a specific signer.
    // POST /api/docs/:docId/remind/:signerId
    const remindMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/remind\/([^/]+)$/);
    if (request.method === 'POST' && remindMatch) {
      return await handleRemind(request, env, remindMatch[1], remindMatch[2], url);
    }

    // Sender's view of progress for one of their docs (no auth in
    // Phase 1; in production this is keyed on the sender's account).
    const docMatch = url.pathname.match(/^\/api\/docs\/([^/]+)$/);
    if (request.method === 'GET' && docMatch) {
      return await handleGetDocProgress(env, docMatch[1], url);
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
    // Public API v1, API-key authenticated, server-to-server. Handled before
    // the /api/ 404 fallthrough; routeApiV1 returns null for non-v1 paths so
    // nothing else is affected.
    if (url.pathname.startsWith('/api/v1')) {
      const v1 = await routeApiV1(request, env, url, ctx, { handleCreateDoc, handleGetPdf, handleGetAudit, handleGetSignedPdf });
      if (v1) return v1;
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse(404, {
        error: 'not_found',
        message: 'No route matches this URL.',
      });
    }
    if (env && env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      // Crawler visibility. Every other telemetry path depends on browser
      // JavaScript, so Googlebot and the AI crawlers named in robots.txt are
      // otherwise completely invisible. HTML document serves only: counting
      // js/css/png would multiply one visit into a dozen. Fire and forget,
      // and countCrawler itself no-ops for any non-crawler user agent.
      const isHtmlDoc = request.method === 'GET' && (
        url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html')
      );
      if (isHtmlDoc && ctx && typeof ctx.waitUntil === 'function') {
        try { ctx.waitUntil(countCrawler(env, request)); } catch (e) {}
      }
      const upstream = await env.ASSETS.fetch(request);
      const hardened = hardenAssetHeaders(await maybeInjectAnalytics(upstream, env), url.pathname);
      // Preview host (workers.dev): mirror content for debugging, but keep it
      // out of the index so the apex stays the only crawlable origin.
      if (isPreviewHost) {
        const h = new Headers(hardened.headers);
        h.set('x-robots-tag', 'noindex');
        return new Response(hardened.body, { status: hardened.status, statusText: hardened.statusText, headers: h });
      }
      return hardened;
    }
    return new Response('Not found.', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
   } catch (err) {
      // Top-level safety net: never let an unhandled exception surface as a raw
      // Cloudflare 1101 page. Report it, then return clean JSON for API routes
      // and a generic 500 for everything else.
      try { await reportToSentry(env, err, { where: 'fetch', url: request.url }); } catch (_) {}
      // Also record locally. reportToSentry is a no-op with no DSN configured,
      // and console.error is not retained anywhere a human will look, so
      // without this an uncaught error in production is invisible.
      try { await recordError(env, err, { where: 'fetch', url: request.url }); } catch (_) {}
      console.error('[fetch] unhandled:', (err && err.stack) || err);
      let isApi = false;
      try { isApi = new URL(request.url).pathname.startsWith('/api/'); } catch (_) {}
      if (isApi) return jsonResponse(500, { error: 'internal_error', message: 'Something went wrong. Please try again.' });
      return new Response('Internal error.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
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
    setEmailBusinessAddress(env && env.CYBERSYGN_BUSINESS_ADDRESS);
    ctx.waitUntil(cronTask(env, 'reminder-sweep', () => runReminderSweep(env, event)));
    if (shouldRunMonthlyReport(event)) {
      ctx.waitUntil(cronTask(env, 'monthly-owner-report', () => runMonthlyOwnerReport(env, event)));
    }
    if (shouldRunDripCampaign(event)) {
      ctx.waitUntil(cronTask(env, 'drip-campaign', () => runDripCampaign(env, event)));
    }
    // Ambassador mail. Monthly scoreboard on the 1st (same window as the owner
    // report), weekly digest on Mondays. Both are internally guarded so a
    // duplicate cron fire cannot double-send.
    if (shouldRunMonthlyReport(event)) {
      ctx.waitUntil(cronTask(env, 'ambassador-monthly', (async () => {
        const { runMonthlyScoreboard } = await import('./ambassador-email.js');
        await runMonthlyScoreboard(env, {});
      })()));
    }
    if (shouldRunAmbassadorWeekly(event)) {
      ctx.waitUntil(cronTask(env, 'ambassador-weekly', (async () => {
        const { runWeeklyDigest } = await import('./ambassador-email.js');
        await runWeeklyDigest(env, {});
      })()));
    }
    // Daily KV to R2 backup at 03:00 UTC (slice 100). No-op if R2
    // binding isn't configured.
    if (shouldRunKvBackup(event)) {
      // Back up, then prune. Pruning is what makes an erasure request actually
      // propagate out of the snapshots instead of living in them forever.
      // The NDJSON dump covers the document store. backupSignedArtifacts
      // covers the signed PDFs and audit certificates, which live in the other
      // namespace and so had no backup at all despite being the artifacts the
      // product promises to keep forever. Copy-once, so it does not rewrite
      // every signed PDF every night.
      ctx.waitUntil(cronTask(env, 'kv-backup', () => runDailyKvBackup(env)
        .then(() => backupSignedArtifacts(env))
        .then(() => pruneOldBackups(env))));
    }
    // Sweep the durable webhook retry queue every hour: any Studio delivery
    // that failed both inline attempts gets redelivered with exponential
    // backoff until it succeeds or dead-letters.
    ctx.waitUntil(cronTask(env, 'webhook-retry', () => sweepWebhookQueue(env, redeliverWebhook)));
    // One-time, resumable backfill of the doc-of:<senderId>:<docId> ownership
    // keys. Retires the erasure sweep's full-namespace scan; a no-op once done.
    ctx.waitUntil(cronTask(env, 'ownership-backfill', () => backfillOwnershipIndex(env)));
    // Automated security self-check twice daily, 00:00 and 12:00 UTC
    // (06:00 / 18:00 America/Denver during MDT). Emails the owner only on
    // failure; a passing run is silent. Wrapped so it can never break the cron.
    if (shouldRunSecurityCheck(event)) {
      ctx.waitUntil(cronTask(env, 'security-check', () => runSecurityCheck(env, { trigger: 'cron', dispatch: selfDispatch(env, ctx) })));
    }
    // Uptime self-probe (slice 99). Synchronous KV check is enough, if
    // the binding is up the worker can respond; if it isn't, we record
    // a failure for the day.
    // Measure the REAL endpoint, not the binding.
    //
    // This used to inline a KV put-then-get inside the cron isolate, which is
    // the degraded fallback branch of runUptimeProbe, and record that as the
    // uptime number. It proves only that the KV binding answers: a worker whose
    // routing, auth or /api/health handler was broken would still have reported
    // 100%. runUptimeProbe with a dispatch has been written and tested this
    // whole time; nothing called it with one.
    ctx.waitUntil(cronTask(env, 'uptime-probe',
      () => runUptimeProbe(env, { dispatch: selfDispatch(env, ctx) })));
  },
};

export default worker;

// In-process request dispatcher for the security self-check. A Worker
// cannot fetch its OWN public hostname from the scheduled() context: the
// self-subrequest re-enters the same zone and Cloudflare times it out
// (HTTP 522). Dispatching synthetic Requests straight to worker.fetch
// exercises the identical routing + auth + headers with no network hop.
function selfDispatch(env, ctx) {
  const safeCtx = ctx && typeof ctx.waitUntil === 'function' ? ctx : { waitUntil() {}, passThroughOnException() {} };
  return (request) => worker.fetch(request, env, safeCtx);
}

/**
 * Ambassador weekly digest window: Mondays 15:00 UTC (mid-morning US). The
 * digest itself only mails ambassadors who had sales, so a quiet week is silent.
 */
function shouldRunAmbassadorWeekly(event) {
  const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
  return now.getUTCDay() === 1 && now.getUTCHours() === 15;
}

function shouldRunMonthlyReport(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    return now.getUTCDate() === 1 && now.getUTCHours() === 0;
  } catch (e) { return false; }
}

// Twice daily at 06:00 and 18:00 America/Denver, DST-safe. The cron fires hourly,
// so gate on the actual Denver wall-clock hour rather than a fixed UTC hour: the
// old 00:00/12:00 UTC test only hit 06:00/18:00 Denver during MDT and drifted to
// 05:00/17:00 in winter (MST).
function shouldRunSecurityCheck(event) {
  try {
    const now = event && event.scheduledTime ? new Date(event.scheduledTime) : new Date();
    let h;
    try { h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', hour12: false }).format(now), 10); }
    catch { const u = now.getUTCHours(); h = (u === 0 || u === 12) ? 6 : -1; }
    return h === 6 || h === 18;
  } catch (e) { return false; }
}

// GET  /api/owner/security-check            -> last stored result (owner only)
// POST /api/owner/security-check            -> run a fresh check now (owner only)
async function handleOwnerSecurityCheck(request, env, url, ctx) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  if (request.method === 'POST') {
    // Dispatch probes in-process (see selfDispatch): even from a live
    // request the Worker cannot reliably fetch its own hostname.
    const result = await runSecurityCheck(env, { trigger: 'manual', origin: url.origin, dispatch: selfDispatch(env, ctx) });
    return jsonResponse(200, result);
  }
  const latest = await getLatestSecurityCheck(env);
  if (!latest) return jsonResponse(200, { ok: null, never_run: true, message: 'No security check has run yet. POST here to run one now.' });
  return jsonResponse(200, latest);
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
    // A resolved result carrying `error` means the PDF was never parsed. Say so
    // with a 503, rather than returning 200 and an empty field list that reads
    // as "this document has no signature fields".
    if (result && result.error) {
      // Two very different failures reach this line, and blaming the wrong one
      // is how the old "no signature fields were found in this PDF" message
      // pinned a server defect on the caller's document for months. If the
      // pdf.js worker is not wired into the bundle then NOTHING is parseable
      // here and the document is irrelevant, so say that instead.
      const engineDown = !pdfWorkerReady();
      return jsonResponse(503, {
        error: engineDown ? 'detection_engine_unavailable' : 'detection_unavailable',
        message: engineDown
          ? 'The server-side detection engine is not available in this deployment. This is a fault on our side, not a problem with your document.'
          : `Field detection could not read this PDF on the server: ${String(result.error).slice(0, 160)}`,
        pageCount: result.pageCount || 0,
        fields: [],
      });
    }
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

function jsonResponse(status, body, extraHeaders) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // API responses are never framed and never sniffed.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  };
  // Callers may override caching (e.g. the public /api/verify record is
  // safe to cache for 300s). Extra headers win over the defaults above.
  if (extraHeaders && typeof extraHeaders === 'object') {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Baseline security headers for static (ASSETS) responses. The signing surfaces
// (/preview, /embed) are framable BY DESIGN (the embed widget iframes /preview
// cross-origin), so they get nosniff + referrer + HSTS but NOT X-Frame-Options;
// every other page is SAMEORIGIN to block clickjacking + Referer token leakage.
function hardenAssetHeaders(response, pathname) {
  const h = new Headers(response.headers);
  if (!h.has('x-content-type-options')) h.set('x-content-type-options', 'nosniff');
  if (!h.has('referrer-policy')) h.set('referrer-policy', 'strict-origin-when-cross-origin');
  if (!h.has('strict-transport-security')) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  const framable = pathname.startsWith('/preview') || pathname.startsWith('/embed');
  if (!framable && !h.has('x-frame-options')) h.set('x-frame-options', 'SAMEORIGIN');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
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
    const key = `${record.receivedAt}-${record.email}`;
    if (env && env.SIGNUPS && typeof env.SIGNUPS.put === 'function') {
      await env.SIGNUPS.put(key, JSON.stringify(record));
    } else if (env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.put === 'function') {
      // No dedicated SIGNUPS namespace is bound, so store founding-list
      // captures in the main docs KV under a signup: prefix. Without this
      // fallback every signup is silently dropped to the console.
      await env.CYBERSYGN_DOCS.put(`signup:${key}`, JSON.stringify(record));
    } else {
      // No signup store is bound. Log that a capture happened WITHOUT the
      // email/name PII in the record; the full record is not persisted here.
      console.log('[signup]', JSON.stringify({ receivedAt: record.receivedAt, hasEmail: !!record.email, captured: false }));
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
  const rl = await checkRateLimit(env, `owner-claim:${ipKey(request)}`, [{ windowSec: 900, max: 10 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/owner/claim' });
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
  // Brute-force protection: the sole owner account is the highest-value target.
  const rl = await checkRateLimit(env, `owner-login:${ipKey(request)}`, [{ windowSec: 900, max: 10 }, { windowSec: 86400, max: 50 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/owner/login' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { username, password } = body.value || {};
  const result = await loginWithCredentials(username, password, env);
  if (!result.ok) {
    if (result.error === 'login_not_configured') {
      return jsonResponse(503, {
        error: 'login_not_configured',
        // The machine-readable `error` code stays stable for the panel; the
        // human message does not name our secrets or hand a stranger the exact
        // command to look for. This route is unauthenticated by necessity, so
        // its 503 body is public.
        message: 'This deployment is not configured for owner sign-in yet.',
      });
    }
    return jsonResponse(401, { error: result.error });
  }
  return jsonResponse(200, { ok: true, token: result.token, issuedAt: result.issuedAt });
}

// Step 1 of reset: email a one-time link. The link is sent ONLY to the
// configured OWNER_EMAIL (never to the requester's address), and the response
// is identical whether or not the email matched, so this can't be used to probe
// the owner email or to redirect a reset to an attacker.
async function handleOwnerResetRequest(request, env, url) {
  const rl = await checkRateLimit(env, `owner-reset:${ipKey(request)}`, [{ windowSec: 900, max: 5 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/owner/reset/request' });
  const body = await readJsonBody(request);
  const email = String((body.value && body.value.email) || '').trim().toLowerCase();
  const configured = ownerEmail(env);
  const generic = jsonResponse(200, { ok: true, message: 'If that address is on file, a reset link is on its way. Check your inbox (and spam).' });
  if (!configured || !email || email !== String(configured).trim().toLowerCase()) return generic;
  const token = await createResetToken(env);
  if (!token) return generic; // KV unavailable (e.g. daily write quota), fail closed, no leak
  const appUrl = (env && env.CYBERSYGN_APP_URL) || 'https://cybersygn.io';
  const link = `${appUrl}/control/?reset=${token}`;
  try {
    await deliverEmail(env, {
      to: configured,
      subject: 'Reset your CyberSygn owner password',
      text: `Someone asked to reset the CyberSygn owner password.\n\nReset it here (expires in 30 minutes, one use):\n${link}\n\nIf this wasn't you, ignore this email, nothing changes.`,
      html: `<p>Someone asked to reset the CyberSygn owner password.</p>\n<p><a href="${link}">Reset your password</a>, expires in 30 minutes, single use.</p>\n<p>If this wasn't you, ignore this email. Nothing changes.</p>`,
    });
  } catch (e) {
    report(e, 'owner-reset-email');
  }
  return generic;
}

// Step 2 of reset: consume the one-time token and write the new credential to KV.
async function handleOwnerResetConfirm(request, env) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const token = String((body.value && body.value.token) || '').trim();
  const username = String((body.value && body.value.username) || '').trim();
  const password = String((body.value && body.value.password) || '');
  const ok = await consumeResetToken(env, token);
  if (!ok) return jsonResponse(400, { error: 'invalid_token', message: 'That reset link is invalid or has expired. Request a new one.' });
  const res = await setOwnerCredential(env, username, password);
  if (!res.ok) {
    const msg = res.error === 'weak_password' ? 'Password must be at least 8 characters.'
      : res.error === 'invalid_username' ? 'Enter a username.'
      : res.error === 'write_failed' ? 'Could not save, the daily storage write limit may be exhausted. Try again after 00:00 UTC, or upgrade the Cloudflare Workers plan.'
      : 'Could not set the new password.';
    return jsonResponse(res.error === 'write_failed' ? 503 : 400, { error: res.error, message: msg });
  }
  return jsonResponse(200, { ok: true, message: 'Password updated. You can sign in now.' });
}

// ---- Billing handlers ------------------------------------------------------

async function handleCheckoutCreateSession(request, env, url) {
  const rl = await checkRateLimit(env, `checkout:${ipKey(request)}`, [{ windowSec: 60, max: 10 }, { windowSec: 3600, max: 60 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/checkout/create-session' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { tier, senderId, email, ref, quantity, source } = body.value || {};
  // First-touch marketing source, sanitized to a short slug for MRR attribution.
  const safeSource = typeof source === 'string'
    ? source.toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40)
    : undefined;

  if (!tier || !TIERS[tier] || tier === 'free') {
    return jsonResponse(400, {
      error: 'invalid_tier',
      message: 'Pick a valid plan or add-on.',
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
      quantity: Number.isFinite(Number(quantity)) ? Number(quantity) : undefined,
      source: safeSource || undefined,
    });
    return jsonResponse(200, { url: session.url, sessionId: session.sessionId });
  } catch (err) {
    const code = err && err.code || 'checkout_failed';
    const status = code === 'founding_full' || code === 'lifetime_full' ? 409
                 : code === 'not_configured' || code === 'missing_price' ? 503
                 // 'tier_retired' is a CLIENT error: the caller asked for a SKU we no
                 // longer sell. It fell through to 502, which says the upstream
                 // payment provider failed and invites a retry that can never work.
                 : code === 'invalid_tier' || code === 'addon_needs_plan' || code === 'tier_retired' ? 400
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
    // Return 5xx so Stripe RETRIES. applyStripeEvent marks the event seen only
    // AFTER it fully applies, so a mid-apply failure (e.g. a transient KV write
    // error writing sub:<senderId>) was NOT marked seen. Returning 200 here would
    // tell Stripe the webhook succeeded and it would never retry, the customer
    // pays but never gets their tier/entitlement. The pre-apply duplicate check +
    // idempotent handlers make Stripe's retries safe.
    return jsonResponse(500, { received: false, error: err && err.message });
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
 *   - docs created (titles, dates, no PDF bytes, those are at /api/docs/:id/pdf with a token)
 *   - templates saved
 *   - free-tier signup data
 *   - affiliate stats
 *   - webhook config
 *   - brand record
 *   - origin profile if applicable
 *
 * Authenticated by the senderId itself (same trust model as
 * /api/billing/portal, if you know your senderId, you can request
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
    originUrl: request.url,
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

  // Sanitize first, never allow path traversal into the asset path.
  const clean = sanitizeSlug(slug);
  if (!clean) return jsonResponse(404, { error: 'unknown_template' });

  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const firstName = (url.searchParams.get('firstName') || '').trim().slice(0, 80);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'invalid_email', message: 'Provide ?email=you@example.com to download.' });
  }

  // Resolve the bytes: prefer the real pre-rendered static PDF served via
  // env.ASSETS at /templates-pdf/<slug>.pdf. Fall back to the legacy
  // generated wireframe only if the static asset is missing. Return 404
  // only when BOTH the static asset is absent AND findTemplate is null.
  let pdfBytes = await fetchStaticTemplatePdf(env, clean, request.url);
  if (!pdfBytes) {
    const tmpl = findTemplate(clean);
    if (!tmpl) return jsonResponse(404, { error: 'unknown_template' });
    pdfBytes = await generateTemplatePdf(tmpl);
  }

  // Lead-capture side effect: register the email into the free-tier drip
  // funnel (idempotent on email), without emailing. We reuse freeSignup
  // directly so a direct-download doesn't double-register vs. email-it.
  if (email) {
    try {
      const signup = await freeSignup(env, {
        firstName: firstName || 'there',
        lastName: 'friend',
        email,
      });
      if (signup && signup.ok && signup.freeToken) {
        const emailHash = await sha256Hex(new TextEncoder().encode(email));
        await writeFreeTokenPointer(env, signup.freeToken, emailHash);
      }
    } catch (e) { /* lead-capture is best-effort; never block the download */ }
  }

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${clean}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}

/**
 * GDPR export, step 1: prove control of an email associated with this
 * sender. The claimed email (hashed, never compared in cleartext) must
 * match the sender-email binding written at free-tier doc creation, or
 * the email on the Stripe subscription record. On match, a one-time
 * confirmation code is emailed to THAT address (never to a caller-chosen
 * one) with a 15-minute expiry.
 */
async function handleGdprExportRequest(request, env, senderId) {
  const rl = await checkRateLimit(env, `gdpr-req:${ipKey(request)}`, [
    { windowSec: 3600, max: 3 },
    { windowSec: 86400, max: 6 },
  ]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/sender/gdpr-export/request' });

  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const email = String((body.value && body.value.email) || '').trim().toLowerCase();
  if (!isValidEmail(email)) return jsonResponse(400, { error: 'invalid_email', message: 'Provide the email you signed up or subscribed with.' });

  const claimedHash = await sha256Hex(new TextEncoder().encode(email));
  const storage = getStorage(env);

  // Does the claimed email belong to this sender?
  let bound = false;
  try {
    const binding = await storage.docs.get(`sender-email:${safeId}`);
    if (binding && ctEqHex(binding, claimedHash)) bound = true;
  } catch (e) {}
  if (!bound) {
    try {
      const sub = await getSubscription(env, safeId);
      if (sub && typeof sub.email === 'string' && sub.email) {
        const subHash = await sha256Hex(new TextEncoder().encode(sub.email.trim().toLowerCase()));
        if (ctEqHex(subHash, claimedHash)) bound = true;
      }
    } catch (e) {}
  }
  // Mint + email the code ONLY on a match, but always return the same 200.
  // A differing status (200 vs 403) would let anyone holding a senderId
  // capability probe candidate emails and confirm the exact bound address;
  // the uniform response closes that oracle. The code only ever reaches the
  // real inbox, so a mismatch simply results in no email.
  if (bound) {
    const code = await createGdprConfirm(env, safeId, claimedHash);
    await deliverEmail(env, {
      to: email,
      subject: 'Your CyberSygn data export code',
      text: `Someone (hopefully you) requested an export of the CyberSygn data linked to this email.\n\nConfirmation code: ${code}\n\nThe code works once and expires in 15 minutes. If you did not request this, ignore this email; nothing is shared without the code.`,
    }).catch(() => {});
  }

  return jsonResponse(200, {
    ok: true,
    message: 'If that email is associated with this account, a one-time confirmation code has been sent to it. POST the code to /api/sender/:id/gdpr-export/confirm as {"code"}. If your account pre-dates email binding, request your export from hello@cybersygn.io.',
  });
}

// Mint + store the one-time confirmation record. Exported for the test
// harness (email delivery is console-only there, so tests mint directly).
export async function createGdprConfirm(env, senderId, emailHash) {
  const code = randomId(16);
  const rec = {
    codeHash: await sha256Hex(new TextEncoder().encode(code)),
    emailHash,
    expiresAt: Date.now() + 15 * 60 * 1000,
    attempts: 0,
  };
  await getStorage(env).docs.put(`gdpr-confirm:${senderId}`, JSON.stringify(rec), { expirationTtl: 900 });
  return code;
}

/**
 * GDPR export, step 2: exchange the emailed code for the export. The
 * code is single-use, hash-compared in constant time, expires after 15
 * minutes, and dies after 5 wrong attempts.
 */
async function handleGdprExportConfirm(request, env, senderId) {
  const rl = await checkRateLimit(env, `gdpr-conf:${ipKey(request)}`, [{ windowSec: 3600, max: 10 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/sender/gdpr-export/confirm' });

  const safeId = String(senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const code = String((body.value && body.value.code) || '');

  const storage = getStorage(env);
  const key = `gdpr-confirm:${safeId}`;
  let rec = null;
  try { rec = await storage.docs.get(key, { json: true }); } catch (e) {}
  if (!rec || !rec.codeHash) {
    return jsonResponse(410, { error: 'no_pending_request', message: 'No pending export request. Start over at /api/sender/:id/gdpr-export/request.' });
  }
  if (Date.now() > rec.expiresAt) {
    await storage.docs.delete(key).catch(() => {});
    return jsonResponse(410, { error: 'code_expired', message: 'The code expired. Request a new one.' });
  }
  const presentedHash = await sha256Hex(new TextEncoder().encode(code));
  if (!ctEqHex(presentedHash, rec.codeHash)) {
    rec.attempts = (rec.attempts || 0) + 1;
    if (rec.attempts >= 5) {
      await storage.docs.delete(key).catch(() => {});
      return jsonResponse(410, { error: 'too_many_attempts', message: 'Too many wrong codes. Request a new one.' });
    }
    await storage.docs.put(key, JSON.stringify(rec), { expirationTtl: 900 }).catch(() => {});
    return jsonResponse(403, { error: 'wrong_code' });
  }

  // Verified. Single-use: burn the code before building the export.
  await storage.docs.delete(key).catch(() => {});
  return buildGdprExport(env, safeId, rec.emailHash);
}

/**
 * Assemble the export for a VERIFIED sender. Docs come from the
 * sender:<id>:docs index (one read per doc the sender actually owns)
 * instead of the old full doc: list-scan.
 */
async function buildGdprExport(env, senderId, emailHash) {
  const storage = getStorage(env);
  const records = [];
  async function add(label, key) {
    try {
      const raw = await storage.docs.get(key);
      if (raw) records.push({ label, key, data: tryParse(raw) });
    } catch (e) {}
  }
  await add('subscription', `sub:${senderId}`);
  await add('brand', `brand:${senderId}`);
  await add('webhook_config', `webhook:${senderId}`);

  // Docs created by this sender. The sender index is the fast primary
  // source, but it caps at the 200 newest, so for a GDPR subject-access
  // response (which must be complete) we ALSO scan doc:* on real KV and
  // union in anything the truncated index missed. This scan is acceptable
  // here precisely because it is the rare, email-confirmed, rate-limited
  // path, not the old unauthenticated hot path this endpoint used to be.
  const seenDocIds = new Set();
  const pushDoc = (docId, d) => {
    if (!d || seenDocIds.has(docId)) return;
    seenDocIds.add(docId);
    records.push({
      label: 'doc',
      key: `doc:${docId}`,
      data: {
        id: d.id,
        createdAt: d.createdAt,
        title: d.title,
        signerCount: Array.isArray(d.signers) ? d.signers.length : 0,
        completedAt: d.completedAt,
      },
    });
  };
  try {
    const index = (await storage.docs.get(`sender:${senderId}:docs`, { json: true })) || { docs: [] };
    for (const docId of index.docs) {
      pushDoc(docId, await storage.docs.get(`doc:${docId}`, { json: true }));
    }
  } catch (e) {}
  try {
    const kv = env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.list === 'function' ? env.CYBERSYGN_DOCS : null;
    if (kv) {
      let cursor;
      let pages = 0;
      while (true) {
        const r = await kv.list({ prefix: 'doc:', limit: 1000, cursor });
        for (const k of r.keys) {
          const id = k.name.slice(4);
          if (seenDocIds.has(id)) continue;
          let d;
          try { d = await kv.get(k.name, 'json'); } catch (e) { continue; }
          if (d && d.senderId === senderId) pushDoc(id, d);
        }
        pages += 1;
        if (r.list_complete || !r.cursor || pages > 20) break;
        cursor = r.cursor;
      }
    }
  } catch (e) {}

  // Free-tier records for the verified email (the caller just proved
  // control of it, so returning their own signup contact is safe).
  if (emailHash) {
    await add('free_allowance', `free:${emailHash}`);
    await add('free_contact', `drip:${emailHash}`);
  }

  // Templates owned (private scope). Needs KV list(); skipped silently
  // in memory mode.
  try {
    if (env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.list === 'function') {
      const listed = await env.CYBERSYGN_DOCS.list({ prefix: `tpl-priv:${senderId}:`, limit: 1000 });
      for (const e of listed.keys) records.push({ label: 'template', key: e.name });
    }
  } catch (e) {}

  return jsonResponse(200, {
    ok: true,
    sender: senderId,
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
 * Public testimonials list (Move 1: honest social proof).
 *
 * Surfaces ONLY approved testimonials for the homepage. Integrity rules:
 *   - Returns records whose moderationState === 'approved' and nothing
 *     else. Pending and rejected submissions never leak.
 *   - Strips the email (privacy). Each item is only the fields the
 *     submitter consented to publish: name, quote, role, location,
 *     submittedAt.
 *   - If there is no approved data, returns an empty list so the client
 *     hides the section rather than showing fabricated proof.
 *
 * Bounded and cheap: a single KV list page (limit 100), capped at 24
 * rendered items, cached at the edge for 5 minutes.
 */
async function handleTestimonialsList(env) {
  const CAP = 24;
  const items = [];
  const docsBinding = env && env.CYBERSYGN_DOCS;
  if (docsBinding && typeof docsBinding.list === 'function') {
    try {
      // Single bounded page. Cheap by design; we never paginate here.
      const result = await docsBinding.list({ prefix: 'testimonial:', limit: 100 });
      for (const entry of result.keys || []) {
        if (items.length >= CAP) break;
        let raw;
        try { raw = await docsBinding.get(entry.name); } catch (e) { continue; }
        if (!raw) continue;
        let rec;
        try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (!rec || rec.moderationState !== 'approved') continue;
        // Strip email; publish only consented fields.
        items.push({
          name: typeof rec.name === 'string' ? rec.name.slice(0, 80) : '',
          quote: typeof rec.quote === 'string' ? rec.quote.slice(0, 600) : '',
          role: typeof rec.role === 'string' ? rec.role.slice(0, 80) : '',
          location: typeof rec.location === 'string' ? rec.location.slice(0, 80) : '',
          submittedAt: typeof rec.submittedAt === 'string' ? rec.submittedAt : null,
        });
      }
    } catch (e) {
      console.error('[testimonials] list failed:', e && e.message);
    }
  }

  const body = JSON.stringify({ testimonials: items });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    },
  });
}

/**
 * AI contract-drafting wedge (Move 3). Turns a plain-English description
 * into a professional starting draft with bracketed [PLACEHOLDERS].
 *
 * Integrity:
 *   - Hard IP rate limit (5/hour, 20/day) so the paid API can't be run up.
 *   - If ANTHROPIC_API_KEY is not configured, returns 200 { ok:false,
 *     reason:'unconfigured' } so the client shows a graceful fallback,
 *     NOT a 500.
 *   - The draft is a starting template, not legal advice; the disclaimer
 *     rides on every ok response.
 *   - Provider errors and the API key never reach the client.
 */
// Free accounts get a taste of the AI co-pilot; Pro and up get it unmetered.
const FREE_AI_LIFETIME = 3;
const KV_PREFIX_AI = 'ai-used:';

/**
 * Decide whether this caller may spend an AI generation.
 *
 * Both AI endpoints used to run on an IP rate limit alone, with no account and
 * no tier check, so anyone at all could POST and spend our Anthropic budget,
 * and a Pro subscriber received nothing they were not already getting for free.
 * Pro's headline bullets are the AI co-pilot, so this is the gate that makes
 * the price honest in both directions.
 *
 * Identity is the signed-up email hash, not senderId: senderIds live in
 * localStorage and can be rotated at will, which would make any per-sender
 * quota a per-incognito-window quota.
 */
async function checkAiAllowance(env, request, payload, opts = {}) {
  const owner = opts.owner;
  if (owner) return { ok: true, unmetered: true, reason: 'owner' };

  const senderId = String((payload && payload.senderId) || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (senderId) {
    try {
      const sub = await getSubscription(env, senderId);
      if (sub && tierIncludesAi(sub.tier)) return { ok: true, unmetered: true, tier: sub.tier };
    } catch (e) { /* fall through to the free quota rather than refuse a paying customer's peer */ }
  }

  const token = request.headers.get('x-cybersygn-free')
    || String((payload && payload.freeToken) || '');
  const peek = await freePeek(env, token);
  // opts.quotaId lets an ALREADY-AUTHENTICATED caller be metered without a free
  // token. The summary endpoint proves identity with the document's sender
  // token, so demanding a separate free-signup token there would lock out a
  // legitimate sender rather than gate a stranger.
  const quotaKey = peek.ok ? peek.emailHash : (opts.quotaId || null);
  if (!quotaKey) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'free_signup_required',
        message: 'Create a free account to generate a draft. No card needed.',
        aiUsage: { used: 0, cap: FREE_AI_LIFETIME },
      },
    };
  }

  let used = 0;
  try { used = parseInt((await env.CYBERSYGN_DOCS.get(KV_PREFIX_AI + quotaKey)) || '0', 10) || 0; }
  catch (e) { used = 0; }
  if (used >= FREE_AI_LIFETIME) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'ai_cap_reached',
        message: `You have used all ${FREE_AI_LIFETIME} free AI drafts. Pro adds the AI co-pilot, unmetered.`,
        aiUsage: { used, cap: FREE_AI_LIFETIME },
        upgrade: { tiers: ['pro', 'team', 'business'] },
      },
    };
  }
  return { ok: true, emailHash: quotaKey, used, cap: FREE_AI_LIFETIME };
}

/** Burn one free AI generation. Only called after the work actually succeeded. */
async function burnAiCredit(env, allow) {
  if (!allow || allow.unmetered || !allow.emailHash) return;
  try {
    await env.CYBERSYGN_DOCS.put(
      KV_PREFIX_AI + allow.emailHash,
      String((allow.used || 0) + 1),
      { expirationTtl: 60 * 60 * 24 * 365 * 5 },
    );
  } catch (e) { /* a failed write risks one extra free draft, never a refusal */ }
}

async function handleDraftGenerate(request, env, url) {
  const limit = await checkRateLimit(env, `draft:${ipKey(request)}`, [
    { windowSec: 60 * 60, max: 5 },
    { windowSec: 60 * 60 * 24, max: 20 },
  ]);
  if (!limit.ok) return rateLimitedResponse(limit, { endpoint: '/api/draft/generate' });

  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse(400, parsed.error);
  const payload = parsed.value || {};

  // Account + tier gate. The IP rate limit above is an abuse brake, not an
  // entitlement: without this anyone could spend the Anthropic budget with no
  // account at all, and Pro's headline feature was free to everyone.
  const owner = await getOwnerForRequest(request, env, url);
  const allow = await checkAiAllowance(env, request, payload, { owner });
  if (!allow.ok) return jsonResponse(allow.status, allow.body);

  const parties = payload.parties && typeof payload.parties === 'object' ? payload.parties : {};

  let result;
  try {
    result = await generateDraft(env, {
      kind: payload.kind,
      description: payload.description,
      parties: { you: parties.you, them: parties.them },
    });
  } catch (e) {
    // Belt-and-suspenders: generateDraft already guards its failures, but
    // any unexpected throw must never surface a raw error or the key.
    console.error('[draft] unexpected error:', e && e.message);
    return jsonResponse(200, {
      ok: false,
      reason: 'error',
      message: 'Drafting is temporarily unavailable. Please try again in a moment.',
    });
  }

  if (!result || !result.ok) {
    // Graceful, non-500 for every non-ok path (unconfigured / invalid / error).
    return jsonResponse(200, {
      ok: false,
      reason: (result && result.reason) || 'error',
      message: (result && result.message) || 'Drafting is temporarily unavailable. Please try again in a moment.',
    });
  }

  // Charge only for work that actually produced a draft. Every failure path
  // above returns before this, so an unconfigured key or a provider error can
  // never cost someone one of their three.
  await burnAiCredit(env, allow);

  return jsonResponse(200, {
    ok: true,
    kind: result.kind,
    title: result.title,
    body: result.body,
    aiUsage: allow.unmetered
      ? { unmetered: true }
      : { used: (allow.used || 0) + 1, cap: allow.cap },
    disclaimer: 'This is a starting draft, not legal advice. Review it (ideally with a licensed attorney) before you send.',
  });
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
  // wraps get/put but not list). Small list, cap is 100, so a single
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
        // An erased person stays off the public wall even if a future field
        // is missed by the scrub list. Defence in depth: erasure strips the
        // fields, and this refuses the record outright.
        if (rec.erasedAt) continue;
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
 * wall. Mirrors the auth pattern of /api/billing/portal, caller passes
 * senderId in the body, and the server only updates if a sub:senderId
 * record exists AND the record is an Origin member with a foundingNumber.
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
  // display name + city, no email, no billing, no auth state.
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
      // /v1/models is a listing endpoint, auth required, no token usage.
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
      // Public payload: report only that it's unconfigured. Never advertise the
      // dev-phrase backdoor to unauthenticated scanners.
      return { ok: false, mode: 'unconfigured', detail: 'owner hash not configured' };
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
  // Each call is a paid Anthropic vision request. IP-limit before anything so a
  // rotated (client-supplied) senderId cannot bypass the spend cap.
  const rl = await checkRateLimit(env, `vision:${ipKey(request)}`, [{ windowSec: 60, max: 5 }, { windowSec: 86400, max: 50 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/detect-vision' });
  if (!env || !env.ANTHROPIC_API_KEY) {
    return jsonResponse(503, {
      error: 'vision_not_configured',
      message: 'This feature is not enabled on this deployment.',
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
    /* usage_check_unavailable (a KV read error) fails closed here: better to
       ask the sender to retry than to burn an unmetered paid vision call while
       the usage store is down. */
    if (usage.error === 'usage_check_unavailable') {
      return jsonResponse(503, { error: 'usage_check_unavailable', message: 'We could not check your usage just now. Please retry in a moment.' });
    }
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
  // templates grow the shared corpus, owner-saved templates are
  // forced to private inside saveTemplate so they never reach this
  // branch. Watchdog is idempotent, one-shot alert per cluster lifetime.
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
  // Rate limit: per-IP 12 signup ATTEMPTS per 24h, 40 per week. The check
  // runs before body validation, so a typo'd email burns an attempt; and
  // launch traffic can put whole offices or carrier-NAT audiences behind one
  // IP. These caps stop drive-by floods without locking out a shared-IP
  // audience on launch day; real free-tier abuse is separately capped
  // per-account by the emailHash lifetime document limit.
  const owner = await getOwnerForRequest(request, env, new URL(request.url));
  if (!owner) {
    const limit = await checkRateLimit(env, `signup:${ipKey(request)}`, [
      { windowSec: 60 * 60 * 24,     max: 12 },
      { windowSec: 60 * 60 * 24 * 7, max: 40 },
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
  // NOTE: email->senderId binding is deliberately NOT done here. Signup does
  // not prove the person controls the email, so binding at this point would
  // let an attacker pre-seed a victim's future magic-link recovery with the
  // attacker's senderId. Binding happens only at verified magic-link confirm
  // (worker/src/auth.js), using the confirming device's own senderId.

  // Affiliate signup attribution: if the visitor arrived via a ?ref link the
  // cybersygn_ref cookie is set; count the signup against that code so the
  // affiliate's "Signups" stat is real. Best-effort, first signup only, never
  // blocks the response.
  if (!result.isReturning) {
    try {
      const cookie = request.headers.get('cookie') || '';
      const m = cookie.match(/(?:^|;\s*)cybersygn_ref=([a-z0-9]{4,16})/);
      if (m) {
        const { bumpSignup } = await import('./affiliate.js');
        await bumpSignup(env, m[1].toLowerCase()).catch(() => {});
      }
    } catch (e) { /* attribution is never load-bearing */ }
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

  // A PAYING CUSTOMER MUST NEVER HIT THE FREE-TIER PAYWALL.
  //
  // handleCreateDoc already gets this right: it bypasses the gate when the
  // sender has a real paid tier. This path did not, and the client-side guard
  // that was supposed to cover it keyed on a 'paid:' token prefix that is READ
  // in three places and WRITTEN in none, so it never fired. The result was that
  // a customer who used their three free documents and then subscribed was
  // refused their own download, with no file at all.
  //
  // The subscription is the authority, not a client-supplied marker.
  const senderId = String(request.headers.get('x-cybersygn-sender') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (senderId) {
    try {
      const sub = await getSubscription(env, senderId);
      if (sub && sub.tier && sub.tier !== 'free') {
        return jsonResponse(200, { ok: true, unmetered: true, tier: sub.tier, reason: 'paid_plan' });
      }
    } catch (e) { /* fall through to the free path rather than refuse a download */ }
  }

  // The client already sends this on the download path; it is what lets a
  // later send of the same document settle against one credit instead of two.
  const docSha = request.headers.get('x-cybersygn-doc-sha') || '';
  const result = await freeConsume(env, token, docSha, { mark: true });
  if (!result.ok) {
    const status = result.error === 'free_cap_reached' ? 402 : 401;
    return jsonResponse(status, result);
  }
  return jsonResponse(200, result);
}

/**
 * Email the signed PDF the user just downloaded to the address on file
 * for their freeToken. The user gets a copy in their inbox; we get
 * delivery confirmation back from Resend, which doubles as a real-time
 * verification that the email address they submitted at signup is valid.
 *
 * Body: { pdfBase64: string, filename: string }
 * Header: X-CyberSygn-Free: <freeToken>
 *
 * Failures are tolerated (no surface error to the user), the download
 * already worked client-side; this is a best-effort copy.
 */
async function handleEmailSignedPdf(request, env) {
  const token = request.headers.get('x-cybersygn-free') || '';
  if (!token) return jsonResponse(401, { ok: false, error: 'missing_token' });
  if (!env || !env.CYBERSYGN_DOCS) return jsonResponse(503, { ok: false, error: 'kv_unavailable' });
  // Requires a valid freeToken, but still cap send volume per IP: each call
  // fires a real Resend email with an attachment.
  const rl = await checkRateLimit(env, `email-pdf:${ipKey(request)}`, [{ windowSec: 3600, max: 10 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/free/email-signed-pdf' });
  // Resolve email via the free-tier key schema (see worker/src/free-tier.js):
  // free-tok:<token> -> emailHash, then drip:<emailHash> holds the cleartext
  // email + name (the free:<emailHash> record deliberately has no email).
  const emailHash = await env.CYBERSYGN_DOCS.get(`free-tok:${token}`);
  if (!emailHash) return jsonResponse(401, { ok: false, error: 'unknown_token' });
  const emailRaw = await env.CYBERSYGN_DOCS.get(`drip:${emailHash}`);
  if (!emailRaw) return jsonResponse(404, { ok: false, error: 'no_email_on_file' });
  let emailRecord;
  try { emailRecord = JSON.parse(emailRaw); } catch (e) { return jsonResponse(500, { ok: false, error: 'bad_record' }); }
  const email = emailRecord.email;
  const firstName = emailRecord.firstName || 'there';
  if (!email) return jsonResponse(404, { ok: false, error: 'no_email_on_record' });

  // The body carries a base64 PDF, so the small-JSON default cap is too low.
  const body = await readJsonBody(request, MAX_DOC_JSON_BYTES);
  if (body.error) return jsonResponse(400, body.error);
  const { pdfBase64, filename } = body.value || {};
  if (!pdfBase64 || !filename) return jsonResponse(400, { ok: false, error: 'missing_pdf' });

  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) {
    return jsonResponse(200, { ok: true, mode: 'console', detail: 'RESEND_API_KEY not set; download succeeded client-side' });
  }

  const subject = `Your signed PDF, from CyberSygn.`;
  const text =
    `Hi ${firstName},\n\n` +
    `Your signed PDF "${filename}" is attached for your records.\n\n` +
    `CyberSygn keeps every signed document and audit certificate available in your account. Open https://cybersygn.io/dashboard/ to see the full history.\n\n` +
    `If you did not just sign a document with CyberSygn, reply to this email and we will look into it.\n\n` +
    `CyberSygn. Built in Colorado.`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.CYBERSYGN_FROM || 'hello@cybersygn.io',
        to: [email],
        subject,
        text,
        attachments: [{ filename, content: pdfBase64 }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return jsonResponse(200, { ok: false, error: `resend_${res.status}`, detail: txt.slice(0, 200) });
    }
    const r = await res.json();
    return jsonResponse(200, { ok: true, providerId: r.id || null });
  } catch (e) {
    return jsonResponse(200, { ok: false, error: 'exception', detail: (e && e.message) || String(e) });
  }
}

async function handleDatasetCount(env) {
  const r = await getDatasetCount(env);
  /* Never publish a KV failure as an authoritative "0 documents". The old
     code hard-coded ok:true and cached the count for 60s, so a transient read
     error turned into a confident, edge-cached zero on the public social-proof
     widget. Propagate the failure with no-store so it is not cached, and let
     the client render "unavailable" rather than a false scarcity number. */
  if (!r.ok) {
    const res = jsonResponse(503, { ok: false, error: 'count_unavailable' });
    res.headers.set('cache-control', 'no-store');
    return res;
  }
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
  const limit = await checkRateLimit(env, `contact:${ip}`, [{ windowSec: 60 * 60, max: 5 }]);
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
  // Truthfulness over presence: a set-but-dead key (the 2026-07-10 Resend 401
  // incident) must show degraded, not operational. Reuse the /api/health auth
  // probes, cached in KV for 60s so anonymous status polling cannot amplify
  // external API calls. If the probe layer itself fails, fall back to the old
  // presence checks rather than taking the status page down.
  let probes = null;
  try {
    const kv = env && env.CYBERSYGN_DOCS;
    if (kv) {
      const cached = await kv.get('status:probes');
      if (cached) probes = JSON.parse(cached);
    }
    if (!probes) {
      const healthResp = await handleHealth(env);
      const health = await healthResp.json();
      probes = health && health.subsystems ? health.subsystems : null;
      if (probes && kv) {
        try { await kv.put('status:probes', JSON.stringify(probes), { expirationTtl: 60 }); } catch (_) {}
      }
    }
  } catch (_) { probes = null; }
  const subsystems = {
    worker: { ok: true, label: 'CyberSygn API' },
    kv: { ok: probes && probes.kv ? probes.kv.ok === true : Boolean(env && env.CYBERSYGN_DOCS), label: 'Document storage (KV)' },
    pdfs: { ok: Boolean(env && env.CYBERSYGN_PDFS), label: 'PDF storage' },
    stripe: { ok: probes && probes.stripe ? probes.stripe.ok === true : Boolean(env && env.STRIPE_SECRET_KEY), label: 'Payments (Stripe)' },
    email: { ok: probes && probes.resend ? probes.resend.ok === true : Boolean(env && env.RESEND_API_KEY), label: 'Email (Resend)' },
    analytics: { ok: Boolean(env && env.CYBERSYGN_EVENTS), label: 'Analytics Engine' },
    vision: { ok: probes && probes.anthropic ? probes.anthropic.ok === true : Boolean(env && env.ANTHROPIC_API_KEY), label: 'Vision API (optional)' },
  };
  const allOk = Object.values(subsystems).every(s => s.ok || s.label.includes('optional'));
  const storage = getStorage(env);
  return new Response(JSON.stringify({
    ok: allOk,
    status: allOk ? 'operational' : 'degraded',
    // Liveness fields kept so the light /api/status contract still holds.
    service: 'cybersygn',
    version: VERSION,
    storage: storage.mode,
    email: env && env.RESEND_API_KEY ? 'resend' : 'console',
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
 * Idempotent, calling it twice returns the same code.
 *
 * Body: { senderId, email? }
 * Returns: { ok, code, record, isNew, shareUrl }
 */
/**
 * GET /api/ambassador/me?senderId=...
 * One response with every number the dashboard renders. Opening the dashboard
 * is a signal of life, so this also RENEWS the product pass (the pass can
 * never lapse mid-program while someone is actually showing up).
 *
 * Honesty rules baked in: rates are omitted below a meaningful sample, and
 * zero-sale ambassadors get an activation checklist instead of a wall of
 * zeros. The client renders what it is given, it never invents numbers.
 */


// ---- Phase 6: owner visibility into the ambassador program ----------------

/**
 * GET /api/owner/ambassadors
 * The roster plus the number that actually matters to a solo operator: total
 * unpaid commission liability. Owner-gated like every /api/owner/* route.
 */
async function handleOwnerAmbassadors(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });

  const [{ payoutState, passActive, PAYOUT_TERMS }, { tierFor }] = await Promise.all([
    import('./ambassador.js'), import('./affiliate.js'),
  ]);
  // Totals are summed in dollars, so round each step: 0.1 + 0.2 across a
  // roster is exactly how a liability figure ends in ...0000004.
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const rows = [];
  const totals = {
    ambassadors: 0, active: 0, sales: 0,
    earnedUsd: 0, paidUsd: 0, owedUsd: 0,
    // The split that decides what actually gets sent on payout day.
    availableUsd: 0, pendingUsd: 0,
    // Money already out the door that a clawback took back. Its own line,
    // because it used to hide inside owedUsd reading as a settled $0.
    overpaidUsd: 0,
    taxDocBlocked: 0, payableNow: 0,
  };
  try {
    let cursor, pages = 0;
    while (pages < 10) {
      const page = await env.CYBERSYGN_DOCS.list({ prefix: 'affiliate:code:', limit: 100, cursor });
      for (const k of (page.keys || [])) {
        let rec = null;
        try { rec = JSON.parse(await env.CYBERSYGN_DOCS.get(k.name)); } catch (e) {}
        if (!rec || !rec.code) continue;
        const pay = payoutState(rec);
        const active = passActive(rec);
        totals.ambassadors += 1;
        if (active) totals.active += 1;
        totals.sales += Number(rec.conversions) || 0;
        totals.earnedUsd = round2(totals.earnedUsd + pay.earnedAllTimeUsd);
        totals.paidUsd = round2(totals.paidUsd + pay.paidUsd);
        totals.owedUsd = round2(totals.owedUsd + pay.owedUsd);
        totals.availableUsd = round2(totals.availableUsd + pay.payableUsd);
        totals.pendingUsd = round2(totals.pendingUsd + pay.pendingUsd);
        totals.overpaidUsd = round2(totals.overpaidUsd + pay.overpaidUsd);
        if (pay.w9Blocking) totals.taxDocBlocked += 1;
        if (pay.payable) totals.payableNow += 1;
        rows.push({
          code: rec.code,
          email: rec.email || '',
          status: rec.status === 'revoked' ? 'revoked' : (active ? 'active' : 'lapsed'),
          tier: tierFor(rec.conversions || 0).label,
          clicks: Number(rec.clicks) || 0,
          sales: Number(rec.conversions) || 0,
          earnedUsd: pay.earnedAllTimeUsd,
          paidUsd: pay.paidUsd,
          owedUsd: pay.owedUsd,
          // Send this number, not owedUsd.
          availableUsd: pay.payableUsd,
          pendingUsd: pay.pendingUsd,
          balanceUsd: pay.balanceUsd,
          overpaidUsd: pay.overpaidUsd,
          belowMinimum: pay.belowMinimum,
          payable: pay.payable,
          blockReasons: pay.blockReasons,
          warnings: pay.warnings,
          nextPayoutDate: pay.nextPayoutDate,
          // Tax, on a cash basis and against the correct year's threshold.
          paidThisYearUsd: pay.paidThisYearUsd,
          reportingThresholdUsd: pay.reportingThresholdUsd,
          reportingLikely: pay.reportingLikely,
          priorYearReported: pay.priorYearReported,
          taxDocState: pay.w9State,
          taxDocType: pay.taxDocType,
          taxDocExpiresAt: pay.taxDocExpiresAt,
          w9Blocking: pay.w9Blocking,
          termsAcceptedAt: pay.termsAcceptedAt,
          termsVersion: pay.termsVersion,
          createdAt: rec.createdAt || null,
          lastConversionAt: rec.lastConversionAt || null,
        });
      }
      pages += 1;
      if (page.list_complete || !page.cursor) break;
      cursor = page.cursor;
    }
  } catch (e) {
    return jsonResponse(200, { ok: true, rows, totals, error: 'partial_list' });
  }
  // Overpaid accounts first (they must be cleared before anything is sent),
  // then the actually-payable queue by size. Sorting by owedUsd was wrong:
  // owed includes money still inside its hold window.
  rows.sort((a, b) =>
    (b.overpaidUsd - a.overpaidUsd) ||
    (b.availableUsd - a.availableUsd) ||
    (b.sales - a.sales));
  return jsonResponse(200, { ok: true, rows, totals, terms: PAYOUT_TERMS });
}

/**
 * POST /api/owner/ambassadors/payout
 * {code, amount, rail, railRef, idempotencyKey, note, belowMinimum?, allowOverpay?}
 * The override flags are forwarded deliberately: a final settlement on a
 * closing account is legitimately below the minimum, and recordPayout refuses
 * it otherwise.
 */
async function handleOwnerAmbassadorPayout(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { code, amount, method, note, rail, railRef, idempotencyKey, belowMinimum, allowOverpay } = body.value || {};
  const { recordPayout } = await import('./ambassador.js');
  const r = await recordPayout(env, String(code || '').toLowerCase(), {
    amount, method, note, rail, railRef, idempotencyKey,
    belowMinimum: belowMinimum === true,
    allowOverpay: allowOverpay === true,
  });
  return jsonResponse(r.ok ? 200 : 400, r);
}

/**
 * POST /api/owner/ambassadors/taxdoc {code, state, docType?, vendor?, vendorPayeeId?, collectedAt?, expiresAt?, country?}
 * Marks a W-9 or W-8BEN as collected. We never receive or store the TIN
 * itself, only the status and an opaque collector reference.
 */
async function handleOwnerAmbassadorTaxDoc(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { code, state, docType, vendor, vendorPayeeId, collectedAt, expiresAt, country } = body.value || {};
  const { setW9State } = await import('./ambassador.js');
  const r = await setW9State(env, String(code || '').toLowerCase(), state, {
    docType, vendor, vendorPayeeId, collectedAt, expiresAt, country,
  });
  return jsonResponse(r.ok ? 200 : 400, r);
}

/** POST /api/owner/ambassadors/revoke {code, reason} */
async function handleOwnerAmbassadorRevoke(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const { code, reason } = body.value || {};
  const { revokeAmbassador } = await import('./ambassador.js');
  const r = await revokeAmbassador(env, String(code || '').toLowerCase(), reason);
  return jsonResponse(r.ok ? 200 : 400, r);
}

/**
 * POST /api/owner/ambassadors/test-email
 * Renders the monthly scoreboard from REAL records but ALWAYS redirects the
 * send to the owner, so a test can never reach a real ambassador.
 */
async function handleOwnerAmbassadorTestEmail(request, env, url) {
  const owner = await getOwnerForRequest(request, env, url);
  if (!owner) return jsonResponse(401, { error: 'unauthorized' });
  const to = ownerEmail(env);
  if (!to) return jsonResponse(400, { error: 'no_owner_email' });
  const { runMonthlyScoreboard } = await import('./ambassador-email.js');
  const result = await runMonthlyScoreboard(env, { redirectTo: to, limit: 3 });
  return jsonResponse(200, { ok: true, redirectedTo: to, ...result });
}

/** Canonical base URL for links inside ambassador mail. */
function baseUrlForMail(env, url) {
  return (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
}

async function handleAmbassadorMe(request, env, url) {
  const senderId = String(url.searchParams.get('senderId') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender' });

  const { ambassadorBySender, passActive, touchPass, payoutState, PAYOUT_TERMS } = await import('./ambassador.js');
  const { tierFor, TIERS: LADDER, MILESTONES, SPRINT, DISCOUNT, payoutFor } = await import('./affiliate.js');

  const rec = await ambassadorBySender(env, senderId);
  if (!rec) return jsonResponse(404, { error: 'not_an_ambassador' });

  // Signal of life: renew the pass on every dashboard open.
  await touchPass(env, rec, 'dashboard');

  const sales = Number(rec.conversions) || 0;
  const clicks = Number(rec.clicks) || 0;
  const tier = tierFor(sales);
  const nextTier = LADDER.find(t => t.min > sales) || null;
  const nextMilestone = MILESTONES.find(m => m.at > sales) || null;
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthly = (rec.monthly && rec.monthly.month === monthKey) ? rec.monthly : { month: monthKey, sales: 0, sprintPaid: false };
  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;

  // A conversion rate on a tiny sample is noise, not information. Below 50
  // clicks we send null and the dashboard hides the stat entirely.
  const conversionRate = clicks >= 50 ? Math.round((sales / clicks) * 1000) / 10 : null;

  return jsonResponse(200, {
    ok: true,
    code: rec.code,
    shareUrl: `${baseUrl}/?ref=${rec.code}`,
    discount: DISCOUNT.label,
    status: rec.status === 'revoked' ? 'revoked' : 'active',
    pass: { active: passActive(rec), until: rec.passUntil || null },
    // Bounty is per-plan now, so the tier carries its multiplier and the
    // payout table below shows what each plan actually pays.
    tier: { key: tier.key, label: tier.label, mult: tier.mult, soloBounty: payoutFor('solo', sales) },
    nextTier: nextTier ? { label: nextTier.label, mult: nextTier.mult, salesRemaining: nextTier.min - sales } : null,
    nextMilestone: nextMilestone ? { label: nextMilestone.label, bonus: nextMilestone.bonus, salesRemaining: nextMilestone.at - sales } : null,
    sprint: { needed: SPRINT.salesNeeded, bonus: SPRINT.bonus, sales: monthly.sales, paid: !!monthly.sprintPaid, month: monthly.month },
    stats: { clicks, sales, conversionRate },
    hasSales: sales > 0,
    // The dashboard renders terms from the server so the published numbers and
    // the enforced ones cannot drift. Without this it silently fell back to a
    // hardcoded literal in app.js, which is the exact drift the single source
    // of truth exists to prevent.
    terms: PAYOUT_TERMS,
    payout: payoutState(rec),
    learn: rec.learn || {},
    ledger: Array.isArray(rec.ledger) ? rec.ledger.slice(-10).reverse() : [],
    // Live payout table computed from THIS ambassador's current tier and the
    // real price book, so what they see is what a sale actually pays them.
    payoutTable: ['solo', 'pro', 'team', 'business'].map((planId) => {
      const sticker = (TIER_MRR_CENTS[planId] || 0) / 100;
      const buyerPays = Math.round(sticker * (1 - DISCOUNT.percentOff / 100) * 100) / 100;
      return {
        plan: planId === 'team' ? 'Studio' : planId.charAt(0).toUpperCase() + planId.slice(1),
        stickerUsd: sticker,
        buyerPaysUsd: buyerPays,
        buyerPaysNote: `for ${DISCOUNT.months} months`,
        youEarnUsd: payoutFor(planId, sales),
      };
    }),
    // First-sale math, shown only to ambassadors who have not sold yet.
    firstSale: sales === 0
      ? { bounty: payoutFor('pro', 0), milestoneBonus: (MILESTONES[0] && MILESTONES[0].bonus) || 0, totalUsd: payoutFor('pro', 0) + ((MILESTONES[0] && MILESTONES[0].bonus) || 0), plan: 'Pro' }
      : null,
  });
}

/**
 * POST /api/ambassador/accept-terms {senderId, termsVersion} -> record it.
 *
 * The affiliate code is minted silently on the first dashboard visit, which is
 * fine for a tracking code but is NOT agreement to a payout contract. Without
 * this endpoint no ambassador could ever accept, so the no_terms_acceptance
 * block was permanent and unclearable and NOBODY could be paid, ever.
 */
async function handleAmbassadorAcceptTerms(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender' });

  const { ambassadorBySender, acceptTermsForCode, payoutState, TERMS_VERSION } = await import('./ambassador.js');
  const rec = await ambassadorBySender(env, senderId);
  if (!rec) return jsonResponse(404, { error: 'not_an_ambassador' });

  // Only the CURRENT published version can be accepted. Letting a client name
  // an arbitrary version would let someone accept terms that were never shown.
  const claimed = String(payload.termsVersion || TERMS_VERSION);
  if (claimed !== TERMS_VERSION) {
    return jsonResponse(409, { error: 'stale_terms_version', current: TERMS_VERSION });
  }

  // Hash the IP rather than storing it: enough to evidence acceptance, not a
  // durable record of where someone was.
  let ipHash = null;
  try {
    const { sha256Hex } = await import('./audit.js');
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (ip) ipHash = await sha256Hex(ip);
  } catch (e) {}

  const result = await acceptTermsForCode(env, rec.code, TERMS_VERSION, ipHash);
  if (!result || !result.ok) return jsonResponse(400, { error: (result && result.error) || 'accept_failed' });
  const fresh = await ambassadorBySender(env, senderId);
  return jsonResponse(200, {
    ok: true,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: fresh && fresh.termsAcceptedAt,
    payout: payoutState(fresh || rec),
  });
}

/** POST /api/ambassador/learn {senderId, moduleId} -> persist completion. */
async function handleAmbassadorLearn(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender' });

  const { ambassadorBySender, markLearnDone } = await import('./ambassador.js');
  const rec = await ambassadorBySender(env, senderId);
  if (!rec) return jsonResponse(404, { error: 'not_an_ambassador' });

  const result = await markLearnDone(env, rec, payload.moduleId);
  if (!result.ok) return jsonResponse(400, { error: result.error });
  return jsonResponse(200, { ok: true, learn: result.learn });
}

async function handleAffiliateRegister(request, env, url) {
  const body = await readJsonBody(request);
  if (body.error) return jsonResponse(400, body.error);
  const payload = body.value || {};
  const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!senderId) return jsonResponse(400, { error: 'missing_sender' });
  const email = typeof payload.email === 'string' ? payload.email.trim().slice(0, 320) : '';

  const result = await registerAffiliate(env, { senderId, email });
  if (!result.ok) return jsonResponse(500, { error: result.error });

  // Record acceptance of the published program terms. Without a stored version
  // and timestamp there is no evidence anyone agreed to the clawback, the
  // disclosure duty, or the payout schedule, in either direction. Enrolment is
  // not blocked on it: an existing caller that predates the terms page still
  // gets a working code, and payoutState treats a missing acceptance on a
  // post-terms record as a payout block, which is the right place to stop.
  try {
    const { acceptTermsForCode, TERMS_VERSION } = await import('./ambassador.js');
    if (payload.termsAccepted === true) {
      const ipHash = await sha256Hex(new TextEncoder().encode(
        `${request.headers.get('cf-connecting-ip') || ''}|${TERMS_VERSION}`,
      ));
      await acceptTermsForCode(env, result.code, String(payload.termsVersion || TERMS_VERSION), ipHash);
    }
  } catch (e) { /* non-fatal: the block reason surfaces it in Control */ }

  // Provision the real Stripe discount so the promised offer cannot silently
  // fail at checkout. Idempotent, and non-fatal: attribution still works if
  // Stripe is unreachable, and the next call retries cleanly (orphan coupons
  // are cleaned up inside ensureStripeDiscount).
  let discount = null;
  try {
    const { ensureStripeDiscount, DISCOUNT } = await import('./affiliate.js');
    const d = await ensureStripeDiscount(env, result.code, result.record);
    if (d.ok) discount = DISCOUNT.label;
    // Grant the product pass immediately so a new ambassador can run the
    // product on their own contract before pitching it (lesson 1 asks them to).
    const { touchPass } = await import('./ambassador.js');
    await touchPass(env, result.record, 'enrolled');
    // You-are-live email with a SIGNED-IN dashboard link. They just proved
    // this email is theirs, so we do not force a second round trip. Guarded
    // at-most-once inside sendYouAreLive.
    if (result.isNew && email) {
      const { sendYouAreLive } = await import('./ambassador-email.js');
      const { payoutFor } = await import('./affiliate.js');
      await sendYouAreLive(env, {
        to: email,
        code: result.code,
        shareUrl: `${baseUrlForMail(env, url)}/?ref=${result.code}`,
        discount: DISCOUNT.label,
        signedInUrl: `${baseUrlForMail(env, url)}/ambassador/?s=${encodeURIComponent(senderId)}`,
        bounty: payoutFor('pro', 0),
      }).catch(() => {});
    }
  } catch (e) {
    console.error('[affiliate] discount provision failed:', e && e.message);
  }

  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  return jsonResponse(200, {
    ok: true,
    code: result.code,
    isNew: result.isNew,
    shareUrl: `${baseUrl}/?ref=${result.code}`,
    discount,
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
 * lands with ?ref=<code> in the URL. Cheap, no auth, just bumps.
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
 *   pills (e.g. "Jane is signing, page 2, 5 of 8 fields filled").
 *
 * POST /api/docs/:docId/live?t=<signerToken>
 *   Body: { currentPage }
 *   Updates the calling signer's presence on the doc record. Cheap,
 *   no event log entry, we keep this off the audit trail because
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
/**
 * Overlay per-signer durable state onto a doc record. Each signer's
 * fills + completion stamp are ALSO written to signer-fills:<docId>:<id>
 * (single writer: that signer), so a lost read-modify-write on the shared
 * doc record can never lose ink: every fill-sensitive reader goes through
 * this overlay, and the subkey always wins per field.
 */
async function overlaySignerState(storage, doc, docId) {
  if (!doc || !Array.isArray(doc.signers)) return doc;
  await Promise.all(doc.signers.map(async (s) => {
    try {
      const sub = await storage.docs.get(`signer-fills:${docId}:${s.id}`, { json: true });
      if (!sub) return;
      s.fills = { ...(s.fills || {}), ...(sub.fills || {}) };
      if (!s.completedAt && sub.completedAt) s.completedAt = sub.completedAt;
    } catch (e) {}
  }));
  return doc;
}

/**
 * Load a doc record with the per-signer overlay applied.
 *
 * Guards the id BEFORE it reaches KV. Cloudflare caps a KV key at 512 bytes
 * and THROWS above it, so an oversized path segment used to escape as an
 * unhandled rejection and render a raw Cloudflare 1101 page on an
 * unauthenticated GET. Ids are minted by randomId(16), so anything long or
 * exotic is malformed by construction and deserves a clean not-found rather
 * than a crash.
 */
const DOC_ID_MAX = 128;
async function loadDocMerged(storage, docId) {
  const id = String(docId || '');
  if (!id || id.length > DOC_ID_MAX) return null;
  const doc = await storage.docs.get(`doc:${id}`, { json: true });
  if (!doc) return null;
  return overlaySignerState(storage, doc, id);
}

async function handleDocLive(request, env, url, docId) {
  const token = url.searchParams.get('t');
  if (!token) return jsonResponse(400, { error: 'missing_token' });
  const storage = getStorage(env);
  const doc = await loadDocMerged(storage, docId);
  if (!doc) return jsonResponse(404, { error: 'not_found' });
  const callingSigner = doc.signers.find(s => ctEqHex(s.token, token));
  if (!callingSigner) return jsonResponse(403, { error: 'invalid_token' });

  // Presence now lives in per-signer short-TTL keys (see
  // handleDocPresenceUpdate); docs from before the extraction may still
  // carry an embedded doc.presence, kept as a read-only fallback.
  const presenceEntries = await Promise.all(doc.signers.map(async (s) => {
    try {
      return [s.id, await storage.docs.get(`presence:${docId}:${s.id}`, { json: true })];
    } catch (e) {
      return [s.id, null];
    }
  }));
  const legacyPresence = doc.presence || {};
  const presence = {};
  for (const [sid, p] of presenceEntries) presence[sid] = p || legacyPresence[sid] || null;
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

  // Presence lives in its own short-TTL key with exactly one writer
  // (this signer). Heartbeats used to rewrite the whole doc record every
  // couple of seconds, racing handleSubmitFills on the same key and
  // occasionally clobbering another signer's just-written fills. This
  // path no longer touches doc:<id> at all.
  try {
    await storage.docs.put(`presence:${docId}:${signer.id}`, {
      currentPage,
      currentFieldId,
      lastSeenAt: new Date().toISOString(),
    }, { expirationTtl: 300 });
  } catch (e) {}
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
// Webhooks are a Studio feature. An ALLOWLIST, not a denylist.
//
// All four handlers used to exclude free/solo/solo_annual by name, which meant
// every tier nobody thought to name got Studio webhooks for free: Origin at $9,
// Lifetime at $299 and Pro at $19 all passed. A denylist silently grants each
// new SKU the feature until someone remembers to add it.
const WEBHOOK_TIERS = new Set(['team', 'business']);

async function handleWebhookGet(request, env, senderId) {
  const owner = await getOwnerForRequest(request, env, new URL(request.url));
  if (!owner) {
    const sub = await getSubscription(env, senderId);
    if (!sub || !WEBHOOK_TIERS.has(String(sub.tier || '').replace(/_annual$/, ''))) {
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
    if (!sub || !WEBHOOK_TIERS.has(String(sub.tier || '').replace(/_annual$/, ''))) {
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
    if (!sub || !WEBHOOK_TIERS.has(String(sub.tier || '').replace(/_annual$/, ''))) {
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
    if (!sub || !WEBHOOK_TIERS.has(String(sub.tier || '').replace(/_annual$/, ''))) {
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
    // List bounded, for very prolific senders we cap at 1000.
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

  // Source-attributed recurring revenue. Sums active MRR from the subs
  // registry and groups it by the first-touch marketing source captured at
  // checkout, so the owner can see which channels drive paid subscriptions.
  out.revenue = { mrrCents: 0, activeSubs: 0, bySource: [] };
  try {
    await ensureSubsBackfill(env);
    const registry = (await readSubsRegistry(env)) || {};
    const bySource = {};
    for (const rec of Object.values(registry)) {
      const tier = typeof rec.tier === 'string' ? rec.tier : 'free';
      const status = typeof rec.status === 'string' ? rec.status : '';
      if (tier === 'free' || (status !== 'active' && status !== 'trialing')) continue;
      const cents = TIER_MRR_CENTS[tier] || 0;
      if (cents <= 0) continue;
      out.revenue.activeSubs += 1;
      out.revenue.mrrCents += cents;
      const src = (typeof rec.source === 'string' && rec.source) ? rec.source : 'unknown';
      if (!bySource[src]) bySource[src] = { source: src, subs: 0, mrrCents: 0 };
      bySource[src].subs += 1;
      bySource[src].mrrCents += cents;
    }
    out.revenue.bySource = Object.values(bySource).sort((a, b) => b.mrrCents - a.mrrCents);
  } catch (e) {
    out.errors.push('revenue: ' + (e && e.message ? e.message : 'unknown'));
  }

  // At-risk revenue: refunds, disputes, and failed (past-due) payments, from
  // the best-effort metrics:risk counter the Stripe webhook maintains.
  out.risk = { refunds: 0, disputes: 0, failedPayments: 0, recent: [] };
  try {
    if (env && env.CYBERSYGN_DOCS) {
      const raw = await env.CYBERSYGN_DOCS.get('metrics:risk');
      if (raw) {
        const r = JSON.parse(raw) || {};
        out.risk.refunds = r.refunds || 0;
        out.risk.disputes = r.disputes || 0;
        out.risk.failedPayments = r.failedPayments || 0;
        out.risk.recent = Array.isArray(r.recent) ? r.recent.slice(0, 8) : [];
      }
    }
  } catch (e) {
    out.errors.push('risk: ' + (e && e.message ? e.message : 'unknown'));
  }

  // Affiliate liability: unpaid commission owed across all codes, so the owner
  // knows what is owed before recruiting more. Bounded list (1000 codes).
  out.affiliates = { count: 0, unpaidUsd: 0, conversions: 0, top: [] };
  try {
    if (env && env.CYBERSYGN_DOCS && typeof env.CYBERSYGN_DOCS.list === 'function') {
      const res = await env.CYBERSYGN_DOCS.list({ prefix: 'affiliate:code:', limit: 1000 });
      const rows = [];
      for (const key of res.keys || []) {
        const raw = await env.CYBERSYGN_DOCS.get(key.name);
        if (!raw) continue;
        let rec; try { rec = JSON.parse(raw); } catch (e) { continue; }
        if (!rec) continue;
        out.affiliates.count += 1;
        const earned = Number(rec.earnedUsd) || 0;
        const paid = Number(rec.paidUsd) || 0;
        out.affiliates.unpaidUsd += Math.max(0, earned - paid);
        out.affiliates.conversions += Number(rec.conversions) || 0;
        rows.push({ code: rec.code, unpaidUsd: Math.max(0, earned - paid), conversions: Number(rec.conversions) || 0 });
      }
      out.affiliates.top = rows.filter(r => r.unpaidUsd > 0).sort((a, b) => b.unpaidUsd - a.unpaidUsd).slice(0, 5);
    }
  } catch (e) {
    out.errors.push('affiliates: ' + (e && e.message ? e.message : 'unknown'));
  }

  return jsonResponse(200, out);
}

// ---- /api/metrics (Vyan Control, spine CONTRACT §6) ------------------------

/**
 * House-key gate for the standardized metrics endpoint. The key comes from
 * env (VYAN_METRICS_KEY, falling back to VYAN_HOUSE_KEY), never from code.
 * Fails closed: if no key is configured, the endpoint is never open. Auth is
 * `Authorization: Bearer <key>`, the same convention every Vyan product uses.
 */
function metricsKey(env) {
  return (env && (env.VYAN_METRICS_KEY || env.VYAN_HOUSE_KEY)) || '';
}

function metricsAuthorized(request, env) {
  const key = metricsKey(env);
  if (!key) return false; // no key configured → no access (never open)
  const presented = (request.headers.get('authorization') || '').replace(/^bearer\s+/i, '').trim();
  if (!presented || presented.length !== key.length) return false;
  // Constant-time compare so the key can't be recovered by response timing.
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= presented.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

/**
 * Standardized metrics document for Vyan Control (spine CONTRACT §6). Vyan
 * Control polls this across every product to render one founder dashboard.
 *
 * Shape:
 *   {
 *     product: "cybersygn",
 *     period: { from, to },              // epoch ms, override with ?from=&to=
 *     activeOperators: <number>,         // paid, active subscriptions
 *     usage: { docsSent, docsCompleted },// docs created / completed in period
 *     revenueCents: <number>,            // MRR attributable to CyberSygn
 *     health: { ok: true }
 *   }
 *
 * Counters are derived by scanning KV (sub:* and doc:*). All scans are
 * bounded and every read is guarded, so a partial KV failure degrades to a
 * lower count rather than throwing (Section 1.9). Annual plans are normalized
 * to monthly-equivalent cents; lifetime is one-time and excluded from MRR.
 */
async function handleMetrics(env, url) {
  const now = Date.now();
  const from = parseEpochParam(url.searchParams.get('from'), now - 30 * 24 * 60 * 60 * 1000);
  const to = parseEpochParam(url.searchParams.get('to'), now);

  let activeOperators = 0;
  let revenueCents = 0;

  // ---- Active operators + MRR from the rolling subs registry ----------
  // Maintained at write time next to every sub:<senderId> put (stripe.js
  // recordSubForMetrics). First call after deploy seeds it with one final
  // legacy scan; every call after that is a single GET. Lifetime counts
  // as an active operator but adds 0 to recurring MRR.
  try {
    await ensureSubsBackfill(env);
    const registry = await readSubsRegistry(env);
    for (const rec of Object.values(registry || {})) {
      const tier = typeof rec.tier === 'string' ? rec.tier : 'free';
      const status = typeof rec.status === 'string' ? rec.status : '';
      if (tier !== 'free' && (status === 'active' || status === 'trialing')) {
        activeOperators += 1;
        revenueCents += (TIER_MRR_CENTS[tier] || 0);
      }
    }
  } catch (e) { /* degrade: report what we counted */ }

  // ---- Docs sent / completed from daily buckets -------------------------
  // Bumped on every doc creation / completion; a window read is one GET
  // per day (max 92), not one GET per doc ever created. The old full
  // doc:* scan runs exactly once more as a lazy backfill, then never again.
  let usage = { docsSent: 0, docsCompleted: 0 };
  try {
    await ensureDailyBackfill(env);
    usage = await readDailyMetrics(env, from, to);
  } catch (e) { /* degrade: zeros beat a 1101 */ }

  return jsonResponse(200, {
    product: 'cybersygn',
    period: { from, to },
    activeOperators,
    usage,
    revenueCents,
    health: { ok: true },
  });
}

// Parse an epoch-ms query param. Accepts ms or ISO; falls back to `fallback`.
function parseEpochParam(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const iso = Date.parse(raw);
  return Number.isFinite(iso) ? iso : fallback;
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
  //, useful when the owner wants to confirm their own clicks landed.
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
  const body = await readJsonBody(request, MAX_DOC_JSON_BYTES);
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

async function handleCreateDoc(request, env, url, ctx, opts = {}) {
  const body = await readJsonBody(request, MAX_DOC_JSON_BYTES);
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
  // opts.unmetered is set ONLY by the authenticated v1 path for keys flagged
  // unmetered (partner-issued tenant keys). The public /api/docs route never
  // passes it, so this is not forgeable from outside.
  let freeGate = null; // set when this create burns a free-tier allowance
  // FOOTER DECISION, PINNED AT CREATION.
  //
  // Solo and up are sold with "No footer." and every canonical signed PDF got
  // one anyway: drawSignedFooter in signed-pdf.js has no tier check, and the
  // browser's only gate was a localStorage flag that any free user could set
  // and no subscription ever wrote. So paid customers got the footer they paid
  // to remove, and free users could remove it for nothing.
  //
  // Decided ONCE, here, and stored on the record. Resolving the tier later
  // inside ensureSignedPdf would mean a subscription lapsing between two
  // builds silently changes the bytes, and those bytes are hashed and
  // published as signedPdfSha256 on the audit certificate.
  let footerless = !!owner || !!opts.unmetered;
  if (!owner && !opts.unmetered) {
    const gate = await checkFreeTierAllowance(env, senderId);
    // "Never paid" = no subscription record, or one whose tier reverted to
    // free (a fully canceled account). A sender with a real paid tier in ANY
    // status (active, trialing, past_due during dunning) is a customer, not
    // an anonymous free user: they are never told to "create a free account".
    const neverPaid = !gate.sub || gate.sub.tier === 'free';
    // Same subscription the gate just read, no extra KV round trip.
    footerless = !neverPaid;
    if (gate.tier === 'free' && neverPaid) {
      // SINGLE SIGNER ON FREE. llms.txt sells the free tier as "single signer
      // per document" and sells Solo on "Multi-signer routing with magic-link
      // email delivery", and nothing enforced either half: a free account could
      // route a document to as many signers as it liked, so Solo's advertised
      // differentiator was free. Checked before the allowance is consumed, so a
      // refused multi-signer send costs no credit.
      const signerCount = Array.isArray(payload.signers) ? payload.signers.length : 0;
      if (signerCount > 1) {
        return jsonResponse(402, {
          error: 'multi_signer_requires_paid',
          message: 'The free tier covers one signer per document. Solo adds multi-signer routing with magic-link delivery.',
          signerCount,
          upgrade: { tiers: ['solo', 'founding', 'team'] },
        });
      }
      // Free tier. The durable identity is the signed-up EMAIL (hashed),
      // not the senderId: senderIds live in localStorage and can be
      // rotated at will, so a per-sender counter alone is a 3-docs-per-
      // incognito-window cap, not a lifetime cap. Require the free token
      // minted at signup and enforce the lifetime allowance against its
      // email-hash record. API-keyed calls (v1) skip the token: keys are
      // owner/partner-minted identities whose senderId cannot be rotated,
      // so the monthly per-sender cap below is already binding for them.
      if (!opts.apiKeyed) {
        const freeToken = request.headers.get('x-cybersygn-free') || String(payload.freeToken || '');
        const peek = await freePeek(env, freeToken);
        if (!peek.ok) {
          return jsonResponse(402, {
            error: 'free_signup_required',
            message: 'Create a free account to send documents (three free, lifetime, no card needed), or upgrade for unlimited.',
            upgrade: { tiers: ['solo', 'founding', 'team'] },
          });
        }
        if (peek.remaining <= 0) {
          return jsonResponse(402, {
            error: 'free_cap_reached',
            message: 'You have used all three lifetime free documents. Upgrade to keep signing.',
            usage: { used: peek.used, cap: peek.cap, remaining: 0 },
            upgrade: { tiers: ['solo', 'founding', 'team'] },
          });
        }
        freeGate = { token: freeToken, emailHash: peek.emailHash };
      }
      if (!gate.allowed) {
        return jsonResponse(402, {
          error: 'free_tier_limit',
          message: `You have used all ${gate.cap} free documents this month. Upgrade to keep signing.`,
          usage: { used: gate.used, cap: gate.cap, remaining: 0 },
          upgrade: { tiers: ['solo', 'founding', 'team'] },
        });
      }
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
  // Hard cap: no downstream loop (invite emails, assignments, contact
  // auto-save) should be driven by an unbounded signer array. Bulk send is
  // the path for reaching many recipients, one document each.
  if (payload.signers.length > 50) {
    return jsonResponse(400, { error: 'too_many_signers', message: 'A single document supports up to 50 signers. Use bulk send for larger lists.' });
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

  // Signing order. 'sequential' routes the document to one signer at a time,
  // in order: only the first signer is emailed up front, and each subsequent
  // signer is emailed when the previous one completes (see handleSubmitFills).
  // 'parallel' (the default) emails everyone at once. Backward compatible:
  // documents created without signingOrder behave exactly as before.
  const sequential = payload.signingOrder === 'sequential' && payload.signers.length > 1;

  // Build the doc record. Each signer gets a fresh random token so the
  // magic-link URL is unguessable. `order` is the signing position (explicit
  // or array index); `notifiedAt` records when their invite was actually sent.
  const signers = payload.signers.map((s, idx) => ({
    id: String(s.id),
    name: String(s.name || '').trim() || 'Signer',
    email: String(s.email || '').trim(),
    token: randomId(32),
    order: Number.isFinite(s.order) ? s.order : idx,
    notifiedAt: null,
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
    // Hash of the free-signup email that paid for this doc (free tier
    // only). Never the cleartext. Lets GDPR export verify doc ownership
    // by email without a scan.
    senderEmailHash: freeGate ? freeGate.emailHash : null,
    // Whether the signed PDF carries the CyberSygn footer. Frozen here so the
    // artifact and its published hash can never disagree.
    footer: !footerless,
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
    signingOrder: sequential ? 'sequential' : 'parallel',
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

  // Burn the lifetime free allowance BEFORE the store, not after. The gate
  // above only PEEKED (read-only), so a burst of concurrent creates on one
  // token could all pass the peek; consuming here makes each request pass
  // through the counter increment first, collapsing that window. KV has no
  // atomic increment, so a same-instant burst within the seconds-long
  // cross-PoP consistency window can still slip an extra doc or two; a hard
  // cap would need a Durable Object and is out of scope. If the store below
  // then fails, we refund so the user is not charged for a doc that vanished.
  if (freeGate) {
    // Settle against the SAME identity the download path uses: the SHA-256 of
    // the original PDF bytes, which is also how the client derives docState.docId.
    // Computed here from the bytes we were handed rather than read from the
    // request body, so a client cannot claim a document was already paid for.
    //
    // Without this, downloading a signed PDF and then sending that same document
    // for signature burned two of a free user's three lifetime credits, so three
    // free documents bought one complete workflow instead of three.
    let createSha = null;
    try { createSha = await sha256Hex(pdfBytes); } catch (e) { /* dedupe is best effort */ }
    const consumed = await freeConsume(env, freeGate.token, createSha, { redeem: true });
    if (!consumed.ok) {
      return jsonResponse(402, {
        error: consumed.error === 'free_cap_reached' ? 'free_cap_reached' : 'free_consume_failed',
        message: consumed.error === 'free_cap_reached'
          ? 'You have used all three lifetime free documents. Upgrade to keep signing.'
          : 'Could not verify your free allowance. Please try again.',
        usage: consumed.used != null ? { used: consumed.used, cap: consumed.cap, remaining: 0 } : undefined,
        upgrade: { tiers: ['solo', 'founding', 'team'] },
      });
    }
  }

  try {
    await storage.docs.put(`doc:${docId}`, docRecord, docRetention(docRecord));
    await storage.pdfs.put(`pdf:${docId}`, pdfBytes.buffer, { expirationTtl: DOC_TTL_SECONDS });
  } catch (e) {
    if (freeGate) await freeRefund(env, freeGate.token).catch(() => {});
    throw e;
  }
  await addToActiveIndex(storage, docId);
  await addToSenderIndex(storage, senderId, docId);
  // OWNERSHIP IN THE KEY NAME, for erasure.
  //
  // sender:<id>:docs is capped at 200 entries, so erasure also ran an orphan
  // sweep that listed the ENTIRE doc: namespace and read every record to check
  // its senderId. That is one KV read per document product-wide, not per user,
  // so past roughly a thousand documents a single erase request exhausted its
  // subrequest budget mid-sweep. Encoding the owner in the key lets the sweep
  // list a sender-scoped prefix and read nothing to establish ownership.
  try {
    await storage.docs.put(`doc-of:${senderId}:${docId}`, '1', docRetention(docRecord));
  } catch (e) { /* the legacy scan still covers this document */ }
  if (workspaceId) {
    await addToWorkspaceIndex(storage, workspaceId, docId);
  }

  // F5: auto-save the signers as saved contacts for this sender so the next
  // send is a one-tap quick-pick. ONE batched read-modify-write (not a KV
  // write per signer) so a large signer array cannot exhaust the subrequest
  // budget. Best-effort: never blocks document creation.
  try {
    await upsertContacts(env, senderId, signers.map(s => ({ name: s.name, email: s.email })));
  } catch (e) {}

  // Meter free-tier docs against this month's counter. Owner-created docs
  // and docs from paid senders are never metered. Best-effort: a missed
  // increment is preferable to refusing a doc the user already created.
  if (!owner) {
    const subForMeter = await getSubscription(env, senderId);
    if (!(subForMeter.status === 'active' && subForMeter.tier !== 'free')) {
      await incrementUsage(env, senderId);
    }
  }

  // Bind senderId -> emailHash so the GDPR export flow can verify this
  // sender by email without a scan. (The allowance was already consumed
  // above.)
  if (freeGate) {
    try {
      await storage.docs.put(`sender-email:${senderId}`, freeGate.emailHash, {
        expirationTtl: 60 * 60 * 24 * 365 * 5,
      });
    } catch (e) {}
  }

  // Build magic links and dispatch invites in parallel.
  const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
  // Pull sender branding (slice 90) once so every invite carries the
  // same logo + accent. Free senders have no brand record; the email
  // renderer falls back to CyberSygn defaults.
  const senderBrand = await loadSenderBrand(env, senderId);

  // Sequential: only the first signer by order is invited now; the rest are
  // queued and emailed as each predecessor completes. Parallel: invite all.
  const orderedSigners = [...signers].sort((a, b) => a.order - b.order);
  const notifyNowIds = new Set(
    sequential
      ? (orderedSigners.length ? [orderedSigners[0].id] : [])
      : signers.map(s => s.id),
  );

  const signerLinks = await Promise.all(signers.map(async s => {
    const magicLink = `${baseUrl}/preview/?doc=${docId}&t=${s.token}`;
    let sent = false;
    let error = null;
    let queued = false;
    if (!notifyNowIds.has(s.id)) {
      // Sequential and not this signer's turn yet.
      queued = true;
    } else if (isValidEmail(s.email)) {
      const result = await sendInvite(env, {
        to: s.email,
        name: s.name,
        docTitle: docRecord.title,
        magicLink,
        senderName: docRecord.senderName,
        brand: senderBrand,
      });
      sent = !!result.delivered;
      if (sent) s.notifiedAt = new Date().toISOString();
      else error = result.error || 'send failed';
    }
    return {
      signerId: s.id,
      name: s.name,
      email: s.email,
      token: s.token,
      magicLink,
      order: s.order,
      sent,
      queued,
      error,
    };
  }));

  // Persist the notifiedAt stamps set during dispatch (the doc was written
  // before sending so the records existed; this re-write captures who was
  // actually invited, which sequential routing reads on each completion).
  await storage.docs.put(`doc:${docId}`, docRecord, docRetention(docRecord));

  // Fire doc.created webhook (slice 91). Studio-only, fireWebhook
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
  waitUntil(bumpDailyMetric(env, 'sent'));

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
  const doc = await loadDocMerged(storage, docId);
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
    await storage.docs.put(`doc:${docId}`, doc, docRetention(doc));
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
  const doc = await loadDocMerged(storage, docId);
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });
  if (doc.voidedAt) return jsonResponse(410, { error: 'voided', message: 'This document was voided and can no longer be signed.' });
  const eventCountAtLoad = Array.isArray(doc.events) ? doc.events.length : 0;

  const signerIdx = doc.signers.findIndex(s => ctEqHex(s.token, token));
  if (signerIdx < 0) return jsonResponse(403, { error: 'invalid_token', message: 'Invalid signing link.' });
  const signer = doc.signers[signerIdx];

  // Once the document is fully executed the record is legally final, no signer
  // may add or change anything. (Void/decline are the only post-signing moves.)
  if (doc.completedAt) {
    return jsonResponse(409, { error: 'already_completed', message: 'This document is already fully signed and can no longer be changed.' });
  }

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

  // A signer who has already completed cannot alter their own signed fields.
  // Unowned fields were filtered out above, so an empty accepted set is a
  // harmless no-op that falls through to the normal 0-accepted response; only
  // a real attempt to overwrite signed values is rejected.
  if (signer.completedAt && Object.keys(accepted).length > 0) {
    return jsonResponse(409, { error: 'already_signed', message: 'You have already completed signing this document and cannot change your fields.' });
  }

  const wasSignerComplete = Boolean(signer.completedAt);

  // Merge this submission's accepted fills onto the DURABLE subkey, not
  // just the in-memory copy. Reading the subkey fresh here means the fill
  // set is monotonic: a transient overlay-read miss on the initial load
  // can never cause us to write back a shrunken subkey and lose earlier
  // ink. The union is the authority for both the subkey write and the
  // completion decision below.
  let priorFills = {};
  try {
    const prior = await storage.docs.get(`signer-fills:${docId}:${signer.id}`, { json: true });
    if (prior && prior.fills && typeof prior.fills === 'object') priorFills = prior.fills;
  } catch (e) {}
  signer.fills = { ...priorFills, ...signer.fills, ...accepted };

  const ownedCount = ownedSet.size;
  const filledCount = Object.keys(signer.fills).length;
  if (ownedCount > 0 && filledCount >= ownedCount) {
    signer.completedAt = signer.completedAt || new Date().toISOString();
  }

  // Durable per-signer record, written BEFORE the shared doc record.
  // This key has exactly one writer (this signer), so even if a concurrent
  // writer wins the doc:<id> race below, the ink survives here and every
  // reader re-overlays it (see overlaySignerState).
  if (Object.keys(accepted).length > 0 || (signer.completedAt && !wasSignerComplete)) {
    try {
      await storage.docs.put(`signer-fills:${docId}:${signer.id}`, {
        fills: signer.fills,
        completedAt: signer.completedAt || null,
        updatedAt: new Date().toISOString(),
      }, { expirationTtl: DOC_TTL_SECONDS });
    } catch (e) {}
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

  // Webhook fires (slice 91). signer.completed when this submission
  // crossed the per-signer threshold. doc.completed fires further down,
  // after the write-freshen decides completion on the final state.
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

  // Sequential signing-order routing: when this signer just completed and the
  // document is not yet fully done, invite the next signer in order who has
  // not been notified or completed. This is what makes ordered routing work,
  // one signer at a time. Parallel docs skip this (everyone was emailed up
  // front). Best-effort send; notifiedAt is stamped so we never double-invite.
  let invitedNextId = null;
  if (doc.signingOrder === 'sequential' && signer.completedAt && !wasSignerComplete && !doc.completedAt) {
    const ordered = [...doc.signers].sort((a, b) => (a.order || 0) - (b.order || 0));
    const next = ordered.find(s => !s.completedAt && !s.notifiedAt && s.id !== signer.id);
    if (next) {
      const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
      const magicLink = `${baseUrl}/preview/?doc=${docId}&t=${next.token}`;
      next.notifiedAt = new Date().toISOString();
      invitedNextId = next.id;
      recordEvent(doc, { type: 'signer-invited', signerId: next.id, request, meta: { order: next.order } });
      if (isValidEmail(next.email)) {
        const senderBrand = await loadSenderBrand(env, doc.senderId);
        waitUntil(sendInvite(env, {
          to: next.email,
          name: next.name,
          docTitle: doc.title,
          magicLink,
          senderName: doc.senderName,
          brand: senderBrand,
        }));
      }
    }
  }

  doc.signers[signerIdx] = signer;

  // Write-freshen: re-read the shared record and graft this request's
  // changes onto the newest copy, so writers that landed while this
  // request was processing (another signer's submit, a decline, a
  // reminder stamp) are not clobbered by our stale read. Our own ink is
  // already durable in the signer-fills subkey either way.
  let final = doc;
  let freshWasAlias = false;
  try {
    const fresh = await loadDocMerged(storage, docId);
    // Concurrent void (or expiry) wins: if the freshest copy is voided or
    // gone, do NOT write our stale un-voided copy back: that would
    // resurrect a legally voided document. The subkey ink we wrote is
    // inert because every reader rejects a voided doc.
    if (!fresh || fresh.voidedAt) {
      return jsonResponse(410, { error: 'voided', message: 'This document was voided and can no longer be signed.' });
    }
    if (Array.isArray(fresh.signers)) {
      freshWasAlias = fresh === doc; // memory mode returns live references
      const fi = fresh.signers.findIndex(s => s.id === signer.id);
      // Graft only the fields THIS request owns (fills + completion) onto
      // the fresh signer, preserving concurrent third-party mutations of
      // the same signer such as a reminder stamp (lastReminderAt/count).
      if (fi >= 0) {
        fresh.signers[fi] = { ...fresh.signers[fi], fills: signer.fills, completedAt: signer.completedAt };
      }
      if (invitedNextId) {
        const fn = fresh.signers.find(s => s.id === invitedNextId);
        if (fn && !fn.notifiedAt) fn.notifiedAt = new Date().toISOString();
      }
      // Append our new events. When the read aliased our own object
      // (memory mode), those events are already present, so appending
      // again would duplicate them.
      if (!freshWasAlias) {
        fresh.events = [...(fresh.events || []), ...(doc.events || []).slice(eventCountAtLoad)];
      }
      final = fresh;
    }
  } catch (e) {}

  // Decide completion on the FINAL state: the freshen above may have just
  // absorbed the concurrent submit that was the last missing signature.
  const allDone = final.signers.every(s => {
    const ownedForS = Object.values(final.assignments || {}).filter(sId => sId === s.id).length;
    if (ownedForS === 0) return true; // a signer with no fields is trivially complete
    return Boolean(s.completedAt);
  });
  let docJustCompleted = false;
  if (allDone && !final.completedAt) {
    final.completedAt = new Date().toISOString();
    recordEvent(final, { type: 'completed', request });
    docJustCompleted = true;
  }

  await storage.docs.put(`doc:${docId}`, final, docRetention(final));

  // Completion side effects (webhook + emails + audit cert) fire exactly
  // once, gated by a KV marker so concurrent finishers cannot both blast.
  // KV has no compare-and-set, but the marker collapses the common races;
  // the certificate render is idempotent regardless.
  let fireCompletion = false;
  if (allDone) {
    await removeFromActiveIndex(storage, docId);
    if (docJustCompleted) {
      try {
        const marker = `meta:doc-complete-fired:${docId}`;
        const already = await storage.docs.get(marker);
        if (!already) {
          await storage.docs.put(marker, new Date().toISOString(), { expirationTtl: DOC_TTL_SECONDS });
          fireCompletion = true;
        }
      } catch (e) { fireCompletion = true; }
    }
  }
  if (fireCompletion) {
    waitUntil(fireWebhook(env, final.senderId, 'doc.completed', {
      docId,
      title: final.title,
      completedAt: final.completedAt,
      signerCount: final.signers.length,
    }));
    waitUntil(bumpDailyMetric(env, 'completed'));
  }
  // On full completion the doc always has an audit URL to report. The
  // certificate itself is rendered once (by the firing request); a later
  // racing observer still returns the URL, and the cert is regenerable on
  // demand if that single render failed. Everything reads the FINAL state.
  let auditUrl = allDone ? `/api/docs/${docId}/audit?t=${final.signers[0].token}` : null;
  if (fireCompletion) {
    // Build the CANONICAL signed artifact first: the certificate below prints
    // its hash and the verify record stores it, so both need it in hand.
    // final is the loadDocMerged copy, so per-signer subkeys are overlaid and
    // this is the authoritative fill set. Never throws, and a failure only
    // means the document has no signed hash, which every downstream reader
    // and every line of copy is written to handle.
    let signedSha = null;
    try {
      const signedRes = await ensureSignedPdf(env, { ...final, id: docId });
      if (signedRes.ok) {
        signedSha = signedRes.sha256;
        // Graft the hash onto the stored record so a later on-demand render
        // or a /signed request can report it without rebuilding.
        try {
          const fresh = await storage.docs.get(`doc:${docId}`, { json: true });
          if (fresh) {
            fresh.signedPdfSha256 = signedSha;
            await storage.docs.put(`doc:${docId}`, fresh, docRetention(fresh));
          }
        } catch (e) { /* the artifact exists either way */ }
      } else {
        console.error('[signed-pdf] not produced:', signedRes.reason);
      }
    } catch (err) {
      console.error('[signed-pdf] failed:', err && err.message);
    }

    try {
      const certBytes = await renderAuditCertificate({
        doc: final, pdfSha256: final.pdfSha256, signedPdfSha256: signedSha,
      });
      await storage.pdfs.put(`audit:${docId}`, certBytes.buffer); // permanent: see docRetention
    } catch (err) {
      console.error('[audit] render failed:', err && err.message);
    }

    // Lift the TTL off the document itself. The PDF is written once at
    // creation, when the doc is still in flight and correctly carries the 30
    // day expiry, and is never rewritten afterwards. Without this rewrite the
    // record and the certificate would be retained while the actual file they
    // describe silently expired, which is a worse outcome than deleting all
    // three: the audit trail would point at a document that no longer exists.
    // Best effort. A failure here leaves the old TTL in place and is logged,
    // never surfaced, because completion must not fail on a storage retry.
    try {
      const pdfBytes = await storage.pdfs.get(`pdf:${docId}`, { arrayBuffer: true });
      if (pdfBytes) await storage.pdfs.put(`pdf:${docId}`, pdfBytes);
      // Record that the original is now retained, so the self-heal on the read
      // path knows it does not need to do this again.
      try { await storage.docs.put(`meta:pdf-retained:${docId}`, '1'); } catch (e) {}
    } catch (err) {
      // NOT merely logged any more. This block runs exactly once, behind
      // meta:doc-complete-fired, so a single failed put here used to be
      // permanent: pdf:<docId> kept its 30-day expiry while doc:, audit: and
      // signed: were all retained forever, leaving an audit trail pointing at
      // a document that no longer exists, and nothing would ever retry.
      console.error('[retention] could not lift PDF ttl:', err && err.message);
      try { await recordError(env, err, { where: 'retention-lift', docId }); } catch (e) {}
      // Drop the one-shot marker so the next writer on this document re-enters
      // the completion block and tries again. The work inside it is idempotent:
      // the certificate render and ensureSignedPdf both overwrite in place.
      try { await storage.docs.delete(`meta:doc-complete-fired:${docId}`); } catch (e) {}
    }

    // F4: write the PII-FREE public verify record so a recipient can later
    // confirm this fingerprint matches a completed CyberSygn signing. Runs
    // once (inside fireCompletion) and never blocks completion.
    try {
      await writeVerifyRecord(env, {
        pdfSha256: final.pdfSha256,
        // Lets a holder of the SIGNED file verify the bytes they actually
        // have, which is the whole point: hashing your signed PDF used to
        // return "no record found" every single time.
        signedPdfSha256: signedSha,
        signerCount: Array.isArray(final.signers) ? final.signers.length : 0,
        createdAt: final.createdAt,
        completedAt: final.completedAt,
      });
    } catch (err) {
      console.error('[verify] record write failed:', err && err.message);
    }
  }

  // Fire completion emails to every signer, exactly once (fireCompletion).
  // CC recipients (sender-supplied notice-only addresses) get the same
  // completion email so they have the signed PDF link in their inbox.
  let completionEmails = null;
  if (fireCompletion) {
    const baseUrl = (env && env.CYBERSYGN_APP_URL) || `${url.protocol}//${url.host}`;
    // Each signer gets a link built on THEIR OWN token. Emailing one signer's
    // magic link to everyone would hand out cross-signer credentials; the
    // token in each mail must authenticate only its recipient.
    const signerSends = final.signers.filter(s => isValidEmail(s.email)).map(s =>
      sendCompletion(env, {
        to: s.email,
        name: s.name,
        docTitle: final.title,
        // The canonical signed bytes, NOT /preview/. A button labelled
        // "Download signed PDF" that opens a live signing page gives the
        // signer no file at all, and hands them an editing surface for a
        // document they already signed. handleGetSignedPdf accepts ?t=
        // (signer) as well as ?s= (sender), so every party resolves to the
        // same bytes and the same hash on the audit certificate.
        downloadUrl: `${baseUrl}/api/docs/${docId}/signed?t=${s.token}`,
        auditUrl: auditUrl ? `${baseUrl}/api/docs/${docId}/audit?t=${s.token}` : null,
      }).then(r => ({ to: s.email, role: 'signer', ...r })),
    );
    // CC recipients are sender-designated notice-only readers with no token of
    // their own; they get the first signer's read link. Post-completion that
    // token cannot mutate anything (fills/decline both reject completed docs).
    const ccList = Array.isArray(final.cc) ? final.cc : [];
    const ccDownloadUrl = `${baseUrl}/api/docs/${docId}/signed?t=${final.signers[0].token}`;
    const ccSends = ccList.filter(e => isValidEmail(e)).map(email =>
      sendCompletion(env, {
        to: email,
        name: '',
        docTitle: final.title,
        downloadUrl: ccDownloadUrl,
        auditUrl: auditUrl ? `${baseUrl}${auditUrl}` : null,
        notice: true,
      }).then(r => ({ to: email, role: 'cc', ...r })),
    );
    completionEmails = await Promise.all([...signerSends, ...ccSends]);
  }

  return jsonResponse(200, {
    accepted: Object.keys(accepted).length,
    signerComplete: Boolean(signer.completedAt),
    docComplete: Boolean(final.completedAt),
    auditUrl,
    // The public, PII-free fingerprint of the completed document, so the
    // signer-completion screen can offer a shareable /verify certificate link.
    // Only meaningful once the document is fully complete.
    verifyHash: final.completedAt ? (final.pdfSha256 || '') : '',
    completionEmails,
    // Surfaced for the signer-microsite (slice 75). Returning name +
    // email lets the post-submit modal greet the signer by name and
    // prefill the free-tier signup form with their email, one-click
    // conversion.
    signerName: signer.name || '',
    signerEmail: signer.email || '',
  });
}

/**
 * Stream the original PDF back to an authenticated signer.
 * Validates the token against the persisted doc.
 */
/**
 * Stream the canonical signed document to any party to it.
 *
 * This is what makes every signer hold the SAME bytes. Before it existed the
 * only signed artifact was whatever each browser happened to flatten, so no
 * shared value existed to publish or verify.
 *
 * Documents completed before this shipped have no stored artifact. Rather than
 * a migration job, the first request builds it, stores it, and backfills the
 * hash, which is safe precisely because the build is deterministic: the bytes
 * produced now are the bytes that would have been produced then.
 */
async function handleGetSignedPdf(request, env, docId, url) {
  // EITHER credential works, because every party to the document must end up
  // holding the same bytes. ?t= is a signer token (the convention used by
  // /pdf and /audit), ?s= is the sender token (the convention used by the
  // progress and summary endpoints). Accepting only ?t= would leave the
  // SENDER downloading their own browser's local flatten, so "every party
  // gets the same file" would be false for the one person who sent it.
  const token = url.searchParams.get('t');
  const senderToken = url.searchParams.get('s');
  if (!token && !senderToken) {
    return jsonResponse(400, { error: 'missing_token', message: 'A signing or sender token is required.' });
  }

  const storage = getStorage(env);
  const doc = await loadDocMerged(storage, docId);
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  const isSigner = !!(token && (doc.signers || []).some(sg => ctEqHex(sg.token, token)));
  const isSender = !!(senderToken && doc.senderToken && ctEqHex(senderToken, doc.senderToken));
  if (!isSigner && !isSender) {
    return jsonResponse(403, { error: 'invalid_token', message: 'Invalid link.' });
  }

  if (!doc.completedAt) {
    return jsonResponse(409, {
      error: 'not_completed',
      message: 'The signed document is issued once every signer has finished.',
    });
  }

  const res = await ensureSignedPdf(env, { ...doc, id: docId });
  if (!res.ok) {
    // Honest failure. The client falls back to its own local flatten, which
    // still produces a usable file, just not the canonical one.
    return jsonResponse(409, {
      error: 'signed_unavailable',
      reason: res.reason,
      message: 'The canonical signed copy could not be produced for this document.',
    });
  }

  // Backfill the hash and the second verify key for a document that completed
  // before this feature existed, so /verify/ resolves the bytes just served.
  if (!doc.signedPdfSha256) {
    try {
      const fresh = await storage.docs.get(`doc:${docId}`, { json: true });
      if (fresh && !fresh.signedPdfSha256) {
        fresh.signedPdfSha256 = res.sha256;
        await storage.docs.put(`doc:${docId}`, fresh, docRetention(fresh));
        await writeVerifyRecord(env, {
          pdfSha256: fresh.pdfSha256,
          signedPdfSha256: res.sha256,
          signerCount: Array.isArray(fresh.signers) ? fresh.signers.length : 0,
          createdAt: fresh.createdAt,
          completedAt: fresh.completedAt,
        });
      }
    } catch (e) { /* serving the file matters more than the backfill */ }
  }

  return new Response(res.bytes, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'cache-control': 'private, no-store',
      'x-cybersygn-signed-sha256': res.sha256,
    },
  });
}

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
  const doc = await loadDocMerged(storage, docId);
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
      await storage.pdfs.put(`audit:${docId}`, cert); // permanent: see docRetention
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
  const doc = await loadDocMerged(storage, docId);
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
    // /signed, NOT /pdf. handleGetPdf returns the ORIGINAL uploaded file: its
    // own error string says "Original PDF not found in storage", and the only
    // writers of pdf:<docId> are the creation path and a TTL-lifting re-put of
    // the same bytes. Signer fills are flattened into signed:<docId> instead.
    // Pointing a control labelled "Download signed PDF" at /pdf handed the
    // sender a BLANK document and called it signed, and its hash could never
    // match the signedPdfSha256 printed on the audit certificate.
    // ?s= is the sender token, which handleGetSignedPdf validates.
    response.signedPdfUrl = `${baseUrl}/api/docs/${docId}/signed?s=${senderToken}`;
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
  // Unauthenticated email-sending endpoint, IP-limit to blunt abuse by anyone
  // who learns a docId. (Full sender-token auth is a tracked follow-up.)
  const rl = await checkRateLimit(env, `remind:${ipKey(request)}`, [{ windowSec: 3600, max: 20 }]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/docs/remind' });
  const storage = getStorage(env);
  const doc = await loadDocMerged(storage, docId);
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
    await storage.docs.put(`doc:${docId}`, doc, docRetention(doc));
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
  const doc = await loadDocMerged(storage, docId);
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
  // A DECLINE THE SENDER NEVER HEARS ABOUT IS A DEAD DOCUMENT.
  //
  // This used to be `signers.find(s => s.id !== signer.id && ...)` alone. In
  // single-signer mode there IS no other signer, so it never matched, nobody
  // was emailed, and senderNotified came back false on every single-signer
  // decline. The signing page told the signer "The sender has been notified"
  // regardless, so both parties believed the other knew, and the sender sat
  // waiting on a document that was never coming back.
  //
  // The document stores only senderEmailHash, so fall back to resolving the
  // sender's own signup address from it.
  let senderNotified = false;
  let notifyTarget = doc.signers.find(s =>
    s.id !== signer.id && isValidEmail(s.email)
  );
  if (!notifyTarget && doc.senderEmailHash) {
    const senderEmail = await dripEmailForHash(env, doc.senderEmailHash);
    if (senderEmail && isValidEmail(senderEmail)) {
      notifyTarget = { email: senderEmail, name: doc.senderName || '' };
    }
  }
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

  await storage.docs.put(`doc:${docId}`, doc, docRetention(doc));

  return jsonResponse(200, { ok: true, declinedAt: now, senderNotified });
}

/**
 * Direct PDF-to-CC email send. Bypasses the signing flow entirely, 
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
  // Non-owner callers can attach a PDF to arbitrary recipients, IP-limit so a
  // rotated senderId can't turn this into an open email relay off our domain.
  if (!owner) {
    const rl = await checkRateLimit(env, `snapshot:${ipKey(request)}`, [{ windowSec: 3600, max: 8 }, { windowSec: 86400, max: 30 }]);
    if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/snapshot/email' });
  }
  const body = await readJsonBody(request, MAX_DOC_JSON_BYTES);
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

  // FREE-TIER GATE. This path hands the finished, flattened PDF to up to ten
  // recipients, so it is the same artifact the download path charges for. It
  // was ungated, which meant a user with zero credits left, or who never
  // signed up at all, could get the paid outcome from the Tools panel. The
  // client now gates too, but a client gate is a suggestion.
  //
  // Settled by document sha with redeem semantics, so emailing a copy of a PDF
  // that was already paid for does not bill a second credit.
  if (!owner) {
    const senderId = String(payload.senderId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    let paid = false;
    if (senderId) {
      try {
        const sub = await getSubscription(env, senderId);
        paid = !!(sub && sub.tier && sub.tier !== 'free');
      } catch (e) { /* fall through to the free path rather than refuse */ }
    }
    if (!paid) {
      const freeToken = request.headers.get('x-cybersygn-free') || String(payload.freeToken || '');
      let snapSha = null;
      try { snapSha = await sha256Hex(pdfBytes); } catch (e) { /* dedupe is best effort */ }
      const consumed = await freeConsume(env, freeToken, snapSha, { redeem: true });
      if (!consumed.ok) {
        return jsonResponse(402, {
          error: consumed.error === 'free_cap_reached' ? 'free_cap_reached' : 'free_signup_required',
          message: consumed.error === 'free_cap_reached'
            ? 'You have used all three lifetime free documents. Upgrade to keep sending.'
            : 'Create a free account to email a copy. No card needed.',
          upgrade: { tiers: ['solo', 'founding', 'team'] },
        });
      }
    }
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
      // Raw read: the sweep walks the whole active index, so a per-signer
      // overlay here would multiply subrequests past the 1000 limit. A
      // just-completed doc whose only write was clobbered self-heals on the
      // next merged writer; worst case is one extra reminder in that window.
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

        // Sequential docs invite signers one at a time; a null notifiedAt
        // means it is not this signer's turn yet, so reminding them would
        // both break the ordering contract and leak their link early.
        // (Parallel docs are exempt: there a failed invite is exactly what
        // the reminder retries.)
        if (doc.signingOrder === 'sequential' && !signer.notifiedAt) continue;

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
        await storage.docs.put(`doc:${docId}`, doc, docRetention(doc));
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
    // Raw read (dashboard summary; avoids the per-signer subrequest fan-out).
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
/**
 * F5 contacts handlers. Same senderId-capability posture as the docs list:
 * possession of the senderId is the authorization. The id is sanitized to
 * alphanumerics before any storage key is built.
 */
async function handleListContacts(env, senderId) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });
  const contacts = await listContacts(env, safeId);
  return jsonResponse(200, { senderId: safeId, contacts });
}

async function handleUpsertContact(request, env, senderId) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });
  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse(400, parsed.error);
  const body = parsed.value || {};
  if (!isValidContactEmail(String(body.email || '').trim())) {
    return jsonResponse(400, { error: 'invalid_email', message: 'A valid email is required to save a contact.' });
  }
  const result = await upsertContact(env, safeId, {
    name: body.name,
    email: body.email,
    role: body.role,
  });
  if (!result.ok) {
    return jsonResponse(400, { error: result.reason || 'upsert_failed', message: 'Could not save that contact.' });
  }
  return jsonResponse(200, { senderId: safeId, contacts: result.contacts });
}

async function handleRemoveContact(request, env, senderId) {
  const safeId = sanitizeSenderId(senderId);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });
  const parsed = await readJsonBody(request);
  if (parsed.error) return jsonResponse(400, parsed.error);
  const body = parsed.value || {};
  const contactId = String(body.contactId || '').trim();
  if (!contactId) {
    return jsonResponse(400, { error: 'invalid_contact', message: 'A contactId is required.' });
  }
  const result = await removeContact(env, safeId, contactId);
  if (!result.ok) {
    return jsonResponse(400, { error: result.reason || 'remove_failed', message: 'Could not remove that contact.' });
  }
  return jsonResponse(200, { senderId: safeId, contacts: result.contacts });
}

/**
 * F4 public verification. Returns a PII-FREE proof that a fingerprint
 * matches a completed CyberSygn signing. Cacheable (300s) because the
 * record is immutable once written. Zero PII in every branch.
 */
async function handleVerify(env, hash) {
  const clean = String(hash || '').trim().toLowerCase();
  if (!isValidFingerprint(clean)) {
    return jsonResponse(400, { error: 'invalid_hash', message: 'A verification hash is a 64-character hex SHA-256.' });
  }
  const record = await getVerifyRecord(env, clean);
  if (!record) {
    /* Do NOT cache a "not found". getVerifyRecord returns null for BOTH a
       genuine miss and a swallowed KV read error, so caching this for 300s
       could pin a false "this signed document was never signed here" on the
       product's trust surface during a transient blip, and also delay a
       just-signed document from verifying. Only found:true is immutable and
       cacheable; a negative is always fetched fresh. */
    return jsonResponse(200, { found: false }, { 'cache-control': 'no-store' });
  }
  const headers = { 'cache-control': 'public, max-age=300' };
  // Only the fingerprint, count, timestamps, and status leave this endpoint.
  return jsonResponse(200, {
    found: true,
    fingerprint: record.fingerprint,
    signerCount: record.signerCount,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    status: record.status || 'completed',
  }, headers);
}

/**
 * F3 AI summary of a COMPLETED document. Sender-token authenticated
 * (?t=<senderToken>), ANTHROPIC-gated (graceful when unset), IP + per-doc
 * rate-limited, never 500, never leaks the key.
 */
async function handleDocSummary(request, env, docId, url) {
  const token = url.searchParams.get('t') || '';

  const storage = getStorage(env);
  const doc = await storage.docs.get(`doc:${docId}`, { json: true });
  if (!doc) return jsonResponse(404, { error: 'not_found', message: 'Document not found.' });

  // Only the sender may summarize their doc, and only once it is complete.
  if (!doc.senderToken || !ctEqHex(token, doc.senderToken)) {
    return jsonResponse(403, { error: 'forbidden', message: 'A valid sender token is required.' });
  }
  if (!doc.completedAt) {
    return jsonResponse(403, { error: 'not_completed', message: 'A summary is available once every signer has completed.' });
  }

  // IP rate limit plus a light per-doc limit so a single doc cannot be
  // summarized on repeat to burn provider budget.
  const rl = await checkRateLimit(env, `summary:${ipKey(request)}`, [
    { windowSec: 60 * 60, max: 20 },
    { windowSec: 60 * 60 * 24, max: 100 },
  ]);
  if (!rl.ok) return rateLimitedResponse(rl, { endpoint: '/api/docs/summary' });
  const docRl = await checkRateLimit(env, `summary-doc:${docId}`, [
    { windowSec: 60, max: 3 },
    { windowSec: 60 * 60, max: 10 },
  ]);
  if (!docRl.ok) return rateLimitedResponse(docRl, { endpoint: '/api/docs/summary' });

  // Same entitlement as drafting: metered on free and Solo, unmetered from Pro
  // up, which is what the pricing page sells. The caller is already
  // authenticated by the sender token above, so the document's own identity is
  // the quota key rather than a separate free-signup token.
  const owner = await getOwnerForRequest(request, env, url);
  const allow = await checkAiAllowance(env, request, { senderId: doc.senderId }, {
    owner,
    quotaId: doc.senderEmailHash || doc.senderId || null,
  });
  if (!allow.ok) return jsonResponse(allow.status, allow.body);

  const values = mergeSignerFills(doc.signers);

  let result;
  try {
    result = await generateSummary(env, {
      title: doc.title,
      fields: Array.isArray(doc.fields) ? doc.fields : [],
      values,
    });
  } catch (e) {
    // generateSummary already guards its failures; any unexpected throw must
    // still never surface a raw error or the key.
    console.error('[summary] unexpected error:', e && e.message);
    return jsonResponse(200, {
      ok: false,
      reason: 'error',
      message: 'Summaries are temporarily unavailable. Please try again in a moment.',
    });
  }

  if (!result || !result.ok) {
    return jsonResponse(200, {
      ok: false,
      reason: (result && result.reason) || 'error',
      message: (result && result.message) || 'Summaries are temporarily unavailable. Please try again in a moment.',
    });
  }

  await burnAiCredit(env, allow);

  return jsonResponse(200, {
    ok: true,
    summary: result.summary,
    aiUsage: allow.unmetered ? { unmetered: true } : { used: (allow.used || 0) + 1, cap: allow.cap },
    disclaimer: 'This is a plain-English summary for convenience, not legal advice.',
  });
}

async function handleListSenderDocs(env, senderId) {
  const storage = getStorage(env);
  // .slice(0, 64) like every sibling sanitizer. Without the cap a long path
  // segment became a KV key over Cloudflare's 512-byte limit, the binding threw,
  // and an UNAUTHENTICATED GET took the worker to a 500.
  const safeId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!safeId) return jsonResponse(400, { error: 'invalid_sender', message: 'senderId must be alphanumeric.' });

  const index = (await storage.docs.get(`sender:${safeId}:docs`, { json: true })) || { docs: [] };
  const rows = [];
  const expiredDocIds = [];
  for (const docId of index.docs) {
    // Raw read (dashboard summary; avoids the per-signer subrequest fan-out).
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
 * The length-mismatch early return leaks length only, fine here because
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

// Durable Object class, re-exported so the runtime can instantiate it.
export { AtomicCounter };
