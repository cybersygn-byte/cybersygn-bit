# CyberSygn launch checklist (owner-side, by end of day)

Everything I can build is built, committed, and deployed. This is the list of
things only you can do (Stripe dashboard, secrets, verification, announce).
Ordered by priority. Times are rough. Commands assume you run them from the
repo root; secrets are set with `npx wrangler secret put <NAME>` then a
`npx wrangler deploy`.

## Current status (already done, no action needed)

Confirmed set in production (via `npx wrangler secret list`):
- Payments core: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
- Existing plans priced + live: SOLO, SOLO_ANNUAL, FOUNDING, FOUNDING_ANNUAL,
  TEAM, TEAM_ANNUAL, LIFETIME
- Email: RESEND_API_KEY (invites, magic link, drip all send)
- AI co-pilot: ANTHROPIC_API_KEY (draft + summary + vision detection work)
- Owner console /control/: OWNER_USERNAME, OWNER_PASSWORD_HASH/SALT, OWNER_EMAIL
- Domain: cybersygn.io + www + control.cybersygn.io routed and serving
- KV, assets, analytics token: bound

So the site already works end to end for Free, Solo, Studio, Origin, and
Lifetime. The launch gap is only the NEW pricing tiers and a few polish items.

---

## 1. BLOCKER: create the 6 new Stripe prices (about 20 min)

The new Pro / Business tiers and the two add-ons are live on the site but show
"opening soon" and route to free, because their Stripe prices do not exist yet.
`GET /api/billing/config` currently returns pro/business/seat/whitelabel = false.
The moment you create these and set the env vars, the buttons become real
checkout automatically. Nothing else changes.

In the Stripe Dashboard (Products, Live mode), create these products + prices.
Use recurring prices; monthly interval for the *_MONTHLY, yearly for *_ANNUAL.

| Product          | Price            | Interval | Set env var (its price_... id) |
|------------------|------------------|----------|--------------------------------|
| CyberSygn Pro    | $19.00           | monthly  | STRIPE_PRICE_PRO               |
| CyberSygn Pro    | $180.00          | yearly   | STRIPE_PRICE_PRO_ANNUAL        |
| CyberSygn Business | $79.00         | monthly  | STRIPE_PRICE_BUSINESS          |
| CyberSygn Business | $780.00        | yearly   | STRIPE_PRICE_BUSINESS_ANNUAL   |
| CyberSygn seat   | $9.00            | monthly  | STRIPE_PRICE_SEAT              |
| CyberSygn white-label | $19.00      | monthly  | STRIPE_PRICE_WHITELABEL        |

Notes:
- Pro and Business each get TWO prices (one product, a monthly and a yearly).
- The seat price is charged per unit; checkout already sends quantity, so a
  single per-seat price is all you need.
- Copy each price id (starts with `price_`) into the matching secret:

```
npx wrangler secret put STRIPE_PRICE_PRO            # paste the $19/mo price id
npx wrangler secret put STRIPE_PRICE_PRO_ANNUAL     # paste the $180/yr price id
npx wrangler secret put STRIPE_PRICE_BUSINESS       # paste the $79/mo price id
npx wrangler secret put STRIPE_PRICE_BUSINESS_ANNUAL# paste the $780/yr price id
npx wrangler secret put STRIPE_PRICE_SEAT           # paste the $9/mo price id
npx wrangler secret put STRIPE_PRICE_WHITELABEL     # paste the $19/mo price id
npx wrangler deploy
```

Verify (should now show all true):
```
curl -s https://cybersygn.io/api/billing/config
```
Then load cybersygn.io/#pricing: Pro and Business should show real "Start Pro" /
"Scale on Business" buttons (not "opening soon"), and the dashboard add-ons and
post-purchase white-label upsell go live.

## 2. Verify payments end to end (about 10 min)

1. Stripe Dashboard, Developers, Webhooks: confirm there is a live endpoint
   pointing at `https://cybersygn.io/api/stripe/webhook`, subscribed to at
   least `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Its signing secret must equal the
   STRIPE_WEBHOOK_SECRET already set. If you rotate it, re-put the secret.
2. Do one real (or Stripe test-mode) checkout on Pro. Confirm: you land on the
   dashboard, the plan shows "Pro", and (if you bought monthly) the one-click
   "make it fully yours" white-label upsell appears once.
3. Buy one extra seat from the dashboard add-ons and confirm your plan label
   stays "Pro" (add-ons must never overwrite the base plan; this is enforced
   and tested, step 2 just double-checks it live).

## 3. Trust and social proof (about 15 min, recommended)

The trust surfaces are honest-empty by design (no fake testimonials). Before
launch, either populate them with a real quote or leave them hidden.
- If you have ANY real user quote (even a friendly beta tester), add it. Ask me
  and I will wire it into the social-proof strip and comparison pages.
- The homepage "Origin 100" and Lifetime counters are real and live; nothing to
  do there.
- Optional: add a QR code to the signed-PDF audit certificate pointing at
  /verify (deferred; needs a QR encoder, ~30 min of my time if you want it).

## 4. Analytics and monitoring (about 10 min, optional but wanted)

Only add what you actually want to track.
- Google Analytics 4: create a GA4 property, then set the var. It is read as
  CYBERSYGN_GA4_ID (a var, not a secret). Add it under `vars` in wrangler.jsonc
  or `npx wrangler secret put CYBERSYGN_GA4_ID`, then deploy.
- Google Search Console: verify cybersygn.io (DNS TXT or the meta token
  CYBERSYGN_GSC_TOKEN), then submit the sitemap at
  https://cybersygn.io/sitemap.xml.
- Error monitoring (optional): create a Sentry project, `npx wrangler secret
  put SENTRY_DSN`, deploy. Without it, error tracking no-ops safely.

## 5. Email deliverability sanity check (about 5 min)

RESEND_API_KEY is set and mail sends, but confirm the domain is authenticated so
mail lands in inboxes, not spam:
- In Resend, confirm cybersygn.io is a verified domain with SPF, DKIM, and a
  DMARC record published in Cloudflare DNS.
- Send yourself a test: sign up for the free tier with your own email and
  confirm the day-1 drip and a signer invite arrive and look right on mobile.

## 6. Final pre-launch smoke (about 15 min) do these on your phone

1. Open cybersygn.io on your phone. Confirm the "Install CyberSygn" prompt
   appears; install it; confirm it opens standalone to your workspace.
2. Send yourself a real document end to end: upload a PDF, place a signer,
   send, open the signer link, sign, download the signed PDF + audit cert.
3. Tap "email me a sign-in link", confirm it arrives and logs you in on a
   second device.
4. Load 3 or 4 blog posts, a comparison page, and the pricing section; confirm
   nothing looks broken and there are no stray em-dashes (there should be none).
5. Download one contract template PDF and eyeball it.

## 7. Launch and announce (when 1 to 6 are green)

- Product Hunt / Indie Hackers / HN launch drafts already exist in the repo
  (from the launch run-up work). Review and post.
- Share the app-first, installable angle and the AI co-pilot; those are the
  differentiators.
- Watch the Stripe dashboard and /control/ for the first signups.

---

## Appendix: how to set or rotate any secret

```
npx wrangler secret list                 # see what is set (names only)
npx wrangler secret put <NAME>           # set or rotate, paste value when prompted
node scripts/set-owner-password.mjs      # change the /control/ password
npx wrangler deploy                      # apply
```

## Appendix: what is intentionally NOT blocking launch

- Vyan fleet metrics (VYAN_METRICS_KEY): only needed if you want Vyan Control to
  read this product's metrics. Standalone launch does not need it.
- KV backup namespace (CYBERSYGN_BACKUPS): nightly backup is optional.
- The templates "download all" zip: the button was removed earlier; the zip is
  unlinked and not customer-facing.
