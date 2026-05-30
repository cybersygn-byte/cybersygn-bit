# CyberSygn.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/REPLACE-WITH-YOUR-GITHUB-USERNAME/cybersygn)

**Want to deploy this yourself?** Read **[INSTALL.md](./INSTALL.md)** for the plain-English five-step guide (fifteen minutes, no terminal). For exhaustive reference detail, see [INSTALL-detailed.md](./INSTALL-detailed.md).

---

The signature tool engineers actually like. You upload a PDF, we find every signature line, initial, date, and checkbox. You route it to your signers. They sign on any device. You get the signed PDF and a tamper-evident audit certificate the moment the last signer completes.

This repository contains the full working prototype: detection pipeline, signing experience, multi-signer routing, magic-link email, audit-certificate generation, reminder system, sender dashboard, and workspaces.

For brand voice, palette, pricing, and product positioning, see [CONSTITUTION.md](./CONSTITUTION.md).
For deployment, see [DEPLOY.md](./DEPLOY.md).

---

## What this repo does end-to-end.

1. **Start.** Pick a contract template from the curated library at `/templates/`, or upload your own PDF or Word document. The template library ships generic, jurisdiction-neutral starting points (NDA, Independent Contractor Agreement, Services Agreement) written in CyberSygn voice. Every template carries a "not legal advice" disclaimer and is rebuilt from primary sources, not from any third-party template provider.

2. **Detect.** Upload a PDF or Word document. The shared detection module (`worker/src/detect.js`, also used server-side) walks the PDF operators and locates every signature line, initial mark, date placeholder, checkbox, and text field. Word documents are converted to PDF in the browser via mammoth.js before detection, so the entire pipeline post-upload is PDF-native. The detector currently passes 10/10 synthetic test PDFs and 37/37 real-world contracts.

3. **Sign.** Click any detected field to fill it. Signatures and initials open a smooth-stroke signature pad (mouse, trackpad, or touch). Dates open a date picker. Text fields open a text input. Checkboxes toggle inline. Filled fields render in place. pdf-lib flattens the captures back into the original PDF for download.

4. **Route.** Add additional signers with names and emails. Click a field's chip to assign it to any signer. Switch perspective with the "Signing as" dropdown to preview each signer's experience. Click "Send by email" to mint a unique magic link per signer and dispatch invite emails.

5. **Track.** The sender dashboard at `/dashboard/` lists every document with per-signer status, reminder counts, copy-magic-link buttons, and download buttons for the signed PDF and audit certificate once complete.

6. **Remind.** Manual one-click reminder for any pending signer, plus an hourly cron that sends an escalating sequence (gentle nudge at 24 hours, firmer at 72 hours, final at 7 days, hard cap of 3 reminders).

7. **Audit.** Every event (created, viewed, signed, reminder, completed) is recorded with timestamp, IP, and user-agent. On completion the Worker auto-generates a one-page audit certificate listing every signer, every event, and the SHA-256 of the original PDF, and attaches its download URL to the completion email.

8. **Team up.** Workspaces let multiple senders share a single document index. Invite teammates with a one-time-use link; every member sees every doc, with `createdBy` resolved per row.

---

## Running locally.

```bash
npm install
npm run vendor      # copies pdf.js, pdf-lib, fonts from node_modules into web/vendor/
npm run build       # writes the deployable bundle to web/dist/
npm run preview     # serves the dev tree at http://localhost:5173/web/
```

For the full multi-signer flow (real magic links, real reminder cron), run the Worker too:

```bash
cd worker
npx wrangler dev --port 8787
```

Without bindings, the Worker falls back to an in-memory KV store and console email; magic links print in the wrangler log instead of being delivered.

---

## Testing.

```bash
npm test                # synthetic PDF detection regression
npm run test:real       # real-document detection regression
npm run test:worker     # end-to-end Worker tests (141 assertions)
npm run test:docx       # docx ingestion pipeline (mammoth + pdf-lib synthesis)
npm run test:templates  # every shipped template round-trips through the detector
npm run build:templates # regenerate templates/generated/*.docx from source modules
```

`test:worker` imports the Worker module directly and exercises every endpoint with constructed Request objects. It does not need wrangler or any Cloudflare resources to run. `test:docx` synthesizes its own .docx fixtures in memory so no third-party Word templates are checked into the repo. `test:templates` requires `build:templates` to have been run first (the generated `.docx` files are not committed; they are build output).

---

## Repository layout.

```
cybersygn/
  CONSTITUTION.md              project constitution and brand voice
  DEPLOY.md                    step-by-step deployment guide
  README.md                    this file
  package.json                 dev dependencies and scripts

  worker/                      Cloudflare Worker source
    src/
      index.js                 entrypoint, every endpoint
      detect.js                field detection (shared with the browser)
      storage.js               KV namespace abstraction with in-memory fallback
      email.js                 Resend abstraction with console fallback
      audit.js                 audit-certificate PDF rendering
    wrangler.jsonc             Worker config: bindings, secrets, cron trigger

  web/                         static site source
    index.html                 marketing page
    marketing.js               founding-member form handler
    styles.css                 full design system, shared by every page

    brand/                     committed brand assets (logo, lockup, favicons, OG card)
      lockup-navy.png          master lockup, navy on transparent
      lockup-white.png         master lockup, white on transparent
      lockup-*@2x.png          480px web-ready retina variants
      mark-*.png               S-mark only, both color variants
      favicon-*.png            16, 32, 180 px PNG favicons
      favicon.ico              multi-resolution ICO (16+32+48)
      og-image.png             1200x630 social-sharing card

    vendor/                    self-hosted runtime assets (regenerated by `npm run vendor`)
      pdf.mjs                  pdf.js main module
      pdf.worker.mjs           pdf.js worker module
      pdf-lib.mjs              pdf-lib for client-side flatten
      mammoth.browser.min.js   mammoth for .docx ingestion
      fonts.css                @font-face declarations
      fonts/                   Fraunces, Inter, JetBrains Mono woff2 files

    preview/                   the PDF preview + signing experience
      index.html               drop-zone + page strip + sidebar
      app.js                   main client app
      detect.js                build-time copy of worker/src/detect.js
      signing.js               signature pad, modals, pdf-lib flatten
      signers.js               multi-signer assignment, perspective store
      api.js                   thin client over the Worker endpoints
      identity.js              localStorage sender + workspace state

    dashboard/                 sender dashboard
      index.html               doc list, workspace switcher, identity backup
      app.js                   dashboard logic, workspace management modal
      join.html                invite acceptance page

    dist/                      build output (regenerated by `npm run build`)

  scripts/                     dev + ci tooling
    build-web.js               builds web/dist/ from web/ + worker/src/detect.js
    vendor.js                  copies pdf.js, pdf-lib, mammoth, fonts from node_modules
    serve-web.js               local dev server
    run-detection.js           synthetic PDF detection harness
    run-real-detection.js      real-document detection harness
    test-multi-signer.js       end-to-end Worker tests
    test-docx-pipeline.js      docx ingestion pipeline tests
    generate-templates.js      builds templates/generated/ from agreements/
    gen-brand-derivatives.py   regenerates favicon/og/sized variants from master logos
    generate-sample-audit.js   renders sample-audit.pdf
    generate-pdfs.py           creates the synthetic test PDFs

  templates/                   curated contract template library
    agreements/                source modules (one per template)
    generated/                 built .docx files (regenerated by build:templates)
    README.md                  user-facing library overview
    TEMPLATE-LIBRARY-SPEC.md   architecture and governance
    TEMPLATE-INVENTORY.md      triage of third-party inbound templates
    STYLE-GUIDE.md             how to write a CyberSygn-voice template

  test-pdfs/                   10 synthetic test PDFs (regression set)
  real-pdfs/                   37 real-world contracts (regression set)
  sample-audit.pdf             example audit certificate
```

---

## Test results.

The shipping prototype currently passes:

| Suite                  | Result                |
| ---------------------- | --------------------- |
| Synthetic detection    | 10/10                 |
| Real-document detection| 37/37 (100%)          |
| End-to-end Worker      | 141/141 assertions    |
| Docx ingestion         | 9/9 assertions        |
| Template round-trip    | 3/3 templates         |

---

## Brand voice.

CyberSygn is the engineer who automated their own paperwork. Direct. Confident. Sentence case. Periods on headlines. No em-dashes. Never the words "envelope," "workflow," "smart," "intuitive," "magical," or "seamless." Palette: cool paper (#F7F8FB), deep navy (#011434), electric cyan (#00CBF6). Logo is the CYBERSYGN lockup (S-mark plus all-caps wordmark, navy on light, white on dark). Typography: Inter (300/400/500/600/700) for display and body, JetBrains Mono for technical labels. Fraunces is bundled but used only for the audit certificate's serif rendering.

See [CONSTITUTION.md](./CONSTITUTION.md) Section 4 for the full design system.
