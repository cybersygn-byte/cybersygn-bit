# Founder content playbook (slice 102)

## Why this matters

The audience for CyberSygn is solo professionals — freelancers, photographers, coaches, indie founders. **They convert on people, not features.** Marketing copy from a faceless company reads as another SaaS launch. Posts from a real founder building in public read as a peer journey.

Your build-in-public habit IS your marketing channel. Treat it that way.

## The cadence

| Platform | Frequency | Tone | Goal |
|---|---|---|---|
| **Twitter/X** | Daily, 1–3 posts | Direct, opinion-led, technical-light | Visibility + lead capture |
| **LinkedIn** | 2-3x per week | Slightly more polished, business-framed | B2B credibility, Studio-tier funnel |
| **Indie Hackers** | Weekly milestone post | Honest numbers, lessons | Indie audience + backlinks |
| **Personal blog** | Bi-weekly | Long-form, technical or strategic | SEO + cred building |
| **Newsletter** | Monthly | Highlights + behind-the-scenes | Direct relationship with warm leads |

## The principles

1. **Specific numbers beat vague claims.** "Day 73: $1,592 MRR" beats "Things are going well."
2. **Show failures.** "Lost 2 hours to a duplicate CSS selector bug today. Lessons:" — vulnerability earns trust.
3. **Teach, don't sell.** Every post should leave the reader smarter even if they never buy.
4. **Reply to every reply.** For at least the first year. People remember founders who respond.
5. **No emoji-heavy hype posts.** "🚀🔥 BIG NEWS 🔥🚀" reads as fake. Use words.
6. **Photo of you occasionally.** Not your dog, not your desk — you. Face = trust.

## 30 days of post drafts

Copy-paste, edit lightly, schedule.

### Week 1 — what + why

**Day 1 (Twitter/X):**
> Day 1 of building CyberSygn in public.
>
> What it does: drop a PDF, every signature line is detected automatically. No drag-and-drop.
>
> Why it exists: I sent a contract through DocuSign last month and spent 28 minutes placing fields. There had to be a better way.
>
> Following along: cybersygn.io

**Day 2 (Twitter/X):**
> The DocuSign workflow is built around a 2003 mental model: "you, the sender, know exactly where every field goes, and you'll spend 30 minutes telling us."
>
> 2026 mental model: the PDF tells us where the fields go.
>
> This is the entire wedge.

**Day 3 (LinkedIn):**
> I built CyberSygn solo over 60 days on Cloudflare Workers.
> 
> Why solo: I wanted to ship something I'd use myself, fast, without committee.
>
> Why Cloudflare: $5/month covers production for the first 10,000 docs/month.
>
> What's live: auto-detection, magic-link signing, audit certs, real-time co-signing.
>
> What's next: customer #1.

**Day 4 (Twitter/X):**
> Code-level surprise of the week:
>
> Every flattened PDF I've ever signed contains the SHA-256 of the original document baked into the audit certificate.
>
> Means: 5 years from now, anyone can verify "yes this is the document that was actually signed" without trusting me.
>
> Cryptography is wild.

**Day 5 (Twitter/X):**
> Pricing: $9/mo for the first 100 (Origin tier), $12 after.
>
> "Why $9?" — because 100 founding customers paying $9/mo = $900 MRR, enough to keep building without rushing.
>
> "Why $12 after?" — because compounding small customers is more durable than chasing one big one.

**Day 6 (Blog post):**
> Title: "Why I built a DocuSign alternative on Cloudflare Workers"
> 1500 words. Cover: the moment that triggered it, what's interesting technically, where you're going. Link to /preview/.

**Day 7 (Indie Hackers milestone):**
> Title: "From 0 to launching: 7 days of CyberSygn"
> Honest numbers — signups, traffic sources, one win, one failure.

### Week 2 — show the magic

**Day 8 (Twitter/X, video clip):**
> Screen recording, 12 seconds. Drop a contract PDF, fields appear.
>
> Caption: "What 30 minutes of DocuSign drag-and-drop looks like, on CyberSygn."

**Day 9 (Twitter/X):**
> Wrote a script today to verify every JS file in our codebase parses cleanly before deploy.
>
> Background: shipped a duplicate identifier last week. Browser threw SyntaxError, entire upload flow died silently. Took 4 hours to find.
>
> Lesson: never trust your assumptions. Verify them.

**Day 10 (LinkedIn):**
> 3 things solo SaaS founders get wrong (I've gotten all 3 wrong):
>
> 1. Shipping product without a buyer. The product should follow the buyer, not lead them.
> 2. Spending on ads before having organic signal. Paid amplifies what works. Nothing × paid = nothing.
> 3. Optimizing the wrong number. MRR matters less than "did the right person sign up today."

**Day 11 (Twitter/X):**
> The viral footer plan:
>
> Every signed PDF that goes out gets a tiny "Signed with CyberSygn ↗" link in the bottom margin.
>
> One signed contract = one impression in front of lawyers, clients, and accountants.
>
> Free tier mandatory. Paid optional.
>
> This is how Calendly scaled.

**Day 12 (Twitter/X):**
> Question for solo freelancers + photographers:
>
> How many contracts/month do you sign?
>
> And how much time per contract goes into placement of signature/date/etc fields?
>
> Researching for an upcoming launch.

**Day 13 (Blog post):**
> "Cloudflare Workers as production infrastructure: 60 days in"
> Cover: real numbers, what surprised you, what you'd do differently. Link to architecture diagram.

**Day 14 (Indie Hackers + Twitter/X):**
> Week 2 milestone:
> 
> - Signups: [X]
> - Origin members: [Y of 100]
> - Top traffic source: [...]
> - Open question: [...]
>
> Building one slice at a time.

### Week 3 — establish credibility through depth

**Day 15 (Twitter/X):**
> Shipped today: real-time co-signing.
>
> Two signers on the same doc see each other's progress live. "Jane is on page 2, 8 of 12 fields filled."
>
> Built with polling (every 2s) → upgrade to Durable Objects when scale demands it.
>
> Engineering principle: ship the dumb version first.

**Day 16 (Twitter/X):**
> The hardest part of building solo isn't writing code.
>
> It's deciding what NOT to build.
>
> Today's "not yet" list: SAML SSO, Salesforce integration, white-label for agencies, voice annotation.
>
> All real ideas. None get built until a paying customer asks.

**Day 17 (LinkedIn):**
> Real-time co-signing: why it matters.
>
> When two parties sign the same contract, they're usually in a deal-closing moment. Either both at a table, or one waiting on the other.
>
> Knowing "Jane is on page 2, 60% through" eliminates the "did she get it?" anxiety.
>
> Small UX upgrade. Big psychological one.

**Day 18 (Twitter/X):**
> A thing I underestimated: how much trust a clean audit certificate buys.
>
> SHA-256 fingerprint of the original document. IP + timestamp + email of every signer. Every event.
>
> "I have proof this was signed by John on October 23rd at 3:47pm from a Comcast IP in Denver" reads very different than DocuSign's audit trail.

**Day 19 (Twitter/X):**
> Real anecdote: someone signed up today via the magic-link microsite (they signed a doc through CyberSygn, then clicked "claim my own free account").
>
> The viral loop is real. Every signed PDF that goes out is a sales call.

**Day 20 (Blog post):**
> "Why receivers hate signing accounts" — long-form pitch against DocuSign's account-creation friction. Customer-language piece.

**Day 21 (Indie Hackers + Twitter/X):**
> Week 3:
>
> [numbers, lesson, what's next]

### Week 4 — direct invitation

**Day 22-28 (mix):**
- One product clip per day
- One opinion post per day
- One reply marathon (spend 1 hour replying to every comment that week)
- Launch the "Freelancer Pack" — 25 Lifetime spots at $199 for the first 25 freelancers

**Day 28 (Twitter/X):**
> One month of building CyberSygn in public.
>
> Honest numbers:
> - [signups]
> - [Origin members]
> - [Lifetime members]
> - [MRR]
>
> Building solo. Replying to every email at nathan@cybersygn.io.
>
> Try it: cybersygn.io

**Day 30 (Newsletter — month 1):**
> Subject: "30 days of CyberSygn: numbers, lessons, what's next"
> Long-form. Real numbers. The next month's plan.

## Drafts beyond day 30

Repeat patterns: weekly milestones + 2-3 product/opinion posts/day. Use traction → posts about traction. Use customer wins → posts about customer wins (with permission). Use customer feedback → posts about customer feedback.

The audience compounds on itself. By day 90 you'll have a list of 200-2000 people watching what you do.

## When to post

| Platform | Best time (your time zone, MDT) |
|---|---|
| Twitter/X | 7-9am, noon, 5-7pm |
| LinkedIn | 7-9am Tuesday, Wednesday, Thursday |
| Indie Hackers | Tuesday or Thursday morning |
| HackerNews ("Show HN") | Tuesday 6-8am PT |
| Product Hunt | Saturday 12:01am PT |

## One rule

**Don't go dark for more than 3 days.**

People watch builders the way they watch TV shows. The minute you stop showing up, they assume the show is canceled. Stay visible.
