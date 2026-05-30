# CyberSygn template library spec.

This document describes how the CyberSygn template library is structured, how new templates get added, and what guarantees the library makes (and does not make) about legal correctness. It is reference material for engineers and content authors, not marketing copy.

## Purpose.

CyberSygn ships a curated library of generic contract templates as a starting point for users who don't have a contract of their own. The library is a feature of the product, not the product itself. Every template is a starting point. Every signed contract is whatever the user puts on the page, not what we shipped.

The library exists for three reasons:

1. **Lower the cold-start cost.** A first-time user who has never written a contract should be able to start one in under sixty seconds.
2. **Anchor the brand in usefulness.** Sending users to a competitor's template page is a leak in the funnel.
3. **Showcase the field-detection pipeline.** Every shipped template detects cleanly on first upload, which builds trust.

The library does NOT exist to provide legal advice, to replace an attorney, or to be a finished product fit for any specific transaction. Those constraints are baked into the disclaimer block on every template.

## File structure.

```
templates/
  README.md                     # User-facing library overview
  TEMPLATE-LIBRARY-SPEC.md      # This document
  TEMPLATE-INVENTORY.md         # Triage of inbound third-party templates
  STYLE-GUIDE.md                # How to write a CyberSygn-voice template

  agreements/                   # Source modules. Each exports the
    nda-mutual.js               # template definition as data: title,
    independent-contractor.js   # parties, clauses, signature block.
    services-agreement.js
    index.js                    # registry: id -> module

  generated/                    # Built docx files, regenerated from
    nda-mutual.docx             # source modules via the generator.
    independent-contractor.docx # NOT edited by hand. Source of truth
    services-agreement.docx     # lives in agreements/*.js.
```

Source modules are the canonical form. Generated .docx files are build artifacts and may be regenerated at any time by running `npm run build:templates`. Editing a .docx file in Word and committing the result is not the supported workflow; edits go in the .js source.

## Template data shape.

Every template module default-exports an object with this shape:

```js
{
  id: 'nda-mutual',                       // url-safe, stable across versions
  version: '1.0.0',                       // semver, bump on substantive change
  title: 'Mutual Non-Disclosure Agreement',
  category: 'confidentiality',            // for filtering in the UI
  jurisdictionHint: 'us-general',         // never specific to one state
  partyRoles: ['Disclosing Party', 'Receiving Party'],
  signatureCount: 2,                      // matches what the detector should find
  description: 'Two-party NDA for...',    // one-sentence summary
  reviewedBy: null,                       // attorney name when review complete
  reviewedAt: null,                       // ISO date when review complete
  body: [
    { type: 'heading', level: 1, text: 'Mutual Non-Disclosure Agreement' },
    { type: 'paragraph', text: 'This Agreement is entered into ...' },
    { type: 'clause', heading: '1. Definition of Confidential Information.', paragraphs: [...] },
    ...
    { type: 'signatureBlock', parties: [
        { role: 'Disclosing Party', fields: ['Signed', 'Name', 'Title', 'Date'] },
        { role: 'Receiving Party', fields: ['Signed', 'Name', 'Title', 'Date'] },
    ] },
  ],
}
```

Block types and rendering rules live in `scripts/generate-templates.js`. The generator is the single source of truth for how a block shape becomes Word formatting.

## Brand rules every template must follow.

The brand voice rules from `CONSTITUTION.md` Section 4 apply in full. Specifically:

1. **No em-dashes.** Anywhere. Use periods, colons, or parentheses.
2. **Sentence case headlines** with periods on each one.
3. **Reserved words are banned.** No "envelope", "workflow", "smart", "intuitive", "magical", "seamless".
4. **Plain English over Latin.** "Subject to" not "pursuant to". "If" not "in the event that". "Will" not "shall" (except where "shall" is legally meaningful and substituting "will" would change meaning).
5. **Active voice over passive** where the actor matters.
6. **The disclaimer block is mandatory** on every template. See STYLE-GUIDE.md for the exact text.

The generator enforces the em-dash rule mechanically: any string containing U+2014 will fail the build. The other rules are enforced by review.

## Legal posture.

This is the part that matters most, and it bears repeating:

**The template library is not legal advice.** CyberSygn does not practice law. Every template carries a prominent disclaimer to that effect. Terms of Service include a limitation-of-liability clause. Users are directed to consult an attorney for their specific situation.

**Templates are jurisdiction-neutral by default.** No template asks "which state are you in?" and no template generates jurisdiction-specific clauses. That is the line where template provision crosses into unauthorized practice of law. We do not cross it.

**Every template gets attorney review before public release.** The `reviewedBy` and `reviewedAt` fields in the template module are populated when an attorney signs off. Templates without these fields are flagged as "preview" in the UI and tagged with an additional warning. The library does not ship a single unreviewed template to the public surface area.

**Source provenance is documented.** Every template module includes a `provenance` comment block at the top, citing the primary sources used (ABA model forms, state bar templates, public-domain government forms, etc.). No template is derived from a competitor's product or from a paywalled template provider.

**Copyright is respected.** Generic contract language is generally not copyrightable in the US (per Feist v. Rural Telephone Service, 1991), but specific phrasings can be. Templates are written in CyberSygn voice from the ground up. The library does not copy and rebrand third-party templates.

## UI surface.

Phase 1 ships the library at `/templates/` as a static page that lists every template with: title, description, party roles, page count, and a download button that fetches the .docx. The dashboard preview page gains a "Start from template" button next to the upload widget.

Phase 2 (not in scope for the initial release) adds: template categories, search, and a "fill before download" form that pre-populates party names. Phase 2 work begins after at least 10 templates have shipped with attorney review.

## Versioning.

Templates use semver:

- **MAJOR**: changes that materially alter the legal effect (added or removed clauses, changed default terms).
- **MINOR**: clarifying language, formatting, or non-substantive cleanups.
- **PATCH**: typos, brand-voice fixes, em-dash purges.

The version is rendered in the footer of every generated .docx so a user who downloaded a template six months ago can identify exactly which version they're working from. Old versions remain downloadable at `/templates/<id>/<version>.docx` indefinitely.
