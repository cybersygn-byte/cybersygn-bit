# Template inventory triage.

This document categorizes the 36 third-party templates that were uploaded as raw material for the CyberSygn template library. Every file is sorted into one of three buckets: REBUILD (concept worth covering, write from scratch), DISCARD (do not use), or REDUNDANT (covered by a better entry elsewhere).

Bottom line: **zero files in the upload will be used directly.** Every CyberSygn template is written from primary, freely-redistributable sources in CyberSygn voice. The upload served as a survey of which contract types are commonly requested. That was its only function.

## Why nothing is used directly.

Two reasons block direct use of any uploaded file:

1. **Competitor provenance.** All thirty-five of the lowercase-named .docx files (accounting-contract.docx, agency-agreement-template.docx, etc.) contain SignWell branding embedded as base64-encoded PNG images in their internal XML. SignWell is a direct competitor in the e-signature market. Using their templates as the basis of ours, even rebranded, creates both copyright exposure and competitive contamination.

2. **Institutional ownership.** Files prefixed with `HU` or containing `HUHC` are Howard University internal templates. These are the property of that institution and are not licensed for redistribution by us.

The remaining files have unclear provenance but exhibit the same content patterns as the competitor-branded set, suggesting they were sourced from the same template aggregators.

## REBUILD category.

These contract types are worth covering in the CyberSygn template library. The list below is the *category*, not a template-by-template port. Each entry will be written from scratch using ABA model forms, state bar association templates, and public-domain sources. Estimated effort is per-template; total library buildout depends on prioritization.

| Category | Source files (discarded) | Notes |
|----------|--------------------------|-------|
| Mutual NDA | non-disclosure-agreement-templates.docx, Confidentiality and Non-Disclosure Agreement (Locked).docx | Highest-priority Phase 1 template. Shipped as `nda-mutual.js`. |
| Independent Contractor Agreement | independent_contractor_agreement.docx, consulting-agreement.docx, retainer_agreement_monthly.docx | Phase 1. Shipped as `independent-contractor.js`. |
| General Services Agreement | service_contract_template.docx, sales_contract.docx, commission_agreement.docx | Phase 1. Shipped as `services-agreement.js`. |
| Employment Agreement | employment-contract.docx | Phase 2. Requires more attorney review than a services agreement because of jurisdiction-sensitive at-will clauses. |
| Sublease Agreement | sublease_agreement.docx, basic-rental-agreement.docx | Phase 2. Jurisdiction-sensitive; templates should explicitly direct user to state-specific landlord-tenant law. |
| Marketing Services Agreement | marketing-agreement.docx, agency-agreement-template.docx | Phase 2. Variant of services agreement. |
| Web Design Agreement | web-design-contracts.docx, graphic-design-contracts.docx | Phase 2. Variant of services agreement with IP-ownership clause customized for creative work. |
| Photo / Likeness Release | photo-release-forms.docx | Phase 2. Single-signer release form, different shape from contracts. |
| Coaching Services Agreement | coaching-contract.docx | Phase 3. Niche but commonly requested. |
| Intellectual Property Assignment | intellectual-property-agreement.docx | Phase 3. Significant attorney review required. |
| Subcontractor Agreement | subcontractor_agreement.docx | Phase 3. Variant of services agreement layered on top of a prime contract. |
| Catering / Event Services | catering-contract.docx, event_planning_contract.docx | Phase 3. Variants of services agreement with event-specific cancellation clauses. |

Total Phase 1 templates: 3. Total Phase 2 templates: 6. Total Phase 3 templates: 4. Library target at maturity: roughly 15 templates across all phases. The remaining categories (bookkeeping, accounting, painting, remodeling, construction, dj, indemnification) collapse into the General Services or Subcontractor Agreement with party-role substitution, and don't need standalone templates.

## DISCARD category.

These files must not be used as reference material, must not be added to the regression corpus, and should not influence template content.

| File | Reason |
|------|--------|
| All `HU_*` and `*HUHC*` files (7 total) | Howard University institutional property. |
| Construction Professional Srvs K - Official Form 2021.doc | Old Word binary format, also institutional naming pattern (HU). |
| Facilities Use Agreement V3 2025 (Form Locked)_0.docx | Same institutional pattern. |
| Master Agreement for Goods and or Services 2024 - V4 (locked)_0.docx | Institutional sister of the HUHC version. |
| Srvcs for HU Consulting K Template - Official Form 2026.docx | Institutional. |
| Limited License TM & Copyright (multi-use) 2026-b [UNLOCKED].docx | Provenance unclear. The "UNLOCKED" annotation suggests it was distributed with usage restrictions that someone deliberately removed; do not touch. |

## REDUNDANT category.

These contract types are absorbed into broader categories rather than getting standalone templates.

| File | Absorbed into |
|------|---------------|
| accounting-contract.docx | General Services Agreement (with "Accountant" party role) |
| bookkeeping-contract-template.docx | General Services Agreement |
| painting-contract.docx | General Services Agreement |
| remodeling_contract.docx | General Services Agreement |
| construction-contract.docx | General Services Agreement |
| dj-contract.docx | Event Services variant of General Services Agreement |
| indemnification-agreement.docx | Folded into Hold Harmless clauses in other templates rather than standalone |

## What the upload was useful for.

Three things, all of which are now done:

1. **Detector regression coverage.** The 11 net-new PDFs were added to `real-pdfs/` with new `EXPECTED` entries in `scripts/run-real-detection.js`. The detector now covers 37 documents at 92% pass rate.
2. **Docx pipeline validation.** Running all 35 .docx files through the docx-to-PDF on-ramp confirmed the pipeline handles the full range of real-world Word documents, including ones with locked form fields, embedded images, and non-WinAnsi typography.
3. **Category survey.** Knowing which contract types are commonly requested (because they appear in template aggregator catalogs) informs the Phase 1, 2, 3 prioritization above.

Nothing else from the upload survives into the shipping product.
