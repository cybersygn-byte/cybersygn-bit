# CyberSygn Ambassador Program: how the money works

Plain language, no lawyer voice. This is the document an ambassador can read
top to bottom and know exactly what they earn, when they get paid, and what
would end the arrangement.

## What an ambassador gives their people

Their code gives every person who uses it **20% off their first 3 months**.
It is a real Stripe promotion code, applied automatically when someone arrives
through their link. The buyer does not type anything, and the discount shows on
the Stripe checkout page before payment.

## What each sale pays the ambassador

The bounty is scaled to the PLAN the customer bought, and it rises with the
ambassador's lifetime sales. There are no projected or estimated earnings
anywhere in this program: an ambassador is told what each sale pays, never what
they "could make."

Why plan-scaled and not flat: a flat bounty pays the same for a $12 Solo sale
and a $79 Business sale. That overpays cheap plans (a flat $20 on an Origin
sale exceeded the $20.07 the sale actually nets), underpays valuable ones, and
gives nobody a reason to chase the sales that fund the business. Each base
bounty below is roughly 35 to 40 percent of what the customer's discounted
first three months actually net after Stripe fees, so every sale is
margin-positive from day one.

| Plan | Sticker | Base bounty |
|---|---|---|
| Origin | $9/mo | $7 |
| Solo | $12/mo | $10 |
| Pro | $19/mo | $16 |
| Studio | $29/mo | $25 |
| Business | $79/mo | $70 |
| Lifetime | $299 once | $85 |

**Tier multiplier**, by lifetime sales:

| Tier | Lifetime sales | Multiplier |
|---|---|---|
| Bronze | 0 to 4 | 1.0x |
| Silver | 5 to 14 | 1.15x |
| Gold | 15+ | 1.3x |

So a Gold ambassador selling Business earns $91, and a Bronze ambassador
selling Solo earns $10.

**Milestone bonuses** (paid once each): first sale +$10, 10th sale +$40, 25th
sale +$75.

**Monthly sprint** (repeats every calendar month): 5 sales in one calendar
month pays +$40.

Bonuses are funded by ongoing subscription revenue rather than the first three
months. Even the heaviest stack (a Gold ambassador closing five Solo sales in
the month they cross 25 lifetime sales) is recovered by those customers'
ongoing payments inside a single month.

Add-ons (extra seats, white-label) attach to an existing plan and do not pay a
separate bounty.

## What counts as a qualifying sale

A sale qualifies when someone who arrived through the ambassador's link starts
a **paid plan** and the payment clears. One bounty per customer, ever: renewals
and upgrades on the same customer do not pay again. The attribution window is
**60 days, last click**, stored in a first-party cookie on cybersygn.io.

## What does not pay

- **Self-referrals.** Buying through your own code pays nothing. Blocked
  automatically by matching both the buyer's account and their email address
  against the ambassador's.
- **Refunds, chargebacks, and disputed payments.** The commission is reversed
  automatically (clawback) and deducted from the balance.
- **Fraudulent or misleading promotion.** See "What ends the arrangement."

## Getting paid

- **Schedule:** monthly, on the 1st, for balances earned through the prior
  month end.
- **Minimum:** $50. Balances under the minimum roll over.
- **Method:** PayPal or Wise. Payouts are **recorded manually by the founder
  today**, not automated. That is stated honestly in the dashboard rather than
  implied to be instant.
- **Taxes:** a W-9 is requested only once yearly earnings reach **$600**, the
  current IRS reporting threshold. CyberSygn never stores an SSN; tax identity
  collection happens through the payment provider when that is enabled.

## The product pass

Ambassadors get **the full product free while active**. The pass runs 90 days
and renews on any real signal of life: opening the ambassador dashboard, a
click on their referral link, or a sale. It therefore cannot lapse in the
middle of an active program.

The pass ends only after **90 days of complete silence** (no visit, no click,
no sale), or immediately on revoke. A lapsed ambassador keeps their code, their
history, and any commission already earned; they simply stop getting the
product for free.

## Disclosure (FTC)

Every public placement (a post, caption, comment, or story) must include a
clear disclosure that the ambassador earns a commission. Every public script in
the dashboard ships with the disclosure already written into it, so the correct
behavior is the default rather than a thing to remember. Private one-to-one
messages do not require the disclosure, though honesty still applies.

Ambassadors must not make claims beyond what CyberSygn itself publishes: no
income promises, no legal guarantees, no invented statistics.

## What ends the arrangement (revoke)

CyberSygn may revoke an ambassador for misleading promotion, undisclosed paid
placements, self-referral attempts, or abuse of the discount. On revoke, the
Stripe promotion code is deactivated (the discount stops working immediately)
and the product pass ends. **History and any commission already earned are
kept**, because that money may still be owed.

## Where this is implemented

- `worker/src/affiliate.js`: code minting, Stripe coupon and promotion code
  creation with orphan cleanup, tier ladder, milestones, sprint, conversion
  recording with dedupe, self-referral blocking, clawback.
- `worker/src/ambassador.js`: email-based identity, product pass lifecycle,
  learning progress, payout state, revoke.
- `worker/src/stripe.js`: server-side discount application at checkout,
  attribution through subscription metadata, refund and dispute reversal.
- `docs/AMBASSADOR-ACADEMY.md`: the training curriculum and build triggers.
