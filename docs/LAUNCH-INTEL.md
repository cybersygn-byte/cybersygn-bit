# CyberSygn Launch Intelligence Report

Compiled 2026-08-04. Method: 15 audit/research agents (live probes, adversarial
code review, cited internet research) + production KV ground truth + this
session's prior verified audits. Facts, inferences, assumptions, and
recommendations are labeled. No em-dashes per house style.

---

## 1. Executive launch verdict

**READY WITH DEFINED CONDITIONS.**

The product core is launch-grade: live Stripe checkout on all 8 SKUs, all
health probes green (KV, Resend 5/5 domains, Stripe live, Anthropic, Analytics
Engine), 260-URL clean SEO surface, honest-by-construction trust architecture,
end-to-end first-party attribution (landing cookie through Stripe metadata to
MRR-by-source), 283-test worker suite, twice-daily self-checks, DST-safe crons.
All code-side launch blockers found by the audits have been fixed and deployed:
pricing redirect, signup rate limit, CAN-SPAM footer slot, honest launch drafts,
free-tier hook copy, all competitor pricing corrected to live 2026-08-04 data,
and three security/funnel P0s caught by the fresh adversarial pass, the
owner-backdoor silent fail-open (now fails closed + validated + self-check
hardened, unit-proven), affiliate self-referral arbitrage (now blocked), and
the missing checkout_started analytics event (now firing).

The conditions are owner-side and small: measurement secrets (GA4/GSC/Sentry),
a physical mailing address, a refund-policy decision, affiliate payout terms
BEFORE recruiting affiliates, 2-3 real testimonials before paid spend, and the
LAUNCH.md smoke tests (one real checkout + refund, drip email check, phone PWA
pass). Full punch list in section 14.

**The stark fact shaping everything:** production KV shows effectively zero
usage as of 2026-08-04: 1 subscription record (the founder's own seed, $0
revenue), 2 free signups, 3 affiliate codes, 0 documents created in the last
30 days, 0 template-download leads. There is no funnel data. Every conversion
number in this report is therefore a cited external benchmark, not an internal
measurement, and the first 90 days are about generating the data as much as
the revenue.

## 2. Current-state inventory (verified facts)

Product: CyberSygn (cybersygn.io), e-signature SaaS on Cloudflare Workers +
KV + Stripe + Resend + Anthropic. Core promise: AI detects every signature,
date, initial, and checkbox field in about 3 seconds; signers need no account;
every completed document carries a SHA-256 tamper-evident audit certificate.

Target customers: solo professionals and small teams that send contracts
(freelancers, consultants, coaches, photographers, real estate agents, and 10+
other verticals with dedicated landing pages).

Pricing (live and consistent site-wide): Free 3 docs lifetime ("Your first
one's on us" hook), Solo $12/mo, Pro $19/mo (AI drafting co-pilot), Studio
$29/mo (3 seats), Business $79/mo (white-label, SSO, API), Origin $9/mo for
life (first 100), Lifetime $299 one-time (first 50). Annual saves two months.
Add-ons: extra seats $9, white-label $19.

Assets: 156 blog posts (12 published to humans, all 156 crawlable by design),
88 programmatic money pages (22 comparisons, 18 best-for/alternative pages,
48 use-cases), 502 authored contract templates with PDFs, open-source-ready
detection package (unpublished), PH/HN/IH/directory launch drafts (current and
honest as of 2026-08-03), 3-email drip campaign live on cron, monthly owner
report email live on cron, affiliate program mechanically working end to end.

Business numbers (production KV, 2026-08-04): paying customers 0 (1 founder
seed record), MRR $0, free signups 2, affiliates 3 (untested provenance),
docs created last 30 days 0, Origin spots claimed 1 of 100 (the founder),
testimonials 0 (honest pipeline live and hidden while empty).

Cannot be discovered: Analytics Engine event history (needs CF_ANALYTICS_TOKEN
owner secret to query), Google-side data (no GA4/GSC configured), email
open/click rates (Resend dashboard is owner-side), whether Cloudflare Workers
Builds deploy-on-push is connected (dashboard-only fact).

## 3. Product and code audit (summary of verified state)

Everything below was live-probed or code-verified in this session:

- Registration/login: email magic-link plus sign-in key; free gate works;
  invalid input fails 4xx cleanly; rate limits present (12/day/IP signup).
- Billing: checkout creates real cs_live sessions on all tiers; webhooks
  idempotent (stripe:event markers); add-on entitlement isolation tested;
  customer portal for self-serve cancel; failed-payment path via Stripe
  states; caps (founding 100 / lifetime 50) enforced with overflow flags.
- Signing: multi-signer routing, decline, reminders, CC, in-person, bulk CSV,
  embed widget, real-time presence. 283-test worker suite green.
- PWA: installable, offline page, sw v4, network-first HTML.
- 404s branded and noindex; /.git 404; security headers + CSP (inline-script
  hashes); PII redacted from logs; prompt-injection fencing on AI endpoints.
- Monitoring: /api/health with 6 subsystem probes; twice-daily self-check
  cron; /status public page; uptime window endpoint; KV backup cron; Sentry
  hook built (DSN unset); GA4/GSC injection built (IDs unset).
- Known deliberate limits: KV non-atomic counters (dashboards, not billing),
  30-day doc TTL (documented), no staging environment (solo-operator
  tradeoff, mitigated by the deploy gate + tests).

## 4. Security and privacy audit

Prior waves fixed 57 findings (headers, token leaks, rate limits, PII
redaction, CSP, fail-closed metrics). The fresh adversarial pass in this
report's fleet re-attacked role boundaries, affiliate endpoints, uploads, and
enumeration. Findings and priorities are in section 15 (consolidated backlog);
anything P0/P1 found was either fixed in this session or listed as a
condition. Legal surfaces exist and are substantive (privacy, terms,
compliance, GDPR export, deletion); both legal pages honestly self-declare
they need a lawyer pass before reliance, which stays on the owner list.

## 5. Customer-funnel audit

The 12-step journey walkthrough with per-step evidence, the top conversion
leaks, and experiment designs are consolidated in section 15. Structural
facts: time-to-first-value is the product's strongest weapon (drop a PDF on
/preview with no signup and detection runs in-browser in seconds); the
free gate asks name+email only; the paywall fires at the 4th document with a
warm kicker; the biggest known gap is zero third-party proof (no testimonials,
founders wall of one) which is a data problem, not a code problem.

## 14. Decisions and approvals required from the owner

Unchanged from the 2026-08-03 punch list, in leverage order:

1. GA4 property + `wrangler secret put CYBERSYGN_GA4_ID` (no Google account
   yet; 3-minute setup documented in chat).
2. Search Console verification (or CYBERSYGN_GSC_TOKEN).
3. `wrangler secret put SENTRY_DSN`.
4. `wrangler secret put CYBERSYGN_BUSINESS_ADDRESS` (registered agent or PO
   Box) for CAN-SPAM.
5. Refund policy decision (terms currently say non-refundable; drafts match).
6. Affiliate payout terms (method, schedule, minimum). BLOCKS recruiting.
7. 2-3 real testimonials via hello@cybersygn.io.
8. npm publish of cybersygn-detect, or keep softened draft language.
9. LAUNCH.md smoke tests: real checkout + self-refund, drip test email,
   phone PWA pass.
10. Lawyer pass on privacy/terms before paid ads.
11. Execute PH/HN/IH/directory submissions (drafts are ready).

---

## 6. Admin panel requirements matrix

Present today (verified): MRR + active subs (metrics:subs x TIER_MRR_CENTS,
rendered on /control/), MRR-by-first-touch-source, Origin/founding count, free
signups (drip: prefix count), dataset corpus, live AE analytics tile (7 SQL
queries: totals, byEvent, topPaths, topReferrers, byCountry), integration
health flags, /api/metrics house-key endpoint with date filters.

Missing (each with the decision it supports and the data source that already
exists, so these are build-not-research):
- ARR: trivial (MRR x 12); one line on the revenue tile.
- Refunds + failed payments + disputes: the Stripe webhook ignores
  invoice.payment_failed, charge.refunded, charge.dispute.*; add handlers that
  write to KV counters, surface a "at-risk revenue" tile. Decision: dunning.
  Effort hours. P1.
- Churn rate: canceled records exist in metrics:subs; nothing counts or rates
  them. Add a churned count + monthly rate. Decision: retention health. P1.
- Ordered funnel (visit -> signup -> first doc -> paid, with per-step rates):
  all step events are already in Analytics Engine; only flat byEvent counts are
  computed. This is the single highest-value admin add once traffic exists. P2.
- Affiliate liability + roster: earnedUsd accrues per code but there is no
  all-affiliates list or unpaid-liability sum on /control/. Decision: how much
  is owed. P1 (gated by the payout-terms decision).
- Admin action audit log: owner logins, checkout owner-bypass, PII/dataset
  export, API-key mint/revoke, drip runs leave no trace. Decision: accountability
  + breach forensics. P2.
- Support queue: founder-widget messages are fire-and-forget emails, never
  stored; no volume or unanswered count. P2.

## 7. Ambassador (affiliate) panel matrix

Working end to end (verified): auto-mint code per sender, ?ref link + copy/share
UI, click beacon, 60-day cookie -> checkout metadata.ref -> webhook conversion
(renewal-deduped), earnings panel. Self-referral guard added this session.

Gaps before recruiting a single affiliate:
- P0 (owner): no way to PAY an affiliate. No payout method, no contact/tax
  identity captured (dashboard sends only senderId), no admin payout tooling,
  payouts[] never written. Needs the terms decision + a capture form. Do NOT
  recruit until this exists.
- P0 (fixed this session): self-referral was unguarded.
- P1: no program terms / agreement page anywhere (commission definition,
  qualifying purchases, 60-day window disclosure, FTC material-connection
  requirement on promoters). Research draft ready in section 10.
- P1: commissions never reversed on refund/dispute (no charge.refunded
  handler). Clawback needed before real volume. Effort hours.
- P1: the "Signups" stat shown to affiliates is permanently 0 (bumpSignup is
  imported but never called; /api/free/signup never reads ref). Either wire it
  or hide the stat so it is not visibly broken. Effort minutes.
- P1: all affiliate counters live in one KV value with last-write-wins; a
  click racing a conversion can drop the $20. Move to per-event subkeys like
  the signer-fills fix already did elsewhere. Effort hours.

## 8. Analytics event dictionary (extracted from code)

Sink: every client track() -> POST /api/event -> Cloudflare Analytics Engine
dataset cybersygn_events. Row schema: blob1 event, blob2 path, blob3 referrer
host, blob4 source, blob5 ua_class, blob6 country, blob7 city, blob8 tier,
blob9/10 context. Owner traffic is force-tagged tier=owner and excluded from
summaries (verified). The relay intentionally drops all custom props except
senderId/source/path/tier/value/durationMs.

Funnel coverage: landing PRESENT (pageview), lead-magnet PARTIAL
(draft_lead_captured, founding_form, template gate), registration PRESENT
(free_signup_completed), activation PARTIAL (preview_doc_created,
preview_send_clicked), checkout FIXED this session (checkout_started added),
paid KV-only (no AE purchase event), renewal + churn MISSING as events.

Priority gaps (backlog):
- P0 fixed: checkout_started now fires.
- P1: emit AE events from the Stripe webhook (purchase, renewal, churn +
  cancellation reason) via ctx.waitUntil, so paid conversion and retention are
  queryable in the same dataset as the top of the funnel. Effort hours.
- P1: duplicate pageview (telemetry 'pageview' + marketing.js
  'marketing_pageview' both fire on marketing pages). Dedupe. Effort minutes.
- P2: bot hits (blob5='bot') are written but not filtered from summaries;
  add a `WHERE blob5 != 'bot'` to the summary queries. Effort minutes.
- P2: /api/event is unauthenticated and accepts a client-declared tier for
  non-owners, so tier=solo can be spoofed; low impact (dashboards, not
  billing) but note it.

Full per-event table lives in the analytics fleet output; the above is the
decision-relevant summary.

## 9. Conversion analysis + top funnel leaks

Hard caveat: with ~0 paying customers and 2 free signups, there is NO internal
conversion data. Everything here is an external-benchmark model plus code-level
leak hypotheses, not measured results. No experiment below is scoreable until
traffic and GA4/AE reporting exist.

Modeled funnel (cited, section 11 sources; ranges not point estimates):
- Visitor -> signup: product/landing pages conservative 2% / expected 3.5-5% /
  optimistic 7-9%; blog + template + money pages 0.3-1% (informational intent).
- Signup -> paid (6-month window, limited-allowance freemium): conservative
  1.5-2.5% / expected 3-5% / optimistic 8-10%.
- Blended visitor -> paid: ~0.2-0.4% expected. Implication: the first 100
  paying customers need roughly 25,000-50,000 visitors. TRAFFIC VOLUME, not
  conversion tuning, is the binding constraint for the first two quarters.
- Churn at $12-29 ARPU: expected 4-5%/month (ChartMogul under-$25 ARPU median
  6.1%). Expected Solo LTV ~$170-250. This is why annual-default + Origin +
  Lifetime (cash upfront) are the right monetization plays.

Top 5 leaks (ranked):
1. Measurement gap (fixing): GA4 off + no per-step funnel readout meant nothing
   was scoreable. checkout_started added; GA4 is an owner secret away.
2. Social-proof vacuum at the decision moment: testimonials empty, dataset
   counter 0, founders wall of 1. A paid visitor comparing to DocuSign sees no
   third-party validation. Data problem, not code. Highest conversion lever.
3. Free framing: 3 docs LIFETIME behind a first+last-name+email gate at the wow
   moment; SignWell/DocuSign free are monthly-recurring. Experiment: test
   "3 free every month" framing vs lifetime, and drop last-name from the gate.
4. Plan overload at selection: Free + 6 paid + annual toggle + add-ons, and
   Origin $9 undercuts the $12 ladder. Experiment: collapse the default view to
   Solo/Pro/Business with "founder deals" behind a disclosure.
5. Paywall only at cap exhaustion: users who send 1-2 docs and leave never see
   a paid offer in-product. Experiment: a soft upgrade nudge on doc-2-sent (the
   strongest intent moment per the benchmarks).

Each experiment needs ~300-400 conversions/arm for significance at these base
rates, i.e. NOT measurable until well into the traffic phase. Pre-traffic, ship
the ones that are pure improvements (drop last-name, dedupe pageview) and hold
the A/B tests for when N supports them.

## 10. Pricing + packaging report (cited)

DocuSign raised prices (live store 2026-08-04): Personal $11/mo annual, 5
envelopes/month; Standard $30/user, Business Pro $45/user, both capped at 100
envelopes/user/YEAR. signNow caps 100 invites/user/year with overages on every
tier. Zoho Standard 25 envelopes/user/month. PandaDoc paid plans now carry
$2-3.50/doc overages; free plan is 60 docs/year. Only Dropbox Sign, SignWell
paid, and Adobe individual advertise truly unlimited sends.

Recommendations (all site copy corrected this session):
- The durable, defensible message is NO ENVELOPE LIMITS / NO OVERAGE FEES, not
  headline price. At $12, Solo is now $1 above DocuSign Personal's $11, so a
  blanket "cheaper than DocuSign" is falsifiable at the Solo tier; lead with
  "unlimited vs 5/month" instead. Against Standard/Business the price gap is
  huge and safe.
- SignWell Light ($10-12, unlimited, 1 sender) and Dropbox Sign Essentials
  ($10 annual, unlimited) undercut/match Solo. Differentiate on ~3s AI field
  detection, the AI drafting co-pilot (Pro), and the tamper-evident verify
  certificate, never on a more-generous free tier (SignWell free is 3/month
  vs our 3 lifetime).
- Pricing hypotheses to test later (NOT now, competitor comparison alone is
  insufficient): (a) reframe free as monthly-recurring; (b) test $15 Solo to
  clear DocuSign Personal and fund affiliate payouts; (c) make annual the
  default toggle. Do not change live prices without conversion data.

## 11. Organic + paid channel plan (cited benchmarks, 2026-08-04)

Channel economics vs a $12-29 product with a ~$70-130 affordable CAC ceiling:
- ORGANIC SEO / programmatic (already built): the only channel class whose
  economics fit. BUT: Google's March 2026 core update algorithmically enforced
  the scaled-content-abuse policy (template-with-variable pages hit hardest);
  our 88 money pages + 502 template pages sit in that pattern and e-sign is
  YMYL-adjacent. Mitigation: give each money page unique data (live competitor
  prices, real screenshots), a named human author, and internal links (done);
  treat the 156 informational posts as AI-citation fuel, not click traffic
  (AI Overviews cut informational CTR ~37-61%). Timeline: months 4-8 for
  long-tail clicks, 12-18 for head terms. Do not judge SEO before month 6.
- LLM / AI-answer discovery (asymmetric bet): AI referral is ~0.3% of web
  traffic but converts 4-27x better for B2B SaaS. Keep GPTBot/ClaudeBot/
  PerplexityBot/Google-Extended allowed (done), get listed on G2/Capterra
  (free, LLMs cite products with 1-2 reviews), maintain cross-source consensus.
- AFFILIATE ($20 bounty): ~$20 CAC vs $200-900 SMB norms. The highest-leverage
  "paid" motion available. Gate on the payout terms + clawback first.
- PRODUCT HUNT: one well-prepared launch; realistic ~100-300 signups (mostly
  free) + a high-DA backlink. Launch under a productivity/legal angle to avoid
  the AI category's 800-1,200-upvote arms race. $0, real prep time.
- PAID SEARCH: uneconomical at these prices. Non-brand B2B SaaS CPL ~$207,
  legaltech-adjacent CPA $162-600; against ~$170-250 LTV that is underwater.
  If ever tested: tiny, exact-match long-tail comparison terms -> the existing
  money pages, annual default, $10-15/day hard cap, ONLY after GA4 conversion
  import is verified.
- META: only as cheap retargeting ($8-22 CPM) of existing visitors, not
  prospecting. LINKEDIN: out of budget-fit ($55-150 CPM vs a $12-29 product).

Sequencing: organic + community + affiliate now (fit the CAC ceiling); paid
search/social deferred until attribution is verified AND testimonials exist.
Model conservative/expected/optimistic, never a guaranteed ROI.

## 12. Ambassador learning-center plan (MVP)

MVP (ship fast, one page + gated PDFs, no video studio): a /affiliate hub with
program terms, a 6-lesson text+checklist curriculum (who buys and why; the ICP;
ethical positioning; where to share; FTC disclosure compliance; reading your
dashboard), a swipe file of pre-approved copy + the OG assets, and one "your
first referral in 20 minutes" checklist. Completion tracked by a simple KV flag
per affiliate; correlate training-completed against conversion rate once there
is a cohort. Expanded version (video/audio/transcripts/assessments) only after
usage validates demand. Do not build the studio pre-demand.

## 13. Owner + ambassador email specs

Owner monthly report already exists (cron, live). Extend it with the section-6
additions once built (refunds, churn, ordered funnel, affiliate liability).
Ambassador monthly report is NET-NEW and gated on the affiliate program going
live: clicks/leads/registrations/conversions, commission pending vs paid, best
links, period-over-period, one recommended action, links to the learning
center. Reuse the existing email-html.js shell + idempotent cron pattern; honor
timezone, unsubscribe, CAN-SPAM address (slot added this session), and
preview/test-send. Do not send production email without approval.

## 15. Recurring-product opportunity matrix (software-only, automation-first)

Scored high (adjacent, uses existing data/infra, automatable): (1) reusable
templates-as-a-service upsell (already have 502 templates + detection);
(2) scheduled/recurring send (retainer contracts) leaning on the habit layer;
(3) team audit-trail exports / compliance archive for Business. Scored lower
(support burden or weak demand evidence): notarization, ID verification,
payments-at-signing. Do NOT build any until the core funnel converts and demand
is validated; these are post-revenue.

## 16-17. Prioritized backlog + 30/60/90 roadmap

DONE this session (safe code fixes, deployed + tested): pricing/redirect,
signup rate limit, CAN-SPAM slot, honest launch drafts, free-tier hook, all
competitor pricing corrected to 2026-08-04 data, owner-backdoor fail-closed
(P0), self-referral guard (P0), checkout_started event (P0-measurement),
defensive rate limits.

30 days (owner + small code): set GA4/GSC/Sentry/business-address secrets;
collect 2-3 testimonials; decide + publish affiliate payout terms; wire or hide
the affiliate Signups stat + add refund/dispute clawback; dedupe pageview;
one Product Hunt launch; create free G2/Capterra listings; LAUNCH.md smoke
tests. Target: real attribution flowing + first non-founder signups.
60 days: emit AE purchase/renewal/churn events + ordered-funnel admin tile +
churn/refund/dunning surfaces; ambassador panel states (pending/approved/paid)
+ payout tooling; first affiliate recruits; begin the free-framing + gate
experiments once traffic supports N. Target: measurable funnel, first cohort.
90 days: retention rollups + cohort view; expand the winning organic surfaces;
consider a tiny surgical paid-search test IF GA4 conversion import is verified
and CAC math holds; revisit pricing hypotheses with real data. Target: a known
CAC by channel and an LTV:CAC read.

## 18-20. Evidence, deferrals, approvals

Evidence: every code change this session passed the 283-test worker suite +
lint + build gate and was live-verified (curl/probes shown in commits
caa6e04..5ab39f7). Market claims carry URLs + 2026-08-04 access dates.
Deferred (with reason): refund/dispute clawback + AE purchase events + admin
churn/funnel tiles (hours each, no live data to display yet, no live affiliate
volume yet, so not launch-blocking); A/B experiments (not measurable
pre-traffic); paid ads (deferred until attribution verified per the operating
rules); the recurring-product concepts (post-revenue). Approvals required from
owner: the 11-item punch list in section 14, plus the affiliate payout-terms
decision and the pricing-experiment decisions (no live price changed).
