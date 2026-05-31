# CyberSygn handoff

Snapshot of project state. If you (or a fresh AI session) come back to this repo, read this first.

## Production state

| Property | Value |
|---|---|
| Live URLs | https://cybersygn.io, https://www.cybersygn.io, https://cybersygn.nathanavogt.workers.dev |
| Repo | https://github.com/cybersygn-byte/cybersygn-bit |
| Branch | `main` |
| Current Cloudflare Worker version | bump on every `wrangler deploy`; check `/api/health` |
| Health endpoint | https://cybersygn.io/api/health (all subsystems should report `ok: true` except possibly Analytics Engine optional) |
| Owner workbench | https://cybersygn.io/control/ |
| Owner username | `nathan@cybersygn.io` |
| Owner password | (rotated via `node scripts/set-owner-password.mjs` — never write it here) |

## All five subsystems

- **KV** (Cloudflare): `CYBERSYGN_DOCS` and `CYBERSYGN_PDFS` bound, free tier
- **Resend** (email): `cybersygn.io` domain verified, DKIM + SPF live, sends from `hello@cybersygn.io`
- **Stripe** (payments): live mode, three prices wired
  - Solo `price_1Td0LlBearLmu5Er6Kw9iks7` $12/mo
  - Founding `price_1Td0LlBearLmu5ErXt6Oj11k` $9/mo (cap 100, locked-for-life)
  - Team `price_1Td0LlBearLmu5Erb5SbrjjH` $29/mo
  - Webhook `we_1Td0LmBearLmu5ErqBU2eI64` listens to 6 events at `/api/stripe/webhook`
- **Anthropic Claude Vision**: bound, used by `/api/detect-vision`, opt-in client flag `localStorage.cybersygn.visionEnabled = '1'`, ~$0.01/page, per-sender cap default 1000 pages/month
- **Cloudflare Analytics Engine**: `CYBERSYGN_EVENTS` dataset bound, write side live, SQL read side wired (Account ID `445c582eb90d6a32d606896b194ad35f`)

## Worker secrets currently set

```
ANTHROPIC_API_KEY          # Claude Vision
CF_ACCOUNT_ID              # Analytics SQL queries
CF_ANALYTICS_TOKEN         # Analytics SQL queries
CYBERSYGN_OWNER_HASH       # phrase-activation backdoor (slice 21)
OWNER_USERNAME             # /control/ login (slice 43)
OWNER_PASSWORD_SALT        # /control/ login
OWNER_PASSWORD_HASH        # /control/ login
RESEND_API_KEY             # transactional email
STRIPE_SECRET_KEY          # payment intents, customers
STRIPE_PRICE_SOLO          # checkout session product
STRIPE_PRICE_FOUNDING
STRIPE_PRICE_TEAM
STRIPE_WEBHOOK_SECRET      # verify event signatures
```

To list: `npx wrangler secret list`. To rotate any: `npx wrangler secret put <NAME>` then redeploy.

## Code layout

```
worker/src/
  index.js          ~2000 lines, all routes
  detect.js         heuristic field detection (37/37 real PDFs, 10/10 synthetic)
  vision.js         Claude Vision API client (Phase 2b)
  templates.js      labeled-data templates by PDF SHA-256
  free-tier.js      3-doc-lifetime gating + signup + drip records
  stripe.js         checkout session + webhook + sub records
  owner.js          phrase + username/password auth, token mint
  analytics.js      Analytics Engine writes + SQL summary
  dataset.js        owner-only labeled-corpus export
  owner-report.js   monthly stats email
  storage.js        KV abstraction with in-memory fallback
  email.js          Resend wrapper with console fallback
  audit.js          SHA-256, audit certificate PDF rendering

web/
  index.html             marketing home
  preview/               upload + detect + sign UI
  dashboard/             sender dashboard with owner-only analytics panel
  alternatives/          three SEO landing pages
  control/               hidden owner workbench (slice 43)
  privacy/ terms/ refund/  legal pages
  brand/                 logos, favicons, OG card
  polish.js              scroll-reveal driver (slice 36)
  telemetry.js           track + report sinks (slice 9)
  checkout.js            Stripe checkout button wiring
  styles.css             ~4500 lines, design system

scripts/
  build-web.js                builds dist/ from web/ + worker/src/detect.js
  vendor.js                   copies pdf.js, pdf-lib, mammoth, fonts, cmaps
  set-owner-password.mjs      interactive password setter (no echo)
  serve-web.js                local dev server
```

## Slices shipped (most recent first)

Use `git log --oneline` for the full list. Highlights:

- **43** `/control/` owner workbench with username+password login, robots-blocked
- **42** Monthly owner-report email, runs on the 1st of each UTC month
- **41** Phase 3 ML scaffolding (export endpoint + readiness threshold). NOT the full pipeline. Heuristic detection still in production.
- **40** Analytics Engine binding activated
- **39** Stripe checkout-URL verify (real charge is the user's hand only)
- **38** Free tier rework: 3 lifetime per email, signup gate, dataset counter
- **37** Cohesion pass: unified footer across pages, hover lifts on all card types
- **36** Visual polish pass: scroll reveals, gradients, button micro-interactions
- **35** Cinema-quality auto-playing demo on preview empty state
- **34** Template-state badge, page-fill render scale, auto-save nudge
- **32** Document templates keyed by SHA-256 (public + private scopes)
- **28** Phase 2a classical CV detection (disabled by default; tuning ongoing)
- **23** PDF render fix: cmaps + standard_fonts for CJK/macOS-authored PDFs
- **22** Restored missing layout CSS for /preview/ result view
- **21** Owner pill UX hardened
- **18** Interactive hero demo on the marketing homepage
- **14-17** /api/health deep check, real founding count, owner test-email, HTML emails
- **9-13** Cloudflare Analytics Engine, sidebar UX, legal pages, mobile sweep, owner analytics view
- **1-8** Stripe Checkout, SEO + AI crawlers, homepage conversion, render bugs

## Open items I know about

| Item | What's needed | Why deferred |
|---|---|---|
| Real card test of Stripe live | Charge yourself $9, then refund via Stripe API | Safety rule prevents me from charging cards on your behalf |
| Rotate `STRIPE_SECRET_KEY` | Stripe dashboard → API keys → Roll key → expire immediately, then `wrangler secret put STRIPE_SECRET_KEY`, then `wrangler deploy` | The key in chat history is still live; you decide when to rotate |
| Rotate `ANTHROPIC_API_KEY` | Anthropic console → API Keys → delete → create new → `wrangler secret put` | Same — key was in chat |
| Rotate `OWNER_PASSWORD_HASH` | `node scripts/set-owner-password.mjs` | `CyberFounder15` was in chat history |
| Native Roofing template publicly saved | Done (slice 43-era manual promotion) | docId `80cc1a28...` → 79 fields, public scope |
| Phase 3 ML model | Multi-month: collect 5K labeled examples, train custom CV model | Heuristic detection works at 100% on regression set, vision API is the bridge |
| Owner auto-bypass free-tier gate | Small refactor: paintFreeStatus should also check owner token | Owners can already use the product via /control/ or by activating owner mode |
| Analytics SQL scoped token | Generate a Cloudflare token with only Account Analytics:Read scope, swap `CF_ANALYTICS_TOKEN` | Current token uses wrangler OAuth with broader scope; works but defensively-loose |

## Common operations

**Deploy after a code change:**
```
cd ~/Downloads/Claude/cybersygn
~/.local/node/bin/npm run build
~/.local/node/bin/npx wrangler deploy
```

**Set or rotate any secret:**
```
~/.local/node/bin/npx wrangler secret put SECRET_NAME
# Paste value when prompted (hidden), press Enter
~/.local/node/bin/npx wrangler deploy
```

**Run all tests:**
```
~/.local/node/bin/npm test                  # synthetic detection (10/10)
~/.local/node/bin/npm run test:real         # real PDFs (37/37)
~/.local/node/bin/npm run test:worker       # E2E worker (141/141)
~/.local/node/bin/npm run test:stripe       # Stripe (34/34)
```

**Check production health:**
```
curl https://cybersygn.io/api/health | python3 -m json.tool
```

**Trigger the monthly owner report on demand:**
1. Sign into /control/
2. Open browser devtools console
3. `localStorage.getItem('cybersygn.owner.token')` — copy that value
4. `curl https://cybersygn.io/api/owner/report/preview?send=true -H "X-CyberSygn-Owner: <token>"`

**View live Analytics Engine data:**
- /control/ → Live analytics tile, or
- `/api/analytics/summary?window=INTERVAL%20%277%27%20DAY` with owner header

**Export labeled-data corpus for ML work:**
```
curl -H "X-CyberSygn-Owner: <token>" https://cybersygn.io/api/owner/dataset/export > corpus.jsonl
```

## Brand voice / constitution

Read [CONSTITUTION.md](./CONSTITUTION.md) for the immutable rules. Highlights:

- Sentence case. Headlines end with periods. Oxford comma. No em-dashes.
- Forbidden words listed in Section 1.10.
- "Field" not "form element." "Document" not "envelope."
- Modern, not trendy. No glassmorphism. No neon.
- Truth before completion: claim only what's verified by execution.
- Push back when scope is wrong; don't comply by default.

## How to continue this conversation in a fresh session

If you start a new Claude Code session, paste this single line into the first message:

> Read `/Users/nathanvogt/Downloads/Claude/cybersygn/HANDOFF.md` to load project state, then continue from there.

The AI will read this file and have everything it needs.
