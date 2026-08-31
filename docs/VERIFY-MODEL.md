# The verify model: what the fingerprint proves

Date: 2026-08-31. No em-dashes. Read this before you touch anything that
prints, stores, or explains a SHA-256 hash.

This document exists because the product got it wrong once and the mistake
was invisible from the outside. It is written so the next person does not
re-introduce it.

## The mistake this file prevents

Until this change, `doc.pdfSha256` was computed once, at document creation,
over the **uploaded original**. Flattening (baking the signatures into the
page) happened only in the signer's browser. The server never produced a
signed file. So the hash on the audit certificate, and the hash keying the
`verify:` record, described a document with no signatures on it.

That is not a small labeling problem. `/verify` invites a person to check a
signed document. The natural action, hashing the signed PDF they are holding,
produced a value that could never match, because no two browsers even produce
the same bytes: pdf-lib rewrites `ModDate` on load, so each party's local
flatten hashes differently. There was nothing to match against.

The certificate copy was honest about it ("SHA-256 of the original PDF signed
by every party"). The homepage and the /verify page were not, because a reader
hears "the fingerprint of the signed document".

**Rule that falls out of this: a fingerprint is meaningless unless the copy
next to it names the exact bytes it was taken from.**

## What exists now

When every signer on a **sent** document completes, the server builds one
canonical signed PDF: it loads the original, draws each signer's stored fills
(signature PNGs, dates, text, checkboxes) at the field coordinates, draws the
footer, and saves. That artifact is stored, and its SHA-256 is recorded on the
document record.

Two hashes now exist, and they answer two different questions. Keep both.

| Hash | Taken over | Answers |
| --- | --- | --- |
| original | the uploaded PDF, at creation | which document was put in front of the signers |
| signed | the artifact the server issues at completion | is the file in my hand the one CyberSygn issued |

The build is **best effort**. Completion must never fail because of it. If the
source is too large, the original bytes are gone, or pdf-lib throws, the
document still completes, the signed hash is null, and the reason is recorded
and logged. That means there are two classes of completed document, and every
surface has to survive both. See "The failure case is not an edge case" below.

## What is stored, and where

- `pdf:<docId>` (CYBERSYGN_PDFS): the uploaded original. Unchanged.
- the signed artifact (CYBERSYGN_PDFS): the canonical signed PDF, no TTL,
  same permanence as the audit certificate. Deleted by an erasure request.
  Check `worker/src/signed-pdf.js` for the exact key name before you assume it.
- `audit:<docId>` (CYBERSYGN_PDFS): the certificate. Unchanged.
- `doc:<docId>` (CYBERSYGN_DOCS): gains the signed hash, the time it was
  built, its byte length, and the skip reason when it was not built.
- `verify:<hash>` (CYBERSYGN_DOCS): the public record. No TTL.

The `verify:` record is **PII-free by construction** and must stay that way.
It holds hashes, a signer count, a created timestamp, a completed timestamp,
and a fixed status. Nothing else has ever belonged in it.

Specifically: **never put `docId` in a verify record.** `GET /api/docs/:id`
answers without a token and its response carries signer names and emails, so a
doc id inside a public record turns an anonymous fingerprint into a name
lookup. That single field would convert this from a privacy feature into a
disclosure.

Verify records survive an erasure request. That is deliberate, it is stated on
`/erase/` and in the privacy policy, and it is what data protection law expects
of genuinely anonymous records: a contract has more than one party, and one
side should not be able to erase the fact that the agreement completed.

## What the fingerprint proves

- The file being hashed is byte for byte the file CyberSygn issued at
  completion. One changed byte and it does not match.
- A document with that fingerprint was completed on CyberSygn, by that many
  signers, on those dates.

## What it does not prove

- **Who signed.** The record has no name and no email, on purpose. Identity
  evidence lives on the audit certificate, which only the parties receive.
- **What the document says.** No title, no content, nothing reversible.
- **Legal validity.** It is evidence, not a ruling. Never write copy that
  implies a verified fingerprint settles a dispute.
- **That an unmatched file is a forgery.** A miss means only that these exact
  bytes are not a completed CyberSygn artifact. Re-saving a PDF through a
  viewer changes the bytes and therefore the hash. Copy must not accuse.

## What a person should hash

The signed PDF CyberSygn issued at completion, downloaded from the completion
link or the completion email, unmodified. Not a re-saved copy, not a copy that
a browser flattened locally, not a printout scanned back in.

The audit certificate names the file each fingerprint was taken from. That
naming is the load-bearing part: it is what makes the number checkable rather
than decorative. Every fingerprint the certificate prints resolves at
`cybersygn.io/verify`.

## The failure case is not an edge case

When the server could not build the artifact, there is no signed hash. In that
state:

- the certificate keeps its honest original-PDF line and says plainly that no
  canonical signed file was produced;
- the verify record carries a null signed hash and the original still resolves;
- no surface anywhere may claim a signed artifact exists.

There are two kinds of copy and they get different tests.

- **Copy a reader checks against a document in hand**: the certificate labels,
  the /verify result, the retention and evidence descriptions on /privacy/ and
  /erase/. These must be true in **both** states. Never say "the fingerprint of
  the signed PDF" there; say "a fingerprint for every file that exists for this
  signing, labeled with the file it covers", which is what the certificate
  actually prints.
- **Promise copy** (hero, value cards, how-it-works): may describe the designed
  behavior, because a skipped build is an outage, not the product. What it may
  never do is describe behavior the code does not have at all. That is the
  line the old copy crossed: it promised a fingerprint of the signed document
  when no signed document was ever produced, on every single document, forever.

## Documents that never touch the server

Signing on your own device and downloading, without sending, produces a
flattened PDF in the browser and nothing else. No document record, no audit
certificate, no verify record, no server-issued artifact. That is by design and
it is not a bug.

So the boundary for every public claim is **"sent for signature"**, not
"signed". Copy that says "every completed document" is wrong. Copy that says
"every document you send for signature" is right.

## If you change what is hashed, change these too

The copy is not decoration, it is the contract. These files carry claims about
fingerprints and must be re-read against the code on any change here:

- `web/index.html` (hero lede, trust bar, the "Proof anyone can check" card,
  how-it-works step 03, the SHA-256 trust tile, both FAQ blocks, and the
  FAQPage JSON-LD, which must stay word-consistent with the visible FAQ)
- `web/verify/index.html` and `web/verify/app.js` (the result copy has to
  distinguish a match on the signed artifact from a match on the original)
- `web/erase/index.html` ("What we keep, and why")
- `web/privacy/index.html` (section 1 document data, section 5 retention,
  section 10 security)
- `worker/src/audit.js` (the certificate's section 04 labels)
- `worker/src/verify.js` (the module header describes the record)

## Determinism, and why the hash is stored not recomputed

`PDFDocument.load(bytes)` defaults to `updateMetadata: true`, which stamps
`ModDate` with `new Date()`. Two builds seconds apart then hash differently.
The builder loads with `{ updateMetadata: false }` and sets metadata from the
document's own timestamps, which makes the output a pure function of the
inputs.

Even so, **read the stored hash, never recompute it at read time**. A rebuild
that skips one more field than the original run (a fill that failed to embed,
a coordinate that failed validation) produces different bytes and a different
hash, and would silently invalidate every certificate and verify record already
issued. The stored value is the published fact.
