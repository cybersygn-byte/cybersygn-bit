# Hacker News launch — CyberSygn

HN is the highest-leverage launch surface for technical/indie products.
The audience is engineers; the title and the technical-substance of the
first comment matter more than anything else.

Post as: **Show HN: <title>**

## Title

HN titles can't be marketing-y. They have to be flat, descriptive, and
under 80 characters. Best options:

```
Show HN: CyberSygn – e-signature that detects every PDF field automatically
```

Alternates:
- `Show HN: A DocuSign alternative that finds signature fields for you (live)`
- `Show HN: CyberSygn – signature-field detection in PDFs, runs in browser`

Note: NO ALL CAPS, NO EMOJI, NO MARKETING ADJECTIVES. HN moderators
will rewrite or sink the post. "Show HN:" prefix is mandatory.

## First comment (the launch comment, posted within 60 seconds)

```
Hi HN,

I built CyberSygn because the slowest part of signing a contract isn't
reading it — it's telling DocuSign where the fields are. Twenty minutes
of dragging signature boxes onto every page, every time.

The wedge here is automatic field detection. CyberSygn reads the PDF's
text operators + geometry and locates every signature line, initial,
date, and checkbox. About 50 ms per contract on a Cloudflare Worker.
The detection engine is heuristic, not ML — I'll open-source it as
`cybersygn-detect` (MIT) once a few more people kick the tires.

Technical notes that might be interesting:

- Runs entirely on Cloudflare Workers + KV. No origin servers, no
  database. Workers Analytics Engine for product telemetry.
- Detection runs in the BROWSER on upload. The PDF doesn't reach a
  server until the user decides to send (= "send for signature"). pdf.js
  for parsing, pdf-lib for flatten + sign.
- Signers click a magic link and sign in their browser. No account,
  no SDK, no installs.
- Audit certificate is rendered with pdf-lib in the Worker on
  completion. SHA-256 of the original document is the receipt key.
- Cron-driven reminder sweep at first/72h/7-day intervals via
  scheduled() handler.
- Idempotent Stripe webhooks via meta:webhook-seen:<event-id> KV
  markers. Six event types: invoice paid, customer deleted, etc.

Detection accuracy: 100% on a regression set of 37 real-world contracts
and 10 synthetic PDFs. Most failures during dev were around exotic
fonts (Hiragino CJK, etc.) — pdf.js needs CMap data shipped alongside.

Pricing: 3 free signs (lifetime, no card). $9/mo Origin (founding 100,
locked for life). $12/mo Solo. $29/mo Studio (3 seats). Why those
prices: $12/mo Solo is half of DocuSign Personal's $25, and the $9
Origin rate is a thank-you to the first 100 people who try it.

Live: https://cybersygn.io
Try it (no signup, drop any PDF): https://cybersygn.io/preview/
Comparison vs DocuSign: https://cybersygn.io/alternatives/cybersygn-vs-docusign/

Built solo. Nathan@cybersygn.io. Happy to dig into the architecture
(or anything else) in this thread.
```

## When to post

Tuesday-Thursday, 8-10 am Eastern. This is when HN is busiest, and
the post needs to gain initial traction in the first 30 minutes or it
drops off the new page.

Avoid: Mondays (low traffic), Fridays (people checking out), early am
PT (US not online), late evenings.

## Engagement playbook

- Stay in the thread continuously for the first 3 hours. Reply to every
  technical comment with substance.
- Don't argue. HN respects "fair point, here's what we considered" more
  than "you're wrong, here's why."
- When someone asks "why not just use DocuSign?" — answer with the
  detection-engine technical detail, not with marketing copy.
- Have detection screenshots / GIFs ready to paste as imgur links.
- If the post goes well (front page), prepare to handle 5-10x normal
  traffic. Verify Cloudflare's free-tier rate limits are above what
  you expect.

## What NOT to do

- Don't say "please upvote." HN auto-detects and shadow-bans.
- Don't link to your own posts elsewhere ("as I wrote on IH..." — fine,
  but never "see my IH post for more").
- Don't reply with marketing speak. The audience smells it instantly.
- Don't take feedback personally in public, even when it's wrong.
