# CyberSygn as a standalone, installable app (STANDALONE-APP)

Goal (Nathan, 2026-07-06): cybersygn.io must BE a fully usable version of the
software, not a brochure that redirects you into a tool. It must be standalone
yet part of the Vyan fleet, mobile-first, installable as an app, and so simple
a layman never feels lost. No em-dashes. Honest. SEO of the marketing homepage
preserved.

## Decisions (locked by Nathan)

1. Front door = APP-FIRST, marketing kept underneath. The root `/` recognizes
   you and puts the working app in place; marketing stays reachable and keeps
   its SEO. New visitors get a one-tap start, not a redirect.
2. Sign-in = BOTH a copy/paste sign-in key AND an email magic link. No
   passwords.

## The identity model (unify email + free-tier + login)

Today a sender is a random `cybersygn.senderId` capability in localStorage.
Free signup already requires an email. We make that one email do three jobs:
your free allowance, your identity, and your cross-device login. Nothing new
is asked of the user; the email step that already existed now also makes the
account portable.

- KEEP: `senderId` capability, `cybersygn.docTokens`, workspaces, free token.
- ADD reverse index `login:email:<emailHash>` -> `{ senderId, boundAt }` so an
  email can recover its senderId. Written at free signup (client now sends its
  senderId) and on first magic-link verify. First bind wins; re-signup keeps
  the original senderId.
- ADD `cybersygn.email` (display only) + `cybersygn.hasUsed` flag so the root
  can tell a returning user from a first-timer without a network call.

### Sign-in key (private path)
The sign-in key IS the senderId (raw value, unchanged so existing users keep
working). The Account screen presents it as "your sign-in key": Copy, and
"Use a key" pastes one on another device -> `setSenderId` -> boot into
workspace. Validation: 24-64 hex chars.

### Email magic link (layman path): worker/src/auth.js
- `POST /api/auth/request-link { email }`
  - hash email (free-tier hashEmail), look up `login:email:<emailHash>`.
  - Always respond `{ ok:true }` (anti-enumeration). Rate-limited by IP+email.
  - If bound: mint single-use token `login:token:<token>` -> { senderId,
    emailHash, exp } TTL 15m; email `https://cybersygn.io/?signin=<token>` via
    Resend (email.js deliver()). If not bound: send a gentle "no account yet,
    start free" email (or no-op); never reveal which.
- `POST /api/auth/verify { token }`
  - validate token (exists, not expired), DELETE on use (single-use), return
    `{ senderId }`. Rate-limited. Never logs token or senderId.
- Client boot on `/?signin=<token>`: POST verify -> setSenderId(senderId) ->
  set hasUsed -> strip query -> boot into workspace. Bind is idempotent.

Security: tokens are 256-bit random hex, single-use, short TTL, enumeration-
safe responses, rate-limited, no secret in logs, reuse jsonResponse security
headers. Losing an email does not create a new capability; it only recovers
the existing senderId (same trust model as "hold the senderId = you").

## PWA (the "app interface")

- `web/manifest.webmanifest`: name CyberSygn, display standalone, start_url
  `/?app=1`, scope `/`, theme/background from brand, icons 192 + 512 +
  maskable (from brand mark).
- `web/sw.js`: versioned cache. Cache-first for the static app shell
  (shell CSS/JS, offline page); NETWORK-ONLY for `/api/*` and anything with a
  query token (never cache auth/API/PDF bytes). Clean old caches on activate.
- Registration + `beforeinstallprompt` capture in app-shell.js -> "Install
  app" button in Account. iOS Safari (no bip event) -> "Add to Home Screen"
  hint. Meta: apple-mobile-web-app-capable, status-bar-style, mobile-web-app-
  capable, application-name, manifest link on every app surface.
- `?app=1` (standalone launch) => boot straight into the app view, skip
  marketing.

## Shared app shell (one app, never lost): web/shared/app-shell.{css,js}

Persistent bottom tab bar on touch / compact top bar on desktop. Tabs:
- Home  -> `/`            (workspace when known, marketing when new)
- New   -> `/preview/`    (start a document)
- Docs  -> `/dashboard/`  (your documents)
- Account -> opens a sheet (email, install app, sign-in key copy/paste,
  free/paid status, sign out)

Contract:
- Auto-mounts when `document.body` has `data-app-shell` (and NOT in signer
  mode or embed mode). Adds `.has-app-shell` to body for safe-area padding.
- Big tap targets (>=56px), `env(safe-area-inset-bottom)`, active tab by path.
- Zero dependencies, no framework, matches Crisp design tokens in styles.css.
- Must NOT appear on the signer view (`?doc=`/signing), embed iframes, or
  `/control/`.

## Root app-first: web/index.html (additive) + web/app-home.js

- SEO DOM of index.html is left intact (crawlers + first-timers see marketing).
- Add manifest + apple meta + app-shell + app-home.js.
- Boot (app-home.js), no server redirect, no cross-page redirect:
  - if `?signin=` -> verify -> proceed as known.
  - known (hasUsed or standalone `?app=1` or signed in) -> render App Home
    OVERLAY in place: greeting, big "New document", recent documents (reuse
    fetchSenderDocs), quick links; hide marketing sections via a body flag.
  - new visitor -> marketing as-is, but a always-visible app entry ("Open app"
    / hero "Start now, it is free") and the bottom shell.

## File ownership (avoid collisions)

- worker/src/auth.js (new), worker/src/index.js (routes only), worker/src/
  free-tier.js (bind senderId at signup). foundation, hand-built.
- web/manifest.webmanifest, web/sw.js, web/brand/icon-*.png (new). PWA.
- web/shared/app-shell.css, web/shared/app-shell.js (new). shell.
- web/index.html (additive head + mount), web/app-home.js (new). root.
- web/preview/index.html, web/dashboard/index.html, web/draft/index.html,
  web/verify/index.html. one owner each (shell mount + meta only).
- scripts/build-web.js. copy new static files into dist.
- scripts/test-worker.js (or worker test file). auth tests.

## Guardrails

- test:worker stays green (260 baseline). node --check every touched JS.
- No em-dashes anywhere. Honest copy, no legal overclaims, no fake data.
- Ecosystem intact: /api/metrics + partner keys + /control unchanged.
- Mobile-first: everything usable one-thumb at 375px; inputs 16px (no zoom).
- Reversible: marketing DOM untouched; the app layer is additive and can be
  removed by deleting the mounts.

## Waves

0. Contract (this doc). 1. Auth backend + tests. 2. PWA. 3. Shell.
4. Root app-first. 5. Unify surfaces + mobile + Account. 6. Review + build +
deploy + live-verify + memory.
