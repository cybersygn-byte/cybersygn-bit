# CyberSygn Ambassador Program: how the money works

Plain language, no lawyer voice. This is the document an ambassador can read
top to bottom and know exactly what they earn, when they get paid, and what
would end the arrangement.

> **The binding version is the public page at
> [/ambassador/terms/](https://cybersygn.io/ambassador/terms/).** That page is
> what an ambassador accepts at enrollment, it carries a version string, and
> the acceptance is recorded on their record. This file is the internal
> reference copy for whoever is building or operating the program. If the two
> ever disagree, the public page wins and this file is the bug.

Honest state of the program as of this writing: **zero ambassadors have ever
been paid.** Every number below is the rule the code enforces, not a track
record.

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
  automatically (clawback) and deducted from the balance. The reversal backs
  out the exact amount that sale credited, including any milestone or sprint
  bonus the sale triggered, and it appears on the ledger as a visible negative
  entry with the reason and the date. See "Clawback" below.
- **Fraudulent or misleading promotion.** See "What ends the arrangement."

## Getting paid

### The hold

Every commission sits for **30 days** before it can be paid. The clearing date
is stamped on the ledger entry the moment the sale is credited (`clearsAt`), so
a later change to the hold length can never move money already promised to
someone. Until that date the money shows as **pending**. After it, the money
shows as **available**, and only available money can go out.

Why a hold exists at all: a customer can dispute a card charge long after the
payment cleared. Thirty days is what comparable programs run, and it is enough
to catch the ordinary refund without making anyone wait a quarter for their
first dollar.

### The schedule

Payouts run **once a month, on the 5th** (the next business day if the 5th
falls on a weekend or a US holiday). A commission joins a run once its 30 day
hold has finished **on or before the 5th**. For most sales that is **30 to 35
days** from the day the customer's payment cleared.

The honest edge case: a sale that clears just after a monthly cutoff waits for
the following run, which is **up to about 60 days**. That is stated out loud
rather than buried, because every monthly schedule has this cliff.

### The minimum

**$25.** Balances under the minimum roll over and are paid in the first run
that clears the minimum.

Any balance is paid in full, **minimum waived**, in three cases:

1. On request after **90 days with no new qualifying sale**.
2. On account closure.
3. If the program shuts down.

Account credit against a CyberSygn subscription has **no minimum and no
transfer fee**.

### The rails

| Rail | Enum value | Minimum | Fees |
|---|---|---|---|
| PayPal goods and services | `paypal_gs` | $25 | CyberSygn pays the sending fee |
| Wise | `wise` | $25 | CyberSygn pays the sending fee |
| CyberSygn account credit | `account_credit` | none | none |

Any receiving or currency conversion fee charged by the ambassador's own bank
or PayPal account is theirs. Account credit counts exactly like cash for the
year total and for the tax documentation rule, because credit for services
rendered is still compensation.

**One person, the founder, runs every payout by hand.** There is no automation
and no cron job behind this schedule. That is stated on the dashboard rather
than implied to be instant.

### Taxes

**Tax documentation is required before the first dollar moves, at any amount.**
A completed W-9 (US ambassadors) or W-8BEN (non-US ambassadors) must be on file
before a payout can be recorded. A missing, refused, or expired tax document
**hard blocks** the payout in code, not just in copy.

Nothing in the law forces that moment. It is a deliberate program choice: all
leverage disappears the instant money moves, and if CyberSygn pays an
undocumented payee and the IRS later determines backup withholding was owed,
CyberSygn is liable for the 24 percent out of pocket plus interest, with no
realistic way to recover it from the payee.

**The reporting threshold is $2,000 for payments made in calendar year 2026.**
It is not $600. IRC 6041(a) was amended by the One Big Beautiful Bill Act
(Pub. L. 119-21) section 70433, applicable to payments made after December 31,
2025, and IRC 6041A(a)(2) was conformed for nonemployee remuneration. New IRC
6041(h) indexes the amount for inflation for years after 2026, with the first
adjustment landing on 2027 payments, rounded to the nearest $100.

Three consequences bind the implementation:

- The threshold is a **per-year lookup table**
  (`REPORTING_THRESHOLD_BY_YEAR = { 2026: 2000 }`), never a literal, because it
  re-indexes annually. An unseeded year falls back to the highest seeded year
  and logs a warning rather than guessing silently.
- The threshold is measured against cash **actually paid** in the calendar
  year, not commission accrued, because information reporting is cash basis.
  Every payout entry stamps its own `taxYear` at write time.
- IRC 3406(b)(6) removes the threshold entirely for any payee we filed an
  information return for in the **preceding** calendar year. A payee we 1099
  for 2026 is reportable from the first dollar in 2027. The record carries
  `reportedYears` for exactly this.

W-8BEN is valid through the last day of the third succeeding calendar year from
signature, and must be re-collected on expiry.

**CyberSygn does not store a TIN, an SSN, an EIN, or a raw W-9** in Cloudflare
KV or in any datastore the worker can read. Collection is routed to a
third-party collector, and only a status flag plus an opaque vendor payee id is
persisted. Neither PayPal nor Wise collects a W-9 on our behalf and neither
files a 1099-NEC for us, so the collector is a named vendor (Stripe Connect,
Tipalti, Trolley, or Tax1099), not the payment rail.

**RESOLVED 2026-08-12: Colorado kept the $600 threshold.** CyberSygn files
from Colorado, which did not conform to the federal increase, so the number
that actually triggers a filing is **$600, not $2,000**. Both figures are now
in the code (`PAYER_STATE`, `STATE_REPORTING_THRESHOLD`,
`federalThresholdForYear`, `stateThresholdForYear`), and
`reportingThresholdForYear` returns the lower of the two. `payoutState` reports
`reportingLikelyFederal` and `reportingLikelyState` separately, because at year
end they are two different filings: $600 to $1,999 paid is a state return only,
$2,000 and up is both.

One question remains open with the CPA and must not be treated as settled:
whether PayPal goods and services payouts qualify for the Treas. Reg.
1.6041-1(a)(1)(iv) third party network transaction relief that would move the
federal 1099 duty off us. Note that even a yes there is only federal relief and
does not by itself answer the Colorado obligation. Until that comes back in
writing, we build as payer of record with the full W-9 stack, because that
design is correct under either answer.

### What blocks a payout

The server refuses to record a payout, with the specific reason, when any of
these are true:

| Block | Meaning |
|---|---|
| `no_terms_acceptance` | The ambassador never accepted the published terms |
| `tax_doc_missing` | No W-9 or W-8BEN on file |
| `tax_doc_expired` | W-8BEN passed its expiry date |
| `tax_doc_refused` | Ambassador declined to provide tax documentation |
| `overpaid_balance` | The record carries a negative balance from a clawback |
| `owner_freeze` | Manual freeze set by the founder, with a reason |
| `below_minimum` | Under $25 and the waiver was not explicitly invoked |
| `nothing_cleared` | Nothing has finished its 30 day hold |

### Clawback

If a referred customer's payment is refunded, charged back, disputed, or
otherwise reversed, the commission for that sale is reversed.

- The reversal backs out **the exact amount that sale credited**, including any
  milestone bonus or monthly sprint bonus the sale triggered, never a flat
  figure.
- It is written to the ledger as a **visible negative entry** with the reason
  and the date.
- The sale stops counting toward lifetime sales and tier.
- If the unpaid balance covers the reversal, it comes out of the balance.
- If the reversal is larger than the unpaid balance, the shortfall becomes a
  **negative balance carried forward** and offset against future commissions.

CyberSygn will **not invoice an ambassador for a reversal and will not ask for
money back.** If an ambassador leaves the program, or the program ends, while
carrying a negative balance, the balance is written off to zero. The single
exception is fraud or self-dealing, where we reserve the right to recover.

Card networks generally allow a customer to dispute a charge for up to 120
days after payment, and some payment methods allow up to 180 days, so a
reversal can arrive well after a commission has already been paid. The 30 day
hold covers the common case and the carry-forward rule covers the long tail.

Both the pending balance and any negative balance are shown to the ambassador
and to the founder. Neither is hidden or clamped to zero.

### Disclosure is a condition of earning

Commission is earned only on promotion that clearly and conspicuously discloses
the paid relationship, as the FTC Endorsement Guides require of the advertiser
at 16 CFR 255.1(d). CyberSygn may withhold or reverse commission on any sale
generated by an undisclosed placement, and may end the arrangement for repeated
non-disclosure.

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

- `web/ambassador/terms/`: the published, binding terms page. Version string,
  acceptance checkbox at enrollment, and the copy an ambassador actually agrees
  to.
- `worker/src/affiliate.js`: code minting, Stripe coupon and promotion code
  creation with orphan cleanup, tier ladder, milestones, sprint, per-component
  ledger entries with `clearsAt`, per-customer conversion records carrying
  `creditTotal` and `entryIds`, self-referral blocking, exact-amount clawback.
- `worker/src/ambassador.js`: email-based identity, product pass lifecycle,
  learning progress, the payout constants (`HOLD_DAYS`, `PAYOUT_MINIMUM_USD`,
  `PAYOUT_RUN_DAY`, `REPORTING_THRESHOLD_BY_YEAR`), `payoutState`,
  `recordPayout` with its enforcement and idempotency, tax document state,
  revoke.
- `worker/src/stripe.js`: server-side discount application at checkout,
  attribution through subscription metadata, refund and dispute reversal.
- `worker/test/payout.test.mjs`: the money arithmetic under test. Runs in the
  deploy gate.
- `docs/PAYOUT-RUNBOOK.md`: the operational procedure for running a payout,
  handling a clawback, and filing at year end.
- `docs/AMBASSADOR-ACADEMY.md`: the training curriculum and build triggers.

## The rule that governs changes to this document

Every number here is enforced server-side in the same commit that publishes it,
or it does not get published. Stated terms the code does not enforce are worse
than saying nothing, because they are a promise to a real person that nothing
keeps.
