/**
 * The canonical signed document.
 *
 * THE DEFECT THIS EXISTS TO FIX. Until now, flattening happened only in the
 * browser (web/preview/signing.js), so there was no authoritative signed file
 * anywhere. Every party who downloaded produced their own bytes in their own
 * tab. Meanwhile doc.pdfSha256 hashes the UPLOADED ORIGINAL (index.js, at
 * creation) and is never recomputed. So /verify/ invited people to check a
 * signed document against a fingerprint that could not possibly match it: the
 * natural action, hashing the file in your hand, always failed.
 *
 * The server now builds ONE signed artifact at completion, hashes it, stores
 * it, and hands the same bytes to every party. Then the fingerprint means what
 * a reader assumes it means.
 *
 * DETERMINISM IS LOAD-BEARING, and pdf-lib fights you on it.
 * PDFDocument.load() defaults updateMetadata:true, which stamps ModDate with
 * new Date(). Two builds seconds apart then differ, and a rebuilt artifact
 * would hash differently from the value already published in the verify
 * record: /verify/ would tell a legitimate holder their real file is wrong.
 * Measured before this fix: identical input, identical 864-byte output size,
 * two different SHA-256 values. So: load with updateMetadata:false, pin every
 * date from the document's own timestamps, and never call Date.now() here.
 * With metadata pinned, output is a pure function of (original, fields, fills)
 * and the artifact can be safely rebuilt years later.
 *
 * The drawing math below mirrors web/preview/signing.js exactly, because the
 * two must produce the same page. Any divergence is a bug in this file.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sha256Hex } from './audit.js';
import { getStorage } from './storage.js';

// Source ceiling well under the Worker's 128MB memory limit. Input and output
// are both live at save() time, and a measured 23MB/52-page flatten already
// reached ~99MB RSS, so the practical ceiling is far below MAX_PDF_BYTES.
export const SIGNED_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// KV caps a value at 25MiB and a flatten only grows the file, so refuse to
// build something that cannot be stored rather than discovering it at put().
export const SIGNED_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
export const MAX_SIGNATURE_DATAURL_CHARS = 700000;
export const MAX_FILL_TEXT_CHARS = 200;

const PNG_DATAURL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

export function signedPdfKey(docId) { return `signed:${docId}`; }

function signedPdfError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/**
 * Replace anything StandardFonts.Helvetica cannot WinAnsi-encode.
 *
 * pdf-lib's drawText THROWS on an unencodable code point. A signer typing an
 * emoji, a CJK character, or a smart quote would otherwise abort the whole
 * flatten and cost the document its signed artifact. The client hit this same
 * trap with an en-dash in the footer once already. A visible '?' is a far
 * better outcome than no document.
 */
export function sanitizeWinAnsi(text) {
  let out = '';
  for (const ch of String(text == null ? '' : text)) {
    const cp = ch.codePointAt(0);
    // Printable ASCII plus the Latin-1 range Helvetica handles.
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out += ch;
    else if (ch === '’' || ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '–' || ch === '—') out += '-';
    else out += '?';
  }
  return out;
}

/**
 * Flatten every signer's fills into one map keyed by field id.
 * The doc MUST have been loaded through loadDocMerged so per-signer subkeys
 * are overlaid, or a late submission is silently missing from the artifact.
 */
export function collectFills(doc) {
  const out = {};
  const assignments = (doc && doc.assignments) || {};
  const signers = (doc && doc.signers) || [];
  for (const [fieldId, signerId] of Object.entries(assignments)) {
    const signer = signers.find(s => s && s.id === signerId);
    if (!signer || !signer.fills) continue;
    const v = signer.fills[fieldId];
    if (v) out[fieldId] = v;
  }
  return out;
}

/** Port of drawViralFooter, minus the localStorage check (no DOM in a Worker). */
function drawSignedFooter(pdfDoc, font) {
  // ASCII only. A previous en-dash here broke every download with
  // "WinAnsi cannot encode".
  const text = 'Signed with CyberSygn  -  cybersygn.io';
  const url = 'https://cybersygn.io/';
  const size = 7;
  const fg = rgb(0.00, 0.55, 0.72);
  for (const page of pdfDoc.getPages()) {
    try {
      const { width } = page.getSize();
      const textWidth = font.widthOfTextAtSize(text, size);
      const x = width - textWidth - 14;
      const y = 8;
      page.drawText(text, { x, y, size, font, color: fg });
      const linkAnnot = pdfDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x - 2, y - 1, x + textWidth + 2, y + size + 1],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: pdfDoc.context.obj(url) },
      });
      const annots = page.node.lookup(pdfDoc.context.obj('Annots'));
      if (annots && typeof annots.push === 'function') annots.push(linkAnnot);
      else page.node.set(pdfDoc.context.obj('Annots'), pdfDoc.context.obj([linkAnnot]));
    } catch (e) { /* a missing link annotation is cosmetic, never fatal */ }
  }
}

/**
 * Build the signed artifact. THROWS on unrecoverable failure so the caller can
 * classify; per-field problems are swallowed and skipped instead.
 */
export async function buildSignedPdf({ originalBytes, doc }) {
  if (!originalBytes) throw signedPdfError('no_original');
  const srcLen = originalBytes.byteLength != null ? originalBytes.byteLength : originalBytes.length;
  if (srcLen > SIGNED_MAX_SOURCE_BYTES) throw signedPdfError('too_large');

  // updateMetadata:false is what makes the output reproducible. See header.
  const pdfDoc = await PDFDocument.load(originalBytes, { updateMetadata: false });
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Pin metadata from the document's own timestamps. No Date.now() anywhere.
  try {
    pdfDoc.setProducer('CyberSygn');
    if (doc && doc.completedAt) pdfDoc.setModificationDate(new Date(doc.completedAt));
    if (doc && doc.createdAt) pdfDoc.setCreationDate(new Date(doc.createdAt));
  } catch (e) { /* metadata is cosmetic; never lose the artifact over it */ }

  const fills = collectFills(doc);
  const pages = pdfDoc.getPages();

  // Iterate doc.fields IN ARRAY ORDER. Object.keys(fills) order depends on
  // merge history, which would make the output, and therefore the hash,
  // depend on the order signatures happened to arrive.
  for (const field of ((doc && doc.fields) || [])) {
    const value = fills[field.id];
    if (!value) continue;
    const page = pages[field.page - 1];
    if (!page) continue;

    try {
      if (value.kind === 'signature') {
        const dataUrl = String(value.dataUrl || '');
        if (!PNG_DATAURL_RE.test(dataUrl)) continue;
        if (dataUrl.length > MAX_SIGNATURE_DATAURL_CHARS) continue;
        const png = await pdfDoc.embedPng(dataUrl);
        const box = { w: field.width, h: field.height + 8 };
        const imgAspect = png.width / png.height;
        const boxAspect = box.w / box.h;
        let drawW, drawH;
        if (imgAspect > boxAspect) { drawW = box.w; drawH = box.w / imgAspect; }
        else { drawH = box.h; drawW = box.h * imgAspect; }
        page.drawImage(png, {
          x: field.x + (box.w - drawW) / 2,
          y: field.y + (box.h - drawH) / 2 - 2,
          width: drawW,
          height: drawH,
        });
      } else if (value.kind === 'date' || value.kind === 'text') {
        const text = sanitizeWinAnsi(value.text).slice(0, MAX_FILL_TEXT_CHARS);
        if (!text) continue;
        const size = Math.max(9, Math.min(field.height - 2, 12));
        page.drawText(text, {
          x: field.x + 4, y: field.y + 3, size, font: helvetica,
          color: rgb(0.08, 0.08, 0.1),
        });
      } else if (value.kind === 'checkbox' && value.checked) {
        const size = Math.max(10, Math.min(field.height - 2, 14));
        page.drawText('X', {
          x: field.x + 2, y: field.y + 1, size, font: helvetica,
          color: rgb(0.72, 0.20, 0.15),
        });
      }
    } catch (e) {
      // One unrenderable field must never cost the whole document.
      console.warn('[signed-pdf] field skipped', field && field.id, e && e.message);
    }
  }

  // doc.footer is pinned when the document is created, from the sender's tier
  // at that moment (index.js). Paid plans are sold as "No footer." and this
  // call used to be unconditional, so every paid customer's canonical signed
  // PDF carried it anyway. Undefined means a record written before the field
  // existed: those keep the footer, which is the free-tier default and the
  // safe direction to be wrong in.
  if (doc && doc.footer === false) {
    // no footer: this sender pays for a clean artifact
  } else {
    drawSignedFooter(pdfDoc, helvetica);
  }
  return await pdfDoc.save();
}

/**
 * Get the canonical signed artifact, building and storing it on first need.
 * NEVER throws: completion must not fail because of this work.
 */
export async function ensureSignedPdf(env, doc, { force = false } = {}) {
  try {
    if (!doc || !doc.completedAt) return { ok: false, reason: 'not_completed' };
    const storage = getStorage(env);
    const key = signedPdfKey(doc.id);

    if (!force) {
      const stored = await storage.pdfs.get(key, { arrayBuffer: true });
      if (stored) {
        return {
          ok: true,
          bytes: new Uint8Array(stored),
          sha256: doc.signedPdfSha256 || await sha256Hex(new Uint8Array(stored)),
          source: 'stored',
        };
      }
    }

    const original = await storage.pdfs.get(`pdf:${doc.id}`, { arrayBuffer: true });
    if (!original) return { ok: false, reason: 'no_original' };

    let bytes;
    try {
      bytes = await buildSignedPdf({ originalBytes: original, doc });
    } catch (e) {
      const code = e && e.code;
      return { ok: false, reason: (code === 'no_original' || code === 'too_large') ? code : 'build_failed' };
    }

    if (bytes.byteLength > SIGNED_MAX_OUTPUT_BYTES) return { ok: false, reason: 'oversize_output' };

    try {
      // No expirationTtl: the signed artifact is the record, same as audit:.
      await storage.pdfs.put(key, bytes.buffer);
    } catch (e) {
      return { ok: false, reason: 'store_failed' };
    }
    // Concurrent builders are harmless: determinism makes both writes identical.
    return { ok: true, bytes, sha256: await sha256Hex(bytes), source: 'built' };
  } catch (e) {
    return { ok: false, reason: 'build_failed' };
  }
}
