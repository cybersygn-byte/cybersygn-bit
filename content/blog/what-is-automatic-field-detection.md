---
title: What is automatic field detection?
description: The technical wedge that makes CyberSygn different from every other e-signature tool. Heuristic detection of signature lines, initials, dates, and checkboxes — in about three seconds per document.
date: 2026-06-04
author: Nathan Vogt
slug: what-is-automatic-field-detection
---

Every other e-signature tool — DocuSign, HelloSign, PandaDoc, SignWell, SignNow — makes you draw a box on the screen for every place someone needs to sign. Every line. Every initial. Every date field. Twenty minutes of clicking and dragging, every single contract.

CyberSygn doesn't. We find the fields for you, in about three seconds. Here's how that actually works.

## The problem in technical terms

A PDF is a graph of text operators, fonts, and geometry. When InDesign or Word exports a signed-line-with-a-blank-after-it, the underscore characters become a run of Tj (text-show) operators with specific x-coordinates, font metrics, and (usually) repeating glyph codes. The signature line "Client signature: ______________________" is a deterministic geometric structure in the PDF stream.

A human reads this and sees "ah, I sign here." Software can read it too, if you write the parsing layer right.

## What CyberSygn looks for

Five categories of field, each detected by a different heuristic:

### Signature fields

- Underscore runs of width > 200 pixels at typical signature-line geometry (low on the page, horizontal, single line)
- Phrases like `Signature:`, `Signed:`, `Authorized signature:`, `/s/` followed by whitespace
- Named blocks: "Client signature", "Contractor signature", "Witness signature"
- Common formats: `X______________________`

### Initial fields

- Phrases like `(Initial)`, `(Init.)`, `Initials:`
- Small underscore boxes (width < 80 px) in the margin
- Sequence detection: if there are six small boxes evenly spaced near the right edge of every page, those are page-initials

### Date fields

- `Date:`, `Date signed:`, narrow underscores adjacent to date labels
- `MM/DD/YYYY` placeholders and similar
- `_____ / _____ / _____` (a common three-segment date pattern)

### Checkboxes

- ASCII patterns: `[ ]`, `[]`, `( )`
- Unicode patterns: `□`, `☐`, `☑`
- Empty small squares in the PDF's geometry that lack a fill but have stroke

### Generic text fields

- Underscore runs that don't match any of the above patterns
- Often used for write-in lines like "Address: ____________________"

## How it gets to 100% on real-world contracts

The detection engine passes 37 out of 37 real-world contracts on our regression set, plus all 10 synthetic test PDFs. The key insights:

- **Use PDF.js operators, not raster pixels.** Reading the PDF stream is deterministic; reading the raster image is probabilistic and slow.
- **Multi-strategy fallback.** Most fields match more than one heuristic, but the strict ordering above means a "Signature: _____" line gets correctly classified even if the underscore run alone might have matched as generic-text.
- **Geometry awareness.** A 40-pixel underscore at the top-right of a page is probably an initial; the same underscore at the bottom-center is probably a signature.

## What it can't do (yet)

- **Image-based PDFs.** A scanned contract that's all raster has no text operators to parse. We've considered OCR (Tesseract on Workers) but the latency hit isn't worth it for the v1 audience.
- **Heavily designed forms.** A wedding-invite-styled contract with handwritten-font signature lines fails detection. Most business contracts use standard underscore conventions; designed ones don't.
- **Languages we haven't tuned for.** The English-language heuristics work in any language that uses similar underscore conventions (which is most of them), but we don't yet special-case for, e.g., Japanese-style signature blocks.

## Why this matters

DocuSign's drag-and-drop UX is what happens when you build for the legal team that signed off on the requirements doc. The legal team isn't the one wasting 30 minutes per contract.

The hardest part of building CyberSygn wasn't the detection engine — it was convincing myself that detection was actually worth building. The signing market is locked-in, the incumbents have huge moats, and nobody was demanding this feature.

Once the engine worked, the demand showed up immediately. Turns out: when you stop forcing people to do the slow work, they notice.

[Try the demo](/preview/). Drop any PDF. Watch every field appear in about three seconds.
