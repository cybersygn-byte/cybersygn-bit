---
title: How I built CyberSygn solo on Cloudflare in 60 days
description: The stack, the slices, the numbers, the hard parts. A field report from one founder shipping an e-signature SaaS with no team, no investors, and a deliberately small surface area.
date: 2026-05-30
author: Nathan Vogt
slug: built-cybersygn-solo-on-cloudflare
---

CyberSygn launched in beta after 60 days of solo development. Here's what's actually in production, what didn't make the cut, and what I'd do differently.

## The stack

- **Frontend**: vanilla HTML + ES modules. No React, no Vue, no build framework. Plain `<script type="module">` and `import`. CSS is one ~6000-line file structured as `@layer base, components, utilities`.
- **Backend**: Cloudflare Workers, exclusively. Every API route, the cron handler, the webhook listener, the audit-cert renderer — all one Worker.
- **Storage**: Cloudflare KV. Six namespaces: `CYBERSYGN_DOCS`, `CYBERSYGN_PDFS`, `CYBERSYGN_EVENTS` (Analytics Engine), founding-signups, drip records, owner tokens. R2 was on deck if I needed object storage at scale — turns out KV is sufficient at current volume.
- **Email**: Resend. ~$0 at the volume I'm at, generous free tier, drop-dead simple API.
- **Payments**: Stripe Checkout + webhook handler with idempotency. Customer Portal for self-service cancellation. Six event types handled: subscription paid, customer deleted, invoice failed, etc.
- **PDF**: pdf.js (parsing + rendering) in the browser, pdf-lib (modification + signing) in the browser AND in the Worker for audit-cert generation.
- **Detection engine**: heuristic, not ML. ~50ms per PDF on a Cloudflare Worker. Multi-strategy fallback — five field types (signature, initial, date, checkbox, text), each detected by a different ordered heuristic. 100% accuracy on a regression set of 37 real-world contracts.
- **Voice + design**: own house style. Inter Display + Inter for typography. Navy (#011434), cyan (#00CBF6), paper (#F7F8FB) — three colors, no expansion. Period-terminated headlines.
- **Cron**: Workers scheduled handler. Every hour for reminder sweeps; once-daily for the drip campaign and the monthly owner report.

## The numbers

- **67 commits**: each one a deployable slice. Slices ranged from "add a comment to clarify intent" to "ship the Charter wall page."
- **141 worker tests**: every commit runs them.
- **28 SEO landing pages** generated from a docs × verticals matrix.
- **6 blog posts** (this one's the 6th).
- **9 Stripe webhook events** handled idempotently.
- **1 cinematic hero video** rendered in Higgsfield.
- **0 third-party JS** beyond Stripe Checkout and the GA4 stub. No Intercom, no Drift, no chat widget tracking pixel.
- **0 employees, 0 investors, 0 outside engineers.** One founder, ~10 hours a day, deliberate slice-based work.

## What worked

**Cloudflare Workers as the deployment substrate.** Latency is excellent everywhere. Cold-start is invisible. The free tier covers a lot of real load. `wrangler deploy` takes about 4 seconds end-to-end. I never once felt constrained by the platform.

**Heuristic detection over ML.** I considered a vision-model approach (Claude or GPT-4V) to detect fields. Heuristic detection runs in 50ms; vision-model detection runs in 4-8 seconds. The accuracy is the same on real-world contracts (heuristic is actually higher on the regression set I trained against). Vision API costs money per call; heuristic detection costs nothing per call. Easy decision.

**KV instead of D1.** I keep going back and forth on this, but at the volume I'm at, KV's flat get/put is faster and cheaper than D1's SQL. When I need joins or transactions, I'll switch. I don't yet.

**Stripe's idempotency-key behavior.** Every webhook gets a `meta:webhook-seen:<event-id>` KV marker before processing. Cloudflare sometimes delivers webhooks twice; the marker means I process each one exactly once. The same pattern protects against scheduled-handler double-fires.

**The slice methodology.** Every commit is a deployable unit. Every commit has a 1-3 paragraph "why" message. After 67 of them, the project archaeology is the cleanest I've ever maintained.

## What I'd do differently

**I shipped marketing copy before I shipped social proof.** Slice 56 was the "conversion pass" with tier renaming and pain-led hero copy. It would have been more effective to ship in this order:
1. Make the product work
2. Get 10 customers (the proof)
3. THEN write the copy that quotes those customers

I did it in the opposite order. The copy is good but unsupported.

**The /preview/ sidebar took too many slices.** Slice 34, 45, 46, 47, 48, 58 — all sidebar UX iterations. Should have done one bigger rebuild upfront rather than iterating in public.

**Higgsfield-rendered video came late.** The cinematic hero went live in slice 57; I should have had it from the start. A 12-second product reveal is the single most expensive thing on the homepage to compete with.

**Worker secrets management is too manual.** I rotate them by `npx wrangler secret put`, which means typing into a terminal. Should have built a `scripts/rotate-secrets.mjs` that handles the whole pipeline. Slipped past by hand-rotating each one.

## What I'm proud of

- The detection engine. 50ms per PDF, 100% accuracy. The hardest single problem on the roadmap and it works.
- The Origin tier mechanic. $9/month locked for life, capped at 100. Scarcity + value pricing + permanent reward for early belief.
- The audit certificate renderer. A one-page PDF with the document SHA-256, every signing event, every IP, every timestamp. Renders in the Worker via pdf-lib.
- The cinematic hero with logo bookends. Plays cleanly, loops, dark-mode-aware, mobile-responsive.

## What's next

Free tools subdomain at `tools.cybersygn.io` (free PDF sign, compress, merge, split — pure SEO bait that funnels into the paid product). Real video testimonials from Origin members as they land. ML-trained detection engine v2 once the corpus hits 5K labeled examples.

For now: shipped. Now I have to figure out distribution.

[Try the demo](/preview/). Drop any PDF. Watch every field appear in three seconds.
