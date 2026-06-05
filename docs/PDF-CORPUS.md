# Open-source PDF corpus for CyberSygn detection training

CyberSygn's detection engine is heuristic today and ML-trained at Phase 3
(once the user-contributed corpus crosses 5,000 examples). To get there
faster, and to honestly say "we've seen 12,000 contracts" on the homepage,
we need a free, license-clean, real-world PDF corpus.

This document inventories what's actually available, what's worth using,
and the workflow for pulling a curated subset into our training pipeline.

## The big sources (ranked by signal-per-megabyte)

### 1. SEC EDGAR — best signal for contracts ★★★★★

URL: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany
API: https://data.sec.gov/

The U.S. Securities and Exchange Commission requires public companies
to file all "material contracts" as exhibits to their 10-K, 10-Q, and
8-K filings. These are real signed contracts: MSAs, employment
agreements, consulting agreements, partnership agreements, vendor
contracts. Most are signed PDFs with visible signature blocks, dates,
and initials.

Licensing: U.S. government, public domain, no restrictions.

Sample search: https://www.sec.gov/cgi-bin/srqsb?text=form-type%3D10-K+%22Exhibit+10%22

Useful filing types:
- **10-K Exhibit 10**: material contracts (NDAs, MSAs, vendor, employment)
- **8-K Exhibit 10**: newly executed contracts
- **DEF 14A**: proxy statements (signature-rich)

Approach: pull a curated sample of 200-500 filings via the EDGAR API,
extract the PDF exhibits, run them through our detection regression
suite. Add the ones with cleanly-detected fields to our training
corpus.

### 2. GovInfo.gov — public federal documents ★★★★☆

URL: https://www.govinfo.gov/

Federal contracts, court documents, regulations. All public domain.
The "Compilation of Presidential Documents" and federal court records
include thousands of signed PDFs.

Useful collections:
- **CCAL**: Code of Federal Regulations (signature-light, but layout-rich)
- **PRES**: Presidential documents (signed)
- **USCOURTS**: Court filings (signature-heavy, real contracts)
- **CHRG**: Congressional hearings (testimony signatures)

Licensing: U.S. government, public domain.

### 3. PubLayNet — layout-labeled academic PDFs ★★★☆☆

URL: https://github.com/ibm-aur-nlp/PubLayNet

IBM Research, 360,000 PDF pages from PubMed Central. Each page is
labeled with layout regions (title, list, table, figure, text).

License: CC-BY 4.0 (commercial use allowed with attribution).

Useful for: training a layout-detection model. Less useful for
signature-field detection specifically (academic papers don't have
signature blocks).

### 4. DocBank — labeled academic PDFs ★★★☆☆

URL: https://github.com/doc-analysis/DocBank

Microsoft Research, 500,000 PDFs from arXiv with token-level labels.

License: Apache 2.0.

Same caveat as PubLayNet — academic, no signature blocks. Useful for
general document-structure understanding.

### 5. FUNSD — Form Understanding in Noisy Scanned Documents ★★★★☆

URL: https://guillaumejaume.github.io/FUNSD/

199 fully annotated noisy scanned forms with key-value labels. Small
but very high quality. Designed exactly for our problem class.

License: research-only (CC-BY-NC).

Useful for: training a form-field detector. We can use it for
research/validation but cannot redistribute as a CyberSygn-branded
training set.

### 6. RVL-CDIP — document classification ★★★☆☆

URL: https://www.cs.cmu.edu/~aharley/rvl-cdip/

400,000 grayscale images of business documents in 16 classes
(invoice, letter, form, memo, etc.).

License: research-only.

### 7. arXiv bulk download ★★☆☆☆

URL: https://arxiv.org/help/bulk_data

Millions of academic PDFs. License is the original author's, often
CC-BY or similar. Same caveat as PubLayNet.

### 8. Common Crawl PDF subset ★★★☆☆

URL: https://commoncrawl.org/

Common Crawl indexes billions of web pages including millions of PDFs.
The CCPDF subset extracts these.

License: varies by source page; most are accessible but not necessarily
redistributable.

### 9. GitHub contract template repos ★★★★☆

Various open-source repositories collect contract templates:

- **SAFE templates** (Y Combinator): https://www.ycombinator.com/documents
- **Common Paper**: https://commonpaper.com/
- **MSA Open**: https://github.com/openchecklist/legal
- **GitLab "open source contracts"** at https://about.gitlab.com/handbook/legal/

License: usually MIT or CC0 for the template; clean for both training
and redistribution.

Useful for: synthetic-test PDF generation (fill the templates with
fake but plausible data, render to PDF, use as training/regression).

### 10. Contract Standards (CommonLaw) ★★★★☆

URL: https://www.contractstandards.com/

Open-source contract clauses and templates. CC-BY.

## Recommended ingestion pipeline

For Phase 3 ML training:

1. **Pull SEC EDGAR 10-K Exhibit 10s** (200-500 filings) — most realistic
   contracts in the corpus. Public domain.
2. **Pull SAFE templates and Common Paper templates** (30-50 documents) —
   clean, well-structured, useful for synthetic-augmentation.
3. **Add GovInfo Presidential documents** (50 documents) — signature-rich,
   public domain.
4. **Generate 200-500 synthetic PDFs** by filling open-source templates
   with plausible random data.

Total: ~500-1000 high-signal training PDFs from license-clean sources.
Combined with user-contributed PDFs from CyberSygn's free tier (which
will reach 5,000 by month 8-12 at current signup velocity), the
training set will cross the Phase 3 threshold.

## The homepage gallery

Independent of ML training, we can show 5-10 sample PDFs on the
homepage as proof of capability: "Here are real-world contracts the
system handles." Source these from:

- SEC EDGAR 10-K Exhibit 10 (real corporate contracts)
- SAFE template (startup investor agreement)
- Common Paper MSA template
- Open Coaching Contract template
- GovInfo federal vendor agreement

License-clean, real-world, shippable to dist/.

See `scripts/discover-pdf-corpus.mjs` for the discovery script.

## What we DON'T do

- Train on user-uploaded PDFs without explicit consent (free-tier users
  consent at signup; paid-tier users opt out by default).
- Redistribute any PDF whose source license requires attribution we
  can't honor on a homepage gallery.
- Train on copyrighted material from books, journals, or paid
  publications.

Privacy and licensing are not negotiable. The corpus is small and
clean, not big and dirty.
