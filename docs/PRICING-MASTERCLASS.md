# CyberSygn pricing masterclass (canonical price book + psychology)

Goal (Nathan, 2026-07-08): rework all pricing, add-ons, and every funnel into a
masterclass of honest human conversion psychology. Tactful blend of "premium
anchored ladder" + "keep current prices": NO existing price moves (trust +
zero customer friction), and we ADD a hero tier and a high anchor so the ladder
finally has a center of gravity. Honest. No em-dashes. No fake scarcity.

## Canonical price book (single source of truth)

Every surface must match these exactly. Monthly / annual-per-month (billed
yearly) / annual total. Annual = 2 months free (~17% off), shown by default.

| Tier      | Monthly | Annual/mo | Annual total | Seats | One-liner |
|-----------|---------|-----------|--------------|-------|-----------|
| Free/Demo | $0      | -         | -            | 1     | 3 documents lifetime, no card |
| Solo      | $12     | $10       | $120         | 1     | Unlimited signing, the essentials |
| Pro  HERO | $19     | $15       | $180         | 1     | Solo + the AI co-pilot + priority |
| Studio    | $29     | $23       | $276         | 3     | Team workspace, webhooks, bulk |
| Business  | $79     | $65       | $780         | 10    | White-label + SSO + API (the anchor) |

Founder/one-time (kept exactly as-is, real honest scarcity):
- Origin: $9/mo locked for life, first 100 (live counter). Solo-level features.
- Lifetime: $299 one-time, first 50 (live counter).

Add-ons (a la carte, lift AOV):
- Extra seat: $9 / seat / month (Studio and up; already advertised, now real).
- White-label: $19 / month. Removes the CyberSygn footer + adds custom domain
  on signing pages/emails, for Solo/Pro/Studio (included in Business).

### What separates the tiers (the value ladder)
- Free -> Solo: unlimited vs 3 docs.
- Solo -> Pro: the AI co-pilot (draft a contract from a prompt + AI summaries),
  priority send, bulk send, priority support. Same 1 user. This is the easy
  +$7 upsell for anyone who sends contracts weekly.
- Pro -> Studio: 3 seats + shared workspace + webhooks (the team jump).
- Studio -> Business: 10 seats + white-label + SSO + API + custom domain +
  priority support. The anchor that makes Pro/Studio feel like a bargain.

## The psychology playbook (apply on every surface)

1. Anchor high. Business $79 is shown in the ladder so $19 Pro reads as the
   smart-money pick (center-stage + compromise effect). Never hide the anchor.
2. One hero. Pro is the only "Most popular" card, visually lifted, center of
   the paid ladder. Exactly one badge.
3. Charm + clean numbers. Keep the established 12/29/9/299; new tiers 19/79.
4. Annual by default. Toggle defaults to annual; monthly price shown struck
   through, annual per-month big, and the dollars saved named ("$48 / year").
5. Value stacking. Each card lists concrete outcomes, hero stacks the most.
   Where useful, show a "$X value" vs price to widen the gap.
6. Risk reversal. "Start free, no card. Cancel in one click." (No refunds per
   policy; the free trial IS the reversal. Never promise a refund.)
7. Honest urgency/scarcity. Origin (100) + Lifetime (50) use the LIVE counters
   only. Never invent counts, deadlines, or "only N left" that is not real.
8. Social proof at the decision point. Real live totals near pricing; no fake
   testimonials or logos.
9. Loss aversion at the wall. The free-cap paywall reminds them of the value
   they just felt ("you sent 3, each in ~2 minutes") then offers the single
   best next step (Pro annual), not a wall of choices.
10. Reduce choice friction. Lead with one recommended action; secondary
    options are quieter. Order-bump and 1-click upsell, never surprise charges.

## Add-ons, order-bump, 1-click upsell (Nathan-selected)

- Extra seats: dashboard "add seats" for Studio+ -> checkout with quantity.
- White-label add-on: dashboard toggle -> checkout add-on subscription.
- Checkout order-bump: on the pricing card, an "annual saves 2 months" bump is
  the annual toggle (no new Stripe price; reuses *_annual). Post-purchase
  1-click upsell page (dashboard ?checkout=success): offer white-label or, if
  they bought monthly, "switch to annual and save $X" (single click).

## Purchasability / graceful degrade (so nothing is broken on deploy)

New tiers/add-ons need Stripe prices Nathan creates. Until then their CTA must
NOT dead-end. Worker exposes `GET /api/billing/config` -> `{ purchasable: {
solo, pro, studio, business, founding, lifetime, seat, whitelabel } }` computed
from which STRIPE_PRICE_* envs are set. Client:
- purchasable tier -> normal checkout button.
- not-yet-purchasable tier (e.g. Pro/Business before envs set) -> the card
  still shows (for the anchor effect) but the CTA becomes "Notify me at launch"
  -> email capture (reuses /api/free/signup drip), not a broken checkout.
Existing tiers (solo/team/founding/lifetime) are already priced -> live now.

## Stripe env vars Nathan must create (owner-side, before new tiers charge)

- STRIPE_PRICE_PRO, STRIPE_PRICE_PRO_ANNUAL           ($19 / $180yr)
- STRIPE_PRICE_BUSINESS, STRIPE_PRICE_BUSINESS_ANNUAL ($79 / $780yr)
- STRIPE_PRICE_SEAT                                   ($9 / seat / mo)
- STRIPE_PRICE_WHITELABEL                             ($19 / mo add-on)
Existing (unchanged): SOLO, SOLO_ANNUAL, FOUNDING, FOUNDING_ANNUAL, TEAM,
TEAM_ANNUAL, LIFETIME.

## worker/src/stripe.js TIERS (target)

Add: pro, pro_annual, business, business_annual (subscription); seat (per-seat,
quantity), whitelabel (add-on). Keep: free, solo, solo_annual, founding,
founding_annual, team, team_annual, lifetime. checkout.js ANNUAL map gains
pro->pro_annual, business->business_annual.

## Every surface to touch (from the audit)

- web/index.html: #pricing cards 826-984 (rebuild to the 5-card ladder +
  founder deals), value-anchor line 840, sticky 1211-1224, compare table
  1004-1061, calculator label 701, FAQ 802/818/1137-1141, JSON-LD 90-200 offers.
- web/conversion.js: applyCycle 22-72 (annual default + savings), exit-intent
  copy, founder widget unchanged.
- web/checkout.js: ANNUAL map + add-on/quantity + order-bump.
- worker/src/stripe.js: TIERS + createCheckoutSession (quantity, add-on) +
  billing/config; worker/src/index.js route.
- web/preview/app.js: paywall modal 3005-3070 + loss-aversion 443-466.
- web/dashboard/index.html + app.js: sub banner 680-727, seat add-on, white-
  label add-on, post-purchase upsell on ?checkout=success.
- worker/src/email-html.js: drip day7 364-376 (+ day3), keep Origin welcome.
- scripts/build-comparisons.mjs 32-349 + build-use-cases.mjs 59-216 (regen).
- web/terms/index.html 92-97 (+ seat/white-label add-ons), web/about 149-173,
  web/origin/* (Origin story unchanged).

## Guardrails
- No existing price changes. No em-dashes. Honest scarcity (live counters only),
  no fake testimonials/logos/deadlines. No refund promises. test:worker stays
  green (274 baseline). Mobile-first (cards stack, 44px CTAs, no overflow).
  New-tier CTAs never dead-end (purchasability degrade). Ecosystem untouched.
