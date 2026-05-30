# CyberSygn templates.

A small, curated library of contract templates built into CyberSygn. Every template is generic, jurisdiction-neutral, and written in plain English. Every template is a starting point. Not legal advice. Review with an attorney before you sign.

## What's here.

Three templates ship in this initial release. All three are PREVIEW status pending attorney review.

| Template | Parties | When to use |
|----------|---------|-------------|
| [Mutual NDA](./generated/nda-mutual.docx) | Two | Exploratory business discussions where both sides expect to share sensitive information. |
| [Independent Contractor Agreement](./generated/independent-contractor.docx) | Client and individual contractor | Hiring a freelancer or solo provider. Includes worker-classification language. |
| [Services Agreement](./generated/services-agreement.docx) | Client and provider business | Business-to-business services. Uses Statements of Work for engagement-specific terms. |

Each template is a `.docx` file. Download it, fill in the bracketed placeholders, then upload it to CyberSygn for signing. The CyberSygn field detector recognizes every signature, name, title, and date line in the template on the first pass.

## How to use a template.

1. Click a template link above to download the `.docx`.
2. Open it in Word, Google Docs, Pages, or LibreOffice.
3. Fill in the bracketed placeholders. Anything between `[` and `]` is meant to be replaced.
4. Save the file.
5. Upload it to CyberSygn. The detector finds every field. You assign signers, send the document, and the rest is the normal CyberSygn flow.

You can also edit any clause to fit your situation. The templates are starting points, not finished contracts.

## What "preview" means.

Templates in this release are marked PREVIEW because they have not yet been reviewed by a licensed attorney. We wrote them carefully from primary sources (ABA model forms, IRS publications, Cornell LII references) but until an attorney has signed off, they should be treated as drafts. We recommend having a licensed attorney review any template before you use it for an actual transaction. CyberSygn will update this README when each template clears review.

## Authoring new templates.

If you want to contribute a template, read:

1. [TEMPLATE-LIBRARY-SPEC.md](./TEMPLATE-LIBRARY-SPEC.md) for the architecture.
2. [STYLE-GUIDE.md](./STYLE-GUIDE.md) for how to write in CyberSygn voice.
3. [TEMPLATE-INVENTORY.md](./TEMPLATE-INVENTORY.md) for the prioritized list of categories that still need coverage.

Then create a new module under `agreements/`, add it to `agreements/index.js`, and run `npm run build:templates` to regenerate the `.docx` files. The generator enforces the brand rules (no em-dashes, no banned words, signature blocks the detector can find) at build time.

## Why no library from a competitor.

The initial inventory exercise looked at a batch of 36 third-party templates. None made it into the shipping library. Most came from a direct competitor's template library (SignWell) with their branding embedded in the document XML. Others were institutional templates owned by Howard University. Rebranding either set would have created legal exposure with no upside, so every CyberSygn template is written from scratch from primary sources we have the right to use. See TEMPLATE-INVENTORY.md for the full triage.

## Disclaimer.

The templates in this library are provided by CyberSygn as starting points. They are not legal advice and do not create an attorney-client relationship. Laws vary by jurisdiction and by situation. Review with a licensed attorney before signing. CyberSygn makes no warranty about the legal effect of these templates in any particular transaction. See the CyberSygn Terms of Service for the full limitation of liability.
