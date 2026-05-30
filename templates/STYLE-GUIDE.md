# CyberSygn template style guide.

How to write a contract template in CyberSygn voice. This guide is for whoever is authoring a new template module under `templates/agreements/`. Read the spec (TEMPLATE-LIBRARY-SPEC.md) first; this document fills in the writing rules the spec only points at.

## The voice in one paragraph.

Write the way an experienced attorney writes when their client is reading the contract themselves. Direct. Unfussy. Plain English where it works. Legal precision where it matters. Active voice. Sentences end with periods. Headings end with periods. Reasonable people, doing reasonable business, with the legalese trimmed to what the law actually requires.

## Word substitutions.

Use the left column, not the right. The right-column phrases are the ones lawyers reach for out of habit; the left-column phrases mean the same thing and read better.

| Use this | Not this |
|----------|----------|
| if | in the event that |
| will | shall (unless "shall" is doing legal work) |
| under | pursuant to |
| about | with respect to |
| start | commence |
| end | terminate (unless ending early under a termination clause) |
| pay | render payment |
| give notice to | provide notification to |
| signed by both parties | executed by the parties hereto |
| each party | the parties hereto |
| this agreement | this Agreement (capitalized only when used as a defined term) |

Don't write "hereinabove," "hereinbelow," "heretofore," "wheresoever," or any compound starting with "here-" or "where-." If you find yourself reaching for one, restructure the sentence.

## Punctuation.

**No em-dashes. Anywhere.** The generator will refuse to build a template that contains U+2014. Substitute one of:

- A period and a new sentence, when the em-dash was joining two complete thoughts.
- A colon, when the em-dash was introducing an example or a list.
- A pair of commas, when the em-dash was setting off a parenthetical.
- A pair of parentheses, when the parenthetical is longer.

**No en-dashes either.** Use a hyphen. The generator will warn but not fail; fix it anyway.

**Sentence case headings, with periods.** "Confidentiality." not "Confidentiality" or "CONFIDENTIALITY" or "Confidentiality:".

**Defined terms** are capitalized and quoted on first use, then capitalized without quotes thereafter. Example: 'the party disclosing information (the "Disclosing Party")' on first use, then "Disclosing Party" everywhere else.

## Structure of a typical agreement.

Every contract template should follow roughly this skeleton. Not every section is required for every contract; pick what fits.

1. **Title.** One line, sentence case, no period (this is the only exception to the period rule).
2. **Preamble paragraph.** Who, when, why. "This Agreement is entered into as of [date] between [Party A] and [Party B] for the purpose of [purpose]."
3. **Definitions.** Only if there are three or more terms used in a non-obvious way. One-shot terms get defined inline at first use instead.
4. **Numbered clauses.** Each with a sentence-case heading ending in a period.
5. **General provisions.** Severability, waiver, notices, governing law, entire agreement. Standard boilerplate, but write it in CyberSygn voice.
6. **Signature block.** Party role, signed line, name line, optional title line, date line. One block per signer.
7. **Footer (auto-generated).** Template ID, version, generated date, "Not legal advice" disclaimer.

The disclaimer block in the footer is mandatory and is added by the generator automatically; do not write it by hand. The exact text:

> This template is provided by CyberSygn as a starting point. It is not legal advice and does not create an attorney-client relationship. Laws vary by jurisdiction and by situation. Review with a licensed attorney before signing.

## Length.

A general services agreement should fit on three to five pages of letter-sized output. A simple NDA, two to three. If a template runs longer than seven pages, it is either covering too many edge cases or hasn't been edited hard enough.

## Signature blocks the detector can find.

The whole point of a CyberSygn template is that when a user fills it out, downloads it, and uploads it back to CyberSygn for signing, the detector finds every signature field on the first pass. The generator produces signature blocks the detector handles cleanly. The format is:

```
[PARTY ROLE]

Signed:    _________________________________
Name:      _________________________________
Title:     _________________________________
Date:      _________________________________
```

Five things matter about that format:

1. **Party role is on its own line above the block.** This is what the cross-page label propagation pass in the detector uses to assign signatures to the right signer.
2. **Each field label is followed by a colon, then a tab, then a long underscore run.** The detector looks for `\b(signed|signature|name|date|title)\b` followed by an underscore line within roughly 80 PDF user units.
3. **Underscore runs are at least 30 characters.** Shorter runs read as "fill in this short word" not "sign here."
4. **Blocks for different parties are separated by at least one blank line.** This keeps the detector from grouping them together.
5. **The signature block is the last content in the document.** The "primary block" pass marks the final block as `primary: true`, which is what the UI shows by default.

The generator handles all five rules automatically as long as the template module declares its signature block correctly. Don't hand-write underscore runs in a paragraph body.

## Tone for tricky topics.

**Liability limits.** Write what the limit actually is, not "to the maximum extent permitted by law." If you mean "neither party is liable for indirect damages beyond the contract value," say that. Then add a one-sentence note pointing out that some jurisdictions cap how much liability can be waived.

**Indemnification.** State who indemnifies whom and for what. Don't write "each party shall defend, indemnify, and hold the other harmless" without specifying what triggers the indemnity. Mutual indemnification with no trigger is a legal blank check and almost never what either party wants.

**Termination.** Two modes: for cause (with a notice-and-cure window) and for convenience (with longer notice). Both should be written out plainly. "Either party may terminate this Agreement for convenience on 30 days' written notice" is fine. "Either party may terminate this Agreement at any time, in its sole discretion, without cause, on notice" is overweight.

**Confidentiality duration.** Default to two years post-termination for standard NDAs, longer for trade secrets if the law in the relevant jurisdiction supports it. Perpetual confidentiality clauses are unenforceable in many places and CyberSygn templates do not include them.

## Review and sign-off.

A template is not shippable until both `reviewedBy` and `reviewedAt` fields in its module are populated by a licensed attorney. Until then it is marked "preview" and tagged with an additional warning in the UI. There is no shortcut around this step. If you are an engineer authoring a template, leave those fields null and flag the template for legal review before publishing.
