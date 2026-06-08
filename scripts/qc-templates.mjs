#!/usr/bin/env node
/**
 * QC validator for authored template content.
 *
 * Reads every templates-content/<slug>.md against the catalog and enforces the
 * Constitution 1.13 / 1.14 quality bar. A template PASSES only if it clears
 * every check. Anything that fails is listed with the specific reason so it
 * can be re-authored before it goes live.
 *
 * Run: node scripts/qc-templates.mjs
 * Exit code 0 if all authored files pass, 1 otherwise.
 *
 * This does NOT validate legal correctness (no tool can). It validates
 * completeness, structure, framing, and the absence of stub/placeholder junk.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONTENT_DIR = join(ROOT, 'templates-content');
const CATALOG = join(HERE, 'templates-catalog.json');

const MIN_WORDS = 850;          // body substance floor
const MIN_SECTIONS = 7;          // numbered sections floor
// Stub markers indicate lazy, unfinished prose. NOTE: bracketed guidance like
// "[INSERT YOUR STATE'S STATUTORY WARNING]" or "[FFL NAME / TBD]" is a VALID
// fill-in placeholder (same convention as [STATE]), not a stub — so we strip all
// [BRACKETED] tokens before checking. Only bare stubs left in real prose fail.
const STUB_MARKERS = [
  'todo', 'lorem ipsum', 'insert clause here', 'placeholder text',
  'your text here', 'sample text here', 'write this section', 'fill in later',
];

function wordCount(s) {
  return (s.match(/\b[\w'-]+\b/g) || []).length;
}

function sectionCount(md) {
  // Count "## 1." / "## 2." style numbered section headings.
  return (md.match(/^##\s+\d+\./gm) || []).length;
}

function check(md, t) {
  const reasons = [];
  const lower = md.toLowerCase();
  const head = md.slice(0, 1200).toLowerCase();
  const tail = md.slice(-1200).toLowerCase();

  const words = wordCount(md);
  if (words < MIN_WORDS) reasons.push(`word count ${words} < ${MIN_WORDS}`);

  const secs = sectionCount(md);
  if (secs < MIN_SECTIONS) reasons.push(`sections ${secs} < ${MIN_SECTIONS}`);

  // Top callout
  const hasTop = head.includes('customizable starting template') ||
                 head.includes('not a finished legal document');
  if (!hasTop) reasons.push('missing top callout (customizable starting template)');

  // Footer disclaimer
  const hasFooter = (tail.includes('not legal advice')) &&
                    (tail.includes('not a law firm'));
  if (!hasFooter) reasons.push('missing footer disclaimer (not legal advice / not a law firm)');

  // Placeholders
  if (!/\[[A-Z]/.test(md)) reasons.push('no [BRACKETED] placeholders');

  // Signature block
  const hasSig = /signature\s*:/i.test(md) &&
                 (/printed name/i.test(md) || /\bdate\s*:/i.test(md));
  if (!hasSig) reasons.push('no signature block');

  // Stub junk — strip [BRACKETED] placeholders first (those are valid fill-ins).
  const deBracketed = lower.replace(/\[[^\]]*\]/g, ' ');
  for (const m of STUB_MARKERS) {
    if (deBracketed.includes(m)) { reasons.push(`contains stub marker "${m}"`); break; }
  }

  // High-sensitivity stronger warning
  if (t && t.sensitivity === 'high') {
    const strong = head.includes('strongly recommend') || head.includes('significant');
    if (!strong) reasons.push('high-sensitivity: missing stronger attorney-review warning');
  }

  return { words, secs, reasons };
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const bySlug = new Map(catalog.templates.map(t => [t.slug, t]));

  if (!existsSync(CONTENT_DIR)) {
    console.error(`No templates-content/ directory yet.`);
    process.exit(1);
  }
  const files = (await readdir(CONTENT_DIR)).filter(f => f.endsWith('.md')).sort();

  let pass = 0;
  const failed = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, '');
    const t = bySlug.get(slug);
    const md = await readFile(join(CONTENT_DIR, f), 'utf8');
    const { words, secs, reasons } = check(md, t);
    if (reasons.length === 0) {
      pass += 1;
    } else {
      failed.push({ slug, words, secs, reasons });
    }
  }

  console.log(`Authored files: ${files.length} / ${catalog.templates.length} catalog entries`);
  console.log(`QC pass: ${pass}`);
  console.log(`QC fail: ${failed.length}`);
  if (failed.length) {
    console.log('');
    console.log('FAILURES:');
    for (const x of failed) {
      console.log(`  ${x.slug}  (words=${x.words} secs=${x.secs})`);
      for (const r of x.reasons) console.log(`      - ${r}`);
    }
  }
  const missing = catalog.templates.filter(t => !files.includes(t.slug + '.md'));
  console.log('');
  console.log(`Not yet authored: ${missing.length}`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
