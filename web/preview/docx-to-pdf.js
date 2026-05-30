/**
 * CyberSygn docx-to-PDF on-ramp.
 *
 * Native .docx ingestion. The browser owns the conversion: mammoth.js
 * extracts paragraph-structured raw text from the .docx, and pdf-lib
 * lays it out as a clean monospace PDF. The synthesized PDF is then
 * fed into the existing detection pipeline unchanged.
 *
 * Design choices and tradeoffs:
 *
 * 1. Raw text, not HTML. mammoth.convertToHtml is richer but adds
 *    inline base64 images (template-provider branding lifted from
 *    the original docx) and roughly tripples the synthesis cost. For
 *    field detection we only need paragraph-level text structure, and
 *    extractRawText preserves that perfectly: every paragraph break
 *    becomes a newline, every Word tab becomes \t, every underscore
 *    line ("Signed: ____") survives intact.
 *
 * 2. Courier monospace font. pdf-lib has zero standard-font sans-serif
 *    that handles Word's full unicode range, and we don't need pretty
 *    rendering. Monospace makes line-length calculation trivial and
 *    keeps signature labels aligned with their underscore runs the
 *    way they appeared in the original docx.
 *
 * 3. Text sanitization. WinAnsi (pdf-lib's default standard encoding)
 *    cannot encode many characters Word emits freely: en-space U+2002,
 *    em-space U+2003, smart quotes, en-dash, em-dash, ellipsis. We
 *    map these to ASCII near-equivalents on the way in. This also
 *    enforces the no-em-dashes brand rule on user content, which is
 *    a happy side effect rather than a primary motivation.
 *
 * 4. Fidelity is "good enough for field detection," not "indistinguishable
 *    from Word." Tables collapse to plain text rows, embedded images are
 *    dropped, complex multi-column layouts linearize. This is the right
 *    tradeoff because the signed-and-flattened output will be the
 *    synthesized PDF anyway: post-conversion, no one ever sees the
 *    original docx again.
 *
 * Module surface:
 *   - docxToPdfFile(file) -> Promise<File>  (the browser entry point)
 *   - sanitizeWinAnsi(str) -> string         (exported for tests)
 *   - paragraphsToPdfBytes(paragraphs) -> Promise<Uint8Array>  (exported
 *     for Node tests that don't have a File constructor)
 */

// In the browser, mammoth is loaded as a side-effect script that
// attaches itself to window.mammoth. We inject the script tag on
// demand so users who only upload PDFs pay zero bytes for it. In
// Node tests, we import the npm package directly. The wrapper below
// works in both environments.
async function loadMammoth() {
  if (typeof window !== 'undefined') {
    if (window.mammoth) return window.mammoth;
    await injectScript('../vendor/mammoth.browser.min.js');
    if (!window.mammoth) {
      throw new Error('mammoth failed to initialize after script load');
    }
    return window.mammoth;
  }
  // Node fallback: dynamic import of the npm package. Only runs in tests.
  const mod = await import('mammoth');
  return mod.default || mod;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    // If already injected (or about to be), reuse the pending promise
    // so concurrent uploads don't fetch the script twice.
    const existing = document.querySelector(`script[data-cybersygn-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
      return;
    }
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.dataset.cybersygnSrc = src;
    tag.addEventListener('load', () => { tag.dataset.loaded = 'true'; resolve(); }, { once: true });
    tag.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
    document.head.appendChild(tag);
  });
}

// pdf-lib loads from ../vendor/pdf-lib.mjs in the browser. In Node tests
// we import from the installed package. Same dual-environment trick.
async function loadPdfLib() {
  if (typeof window !== 'undefined') {
    return await import('../vendor/pdf-lib.mjs');
  }
  return await import('pdf-lib');
}

// ----- Public API -----------------------------------------------------------

/**
 * Convert a .docx File into a synthesized PDF File. The returned File
 * carries the original base name with ".pdf" extension and the
 * application/pdf MIME type, so it drops cleanly into the existing
 * handleFile() flow.
 */
export async function docxToPdfFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('docxToPdfFile expects a File or Blob');
  }
  const buf = await file.arrayBuffer();
  const paragraphs = await extractParagraphs(buf);
  const pdfBytes = await paragraphsToPdfBytes(paragraphs);
  const baseName = (file.name || 'document.docx').replace(/\.docx?$/i, '');
  return new File([pdfBytes], `${baseName}.pdf`, { type: 'application/pdf' });
}

/**
 * Lower-level: turn a docx ArrayBuffer into an array of sanitized
 * paragraph strings. Exposed for tests and for callers that want to
 * post-process before synthesizing.
 */
export async function extractParagraphs(arrayBuffer) {
  const mammoth = await loadMammoth();
  const result = await mammoth.extractRawText({
    arrayBuffer: arrayBuffer,
    buffer: arrayBuffer,           // Node API uses buffer, browser uses arrayBuffer
  });
  const raw = result.value || '';
  return raw.split('\n').map(p => sanitizeWinAnsi(p.trimEnd()));
}

/**
 * Synthesize a PDF from an array of paragraph strings. Empty strings
 * become blank lines so paragraph spacing from the original docx
 * survives the round-trip.
 */
export async function paragraphsToPdfBytes(paragraphs) {
  const pdfLib = await loadPdfLib();
  const { PDFDocument, StandardFonts } = pdfLib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Courier);

  const fontSize = 10;
  const lineHeight = 13;
  const margin = 54;          // 0.75 inch
  const pageW = 612;          // letter, points
  const pageH = 792;
  const usableW = pageW - 2 * margin;
  // Courier glyph width at size N is ~0.6 * N points.
  const charsPerLine = Math.floor(usableW / (fontSize * 0.6));

  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - margin;

  for (const para of paragraphs) {
    const lines = para === '' ? [''] : wrapToWidth(para, charsPerLine);
    for (const ln of lines) {
      if (y < margin) {
        page = pdf.addPage([pageW, pageH]);
        y = pageH - margin;
      }
      if (ln !== '') {
        // Defensive: even after sanitization a stray non-WinAnsi byte
        // may slip through. Catch the encoding error per-line so one
        // bad paragraph cannot kill the whole conversion.
        try {
          page.drawText(ln, { x: margin, y, font, size: fontSize });
        } catch {
          page.drawText(stripToAscii(ln), { x: margin, y, font, size: fontSize });
        }
      }
      y -= lineHeight;
    }
  }

  return await pdf.save();
}

// ----- Text helpers ---------------------------------------------------------

// Common Word-emitted Unicode that WinAnsi (pdf-lib standard fonts) cannot
// encode. Map each to an ASCII near-equivalent.
const UNICODE_MAP = {
  '\u00A0': ' ',     // non-breaking space
  '\u2002': ' ',     // en space
  '\u2003': ' ',     // em space
  '\u2009': ' ',     // thin space
  '\u200B': '',      // zero-width space
  '\u2018': "'",     // left single quote
  '\u2019': "'",     // right single quote (apostrophe)
  '\u201A': "'",     // single low-9 quote
  '\u201C': '"',     // left double quote
  '\u201D': '"',     // right double quote
  '\u201E': '"',     // double low-9 quote
  '\u2013': '-',     // en dash
  '\u2014': '-',     // em dash (also enforces brand rule: no em-dashes)
  '\u2026': '...',   // ellipsis
  '\u2022': '*',     // bullet
  '\u00B7': '*',     // middle dot
  '\u2122': '(TM)',  // trademark
  '\u00AE': '(R)',   // registered
  '\u00A9': '(C)',   // copyright
  '\u00BD': '1/2',
  '\u00BC': '1/4',
  '\u00BE': '3/4',
  '\u2192': '->',    // right arrow
  '\u2190': '<-',    // left arrow
  '\u2713': 'x',     // check mark
  '\u2717': 'x',     // ballot x
  '\uFEFF': '',      // BOM
};

export function sanitizeWinAnsi(str) {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      out += ch;                                   // plain ASCII
    } else if (UNICODE_MAP[ch] !== undefined) {
      out += UNICODE_MAP[ch];                      // mapped
    } else if (code >= 0xA0 && code <= 0xFF) {
      out += ch;                                   // Latin-1, WinAnsi can encode
    } else {
      out += ' ';                                  // unknown high codepoint, drop
    }
  }
  return out;
}

function stripToAscii(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out += (c >= 0x20 && c <= 0x7E) ? str[i] : ' ';
  }
  return out;
}

function wrapToWidth(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const lines = [];
  // Preserve leading whitespace on the first wrap segment only.
  // Word frequently uses leading tabs to align underscore runs with
  // their labels; preserving them keeps signature-block geometry
  // detectable after wrap.
  const words = text.split(/(\s+)/).filter(s => s.length > 0);
  let cur = '';
  for (const w of words) {
    if (cur.length + w.length > maxChars && cur.length > 0) {
      lines.push(cur);
      cur = /^\s+$/.test(w) ? '' : w;             // drop trailing whitespace at wrap boundary
    } else {
      cur += w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}
