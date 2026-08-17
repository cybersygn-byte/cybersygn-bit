# CyberSygn handoff

The operating document for the next 90 days. If you (or a fresh AI session) come back to this repo, read this first. Every claim in this file was verified against the repo, production, or KV on 2026-08-17. Do not add claims you have not verified the same way.

Ground truth as of 2026-08-17: zero paying customers, about 2 free signups. The product is built. The next 90 days are about evidence, not features.

## The kill criteria (decision date: 2026-11-15)

These are the commitments. On 2026-11-15 we measure, we do not renegotiate the bar.

1. 10 or more documents sent by humans who are not Nathan.
2. 3 or more paying non-founder customers.
3. 5 of 10 watched sessions reaching a signed document unaided.
4. 14 of 20 interviewees recognizing the document pain unprompted.

The four branches:

- **All four pass**: commit to the vertical fork decision made at day 60. No more hedging, build for that vertical.
- **Sends pass but no payers**: pricing or model problem, not a product problem. Test per-document pricing before touching anything else.
- **Watched sessions fail**: product problem. Another activation pass before any marketing spend or outreach. Marketing a product people cannot finish is burning the list.
- **Interviews fail**: wedge problem. The pain is elsewhere. Re-interview a different trade before building anything.

## The owner punch list

One action per line, exact commands. These are the only things blocked on Nathan. All secret names below are the exact names the worker reads (verified in worker/src on 2026-08-17). Run each from the repo root: `cd ~/Projects/Claude/cybersygn`.

1. Create a GA4 property at analytics.google.com, then:
   `npx wrangler secret put CYBERSYGN_GA4_ID` (value like `G-XXXXXXXXXX`; read by worker/src/analytics-inject.js, not set as of 2026-08-17)
2. Verify Search Console ownership via DNS TXT record on cybersygn.io, then:
   `npx wrangler secret put CYBERSYGN_GSC_TOKEN` (the meta-tag content value GSC issues; not set as of 2026-08-17)
3. Create a Sentry project, then:
   `npx wrangler secret put SENTRY_DSN` (read by worker/src/sentry.js; optional, errors are dropped silently until set; not set as of 2026-08-17)
4. Set the physical mailing address for CAN-SPAM email footers:
   `npx wrangler secret put CYBERSYGN_BUSINESS_ADDRESS` (read by worker/src/email-html.js; footers omit the address line until set; not set as of 2026-08-17)
5. AI drafting: NO action needed. The /draft/ page and POST /api/draft/generate run on `ANTHROPIC_API_KEY` (worker/src/ai-draft.js), which IS set in production. There is no OPENAI_API_KEY anywhere in this repo. If the key were ever missing the endpoint degrades to a graceful `{ok:false, reason:'unconfigured'}` 200, not a 500, but the homepage drafting claim would then be false, so keep the key live.
6. Create a Cloudflare API token scoped to Account Analytics Read only, then:
   `npx wrangler secret put CF_ANALYTICS_TOKEN` (replaces the broad-scoped token currently set). This unlocks clean reads of the traffic already collected in the `CYBERSYGN_EVENTS` Analytics Engine dataset, live since slice 40, which is 74+ days of real visitor data nobody has looked at yet.

After any secret change: `npx wrangler deploy`.

## The Nathan sequence

In order. Do not skip ahead. Each step gates the next.

1. **Today**: send one real document to one real counterparty and do not stop until a certificate exists at /verify/. Not a test to yourself. A real agreement with a real other person.
2. Watch ten strangers try the product. Do not help. Do not explain. Write down where each one stalls. This produces the "watched sessions" number for the kill criteria.
3. Twenty interviews with people who sign contracts for a living. One trade. One identical question every time. This produces the "interviews" number.
4. Once the funnel holds (steps 1 to 3 done and acted on): five substantive answers a day in eight rooms. Answers that help, with no link unless asked.
5. The fleet dogfood rule, permanent: every Vyan-fleet agreement goes through cybersygn.io. No exceptions. If it is not good enough for our own paperwork it is not good enough to sell.

## What is deliberately paused

Future sessions: do not resurrect these. They are paused on purpose until the kill criteria are measured.

| Paused item | Current state | Why paused |
|---|---|---|
| Blog post 157+ | 156 posts live | More content does not answer any kill criterion |
| New templates beyond 502 | 502 authored, QC'd, rendered | Same: volume is not the constraint, proof is |
| Ambassador recruitment | System live and finished, dashboard + emails + payout terms | Recruiting waits until the product has proof; ambassadors amplify evidence, they do not create it |
| Self-serve API keys | Metered model designed (docs), Vyan partner key works | No external developer has asked; build on pull, not push |
| i18n scaffold | Deleted 2026-08-17 (web/i18n/ removed, route 404'd in production, nothing referenced it) | English-only until there is a paying English-speaking customer |

## Production state

| Property | Value |
|---|---|
| Live URLs | https://cybersygn.io, https://www.cybersygn.io, https://cybersygn.nathanavogt.workers.dev |
| Repo | ~/Projects/Claude/cybersygn (moved from ~/Downloads/Claude; GitHub: cybersygn-byte/cybersygn-bit, branch `main`) |
| Health endpoint | https://cybersygn.io/api/health (returned `ok: true` on 2026-08-17) |
| Owner workbench | https://cybersygn.io/control/ |
| Owner username | `nathan@cybersygn.io` |
| Owner password | rotated via `node scripts/set-owner-password.mjs`, never written here |

Subsystems: Cloudflare KV (`CYBERSYGN_DOCS`, `CYBERSYGN_PDFS`), Resend (DKIM + SPF verified, sends from hello@cybersygn.io), Stripe live mode (price book in docs/PRICING-MASTERCLASS.md; price IDs live in the STRIPE_PRICE_* secrets, not here), Anthropic Claude (vision detection + drafting + summaries), Cloudflare Analytics Engine (`CYBERSYGN_EVENTS` dataset, writes live).

## Worker secrets currently set (verified `npx wrangler secret list`, 2026-08-17)

```
ANTHROPIC_API_KEY              CF_ACCOUNT_ID              CF_ANALYTICS_TOKEN
CYBERSYGN_OWNER_HASH           OWNER_EMAIL                OWNER_PASSWORD_HASH
OWNER_PASSWORD_SALT            OWNER_USERNAME             RESEND_API_KEY
STRIPE_SECRET_KEY              STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_SOLO              STRIPE_PRICE_SOLO_ANNUAL
STRIPE_PRICE_PRO               STRIPE_PRICE_PRO_ANNUAL
STRIPE_PRICE_BUSINESS          STRIPE_PRICE_BUSINESS_ANNUAL
STRIPE_PRICE_TEAM              STRIPE_PRICE_TEAM_ANNUAL
STRIPE_PRICE_FOUNDING          STRIPE_PRICE_FOUNDING_ANNUAL
STRIPE_PRICE_LIFETIME          STRIPE_PRICE_SEAT          STRIPE_PRICE_WHITELABEL
```

NOT set (see punch list): `CYBERSYGN_GA4_ID`, `CYBERSYGN_GSC_TOKEN`, `SENTRY_DSN`, `CYBERSYGN_BUSINESS_ADDRESS`.

To list: `npx wrangler secret list`. To rotate: `npx wrangler secret put <NAME>` then `npx wrangler deploy`.

## Code layout

```
worker/src/
  index.js          all routes (do not hand-edit during parallel agent runs; the orchestrator owns it)
  detect.js         heuristic field detection
  vision.js         Claude Vision client
  ai-draft.js       contract drafting (ANTHROPIC_API_KEY)
  ai-summary.js     plain-language document summaries
  templates.js      labeled-data templates by PDF SHA-256
  free-tier.js      free gating + signup + drip records
  stripe.js         checkout + webhook + subscription records
  owner.js          owner auth, token mint
  analytics.js      Analytics Engine writes + SQL reads
  analytics-inject.js  GA4 + GSC tag injection (inert until secrets set)
  sentry.js         error forwarding (inert until SENTRY_DSN set)
  email.js / email-html.js  Resend wrapper + CAN-SPAM footer
  audit.js          SHA-256, audit certificate PDF

web/
  index.html        marketing home (5 inline scripts; their sha256 hashes live in web/_headers, recompute on ANY edit or the page breaks silently)
  sw.js             service worker (precaches /offline, the canonical form; bump CACHE_VERSION on any shell change)
  offline.html      source of the offline page, served at /offline (the .html form 307s)
  preview/ dashboard/ control/ draft/ verify/ blog/ templates/  app surfaces
  styles.css        design system

scripts/            plain node test + build scripts (assert pattern, see scripts/test-payout.mjs)
```

## Common operations

```
cd ~/Projects/Claude/cybersygn
npm run build              # builds web/dist
npx wrangler deploy        # ships worker + assets
npm test                   # synthetic detection
npm run test:real          # real PDF corpus
npm run test:worker        # E2E worker
npm run test:stripe        # Stripe flows
curl https://cybersygn.io/api/health | python3 -m json.tool
```

Full slice history: `git log --oneline`. Program docs: docs/LAUNCH-PROGRAM.md, docs/PRICING-MASTERCLASS.md, docs/CRISP-DIRECTIVE.md, docs/NEXT-STANDARD.md.

## Brand voice / constitution

Read CONSTITUTION.md for the immutable rules. Highlights: sentence case, headlines end with periods, no em-dashes anywhere, "field" not "form element", "document" not "envelope", truth before completion (claim only what execution verified), push back when scope is wrong.

## Honesty rails (bind every future session)

- Zero paying customers and about 2 free signups as of 2026-08-17. Never imply otherwise anywhere on the site or in email.
- Never fabricate a count, testimonial, or capability. If a number is shown publicly it must come from a real query at render time or be removed.
- CSP is hash-based with no unsafe-inline for scripts. Most JS is external, but SEVERAL pages carry hashed inline scripts: web/index.html has 5, web/templates/index.html has 1, and web/_headers holds 23 script hashes in total. Editing ANY inline script means recomputing its sha256 (base64 of the digest of the exact bytes between the script tags) and updating web/_headers, or that page silently breaks under CSP.

## How to continue in a fresh session

Paste this into the first message of a new session:

> Read `~/Projects/Claude/cybersygn/HANDOFF.md` to load project state, then continue from there.
