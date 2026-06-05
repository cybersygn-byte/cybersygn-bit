# Indie Hackers launch — CyberSygn

IH rewards substantive posts. "I shipped a thing" gets ignored. "I
shipped a thing and here's the indie-founder story / numbers / lessons"
gets traction. The post below leads with story, lands with the launch.

Post in: **Indie Hackers → "Launched" milestone** (the most discoverable),
or as a standalone in **Indie Hackers Forum → Show IH**.

## Title

```
I built a DocuSign alternative solo on Cloudflare in 8 weeks. Lessons + launch.
```

Alternates:
- `Shipped: an e-signature tool that finds every field for you. Solo, 8 weeks.`
- `How I built CyberSygn (the e-signature tool that doesn't waste your time) without a team or a runway.`

## Body

```markdown
👋 IH,

I'm Nathan, and yesterday I shipped CyberSygn — an e-signature service
that automatically finds every signature line, initial, date, and
checkbox in your PDFs. No drag-and-drop, no signer accounts.

This is one of those "I built this for me first" stories. I sign a lot
of contracts (NDAs, contractor agreements, leases). Every time, I'd
spend twenty minutes dragging signature boxes onto pages that had a
perfectly clear signature line already printed on them. The slowest
part of signing anything was telling DocuSign where the fields were
that I could already see with my eyes.

So I built it.

**Live**: https://cybersygn.io
**Try the demo (no signup)**: https://cybersygn.io/preview/

---

## The stack

- **Cloudflare Workers** for everything backend. The free tier on Workers
  is genuinely shockingly generous and the latency is unreal.
- **KV** for metadata and templates. **R2** would be next if I needed
  more sustained storage, but I haven't yet.
- **Resend** for transactional email. Drop-dead simple, $0 for the first
  3k/month.
- **Stripe** Checkout for billing. Webhook with idempotency keys,
  Customer Portal for self-service cancellation.
- **No frontend framework.** Plain HTML + ES modules. Styles.css is
  ~6000 lines of considered CSS. Total dist bundle is 15 MB and that's
  mostly the pdf.js + audit-cert renderer.
- **pdf.js + pdf-lib** for browser-side PDF parsing and flattening.
- The field-detection engine is heuristic, not ML. ~50 ms per PDF on a
  Cloudflare Worker. I'll open-source it as `cybersygn-detect` this week.

## The numbers (8 weeks in)

- 67 git commits → 67 deployable slices
- 6 KV namespaces
- 9 Stripe webhook events handled with idempotency
- 28 programmatic SEO landing pages
- 100% detection accuracy on the regression set (37 real-world contracts)
- $0 in revenue (pre-launch) → public launch is today
- 0 investors. 0 employees. 0 outside opinions.

## The hard parts

**1. Field detection that actually works on real-world PDFs.**

Real contracts are a mess. Word-exported PDFs use a different coord
system than InDesign-exported. Letterhead screws up your y-axis. The
"underscores ___ ___" pattern is sometimes one operator and sometimes
forty-seven adjacent characters. Spent 3 weeks just on detection
heuristics. Now passes 37/37 on regression.

**2. Receiver UX.**

DocuSign hostility-trains its users to expect signing to suck. I had
to make the receiver flow so frictionless that the receiver doesn't
realize it's CyberSygn — they just click and sign. Magic-link tokens,
zero account creation, browser-side signing pad.

**3. Trust signals when you have no customers yet.**

This one's still in progress. The Origin tier (founding 100 customers
at $9/mo locked for life) is doing dual duty: scarcity + social proof.
A live Origin Wall page surfaces real signups as they happen.

## What I'd love your help with

1. **Try the demo**: https://cybersygn.io/preview/ — drop a PDF, watch
   the fields appear. No signup, 3 docs free, lifetime.
2. **Honest feedback**: what's confusing? what's broken? where did you
   bounce? Email nathan@cybersygn.io — I read everything.
3. **Origin spots**: $9/mo locked for the life of your account, capped
   at 100 founders. I'll keep an IH-flagged count if anyone here claims one.

Happy to answer anything in the comments. Thanks IH 🚀

— Nathan
```

## When to post

Tuesday-Thursday, 7-10 am Eastern. Avoid weekends (low traffic) and
US-holiday weeks.

## Engagement playbook

- Reply to every comment within an hour for the first 6 hours
- Don't get defensive about feedback — IH culture rewards humility
- Have a follow-up post planned for day 7 ("week-1 numbers from the launch")
