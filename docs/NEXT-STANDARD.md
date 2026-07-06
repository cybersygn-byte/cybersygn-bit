# CyberSygn: the new-standard program (5 features)

Date: 2026-07-06. Owner: Nathan. The coordination contract for the five
industry-defining features. Everything mobile-first. No em-dashes. No
fabricated data. No legal overclaims (evidence, not a guarantee).

## Storage keys (CYBERSYGN_DOCS KV)

- `verify:<pdfSha256>` -> PII-FREE proof record, written on doc completion.
  Shape: { v:1, fingerprint, signerCount, createdAt, completedAt, status:'completed' }.
  NEVER any name, email, title, or content. TTL 1 year.
- `contacts:<senderId>` -> { contacts: [{ id, name, email, role, lastUsedAt, useCount }] }, cap 200, newest first.

## Endpoints (worker/src/index.js + new modules)

F4 verify:
- `GET /api/verify/:hash` PUBLIC, cache 300s. Returns { found:true, fingerprint, signerCount, completedAt, status } or { found:false }. Zero PII. `hash` is the 64-hex pdfSha256.
- Completion hook: in handleSubmitFills when the doc becomes complete, write `verify:<doc.pdfSha256>` (best-effort, never blocks completion).

F5 contacts (senderId capability auth, same posture as /api/sender/:id/docs):
- `POST /api/sender/:id/contacts` { name, email, role? } -> upsert by email, returns the list.
- `GET  /api/sender/:id/contacts` -> { contacts: [...] }.
- `DELETE /api/sender/:id/contacts` { contactId } -> removes.
- Create hook: handleCreateDoc auto-upserts each signer (name+email) into the sender's contacts (best-effort).

F3 AI summary:
- `POST /api/docs/:id/summary?t=<senderToken>` -> { ok, summary } plain-English summary of a COMPLETED doc, sender-token authenticated, ANTHROPIC-gated (graceful { ok:false, reason } when unset), IP + sender rate-limited, never 500, never leaks the key. Reuses the ai-draft.js/vision.js Anthropic pattern in a new worker/src/ai-summary.js. Summarizes the doc's own field values + title, not invented facts.

F1 virality + F2 embed: no NEW endpoints required (F1 = client post-sign screen + email CTA + /api/event attribution src=signer-viral; F2 = embed.js DX + docs + demo, uses existing /embed + /api/v1).

## Client surfaces (own CSS per feature to avoid style-file conflicts)

- F1: web/preview/app.js (signer-mode post-sign screen) + web/preview/index.html + web/preview/signer-share.css. After a signer completes, replace the sign panel with a celebration + one primary "Send your own document, free" button to ../?src=signer-viral (or ../preview/). Plus a completion-email CTA in worker email.js.
- F2: web/embed.js (DX polish) + web/developers/index.html (a copy-paste 5-line snippet + a live embed demo iframe). Mobile-first embed.
- F3: web/draft/app.js + web/draft/index.html (a "Prepare and send" action that renders the draft text to a PDF client-side via the vendored pdf-lib and hands off to /preview/ with it, then auto-detect + add signers + send) + a "Summarize" affordance on completed docs (dashboard or signer completion) calling POST /api/docs/:id/summary.
- F4: web/verify/index.html + web/verify/verify.css + web/verify/app.js (reads ?h=<hash> or a paste field, calls GET /api/verify/:hash, shows verified / not-found, links to how-it-works). scripts/build-web.js gains a /verify/ copy block + sitemap entry. The audit certificate (worker/src/audit.js) gains a "Verify at cybersygn.io/verify/?h=<hash>" line and a QR (dependency-free SVG QR, or the URL if a QR encoder is out of scope for v1).
- F5: web/dashboard/index.html + web/dashboard/app.js + web/dashboard/habit.css (a "by counterparty" grouping/filter of the docs list, and saved-contact quick-pick surfaced where relevant) + web/preview/app.js send flow suggesting saved contacts. Reusable flows: web/preview + worker templates.js gains optional default signers on a saved template.

## Mobile-first law (every surface)

Coarse-pointer tap targets >= 44px, inputs >= 16px (no iOS zoom), no
horizontal overflow at 320px, touch-friendly (no hover-only paths), safe-area
on fixed bars. Build the phone layout first, enhance up.

## Wave plan

Wave 1 (backend unblocks all): worker (verify + contacts + ai-summary + hooks) + F1 signer-viral client + F4 verify client.
Wave 2: F2 embed DX + F3 co-pilot + F5 habit layer.
Wave 3: integrate, adversarial review, mobile QA, gate, deploy.
Each wave: worker tests stay green, commit, deploy.
