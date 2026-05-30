/**
 * CyberSygn audit log.
 *
 * Every signing event is appended to the doc record's events array. At
 * document completion the Worker renders an audit-certificate PDF that
 * summarises:
 *
 *   - the document title and ID
 *   - each signer's name, email, and identifier
 *   - the timestamp, IP address, and user-agent for each event
 *   - the SHA-256 of the original PDF, as evidence of what was signed
 *
 * The certificate is generated server-side so it cannot be tampered
 * with by a malicious sender, and so the final email always carries the
 * evidence whether or not the sender returns to the app.
 *
 * pdf-lib runs in Workers under nodejs_compat. The same module powers
 * the client-side flatten in web/preview/signing.js, so the dependency
 * is already in node_modules.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ---------------------------------------------------------------------------
// Event recording
// ---------------------------------------------------------------------------

/**
 * Append a typed event to the doc record. Every event captures who
 * triggered it, when, and from where.
 *
 *   type: 'created' | 'viewed' | 'signed' | 'completed'
 *   signerId?: string  (omitted for 'created' and 'completed')
 *   request?: Request  (used to extract IP and user-agent)
 *   meta?: object      (free-form data per event type)
 */
export function recordEvent(doc, { type, signerId, request, meta }) {
  if (!doc.events) doc.events = [];
  const event = {
    type,
    at: new Date().toISOString(),
    signerId: signerId || null,
    ip: request ? (request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || null) : null,
    userAgent: request ? truncate(request.headers.get('user-agent'), 200) : null,
    meta: meta || null,
  };
  doc.events.push(event);
  return event;
}

/**
 * SHA-256 of bytes, lowercase hex. The Web Crypto API is available in
 * Workers without any polyfill.
 */
export async function sha256Hex(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const arr = new Uint8Array(digest);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Certificate rendering
// ---------------------------------------------------------------------------

/**
 * Render the audit certificate as a PDF. Returns a Uint8Array.
 *
 * Layout: one page, top-of-page CyberSygn wordmark, title block, document
 * identity table, signer table, full event log, document fingerprint
 * footer. Sized for US Letter so it pairs cleanly with most contracts.
 */
export async function renderAuditCertificate({ doc, pdfSha256 }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Audit certificate. ${doc.title || 'CyberSygn document'}.`);
  pdf.setCreator('CyberSygn');
  pdf.setProducer('CyberSygn');

  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const monoBold = await pdf.embedFont(StandardFonts.CourierBold);

  // US Letter, portrait.
  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 54;
  const COL_W = PAGE_W - MARGIN * 2;

  // Ink palette mirrors the brand. pdf-lib accepts rgb() in 0..1.
  // CyberSygn: deep navy text (matches the logo), electric cyan accent,
  // cool gray rules.
  const INK = rgb(0.004, 0.078, 0.204);          // #011434 navy from logo
  const INK_SOFT = rgb(0.227, 0.259, 0.345);     // #3A4258
  const INK_FAINT = rgb(0.439, 0.475, 0.627);    // #7079A0
  const ACCENT = rgb(0.0, 0.796, 0.965);         // #00CBF6 electric cyan from logo
  const RULE = rgb(0.894, 0.906, 0.933);         // #E4E7EE

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  // Cursor anchored at the top; y decreases as we draw down the page.
  let y = PAGE_H - MARGIN;

  function newPageIfNeeded(neededHeight) {
    if (y - neededHeight < MARGIN + 60) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  }

  // ---- 1. Brand bar + title ---------------------------------------------
  // Accent rule, then the wordmark in serif-bold caps. The new brand
  // mark is "CYBERSYGN" set in caps with the S+lightning glyph as the
  // logo on web. On the audit certificate we render the wordmark in
  // type (no image embed) because the cert needs to print clean on
  // any printer and stay under a few KB. Letter-spacing the caps gives
  // it the same techno feel the type-only logo had on web.
  page.drawRectangle({ x: MARGIN, y: y - 4, width: 64, height: 4, color: ACCENT });
  y -= 28;
  page.drawText('CYBERSYGN', {
    x: MARGIN, y, size: 16, font: serifBold, color: INK,
    characterSpacing: 1.8,
  });
  const wordmarkWidth = serifBold.widthOfTextAtSize('CYBERSYGN', 16) + 1.8 * 8;
  page.drawText('AUDIT CERTIFICATE', {
    x: MARGIN + wordmarkWidth + 16, y: y + 3,
    size: 9, font: monoBold, color: INK_FAINT,
  });
  y -= 36;

  page.drawText(truncate(doc.title || 'CyberSygn document', 70), {
    x: MARGIN, y, size: 22, font: serifBold, color: INK,
  });
  y -= 18;
  page.drawText(
    `Issued ${formatDateTime(new Date().toISOString())}.`,
    { x: MARGIN, y, size: 10, font: serif, color: INK_SOFT },
  );
  y -= 24;
  page.drawRectangle({ x: MARGIN, y, width: COL_W, height: 0.6, color: RULE });
  y -= 20;

  // ---- 2. Document identity --------------------------------------------
  drawSectionHead(page, MARGIN, y, '01.', 'Document identity.', serifBold, monoBold, ACCENT, INK);
  y -= 22;
  y = drawKV(page, MARGIN, y, COL_W, [
    ['Document ID', doc.id, mono, INK],
    ['Title',       truncate(doc.title || '(untitled)', 72), serif, INK],
    ['Sender',      doc.senderName || '(unknown)', serif, INK],
    ['Created',     formatDateTime(doc.createdAt), serif, INK],
    ['Completed',   doc.completedAt ? formatDateTime(doc.completedAt) : 'Not yet complete', serif, INK],
    ['Fields',      `${(doc.fields || []).length} detected`, mono, INK],
  ], { labelFont: monoBold, labelColor: INK_FAINT });
  y -= 16;

  // ---- 3. Signers --------------------------------------------------------
  newPageIfNeeded(60 + (doc.signers || []).length * 22);
  drawSectionHead(page, MARGIN, y, '02.', 'Signers.', serifBold, monoBold, ACCENT, INK);
  y -= 22;

  // Header row
  const COLS = [
    { x: MARGIN,        w: 200, label: 'Name' },
    { x: MARGIN + 200,  w: 200, label: 'Email' },
    { x: MARGIN + 400,  w: 60,  label: 'Fields' },
    { x: MARGIN + 460,  w: 60,  label: 'Status' },
  ];
  for (const c of COLS) {
    page.drawText(c.label.toUpperCase(), { x: c.x, y, size: 8, font: monoBold, color: INK_FAINT });
  }
  y -= 10;
  page.drawRectangle({ x: MARGIN, y, width: COL_W, height: 0.4, color: RULE });
  y -= 14;

  for (const signer of (doc.signers || [])) {
    newPageIfNeeded(24);
    const ownedCount = Object.values(doc.assignments || {}).filter(sId => sId === signer.id).length;
    const filledCount = Object.keys(signer.fills || {}).length;
    const statusText = signer.completedAt ? 'Signed' : (filledCount > 0 ? `${filledCount}/${ownedCount}` : 'Pending');
    const statusColor = signer.completedAt ? rgb(0.184, 0.322, 0.286) : INK_SOFT;

    page.drawText(truncate(signer.name, 36), { x: COLS[0].x, y, size: 11, font: serifBold, color: INK });
    page.drawText(truncate(signer.email || '(no email)', 36), { x: COLS[1].x, y, size: 9, font: mono, color: INK_SOFT });
    page.drawText(String(ownedCount), { x: COLS[2].x, y, size: 11, font: mono, color: INK });
    page.drawText(statusText, { x: COLS[3].x, y, size: 9, font: monoBold, color: statusColor });
    y -= 18;
  }
  y -= 6;

  // ---- 4. Event log ------------------------------------------------------
  const events = (doc.events || []).slice();
  newPageIfNeeded(80);
  drawSectionHead(page, MARGIN, y, '03.', 'Event log.', serifBold, monoBold, ACCENT, INK);
  y -= 8;
  page.drawText(`${events.length} ${events.length === 1 ? 'event' : 'events'} recorded.`, {
    x: MARGIN, y, size: 9, font: serif, color: INK_SOFT,
  });
  y -= 16;

  const E_COLS = [
    { x: MARGIN,       w: 130, label: 'Timestamp (UTC)' },
    { x: MARGIN + 130, w: 80,  label: 'Type' },
    { x: MARGIN + 210, w: 130, label: 'Signer' },
    { x: MARGIN + 340, w: 100, label: 'IP' },
    { x: MARGIN + 440, w: 60,  label: 'Device' },
  ];
  for (const c of E_COLS) {
    page.drawText(c.label.toUpperCase(), { x: c.x, y, size: 7, font: monoBold, color: INK_FAINT });
  }
  y -= 9;
  page.drawRectangle({ x: MARGIN, y, width: COL_W, height: 0.4, color: RULE });
  y -= 12;

  for (const ev of events) {
    newPageIfNeeded(16);
    const signerName = ev.signerId
      ? ((doc.signers || []).find(s => s.id === ev.signerId)?.name || ev.signerId)
      : '-';
    page.drawText(formatDateTime(ev.at), { x: E_COLS[0].x, y, size: 8, font: mono, color: INK });
    page.drawText(ev.type, { x: E_COLS[1].x, y, size: 8, font: monoBold, color: INK });
    page.drawText(truncate(signerName, 22), { x: E_COLS[2].x, y, size: 8, font: serif, color: INK });
    page.drawText(ev.ip || '-', { x: E_COLS[3].x, y, size: 8, font: mono, color: INK_SOFT });
    page.drawText(deviceTag(ev.userAgent), { x: E_COLS[4].x, y, size: 8, font: mono, color: INK_SOFT });
    y -= 13;
  }

  // ---- 4b. Sender field edits ------------------------------------------
  // If the sender manually adjusted any auto-detected fields (changed
  // type, promoted/demoted, removed), record those changes here so the
  // audit reflects what the sender actually decided rather than only
  // what the detector found.
  const editEntries = Object.entries(doc.fieldEdits || {});
  if (editEntries.length > 0) {
    y -= 6;
    newPageIfNeeded(80);
    drawSectionHead(page, MARGIN, y, '03b.', 'Sender field edits.', serifBold, monoBold, ACCENT, INK);
    y -= 8;
    page.drawText(
      `${editEntries.length} field${editEntries.length === 1 ? '' : 's'} adjusted from automatic detection.`,
      { x: MARGIN, y, size: 9, font: serif, color: INK_SOFT },
    );
    y -= 16;

    const EE_COLS = [
      { x: MARGIN,       w: 130, label: 'At (UTC)' },
      { x: MARGIN + 130, w: 60,  label: 'Action' },
      { x: MARGIN + 190, w: 100, label: 'Was' },
      { x: MARGIN + 290, w: 100, label: 'Became' },
      { x: MARGIN + 390, w: 110, label: 'Label / location' },
    ];
    for (const c of EE_COLS) {
      page.drawText(c.label.toUpperCase(), { x: c.x, y, size: 7, font: monoBold, color: INK_FAINT });
    }
    y -= 9;
    page.drawRectangle({ x: MARGIN, y, width: COL_W, height: 0.4, color: RULE });
    y -= 12;

    // Sort entries by the earliest history timestamp for chronological display.
    const sortedEntries = editEntries.slice().sort((a, b) => {
      const aT = (a[1].history && a[1].history[0] && a[1].history[0].at) || '';
      const bT = (b[1].history && b[1].history[0] && b[1].history[0].at) || '';
      return aT.localeCompare(bT);
    });

    for (const [fieldId, overlay] of sortedEntries) {
      // Walk each history entry; one row per change so the audit shows
      // the full sequence (e.g. signature -> date -> deleted).
      const history = Array.isArray(overlay.history) ? overlay.history : [];
      if (history.length === 0) {
        // Fall back to a single roll-up row if history was not recorded.
        history.push({ at: doc.createdAt, change: overlay, prev: {} });
      }
      for (const entry of history) {
        newPageIfNeeded(14);
        const at = formatDateTime(entry.at || doc.createdAt);
        let action = 'changed';
        let was = '';
        let became = '';
        if (entry.change && entry.change.deleted) {
          action = 'removed';
          was = entry.prev && entry.prev.type ? entry.prev.type : 'field';
          became = '-';
        } else if (entry.change && typeof entry.change.type === 'string') {
          action = 'retyped';
          was = entry.prev && entry.prev.type ? entry.prev.type : '?';
          became = entry.change.type;
        } else if (entry.change && typeof entry.change.primary === 'boolean') {
          action = entry.change.primary ? 'promoted' : 'demoted';
          was = entry.prev && entry.prev.primary ? 'primary' : 'body';
          became = entry.change.primary ? 'primary' : 'body';
        }
        const labelOrLoc = (overlay.lastSnapshot && overlay.lastSnapshot.label)
          ? overlay.lastSnapshot.label
          : (overlay.lastSnapshot
            ? `page ${overlay.lastSnapshot.page || '?'}`
            : (() => {
              // Look up the field in the doc to get its label, if it still exists.
              const f = (doc.fields || []).find(f => f.id === fieldId);
              return (f && f.label) ? f.label : `field ${fieldId.slice(0, 8)}`;
            })());

        page.drawText(at, { x: EE_COLS[0].x, y, size: 8, font: mono, color: INK });
        page.drawText(action, { x: EE_COLS[1].x, y, size: 8, font: monoBold, color: INK });
        page.drawText(truncate(was, 16), { x: EE_COLS[2].x, y, size: 8, font: mono, color: INK_SOFT });
        page.drawText(truncate(became, 16), { x: EE_COLS[3].x, y, size: 8, font: mono, color: INK });
        page.drawText(truncate(labelOrLoc, 18), { x: EE_COLS[4].x, y, size: 8, font: serif, color: INK });
        y -= 13;
      }
    }
  }

  // ---- 5. Document fingerprint footer -----------------------------------
  newPageIfNeeded(60);
  y -= 12;
  page.drawRectangle({ x: MARGIN, y, width: COL_W, height: 0.6, color: RULE });
  y -= 18;
  drawSectionHead(page, MARGIN, y, '04.', 'Document fingerprint.', serifBold, monoBold, ACCENT, INK);
  y -= 20;
  page.drawText('SHA-256 of the original PDF signed by every party:', {
    x: MARGIN, y, size: 10, font: serif, color: INK_SOFT,
  });
  y -= 14;
  // Split the hash so it always fits the page width.
  const hashParts = chunk(pdfSha256, 16);
  page.drawText(hashParts.slice(0, 2).join(' '), { x: MARGIN, y, size: 10, font: monoBold, color: INK });
  y -= 14;
  page.drawText(hashParts.slice(2).join(' '), { x: MARGIN, y, size: 10, font: monoBold, color: INK });
  y -= 24;
  page.drawText(
    'Any modification to the signed PDF after issuance will change this hash. ' +
    'CyberSygn retains an immutable copy of the signed document for the life of your account.',
    { x: MARGIN, y, size: 9, font: serif, color: INK_FAINT, maxWidth: COL_W, lineHeight: 12 },
  );

  // ---- Page numbering -------------------------------------------------
  const pages = pdf.getPages();
  pages.forEach((p, idx) => {
    const label = `Page ${idx + 1} of ${pages.length}.  CyberSygn audit certificate.  ${doc.id}`;
    p.drawText(label, {
      x: MARGIN, y: 28, size: 7, font: mono, color: INK_FAINT,
    });
  });

  return pdf.save();
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function drawSectionHead(page, x, y, num, label, titleFont, numFont, accent, ink) {
  page.drawText(num, { x, y, size: 11, font: numFont, color: accent });
  page.drawText(label, { x: x + 28, y, size: 14, font: titleFont, color: ink });
}

function drawKV(page, x, y, w, rows, opts = {}) {
  const labelFont = opts.labelFont;
  const labelColor = opts.labelColor;
  let cursor = y;
  for (const [k, v, valueFont, valueColor] of rows) {
    page.drawText(k.toUpperCase(), { x, y: cursor, size: 8, font: labelFont, color: labelColor });
    page.drawText(String(v), { x: x + 110, y: cursor, size: 11, font: valueFont, color: valueColor });
    cursor -= 18;
  }
  return cursor;
}

function chunk(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function deviceTag(ua) {
  if (!ua) return '-';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}
