#!/usr/bin/env node
/**
 * CyberSygn template generator.
 *
 * Reads every template module in `templates/agreements/`, validates it
 * against the brand rules, and writes a branded .docx file to
 * `templates/generated/` for each one. Idempotent: safe to rerun.
 *
 * Brand rule enforcement is non-negotiable. Templates that violate the
 * em-dash ban fail the build with a non-zero exit code, naming the
 * offending template. There is no override flag.
 *
 * Run:
 *   npm run build:templates
 *
 * Verify a single template detects cleanly through the existing
 * pipeline:
 *   node scripts/test-docx-pipeline.js
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
  Footer,
} from 'docx';

import { TEMPLATES } from '../templates/agreements/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'templates', 'generated');

// ----- Brand-rule validation ------------------------------------------------

function collectStrings(block) {
  // Walk a body block and collect every user-visible string for
  // brand-rule scanning. Structural fields (type, level, role, fields)
  // are skipped; text fields are collected.
  const out = [];
  if (typeof block === 'string') return [block];
  if (!block || typeof block !== 'object') return out;
  if (block.text) out.push(block.text);
  if (block.heading) out.push(block.heading);
  if (Array.isArray(block.paragraphs)) {
    for (const p of block.paragraphs) out.push(p);
  }
  if (Array.isArray(block.parties)) {
    for (const party of block.parties) {
      if (party.role) out.push(party.role);
    }
  }
  return out;
}

function validateTemplate(tpl) {
  const errors = [];
  // Required fields.
  const required = ['id', 'version', 'title', 'category', 'partyRoles', 'signatureCount', 'body'];
  for (const f of required) {
    if (tpl[f] === undefined || tpl[f] === null) errors.push(`missing required field: ${f}`);
  }
  // Em-dash ban.
  for (const block of tpl.body || []) {
    for (const str of collectStrings(block)) {
      if (str.includes('\u2014')) {
        errors.push(`em-dash found in template body: "${str.slice(0, 80)}..."`);
      }
    }
  }
  // Banned words from CONSTITUTION.md section 4.
  const BANNED = ['envelope', 'workflow', 'seamless', 'magical', 'intuitive'];
  for (const block of tpl.body || []) {
    for (const str of collectStrings(block)) {
      const lower = str.toLowerCase();
      for (const word of BANNED) {
        // Word-boundary match to avoid false-positives on substrings.
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (re.test(lower)) {
          errors.push(`banned brand-voice word "${word}" found in: "${str.slice(0, 80)}..."`);
        }
      }
    }
  }
  // Signature block must match declared signatureCount.
  const sigBlocks = (tpl.body || []).filter(b => b && b.type === 'signatureBlock');
  if (sigBlocks.length !== 1) {
    errors.push(`expected exactly 1 signatureBlock, found ${sigBlocks.length}`);
  } else {
    const partyCount = (sigBlocks[0].parties || []).length;
    if (partyCount !== tpl.signatureCount) {
      errors.push(`signatureCount=${tpl.signatureCount} but signatureBlock declares ${partyCount} parties`);
    }
  }
  return errors;
}

// ----- Docx rendering -------------------------------------------------------

// Brand colors from CONSTITUTION.md section 4. Word can render hex colors
// in text runs and paragraph properties, but not as the full design-system
// theming you get on the web. The output reads as CyberSygn voice through
// typography and spacing, not through saturated color.
//
// Colors sampled from the actual CYBERSYGN logo PNG. Navy is the
// primary text/ink color; cyan is the lightning-accent color used in
// the lockup's S-mark.
const COLOR_TEXT = '011434';        // navy, sampled from logo
const COLOR_ACCENT = '00CBF6';      // electric cyan, sampled from logo
const COLOR_MUTED = '6B7280';       // gray for fine print

// Long underscore run for signature fields. Wide enough to be unambiguous
// to the detector (matches the >=30-char rule from the style guide) and
// to give an offline signer room to actually sign.
const UNDERSCORE_RUN = '_'.repeat(45);

function renderTitle(text) {
  // Brand wordmark at the head of every template. "CYBERSYGN" set in
  // caps with letter-spacing matches the logo lockup. The trailing
  // accent character is dropped: the cap-form wordmark is its own
  // terminator visually, the way the previous "Cyber/Sygn." treatment
  // used the dot.
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 400 },
    children: [
      new TextRun({
        text: 'CYBERSYGN',
        bold: true,
        color: COLOR_TEXT,
        size: 36,
        characterSpacing: 8,
      }),
    ],
  });
}

function renderDocTitle(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 200, after: 400 },
    children: [new TextRun({ text, bold: true, size: 32, color: COLOR_TEXT })],
  });
}

function renderClauseHeading(text) {
  return new Paragraph({
    spacing: { before: 320, after: 160 },
    children: [new TextRun({ text, bold: true, size: 24, color: COLOR_TEXT })],
  });
}

function renderParagraph(text) {
  return new Paragraph({
    spacing: { before: 0, after: 160, line: 320 },
    alignment: AlignmentType.JUSTIFIED,
    children: [new TextRun({ text, size: 22, color: COLOR_TEXT })],
  });
}

function renderSpacer() {
  return new Paragraph({ spacing: { before: 240, after: 240 }, children: [] });
}

function renderPartyRole(role) {
  return new Paragraph({
    spacing: { before: 320, after: 120 },
    children: [new TextRun({ text: role, bold: true, size: 22, color: COLOR_TEXT })],
  });
}

function renderSignatureField(label) {
  // Layout: "Signed:\t<long underscore run>"
  // The tab gives the detector a clear column separator and keeps the
  // underscore runs aligned across all fields in the block.
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [
      new TextRun({ text: `${label}:`, size: 22, color: COLOR_TEXT }),
      new TextRun({ text: `\t${UNDERSCORE_RUN}`, size: 22, color: COLOR_TEXT }),
    ],
  });
}

function renderSignatureBlock(block) {
  const out = [];
  for (let i = 0; i < block.parties.length; i++) {
    const party = block.parties[i];
    if (i > 0) out.push(renderSpacer());
    out.push(renderPartyRole(party.role));
    for (const field of party.fields) {
      out.push(renderSignatureField(field));
    }
  }
  return out;
}

function renderBody(tpl) {
  const out = [renderTitle()];
  for (const block of tpl.body) {
    if (block.type === 'title') {
      out.push(renderDocTitle(block.text));
    } else if (block.type === 'paragraph') {
      if (block.style === 'spacer') out.push(renderSpacer());
      out.push(renderParagraph(block.text));
    } else if (block.type === 'clause') {
      out.push(renderClauseHeading(block.heading));
      for (const p of block.paragraphs) {
        out.push(renderParagraph(p));
      }
    } else if (block.type === 'signatureBlock') {
      out.push(...renderSignatureBlock(block));
    }
  }
  return out;
}

const DISCLAIMER_TEXT =
  'This template is provided by CyberSygn as a starting point. ' +
  'It is not legal advice and does not create an attorney-client relationship. ' +
  'Laws vary by jurisdiction and by situation. ' +
  'Review with a licensed attorney before signing.';

function renderFooter(tpl) {
  // The footer carries the disclaimer plus template versioning so the
  // user can identify which version of which template they downloaded.
  const stamp = `${tpl.id} v${tpl.version}  |  generated ${new Date().toISOString().slice(0, 10)}`;
  return new Footer({
    children: [
      new Paragraph({
        spacing: { before: 0, after: 60 },
        children: [
          new TextRun({ text: DISCLAIMER_TEXT, italics: true, size: 16, color: COLOR_MUTED }),
        ],
      }),
      new Paragraph({
        spacing: { before: 0, after: 0 },
        children: [new TextRun({ text: stamp, size: 14, color: COLOR_MUTED })],
      }),
    ],
  });
}

async function buildTemplate(tpl) {
  const errors = validateTemplate(tpl);
  if (errors.length > 0) {
    const msg = `Template "${tpl.id}" failed brand-rule validation:\n  - ${errors.join('\n  - ')}`;
    throw new Error(msg);
  }
  const doc = new Document({
    creator: 'CyberSygn',
    title: tpl.title,
    description: tpl.description,
    sections: [
      {
        properties: {},
        children: renderBody(tpl),
        footers: { default: renderFooter(tpl) },
      },
    ],
  });
  const bytes = await Packer.toBuffer(doc);
  return bytes;
}

async function main() {
  console.log('CyberSygn template generator');
  console.log(`  target: ${OUT_DIR}`);
  console.log(`  templates: ${TEMPLATES.length}`);
  console.log('');

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  let ok = 0;
  let fail = 0;
  for (const tpl of TEMPLATES) {
    try {
      const bytes = await buildTemplate(tpl);
      const out = join(OUT_DIR, `${tpl.id}.docx`);
      await writeFile(out, bytes);
      const flag = tpl.reviewedBy ? '' : '  [PREVIEW: not attorney-reviewed]';
      console.log(`  built ${tpl.id} v${tpl.version}  (${bytes.length} bytes)${flag}`);
      ok += 1;
    } catch (err) {
      console.error(`  FAILED ${tpl.id}: ${err.message}`);
      fail += 1;
    }
  }

  console.log('');
  console.log(`${ok} built, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('generator failed:', err);
  process.exit(1);
});
