/**
 * CyberSygn Contract Templates Library (slice 105).
 *
 * Generates a generic-structure PDF on the fly for any of the catalogued
 * templates in scripts/templates-library.json. Two delivery paths:
 *   - 'download': returns the PDF as the HTTP response body
 *   - 'email':    sends the PDF as a Resend attachment to the captured email
 *
 * Email capture flows into the free-tier drip pipeline so every template
 * download converts into a tracked lead.
 *
 * The PDFs are STRUCTURAL templates — section headings + standard
 * boilerplate slots + signature fields — explicitly marked as templates
 * and NOT legal advice. Each one includes the disclaimer:
 *   "Template provided by CyberSygn. Not legal advice. Consult a
 *    licensed attorney for your specific situation."
 *
 * The same template metadata also powers the static landing pages at
 * /templates/<slug>/ for SEO.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { deliver } from './email.js';
import { freeSignup, writeFreeTokenPointer } from './free-tier.js';
// Slug -> title map generated from scripts/templates-catalog.json (all 500+
// owned templates). Bundled into the worker so we can title the email
// subject/body for any catalogued slug, not just the legacy 16 in TEMPLATES.
// esbuild (used by wrangler) supports JSON imports natively.
import TEMPLATE_TITLES from './template-titles.json' with { type: 'json' };

const PAGE_W = 612;   // US letter
const PAGE_H = 792;
const MARGIN = 60;

// Brand colors as pdf-lib rgb tuples (0..1).
const NAVY = rgb(0.004, 0.078, 0.204);
const CYAN = rgb(0.0, 0.797, 0.965);
const INK = rgb(0.06, 0.10, 0.18);
const SOFT = rgb(0.31, 0.35, 0.47);
const LINE = rgb(0.82, 0.84, 0.89);

const DISCLAIMER =
  'Template provided by CyberSygn. Not legal advice. Consult a licensed attorney ' +
  'in your jurisdiction for guidance specific to your situation. Replace bracketed ' +
  'placeholders before signing. CyberSygn makes no representation that this template ' +
  'is suitable for any particular use.';

// Static template registry (mirrors scripts/templates-library.json).
// Kept inline so the worker bundle doesn't have to bundle a separate JSON;
// keep this synced when the JSON updates.
const TEMPLATES = [
  // The list is in order of appearance in the JSON.
  { slug: 'master-services-agreement', title: 'Master Services Agreement', short: 'Vendor contracts, retainer agreements, consulting MSAs.', sections: [
    '1. Parties and Effective Date', '2. Scope of Services', '3. Compensation and Payment Terms',
    '4. Confidentiality', '5. Intellectual Property', '6. Term and Termination',
    '7. Indemnification', '8. Limitation of Liability', '9. General Provisions',
  ], signatures: 2, initials: 2, dates: 2 },
  { slug: 'non-disclosure-agreement', title: 'Non-Disclosure Agreement', short: 'Mutual NDAs, one-way confidentiality, due-diligence wrappers.', sections: [
    '1. Parties', '2. Definition of Confidential Information', '3. Exclusions from Confidential Information',
    '4. Obligations of Receiving Party', '5. Term of Agreement', '6. Return of Materials',
    '7. Remedies for Breach', '8. General Provisions',
  ], signatures: 2, initials: 0, dates: 2 },
  { slug: 'employment-agreement', title: 'Employment Agreement', short: 'W-2 offer letters, advisor terms, formal hiring.', sections: [
    '1. Position and Duties', '2. Start Date and Term', '3. Compensation and Benefits',
    '4. Confidentiality and Trade Secrets', '5. Intellectual Property Assignment', '6. Non-Solicitation',
    '7. Termination', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'rental-lease', title: 'Rental Lease', short: 'Residential leases, commercial subleases, room rentals.', sections: [
    '1. Parties and Property Address', '2. Lease Term', '3. Rent and Security Deposit',
    '4. Use of Property', '5. Tenant Obligations', '6. Landlord Obligations',
    '7. Termination and Renewal', '8. Disputes and Governing Law',
  ], signatures: 2, initials: 2, dates: 2 },
  { slug: 'photography-contract', title: 'Photography Contract', short: 'Shoot agreements, model releases, image licensing.', sections: [
    '1. Parties and Shoot Details', '2. Deliverables and Timeline', '3. Fee, Deposit, and Payment Terms',
    '4. Cancellation and Rescheduling', '5. Usage Rights and Licensing', '6. Model Release (if applicable)',
    '7. Liability and Limitations', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'coaching-agreement', title: 'Coaching Agreement', short: 'Engagement terms, intake forms, cancellation policies.', sections: [
    '1. Parties and Effective Date', '2. Coaching Services and Package', '3. Fees and Payment Schedule',
    '4. Session Cancellation Policy', '5. Confidentiality', '6. Disclaimer and Limitations',
    '7. Term and Termination', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'freelance-contract', title: 'Freelance Contract', short: 'Project SOWs, milestone payments, IP transfer clauses.', sections: [
    '1. Parties and Project', '2. Scope of Work', '3. Deliverables and Timeline',
    '4. Fee and Payment Milestones', '5. Revisions Policy', '6. Intellectual Property Transfer',
    '7. Cancellation Terms', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'safe-investor-agreement', title: 'SAFE / Investor Agreement', short: 'YC SAFE templates, convertible notes, advisor agreements.', sections: [
    '1. Parties and Investment Amount', '2. Conversion Mechanics', '3. Valuation Cap and Discount',
    '4. Pro Rata Rights', '5. Information Rights', '6. Representations',
    '7. Dissolution and Liquidation Priority', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'consulting-agreement', title: 'Consulting Agreement', short: 'Consulting engagements, scope-of-work, retainer terms.', sections: [
    '1. Parties and Effective Date', '2. Scope of Consulting Services', '3. Fee Structure and Payment',
    '4. Deliverables', '5. Independent Contractor Relationship', '6. Confidentiality',
    '7. Term and Termination', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'contractor-agreement', title: 'Independent Contractor Agreement', short: 'Independent contractor engagements with 1099 reporting.', sections: [
    '1. Parties and Project Description', '2. Independent Contractor Status', '3. Scope of Work',
    '4. Fee and Payment Terms', '5. Intellectual Property', '6. Confidentiality',
    '7. Term and Termination', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'model-release', title: 'Model Release', short: 'Standard model release for commercial photo and video.', sections: [
    '1. Parties and Identification', '2. Grant of Rights', '3. Scope of Use',
    '4. Compensation', '5. Acknowledgment', '6. Minor Release (if applicable)',
    '7. Limitations', '8. General Provisions',
  ], signatures: 2, initials: 0, dates: 1 },
  { slug: 'speaker-agreement', title: 'Speaker Agreement', short: 'Conference, podcast, and workshop speaking terms.', sections: [
    '1. Parties and Event Details', '2. Speaker Topic and Format', '3. Speaker Fee and Expenses',
    '4. Travel and Accommodations', '5. Recording and Distribution Rights', '6. Cancellation',
    '7. Promotional Use of Likeness', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'sponsorship-agreement', title: 'Sponsorship Agreement', short: 'Event, podcast, and content-creator sponsorship terms.', sections: [
    '1. Parties and Sponsorship Tier', '2. Sponsor Deliverables', '3. Property Owner Deliverables',
    '4. Payment Schedule', '5. Exclusivity', '6. Brand Usage and Approval',
    '7. Term and Termination', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'subscription-services', title: 'Subscription Services Agreement', short: 'SaaS, retainer, and recurring-service subscription terms.', sections: [
    '1. Parties and Subscription Plan', '2. Term and Renewal', '3. Billing and Payment Terms',
    '4. Service Level Commitments', '5. Data Handling and Privacy', '6. Customer Obligations',
    '7. Termination and Suspension', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
  { slug: 'mutual-nda', title: 'Mutual Non-Disclosure Agreement', short: 'Two-way confidentiality for partnerships and diligence.', sections: [
    '1. Parties', '2. Mutual Confidentiality Obligations', '3. Definition of Confidential Information',
    '4. Permitted Disclosures', '5. Term and Survival', '6. Return of Materials',
    '7. Remedies', '8. General Provisions',
  ], signatures: 2, initials: 0, dates: 2 },
  { slug: 'advisor-agreement', title: 'Advisor Agreement', short: 'Equity-compensated advisor terms with vesting.', sections: [
    '1. Parties and Advisor Role', '2. Advisory Services', '3. Equity Compensation and Vesting',
    '4. Confidentiality', '5. Intellectual Property', '6. Term and Termination',
    '7. Independent Contractor Status', '8. General Provisions',
  ], signatures: 2, initials: 1, dates: 2 },
];

export function findTemplate(slug) {
  if (typeof slug !== 'string') return null;
  return TEMPLATES.find(t => t.slug === slug.toLowerCase()) || null;
}

export function listTemplates() {
  return TEMPLATES.map(t => ({ slug: t.slug, title: t.title, short: t.short }));
}

/**
 * Sanitize a slug for use in an asset path. Lowercase, allow only
 * [a-z0-9-]. Strips anything else (so no path traversal, no '/', no '.').
 * Returns '' for non-strings or empty results.
 */
export function sanitizeSlug(slug) {
  if (typeof slug !== 'string') return '';
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 120);
}

/**
 * Title-case a slug as a last-resort fallback when the slug is not in the
 * generated catalog map nor the legacy TEMPLATES registry.
 */
function titleCaseSlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Resolve a human title for a slug. Prefers the generated catalog map,
 * then the legacy registry, then a title-cased fallback.
 */
export function titleForSlug(slug) {
  const clean = sanitizeSlug(slug);
  if (clean && Object.prototype.hasOwnProperty.call(TEMPLATE_TITLES, clean)) {
    return TEMPLATE_TITLES[clean];
  }
  const tmpl = findTemplate(clean);
  if (tmpl) return tmpl.title;
  return titleCaseSlug(clean) || 'Contract';
}

/**
 * Fetch the pre-rendered static PDF for a slug via the ASSETS binding.
 * Builds an absolute-URL Request to the same origin at
 * /templates-pdf/<slug>.pdf. Returns a Uint8Array of the PDF bytes on a
 * 200, or null if the asset is missing / ASSETS is unavailable.
 *
 * `originUrl` is any URL on the same origin (typically the inbound request
 * URL) used to construct an absolute asset URL. If omitted, a stable
 * placeholder origin is used (the ASSETS binding ignores the host).
 */
export async function fetchStaticTemplatePdf(env, slug, originUrl) {
  const clean = sanitizeSlug(slug);
  if (!clean) return null;
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  let assetUrl;
  try {
    const base = originUrl ? new URL(originUrl) : new URL('https://cybersygn.io/');
    assetUrl = new URL(`/templates-pdf/${clean}.pdf`, base);
  } catch (e) {
    return null;
  }
  try {
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
    if (!res || res.status !== 200) return null;
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) return null;
    return new Uint8Array(buf);
  } catch (e) {
    return null;
  }
}

/**
 * Generate a PDF for the given template metadata. Returns Uint8Array.
 *
 * Layout:
 *   Page 1:
 *     - "CYBERSYGN" wordmark top-left, small
 *     - Big title centered
 *     - "Between: [Party A Name]" and "And: [Party B Name]" placeholder lines
 *     - "Effective Date: __________________________"
 *     - Section headings (numbered) followed by 2 lines of placeholder text
 *       and a horizontal rule
 *   Last page:
 *     - Signature blocks (signature line + printed name + date)
 *     - Footer with disclaimer
 */
export async function generateTemplatePdf(tmpl) {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const timesItal = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  pdf.setTitle(tmpl.title + ' Template');
  pdf.setAuthor('CyberSygn');
  pdf.setSubject(`${tmpl.title} structural template`);
  pdf.setKeywords([tmpl.title.toLowerCase(), 'template', 'CyberSygn']);

  function newPage() {
    const p = pdf.addPage([PAGE_W, PAGE_H]);
    // Header wordmark
    p.drawText('CYBERSYGN', { x: MARGIN, y: PAGE_H - 40, size: 9, font: helvBold, color: NAVY });
    p.drawText('template', { x: MARGIN + 70, y: PAGE_H - 40, size: 8, font: helv, color: SOFT });
    return p;
  }

  let page = newPage();
  let y = PAGE_H - 90;

  // Title
  const titleSize = 22;
  const titleW = helvBold.widthOfTextAtSize(tmpl.title, titleSize);
  page.drawText(tmpl.title, { x: (PAGE_W - titleW) / 2, y: y, size: titleSize, font: helvBold, color: INK });
  y -= 34;

  // Subtitle / short
  if (tmpl.short) {
    const subSize = 10;
    const subW = helv.widthOfTextAtSize(tmpl.short, subSize);
    page.drawText(tmpl.short, { x: (PAGE_W - subW) / 2, y: y, size: subSize, font: helv, color: SOFT });
    y -= 26;
  }

  // Parties block.
  function placeholder(label, fieldHint) {
    page.drawText(label, { x: MARGIN, y: y, size: 10, font: helvBold, color: INK });
    const labelW = helvBold.widthOfTextAtSize(label, 10);
    // Underline placeholder
    page.drawRectangle({
      x: MARGIN + labelW + 8, y: y - 2, width: PAGE_W - MARGIN - MARGIN - labelW - 8,
      height: 1, color: LINE,
    });
    if (fieldHint) {
      page.drawText(`[${fieldHint}]`, {
        x: MARGIN + labelW + 12, y: y + 1, size: 9, font: timesItal, color: SOFT,
      });
    }
    y -= 22;
  }
  placeholder('Between:', 'party A full legal name');
  placeholder('And:', 'party B full legal name');
  placeholder('Effective Date:', 'YYYY-MM-DD');
  y -= 10;

  // Sections.
  for (const heading of tmpl.sections) {
    if (y < 140) {
      page = newPage();
      y = PAGE_H - 80;
    }
    page.drawText(heading, { x: MARGIN, y: y, size: 12, font: helvBold, color: INK });
    y -= 18;
    // Two placeholder lines for content.
    for (let i = 0; i < 2; i++) {
      page.drawRectangle({
        x: MARGIN, y: y, width: PAGE_W - 2 * MARGIN, height: 0.5,
        color: LINE,
      });
      y -= 14;
    }
    y -= 8;
  }

  // Signature block. If insufficient room, new page.
  const sigHeight = 60 + (tmpl.signatures * 70);
  if (y < sigHeight + 40) {
    page = newPage();
    y = PAGE_H - 90;
  }
  page.drawText('Signatures', { x: MARGIN, y: y, size: 14, font: helvBold, color: INK });
  y -= 22;
  for (let i = 0; i < tmpl.signatures; i++) {
    const label = i === 0 ? 'Party A Signature' : (i === 1 ? 'Party B Signature' : `Signature ${i + 1}`);
    // Signature line
    page.drawRectangle({ x: MARGIN, y: y, width: 220, height: 1, color: INK });
    page.drawText(label, { x: MARGIN, y: y - 14, size: 9, font: helv, color: SOFT });
    // Date line
    page.drawRectangle({ x: PAGE_W - MARGIN - 140, y: y, width: 140, height: 1, color: INK });
    page.drawText('Date', { x: PAGE_W - MARGIN - 140, y: y - 14, size: 9, font: helv, color: SOFT });
    y -= 48;
  }

  // Initials slots (if any).
  if (tmpl.initials > 0) {
    y -= 6;
    page.drawText('Initials', { x: MARGIN, y: y, size: 10, font: helvBold, color: INK });
    y -= 18;
    let x = MARGIN;
    for (let i = 0; i < tmpl.initials; i++) {
      page.drawRectangle({ x, y, width: 60, height: 22, borderColor: INK, borderWidth: 0.6, color: undefined });
      x += 80;
    }
    y -= 36;
  }

  // Footer disclaimer on each page.
  const pages = pdf.getPages();
  for (const p of pages) {
    p.drawRectangle({ x: MARGIN, y: 36, width: PAGE_W - 2 * MARGIN, height: 0.5, color: LINE });
    // Disclaimer text wrapped to fit margins.
    const lines = wrap(DISCLAIMER, 75);
    let dY = 28;
    for (const line of lines) {
      p.drawText(line, { x: MARGIN, y: dY, size: 7, font: helv, color: SOFT });
      dY -= 9;
    }
  }

  return await pdf.save();
}

function wrap(s, maxChars) {
  const out = [];
  const words = s.split(/\s+/);
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Send a template via Resend with the PDF as an attachment.
 * Captures the email into the free-tier drip funnel as a side effect.
 */
export async function sendTemplateByEmail(env, { templateSlug, email, firstName, lastName, originUrl }) {
  const slug = sanitizeSlug(templateSlug);
  if (!slug) return { ok: false, error: 'unknown_template' };

  // Validation: a template is valid if a real rendered PDF asset exists
  // OR it's in the legacy registry. Prefer the static asset; only fall
  // back to the generated wireframe when the asset is missing.
  let pdfBytes = await fetchStaticTemplatePdf(env, slug, originUrl);
  let usedStatic = !!pdfBytes;
  const tmpl = findTemplate(slug);
  if (!pdfBytes) {
    if (!tmpl) return { ok: false, error: 'unknown_template' };
    pdfBytes = await generateTemplatePdf(tmpl);
  }
  const title = titleForSlug(slug);
  const pdfBase64 = bytesToBase64(pdfBytes);

  // Lead capture: write the drip:<emailHash> record so the welcome
  // drip catches them tomorrow at 9am EST.
  try {
    const signup = await freeSignup(env, {
      firstName: firstName || 'there',
      lastName: lastName || 'friend',
      email,
    });
    if (signup && signup.ok && signup.freeToken) {
      await writeFreeTokenPointer(env, signup.freeToken, hash(email));
    }
  } catch (e) { /* tolerated */ }

  // Send via Resend, embedding the PDF as a base64 attachment.
  const apiKey = env && env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, mode: 'console', detail: 'RESEND_API_KEY not set' };
  }
  const subject = `Your ${title} template, from CyberSygn.`;
  const body =
    `Hi ${firstName || 'there'},\n\n` +
    `Attached is your ${title} template. It's a customizable starting draft — replace the bracketed placeholders, then send it for signature through CyberSygn (https://cybersygn.io/preview/) to get a fully-detected, signable version with audit certificate.\n\n` +
    `Important: this template is a starting draft for general structure only. It is not legal advice. Have a licensed attorney in your jurisdiction review it for your specific situation.\n\n` +
    `CyberSygn. Built in Colorado.`;

  const reqBody = {
    from: env.CYBERSYGN_FROM || 'hello@cybersygn.io',
    to: [email],
    subject,
    text: body,
    attachments: [{
      filename: `${slug}.pdf`,
      content: pdfBase64,
    }],
  };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `resend_${res.status}`, detail: txt.slice(0, 200) };
    }
    const r = await res.json();
    return { ok: true, providerId: r.id || null, mode: 'resend', source: usedStatic ? 'static' : 'generated' };
  } catch (e) {
    return { ok: false, error: 'exception', detail: (e && e.message) || String(e) };
  }
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function hash(s) {
  // Lightweight client-fingerprint (NOT a security hash). Used only to
  // produce a stable token→email pointer when we don't have the proper
  // sha256 helper imported in this module.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}
