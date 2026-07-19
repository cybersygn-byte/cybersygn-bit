# CyberSygn Runbook

Operational runbook for the CyberSygn e-signature Worker + static site. Solo
operator. Everything here is grounded in the live code; file paths are relative
to the repo root. No em dashes, honest steps only.

Production: `https://cybersygn.io` (static `web/dist` served by Cloudflare
Assets, API in `worker/src/`). Deploy: `npm run deploy`. KV binding:
`CYBERSYGN_DOCS`.

---

## 1. Severity tiers

| Tier | Definition | Response time | Examples |
| --- | --- | --- | --- |
| **SEV1** | Signing broken, data loss, secret exposed, or customer PII leaking | Now, drop everything | `/api/docs/*` 5xx, a leaked key, signed-PDF audit trail missing |
| **SEV2** | A revenue or trust surface degraded but signing works | Same day | Stripe webhook failing, AI drafting erroring for everyone, email not delivering |
| **SEV3** | Cosmetic or single-surface, no money/trust impact | Next working session | One template renders wrong, a marketing page typo |

When unsure, treat it one tier hotter.

---

## 2. Pause / disable switches (fastest lever first)

All of these are **reversible** and take effect on the next request. None
mutate customer data.

### Disable AI drafting + summaries (co-pilot)
The AI surfaces are gated on the secret. Remove it and both endpoints return a
graceful `200 { ok:false, reason:'unconfigured' }` (never a 500), the UI shows
the early-access state, and no spend occurs.
```
npx wrangler secret delete ANTHROPIC_API_KEY
```
Re-enable: `npx wrangler secret put ANTHROPIC_API_KEY`. Reference:
`worker/src/ai-draft.js` and `worker/src/ai-summary.js` unconfigured guards.

### Stop all outbound email
Remove the Resend key. `deliver()` falls back to a console-only mode (logs a
masked recipient + body length, never the address or content) and reports
`{ delivered:true, mode:'console' }`, so flows do not hard-fail.
```
npx wrangler secret delete RESEND_API_KEY
```
Reference: `worker/src/email.js` `deliver()`.

### Throttle a runaway / abused endpoint
Rate limits are per-IP (and per-doc for summaries) in `worker/src/index.js`
handlers, backed by `checkRateLimit` (`worker/src/rate-limit.js`). To clamp
harder, lower the `max` in the relevant handler and redeploy. Current caps:
draft 5/hr + 20/day; summary 20/hr + 100/day and per-doc 3/min + 10/hr.

### Full stop
Roll back to the last-good deploy (see section 4) or, in extremis,
`npx wrangler rollback` to the previous Worker version.

---

## 3. Incident playbook by symptom

- **AI drafting/summary erroring for everyone**: check `npx wrangler tail` for
  `[ai-draft] provider status` / `[ai-summary] provider status`. A 401 means the
  key is bad or rotated: `npx wrangler secret put ANTHROPIC_API_KEY`. A timeout
  storm means the provider is slow; the 30s/20s per-call timeouts already
  fail-soft. If it persists, disable AI (section 2) so users get the graceful
  early-access state instead of errors.
- **Email not arriving**: tail for `[cybersygn:email:dev]` (means the key is
  unset, running console mode) or a non-2xx from Resend. Rotate/set
  `RESEND_API_KEY`. Never paste the key into logs or chat.
- **Secret exposed**: rotate it immediately in the provider dashboard, then
  `npx wrangler secret put <NAME>`. Assume the old value is burned. Logs never
  contain secrets or PII by policy (see section 6); if one slipped in, purge it.
- **Prompt-injection / bad AI output reported**: the defense is layered
  (fencing + system clause + `sanitizeDraft`/`sanitizeSummary` backstop). Add
  the failing input as a case in `docs/evals/cases/adversarial.jsonl`, run
  `npm run eval:check` (offline), and if the model itself is the gap, run the
  live set `npm run eval:run` with a key before changing a prompt.

---

## 4. Release checklist (strict)

Never deploy on a red gate. `npm run deploy` already chains lint + build +
worker test + `wrangler deploy`; do not bypass it.

1. `npm run lint` is green. This runs `smoke` (95 JS files parse), `lint:css`,
   and `eval:check` (AI case files parse + 12 guardrail assertions, offline, no
   spend).
2. `npm run build` completes (blog/use-case/comparison/best-for/templates caches
   + `build-web`).
3. `npm run test:worker` passes.
4. If a precached service-worker shell file (`web/sw.js` cached asset list)
   changed, bump `CACHE_VERSION` in `web/sw.js`.
5. If any inline `<script>` was added, its sha256 is in **both** `web/_headers`
   and `web/dist/_headers` (CSP is hash-locked).
6. Deploy: `npm run deploy`.
7. Re-verify live with curl: `curl -sI https://cybersygn.io/` (200 + security
   headers), `curl -s https://cybersygn.io/status/` , and the surface you
   changed. Confirm `/.git/HEAD` is 404.

Rollback: `npx wrangler rollback` (previous Worker version) or
`git revert <sha> && npm run deploy`.

---

## 5. Owner-only action list (things code cannot do for you)

- Rotate `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, and Stripe secrets in their
  dashboards, then `npx wrangler secret put <NAME>`.
- Set the Resend sending domain / verify DNS if email deliverability drops.
- Approve any prompt change by running the live eval set (`npm run eval:run`)
  before deploy.

---

## 6. Data + privacy invariants (do not regress)

- Logs never contain a customer email address, body text, magic link, one-time
  code, client IP, or a raw signup record. Recipients are masked, bodies are
  reduced to a length, rate-limit logs show the limiter family not the key.
  Grep before every deploy: `grep -rn "console\." worker/src` should surface no
  raw PII interpolation.
- PII-bearing KV records carry an `expirationTtl` (free-tier user + drip records,
  sender-email binding, rate-limit buckets, sessions). Retention roll-off is 30
  days after a deletion request, backups 90 days (matches `web/privacy/`).
- The GDPR export/delete path is `POST /api/sender/:id/gdpr-export/request`
  then `.../confirm` with the emailed code.

---

## 7. Rebuild / divestiture path

The product is intentionally portable off any single dependency:

- **Runtime**: one Cloudflare Worker (`worker/src/`) + static assets (`web/`).
  No server to migrate. To move hosts, the Worker is standard fetch-handler JS;
  the static site is plain HTML/CSS/JS with a build step (`scripts/build-web.js`).
- **State**: all in KV under documented prefixes (`doc:`, `sub:`, `signup:`,
  `sender-email:`, `ratelimit:`, dataset counters). `worker/src/kv-backup.js`
  exports it. A rebuild imports the same prefixes.
- **AI**: two self-contained modules with a pinned model string and a written
  prompt inventory (`docs/evals/PROMPTS.md`) + eval set. Swapping providers is a
  localized change to `ai-draft.js` / `ai-summary.js`; the eval set validates the
  replacement.
- **Payments**: Stripe via `worker/src/stripe.js` + webhooks; replaceable behind
  the same endpoints.
- **Gate of record**: `npm run lint && npm run build && npm run test:worker`
  proves a rebuilt copy is faithful before it goes live.
