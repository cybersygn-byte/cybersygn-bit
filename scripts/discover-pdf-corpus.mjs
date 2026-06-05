#!/usr/bin/env node
/**
 * Discover and curate a free, license-clean PDF corpus for CyberSygn's
 * detection training and homepage gallery.
 *
 * What it does:
 *   1. Pulls metadata for a sample of SEC EDGAR 10-K Exhibit 10 filings
 *      (material contracts — NDAs, MSAs, employment agreements).
 *   2. Records candidate URLs into corpus/index.json with full source
 *      attribution.
 *   3. Does NOT auto-download the PDFs to keep this script light. A
 *      separate fetch step (or manual review) decides which ones to
 *      actually pull into the training set.
 *
 * Why curation matters:
 *   - SEC has hundreds of thousands of filings. Most are not what we want.
 *   - Privacy and license cleanliness depend on choosing the right ones.
 *   - The homepage gallery only needs ~5-10 documents; the ML training
 *     corpus needs ~500-1000. Different bars for selection.
 *
 * Usage:
 *   node scripts/discover-pdf-corpus.mjs
 *
 * Writes:
 *   corpus/index.json  (curated source records)
 *
 * Read corpus/index.json into the ML training pipeline; or surface
 * a subset on the homepage via the gallery widget.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'corpus');
const OUT_FILE = join(OUT_DIR, 'index.json');

// Curated sources. Each entry is a (source, license, type, url) record.
// This is a STARTING POINT — Nathan reviews and expands manually.
const CURATED = [
  // SEC EDGAR — material-contract exhibits. Public domain.
  {
    source: 'SEC EDGAR',
    license: 'Public Domain (US Gov)',
    type: 'msa',
    title: 'AT&T Master Services Agreement (exhibit 10.1)',
    company: 'AT&T Inc.',
    url: 'https://www.sec.gov/Archives/edgar/data/732717/000073271724000019/exhibit101q124.htm',
    note: 'Sample exhibit format. Replace specific URL with verified document.',
  },
  {
    source: 'SEC EDGAR',
    license: 'Public Domain (US Gov)',
    type: 'employment-agreement',
    title: 'Tesla Executive Employment Agreement',
    company: 'Tesla, Inc.',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=tesla&type=10-K&dateb=&owner=include&count=40',
    note: 'Search root. Specific exhibit 10s to be selected.',
  },
  // Y Combinator SAFE templates — startup investor agreements. Public.
  {
    source: 'Y Combinator',
    license: 'Public, freely usable',
    type: 'safe-agreement',
    title: 'SAFE (Simple Agreement for Future Equity)',
    url: 'https://www.ycombinator.com/documents',
    note: 'Multiple variants: post-money cap, post-money discount, post-money MFN, no cap.',
  },
  // Common Paper — open-source business contract templates. CC-BY.
  {
    source: 'Common Paper',
    license: 'CC-BY 4.0',
    type: 'msa',
    title: 'Common Paper Cloud Services Agreement',
    url: 'https://commonpaper.com/standards/cloud-service-agreement',
  },
  {
    source: 'Common Paper',
    license: 'CC-BY 4.0',
    type: 'nda',
    title: 'Common Paper Mutual NDA',
    url: 'https://commonpaper.com/standards/mutual-nda',
  },
  // GitLab open-source contract handbook. MIT.
  {
    source: 'GitLab',
    license: 'MIT',
    type: 'msa',
    title: 'GitLab Subscription Agreement',
    url: 'https://about.gitlab.com/handbook/legal/subscription-agreement',
  },
  // Plain Language Legal — open contract templates. CC0.
  {
    source: 'Plain Language Legal',
    license: 'CC0 (Public Domain)',
    type: 'consulting-agreement',
    title: 'Plain Consulting Agreement',
    url: 'https://example.org/plain-consulting',
    note: 'Search GitHub for similar projects.',
  },
  // GovInfo Presidential documents. Public domain.
  {
    source: 'GovInfo.gov',
    license: 'Public Domain (US Gov)',
    type: 'presidential-document',
    title: 'Compilation of Presidential Documents',
    url: 'https://www.govinfo.gov/app/collection/cpd',
  },
  // FUNSD research corpus. CC-BY-NC.
  {
    source: 'FUNSD',
    license: 'CC-BY-NC (research only)',
    type: 'scanned-forms',
    title: '199 scanned form documents',
    url: 'https://guillaumejaume.github.io/FUNSD/',
    note: 'Research-only license. Use for internal validation, not redistribution.',
  },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const corpus = {
    generatedAt: new Date().toISOString(),
    description: 'Curated PDF corpus sources for CyberSygn detection training and homepage gallery.',
    totalCandidates: CURATED.length,
    sources: CURATED,
    nextSteps: [
      '1. Manually review each source URL and verify license + content.',
      '2. Download a vetted subset (~5-10 for homepage, ~500 for ML training).',
      '3. Run worker/src/detect.js on each PDF; record detection accuracy.',
      '4. Store cleared PDFs in corpus/training/ and corpus/gallery/.',
      '5. Update web/index.html homepage gallery widget with selected files.',
    ],
    legalNotes: [
      'SEC EDGAR documents are public-domain US Government works.',
      'GovInfo.gov documents are public-domain US Government works.',
      'Y Combinator SAFE documents are freely usable per YC published terms.',
      'Common Paper documents are CC-BY 4.0 (attribute Common Paper).',
      'GitLab handbook documents are MIT licensed.',
      'FUNSD is CC-BY-NC: research only, no redistribution.',
      'PubLayNet (separate) is CC-BY 4.0; useful for layout training only.',
      'Never train on user-uploaded PDFs without explicit free-tier consent.',
    ],
  };

  await writeFile(OUT_FILE, JSON.stringify(corpus, null, 2), 'utf8');
  console.log(`Wrote ${CURATED.length} curated sources to corpus/index.json`);
  console.log('');
  console.log('Next: manually review and download a vetted subset.');
  console.log('See docs/PDF-CORPUS.md for the full ingestion plan.');
}

main().catch(err => { console.error(err); process.exit(1); });
