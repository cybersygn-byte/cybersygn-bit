# Ambassador Payout Runbook

The operational procedure for the monthly ambassador payout run. One person
(Nathan) does all of this by hand. There is no cron job, no automation, and no
second pair of eyes, so the procedure has to carry the checks that a second
person would.

Terms live in `docs/COMMISSION-MODEL.md` and are published at
`/ambassador/terms/`. This file is how the terms actually get honored.

**Standing facts as of this writing: zero ambassadors have ever been paid.**
If you are reading this before the first run, expect the roster to be empty or
to show only pending balances. That is the correct state, not a bug.

---

## 0. Before the first run ever happens

These are one-time. Nothing below works until they are done.

- [x] **(b) ANSWERED 2026-08-12: Colorado kept $600.** It did not conform to
      the federal increase, so $600 paid in a year triggers a filing here. The
      code encodes this (`STATE_REPORTING_THRESHOLD = { CO: 600 }`) and the
      roster flags against it.
- [ ] CPA call booked and the remaining two answers received **in writing**:
      (a) the $2,000 federal 1099-NEC threshold applies to our 2026 payments,
      (c) whether PayPal goods and services payouts qualify for the
      Treas. Reg. 1.6041-1(a)(1)(iv) third party network relief. Note (c) is
      FEDERAL relief only and would not remove the Colorado obligation.
- [ ] Tax document collector account open (Stripe Connect is the least new
      surface since we are already on Stripe; Tax1099 or Trolley otherwise),
      and the key set:
      `npx wrangler secret put TAXDOC_API_KEY --env production`
- [ ] PayPal business account confirmed able to send goods and services
      payouts, Wise business account funded, and a $1 test sent on each rail
      with both transaction ids recorded below in the run log.
- [ ] The published terms page read top to bottom and its version string
      approved.

---

## 1. The monthly sequence, start to finish

Run on the **5th of the month**. If the 5th is a weekend or a US holiday, run
the next business day. Budget 30 to 60 minutes for a small roster.

1. **Open the roster.** Go to `https://cybersygn.io/control/`, log in, and
    scroll to the Ambassador program tile. Click Refresh so you are looking at
    live numbers, not a cached render.
2. **Read the totals strip first.** Check the **overpaid** total before
    anything else. If it is non-zero, stop and work section 6 (clawback) for
    the affected codes before sending a single dollar.
3. **Pull the roster as JSON** so you have a record of the state you paid
    against (section 2). Save it to `~/payouts/YYYY-MM-05-roster.json`.
4. **Work the queue in order.** The roster sorts highest liability first. For
    each row with a non-zero **available** balance, run the pre-send checklist
    in section 3.
5. **Send the money** on the ambassador's chosen rail (section 4). Capture the
    transaction id from the rail's confirmation before you close the tab. If
    you lose it you cannot record the payout correctly.
6. **Record each payout back into the system** immediately after sending it,
    one at a time, never batched at the end (section 5). The gap between
    sending and recording is the window where a double-send happens.
7. **Refresh the roster** and confirm each code you paid now shows available
    at or near zero and paid increased by exactly what you sent.
8. **Fill in the run log** at the bottom of this file. Commit it.
9. **Reply to anyone who emailed about a balance** during the month
    (section 7).

---

## 2. How to read the /control/ roster

The roster is rendered by `web/control/control.js` from
`GET /api/owner/ambassadors`. Every number on it comes from `payoutState()` in
`worker/src/ambassador.js`.

To pull it as JSON, first get your owner token. It is already in the browser:
open the DevTools console on `/control/` and run
`localStorage.getItem('cybersygn.owner.token')`. Copy that value.

```bash
export CS_OWNER="paste-the-token-here"

curl -s https://cybersygn.io/api/owner/ambassadors \
  -H "X-CyberSygn-Owner: $CS_OWNER" \
  | tee ~/payouts/$(date +%Y-%m-%d)-roster.json | jq .
```

To look at one ambassador:

```bash
jq '.rows[] | select(.code == "abc12345")' ~/payouts/$(date +%Y-%m-%d)-roster.json
```

### Which column is authoritative for what

| Column | What it means | Use it for |
|---|---|---|
| `availableUsd` | Cleared ledger minus everything already paid | **This is the only number you may send.** Nothing else. |
| `pendingUsd` | Credited but still inside the 30 day hold | Explaining to an ambassador why their number is bigger than their payout. Never send this. |
| `balanceUsd` | Earned all time minus paid, **unclamped** | Spotting an overpayment. It can be negative and that is the point. |
| `overpaidUsd` | The positive size of a negative balance | Section 6. A non-zero value blocks payouts for that code. |
| `earnedAllTimeUsd` | Sum of every ledger entry, including negatives | History and disputes. Not a payable figure. |
| `paidUsd` | Sum of every payout ever recorded | Reconciling against PayPal and Wise statements. |
| `paidThisYearUsd` | Cash paid in the current UTC calendar year | Year-end filing. Cash basis, so this is the 1099 number, not earnings. |
| `reportingThresholdUsd` | The threshold for this payee this year | $2,000 for 2026, or 0 if we filed for them last year. |
| `reportingLikely` | `paidThisYearUsd` at or above the threshold | Advisory. Flags who probably needs a 1099-NEC. It is **not** a payout gate. |
| `taxDocState` | `none`, `requested`, `w9_on_file`, `w8ben_on_file`, `w8ben_expired`, `refused` | The hard gate. Anything but `w9_on_file` or `w8ben_on_file` means do not send. |
| `payable` | Server's own verdict | If this is `false`, the API will reject your payout. Read `blockReasons`. |
| `blockReasons` | Array of specific blocks | Tells you exactly what to fix. |

**The one-line rule: send `availableUsd`. Not `earnedAllTimeUsd`, not
`balanceUsd`, not `pendingUsd`, and not the number the ambassador quoted you in
an email.**

---

## 3. Pre-send checklist

Run this per ambassador, every single time, even for someone you paid last
month. The server enforces all of it, but you want to know before you move
money, not after.

- [ ] **`payable` is `true`** and `blockReasons` is empty.
- [ ] **Hold cleared.** `availableUsd` is greater than zero. If it is zero and
      `pendingUsd` is not, nothing has finished its 30 day hold yet. Skip the
      row.
- [ ] **Minimum met.** `availableUsd` is at least **$25**, or you are
      deliberately invoking a waiver (90 days with no new qualifying sale and
      they asked, account closure, program shutdown, or account credit which
      has no minimum). A waiver means passing `belowMinimum: true`.
- [ ] **Tax document on file.** `taxDocState` is `w9_on_file` or
      `w8ben_on_file`. If it is `w8ben_expired`, re-collect before paying: a
      W-8BEN expires on the last day of the third succeeding calendar year from
      signature.
- [ ] **No overpayment flag.** `overpaidUsd` is zero. If it is not, work
      section 6 first.
- [ ] **Terms accepted.** No `no_terms_acceptance` in `blockReasons`.
- [ ] **Amount matches.** The number you are about to type into PayPal or Wise
      equals `availableUsd` to the cent.
- [ ] **Rail and destination confirmed.** You are sending to the address on
      their record, not to an address from an email you received this week.
      A payout address change arriving by email is the classic fraud vector.
      Confirm any change on a second channel before you use it.

---

## 4. How to send on each rail

Record the transaction id from every one of these before you leave the page.

### PayPal goods and services (`paypal_gs`)

1. PayPal business account, Send and Request, Send.
2. Enter the ambassador's PayPal email from their record.
3. Choose **"Paying for an item or service"**, not friends and family.
   Goods and services is what the terms say we use, it gives both sides a
   record, and it is the rail that may qualify for third party network relief
   if the CPA comes back yes.
4. CyberSygn pays the sending fee. Do not deduct it from the ambassador's
   amount, and do not tick any option that passes the fee to the recipient.
5. Payment note: `CyberSygn ambassador commission ABC12345 2026-08` where the
   code is uppercase and the month is the run month.
6. Copy the transaction id from the confirmation screen.

### Wise (`wise`)

1. Wise business account, Send money.
2. Recipient from their record. For a first send you will add the recipient
   with the bank details they provided through the collector or by direct
   request. Verify the name matches the name on their tax document.
3. Send USD. CyberSygn pays the Wise transfer fee. Any receiving or currency
   conversion fee charged by their own bank is theirs, and the terms say so.
4. Reference: `CyberSygn ambassador ABC12345 2026-08`. Wise truncates long
   references, so keep it to that shape.
5. Copy the transfer id.

### CyberSygn account credit (`account_credit`)

1. No minimum and no fee. This is the rail for small balances and for anyone
   who would rather have product than cash.
2. Apply the credit to their subscription in Stripe: Customer, Balance, Add
   credit, entered as a negative balance in USD. Description:
   `Ambassador commission ABC12345 2026-08`.
3. Copy the Stripe balance transaction id.
4. **Credit is compensation.** It counts toward `paidThisYearUsd` exactly like
   cash, it counts toward the reporting threshold, and it needs the same tax
   document on file. Do not treat it as a freebie.

---

## 5. Recording the payout

Do this immediately after each send. The server enforces every rule again, so
a rejection here means the send was wrong and you need to look at it now.

The endpoint is `POST /api/owner/ambassadors/payout`, owner-gated by the
`X-CyberSygn-Owner` header.

```bash
curl -s -X POST https://cybersygn.io/api/owner/ambassadors/payout \
  -H "X-CyberSygn-Owner: $CS_OWNER" \
  -H "content-type: application/json" \
  -d '{
    "code": "abc12345",
    "amount": 91,
    "rail": "paypal_gs",
    "railRef": "8XY12345AB678901C",
    "idempotencyKey": "2026-08-05-abc12345",
    "note": "August run"
  }' | jq .
```

Field notes, all of them real:

| Field | Required | Notes |
|---|---|---|
| `code` | yes | Lowercase ambassador code. The handler lowercases it for you but be consistent. |
| `amount` | yes | USD, to the cent. Must be at or below `availableUsd`. |
| `rail` | yes | Exactly one of `paypal_gs`, `wise`, `account_credit`. Not free text. |
| `railRef` | yes | The PayPal transaction id, Wise transfer id, or Stripe balance transaction id. `credit` is acceptable only if the rail genuinely produced no id. |
| `idempotencyKey` | yes | `YYYY-MM-DD-<code>` is the convention. A repeat call with the same key is a no-op, which is what saves you from a double send being double recorded. |
| `belowMinimum` | only when waiving | `true` to deliberately pay under $25. Leaves an audit trail rather than a silent exception. |
| `allowOverpay` | almost never | `true` to send more than `availableUsd`. There is no ordinary reason to use this. If you think you need it, you are probably looking at the wrong column. |
| `note` | optional | Free text, kept on the record. |

A success returns `{ ok: true, state: { ... } }` with the recomputed payout
state. Check that `paidUsd` moved by exactly what you sent.

A rejection returns `{ ok: false, error: "..." }`. The errors you will actually
see:

| Error | What it means | What to do |
|---|---|---|
| `below_minimum` | Under $25 and no waiver | Let it roll over, or re-send with `belowMinimum: true` if a waiver applies. |
| `exceeds_available` | You typed more than `availableUsd` | You sent too much. Go to section 6, overpayment case. |
| `tax_doc_missing` / `tax_doc_expired` / `tax_doc_refused` | No valid W-9 or W-8BEN | **You should not have sent.** Collect the document, then record. |
| `no_terms_acceptance` | They never accepted the terms | Get acceptance before recording. |
| `overpaid_balance` | Negative balance outstanding | Section 6. |
| `owner_freeze` | You froze this account | Unfreeze deliberately or leave it. |
| `duplicate_idempotency_key` (no-op success) | Already recorded | Nothing to do. This is the double-click guard working. |
| `unknown_code` | Typo in the code | Check the roster. |

### Recording a tax document

When a W-9 or W-8BEN comes back through the collector, mark it. Never paste a
TIN, an SSN, or a W-9 image into the app, a commit, or KV. The only things that
get stored are a status flag and the collector's opaque payee id.

```bash
curl -s -X POST https://cybersygn.io/api/owner/ambassadors/taxdoc \
  -H "X-CyberSygn-Owner: $CS_OWNER" \
  -H "content-type: application/json" \
  -d '{
    "code": "abc12345",
    "state": "w9_on_file",
    "vendorPayeeId": "acct_1XyZ...",
    "collectedAt": "2026-08-04T00:00:00.000Z"
  }' | jq .
```

For a W-8BEN, also pass `"expiresAt"` set to the last day of the third
succeeding calendar year from signature. A document signed any time in 2026
expires `2029-12-31T23:59:59.999Z`.

---

## 6. Clawback: a refund or chargeback lands

### The automatic part

A Stripe refund, dispute, or chargeback fires the webhook, which calls
`reverseConversion()` in `worker/src/affiliate.js`. It:

- subtracts the **exact** amount that sale credited, taken from `creditTotal`
  on the per-customer conversion record, including any milestone or sprint
  bonus that sale triggered,
- writes a negative ledger entry of type `reversal` carrying the `customerId`
  and the reason,
- decrements lifetime sales, clears the sprint if the month drops below the
  requirement, and recomputes the tier,
- marks the conversion record reversed so it can never be double-reversed or
  re-credited.

You do not do any of this by hand. Your job is to check the result.

### Case A: the commission had not been paid yet

Nothing to do. The reversal came out of the unpaid balance, `availableUsd` and
`pendingUsd` absorbed it, and the ambassador sees a negative line on their
ledger with the date and reason. If they ask, point them at that line.

### Case B: the commission was already paid (overpayment)

This is why the roster has an overpaid column. Work it like this:

1. **Confirm the number.** `overpaidUsd` on the roster is the shortfall.
   `balanceUsd` will be negative by the same amount.
2. **Do not invoice. Do not ask for the money back.** The published terms say
   we will not, and that is a promise. The shortfall carries forward as a
   negative balance and is offset against future commissions automatically:
   the next sale's credit reduces the negative before anything becomes
   available.
3. **Payouts for that code are blocked** while `overpaidUsd` is non-zero
   (`blockReasons` contains `overpaid_balance`). That is intentional. Do not
   override it with `allowOverpay`.
4. **Email the ambassador the same day**, before they notice it themselves.
   Plain words: which customer refunded, what the reversal was, what their
   balance is now, that we are not asking for anything back, and that it comes
   off future commissions. Nothing defensive.
5. **If they leave the program, or the program ends, while negative**, write
   the balance off to zero. Record it as an `adjustment` ledger entry with the
   reason, not by editing numbers.
6. **The single exception is fraud or self-dealing**, where we reserve the
   right to recover. That is a conversation, not a runbook step.

### Timing you should expect

Card networks generally allow a dispute for up to 120 days after payment, and
some payment methods allow up to 180. The 30 day hold catches the ordinary
refund. It does not catch the long tail, and it is not supposed to. The
carry-forward rule is what covers that, which is exactly why the terms spell it
out before anyone is ever paid.

---

## 7. When an ambassador disputes an amount

Assume they are right until the ledger says otherwise. The numbers have been
wrong before.

1. **Acknowledge within one business day.** Do not wait until you have the
   answer to reply.
2. **Pull their record.** The roster gives you the summary; the ledger gives
   you the line items.

    ```bash
    npx wrangler kv key get "affiliate:code:abc12345" \
      --namespace-id e487c2c3baaf4e2ebfd01a55d6112b88 --remote | jq .
    ```

    If the ledger has been moved to its own key, read that too:

    ```bash
    npx wrangler kv key get "affiliate:ledger:abc12345" \
      --namespace-id e487c2c3baaf4e2ebfd01a55d6112b88 --remote | jq .
    ```

    (The `--remote` flag is not optional. Without it wrangler reads your local
    KV and you will be looking at nothing.)

3. **Reconcile in this order.** Nine times out of ten the answer is in the
   first two:
    - **Pending versus available.** They are quoting `earnedAllTimeUsd` or
      their dashboard's earned figure and expecting `availableUsd`. Show them
      the clearing dates.
    - **A reversal.** A refund clawed back a sale. Show them the negative
      ledger entry with its `customerId` and date.
    - **A sale that never qualified.** Add-ons and free plans pay zero, and a
      self-referral is blocked. The conversion record will say
      `self_referral` or the sale will not exist.
    - **Attribution.** The window is 60 days last click. If someone else's
      code was the last click, the sale went to them.
    - **Tier timing.** The bounty is set by the tier they were in **as of that
      sale**, not the tier they are in now.
4. **Reply with the actual line items**, dates and amounts, not a summary. If
   the ledger disagrees with what the dashboard showed them, say so plainly.
5. **If we were wrong, pay the difference the same day.** Use a
   `belowMinimum: true` payout if the correction is under $25, with the note
   explaining the correction. Do not make someone wait a month for our error.
6. **If we were right, say so once, kindly, with the numbers**, and leave it.
   Do not argue it twice.
7. **If the same confusion happens twice, the copy is the bug.** Fix the
   dashboard or the terms page, not just the email.

---

## 8. Year end: two filings, two thresholds

### Who needs what

There are TWO separate returns with TWO different floors. Do not read one
number and assume you are done. For each US payee (`taxDocType: "w9"`):

| Paid in the year | Federal 1099-NEC | Colorado return |
|---|---|---|
| Under $600 | No | No |
| $600 to $1,999 | **No** | **Yes** |
| $2,000 and up | Yes | Yes |

Read the flags, not the blended number:
- `reportingLikelyFederal` (against `federalThresholdUsd`) drives the 1099-NEC.
- `reportingLikelyState` (against `stateThresholdUsd`) drives the Colorado one.
- `reportingThresholdUsd` is the LOWER of the two and exists to decide "does
  this payee need paperwork at all". It is NOT the 1099-NEC threshold. Filing a
  1099-NEC off that number would file federal returns for payees who do not
  need one.

- **2026 federal threshold: $2,000.** IRC 6041(a) as amended by Pub. L.
  119-21 section 70433, applicable to payments made after December 31, 2025.
- **2026 Colorado threshold: $600.** Colorado did not conform to the federal
  increase. Colorado also does NOT accept 1099-NEC through the Combined
  Federal/State Filing program: CDOR requires a separate .TXT upload in IRS
  Publication 1220 format through Revenue Online, against a Colorado
  withholding account. No filing vendor does this leg for you automatically,
  so budget for it as manual work every January.
- **2027 and later re-index.** IRC 6041(h) indexes for inflation, rounded to
  the nearest $100. The code carries a per-year table
  (`REPORTING_THRESHOLD_BY_YEAR`). **Seed the new year in that table every
  January**, or an unseeded year falls back to the highest seeded year and logs
  a warning.
- **Prior-year carry.** If we filed an information return for a payee for the
  preceding calendar year, their threshold this year is **zero**, from the
  first dollar. IRC 3406(b)(6). The record's `reportedYears` array drives this
  and `payoutState` already applies it.
- **Cash basis, not accrual.** The figure is what we actually **paid** in the
  calendar year, including account credit. Commission that accrued in December
  and was paid in January belongs to January's year.
- **Non-US payees** (`taxDocType: "w8ben"`) do not get a 1099-NEC. Do not
  improvise here; a Form 1042-S question goes to the CPA.
- **Colorado uses $600, and that is the number that binds you.** RESOLVED
  2026-08-12: Colorado did not conform to the federal increase. So anyone paid
  **$600 or more** in the year needs a filing even though the federal floor is
  $2,000. This is the trap in this whole section: read `reportingLikelyState`,
  not just `reportingLikelyFederal`. A payee at $900 owes a Colorado return and
  no federal one, and looking only at the federal number would tell you there
  is nothing to file.

### Deadlines

| Date | What |
|---|---|
| **January 31** | Form 1099-NEC to the recipient **and** filed with the IRS. Same date for both. There is no extended paper deadline for NEC. |
| **January 31** | Most state filings that follow the federal NEC date. Confirm with the CPA. |
| Ten or more returns | Must be filed electronically. The collector handles this. |

Start the year-end pull in the first week of January so a missing or expired
W-8BEN can be chased before the deadline, not after.

### What our records must contain to file

Pull this in early January:

```bash
curl -s https://cybersygn.io/api/owner/ambassadors \
  -H "X-CyberSygn-Owner: $CS_OWNER" \
  | jq '[.rows[] | select(.paidThisYearUsd > 0) | {code, email, paidThisYearUsd, taxDocState, taxDocType, reportingThresholdUsd, reportingLikely}]'
```

For each payee we file for, the collector needs:

- **Legal name and TIN.** These live at the collector, never in KV, never in a
  commit, never in an email. We hold only the opaque `taxDocVendorPayeeId`.
- **Total paid in the calendar year.** Sum of payout `amount` where `taxYear`
  equals the year. The `taxYear` field is stamped at write time precisely so
  this is a lookup and not a re-derivation you could get wrong.
- **Address**, held by the collector.
- **Our own payer details**: CyberSygn's legal name, address, and EIN.

After filing, add the year to `reportedYears` on each filed record so next
year's threshold correctly drops to zero for those payees. If that step is
skipped, the roster will quietly say a payee is fine when they are reportable
from the first dollar.

Keep the roster JSON snapshots from every monthly run. They are the
contemporaneous record of what was paid and why, and they are the fastest
answer to any question the CPA asks.

---

## 9. Run log

One row per monthly run. Fill it in the day you run it, not later. Commit it.

| Run date | Roster snapshot | Ambassadors paid | Total sent | Rails used | Overpaid at start | Notes |
|---|---|---|---|---|---|---|
| (no runs yet) | | 0 | $0.00 | | $0.00 | Zero ambassadors have been paid to date. |

### Rail test log

The one-time $1 tests from section 0, kept because they are the proof each rail
actually works from this account.

| Date | Rail | Amount | Transaction id | Result |
|---|---|---|---|---|
| | `paypal_gs` | $1.00 | | |
| | `wise` | $1.00 | | |
