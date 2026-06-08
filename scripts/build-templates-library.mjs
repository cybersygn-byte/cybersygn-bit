#!/usr/bin/env node
/**
 * Regenerate scripts/templates-library.json from the catalog + authored content.
 *
 * For every catalog entry that has an authored templates-content/<slug>.md AND a
 * rendered web/templates-pdf/<slug>.pdf, emit a full library entry: the tile copy,
 * SEO metadata, the real section list (pulled from the authored markdown headings),
 * the intro blurb (pulled from the authored intro), sensitivity, and staticPdf:true
 * so the worker serves the pre-rendered PDF instead of generating a wireframe.
 *
 * Entries without authored content are omitted, so the live library only ever shows
 * templates that actually exist at the bar. This is what keeps the "owned count"
 * honest (Constitution 1.13/1.14).
 *
 * Run: node scripts/build-templates-library.mjs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CATALOG = join(HERE, 'templates-catalog.json');
const CONTENT = join(ROOT, 'templates-content');
const PDFS = join(ROOT, 'web', 'templates-pdf');
const OUT = join(HERE, 'templates-library.json');

const ICONS = {
  'business-commercial': '📋', 'business-deal-mechanics': '🤝',
  'confidentiality-ip': '🔒', 'employment-hr': '💼', 'employment-hr-extended': '💼',
  'real-estate': '🏠', 'real-estate-extended': '🏠', 'creative-media': '🎨',
  'creative-media-extended': '🎬', 'freelance-services': '🧑‍💻', 'finance-lending': '💵',
  'finance-lending-extended': '💵', 'sales-goods': '🛒', 'construction-trades': '🔨',
  'events-hospitality': '🎟️', 'personal-family': '👪', 'tech-data': '💾',
  'tech-data-extended': '💾', 'nonprofit-membership': '🎗️', 'waivers-releases': '📝',
  'waivers-extended': '📝', 'letters-notices': '✉️', 'specialized-industry': '🏢',
  'professional-practice': '⚖️', 'agriculture-land': '🌾',
};

// Friendly, consolidated filter groups for the public library page. The catalog
// has ~24 fine-grained categories (incl. "-extended" splits); collapse them into
// a clean, browsable set of top-level groups with human labels.
const GROUPS = {
  'business-commercial':    { key: 'business',        label: 'Business' },
  'business-deal-mechanics':{ key: 'business',        label: 'Business' },
  'confidentiality-ip':     { key: 'confidentiality', label: 'Confidentiality & IP' },
  'employment-hr':          { key: 'employment',      label: 'Employment & HR' },
  'employment-hr-extended': { key: 'employment',      label: 'Employment & HR' },
  'real-estate':            { key: 'real-estate',     label: 'Real Estate' },
  'real-estate-extended':   { key: 'real-estate',     label: 'Real Estate' },
  'creative-media':         { key: 'creative',        label: 'Creative & Media' },
  'creative-media-extended':{ key: 'creative',        label: 'Creative & Media' },
  'freelance-services':     { key: 'freelance',       label: 'Freelance' },
  'finance-lending':        { key: 'finance',         label: 'Finance & Lending' },
  'finance-lending-extended':{ key: 'finance',        label: 'Finance & Lending' },
  'sales-goods':            { key: 'sales',           label: 'Sales & Goods' },
  'construction-trades':    { key: 'construction',    label: 'Construction & Trades' },
  'events-hospitality':     { key: 'events',          label: 'Events & Hospitality' },
  'personal-family':        { key: 'personal',        label: 'Personal & Family' },
  'tech-data':              { key: 'tech',            label: 'Tech & Data' },
  'tech-data-extended':     { key: 'tech',            label: 'Tech & Data' },
  'nonprofit-membership':   { key: 'nonprofit',       label: 'Nonprofit & Membership' },
  'waivers-releases':       { key: 'waivers',         label: 'Waivers & Releases' },
  'waivers-extended':       { key: 'waivers',         label: 'Waivers & Releases' },
  'letters-notices':        { key: 'letters',         label: 'Letters & Notices' },
  'specialized-industry':   { key: 'specialized',     label: 'Specialized Industry' },
  'professional-practice':  { key: 'professional',    label: 'Professional Practice' },
  'agriculture-land':       { key: 'agriculture',     label: 'Agriculture & Land' },
};
function groupFor(cat) { return GROUPS[cat] || { key: cat, label: cat.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }; }

function sectionsFromMd(md) {
  return (md.match(/^##\s+(.+)$/gm) || []).map(h => h.replace(/^##\s+/, '').trim());
}

function introFromMd(md) {
  // First normal paragraph after the recitals marker, fall back to first para.
  const afterRule = md.split(/\n---\n/).slice(1).join('\n---\n') || md;
  const paras = afterRule.split(/\n\s*\n/).map(s => s.trim())
    .filter(s => s && !s.startsWith('#') && !s.startsWith('>') && !s.startsWith('|') && !s.startsWith('*') && s !== '---');
  const recital = paras.find(p => /^\*\*Recitals/.test(p)) || paras[0] || '';
  return recital.replace(/\*\*/g, '').replace(/\s+/g, ' ').replace(/\[[^\]]+\]/g, '___').slice(0, 320).trim();
}

async function main() {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const entries = [];
  let withContent = 0, withPdf = 0;

  for (const t of catalog.templates) {
    const mdPath = join(CONTENT, t.slug + '.md');
    const pdfPath = join(PDFS, t.slug + '.pdf');
    const hasMd = existsSync(mdPath);
    const hasPdf = existsSync(pdfPath);
    if (hasMd) withContent++;
    if (hasPdf) withPdf++;
    if (!hasMd || !hasPdf) continue; // only ship templates that fully exist

    const md = await readFile(mdPath, 'utf8');
    const sections = sectionsFromMd(md);
    const blurb = introFromMd(md);
    const grp = groupFor(t.category);
    entries.push({
      slug: t.slug,
      title: t.title,
      category: t.category,
      group: grp.key,
      groupLabel: grp.label,
      icon: ICONS[t.category] || '📄',
      sensitivity: t.sensitivity,
      shortDescription: t.subtitle,
      metaDescription: `Free ${t.title} template from CyberSygn. ${t.subtitle} A complete, customizable starting draft you can download or sign online. Not legal advice.`,
      primaryKeyword: `${t.title.toLowerCase()} template`,
      longBlurb: blurb || t.subtitle,
      sections,
      staticPdf: true,
    });
  }

  const out = {
    _meta: {
      purpose: 'CyberSygn owned template library. Generated from templates-catalog.json + authored content.',
      bar: 'Constitution 1.13/1.14 — every entry is a complete, professionally drafted, customizable starting draft with attorney-review framing.',
      disclaimer: 'Every template carries a top callout and footer: not legal advice, CyberSygn is not a law firm, consult a licensed attorney.',
      ownedCount: entries.length,
    },
    templates: entries,
  };
  await writeFile(OUT, JSON.stringify(out, null, 2));

  // Compact, web-servable list the public /templates/ page fetches to render all
  // 500+ cards + build its category filter from real data (no hardcoded array).
  const WEB_OUT = join(ROOT, 'web', 'templates-data.json');
  const webList = entries
    .map(e => ({ slug: e.slug, title: e.title, group: e.group, groupLabel: e.groupLabel, short: e.shortDescription }))
    .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.title.localeCompare(b.title));
  await writeFile(WEB_OUT, JSON.stringify({ ownedCount: webList.length, templates: webList }));

  console.log(`Catalog: ${catalog.templates.length} | authored md: ${withContent} | rendered pdf: ${withPdf}`);
  console.log(`Library entries emitted (md + pdf both present): ${entries.length}`);
  console.log(`Wrote web/templates-data.json (${webList.length} entries for the public library page).`);
}

main().catch(e => { console.error(e); process.exit(1); });
