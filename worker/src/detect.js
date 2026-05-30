/**
 * CyberSygn field detection.
 *
 * Input:  Uint8Array of a PDF document.
 * Output: { pageCount, fields: [{ type, label, page, x, y, width, height, confidence, source }] }
 *
 * Coordinates are in PDF user units (1 unit = 1/72 inch), origin bottom-left.
 *
 * Detection pipeline:
 *   1. AcroForm widget annotations (highest confidence, instant match)
 *   2. Text-label heuristics matched against drawn horizontal lines
 *   3. Drawn rectangles classified by size (small square = checkbox)
 *   4. Unlabeled signature lines fall back to type "signature" at low confidence
 *
 * This module is pure ES, uses only pdfjs-dist, and runs in Node 20+ and
 * Cloudflare Workers. No Node-specific imports in the hot path.
 */

import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ---- Label patterns ----------------------------------------------------------

const SIGNATURE_PATTERNS = [
  { re: /^\s*signature\b/i, conf: 0.94 },
  { re: /\bsignature\b/i, conf: 0.9 },
  { re: /\bsign\s+here\b/i, conf: 0.9 },
  // "Signed:" with a colon is the second-most-common signature label
  // form after "Signature:" in real-world templates (every uploaded
  // SignWell, LawDepot, and Signaturely template uses it). Anchored to
  // start-of-label and requires the trailing colon so body-text like
  // "signed the document yesterday" does not false-match.
  { re: /^\s*signed\s*:/i, conf: 0.9 },
  { re: /(^|\s)\/s\/\s*$/, conf: 0.88 },
  { re: /^x\s*$/i, conf: 0.62 },
];

const INITIAL_PATTERNS = [
  { re: /\binitial(s)?\b/i, conf: 0.9 },
  { re: /\(initial(s)?\)/i, conf: 0.92 },
];

const DATE_PATTERNS = [
  { re: /\bdate(\s+signed)?\b/i, conf: 0.88 },
  { re: /\(date\)/i, conf: 0.92 },
  { re: /signed\s+on\b/i, conf: 0.85 },
];

const SIGNATURE_ADJACENT_LABELS = [
  /printed\s+name/i,
  /title\b/i,
  /name\b/i,
];

// Short uppercase labels we treat as party-role markers above a baseline.
// One to four words, letters and spaces only. Matches BRAND AMBASSADOR,
// HUSBAND, PARTY A, SHAREHOLDER. Does not match section headers like
// SIGNATURE AND DATE (4 words but no signature/date keyword would lose
// to those keyword patterns earlier in the pipeline anyway).
const PARTY_ROLE_LABEL = /^[A-Z]{2,}(?:\s+[A-Z]{1,})?(?:\s+[A-Z]{1,})?(?:\s+[A-Z]{1,})?$/;

// ---- Bracket placeholder patterns -------------------------------------------
// Some templates (notably attorney-drafted ones like LegalZoom and
// RocketLawyer outputs) use bracketed instruction tokens instead of
// underscore lines: [Insert Date], [Seller's Name], [Buyer's Signature].
// Pass 5 looks for these and infers the field type from the keyword inside
// the brackets. The keyword set is intentionally narrow: the cost of a
// false positive (a citation or a defined-term reference) is a stray
// field a user has to dismiss, while the cost of a false negative is a
// document with zero detectable fields (as we saw on Land-Purchase).

const BRACKET_PLACEHOLDER = /\[([^\[\]\n]{2,80})\]/g;

const BRACKET_KEYWORD_PATTERNS = [
  { type: 'signature', re: /\bsignature\b/i, conf: 0.86 },
  { type: 'signature', re: /\b(seller|buyer|landlord|tenant|lessor|lessee|client|company|witness|testator|investor|licensor|licensee|organizer|partner|supplier|vendor|freelancer|contractor|employee|employer)(?:['’])?s?\s+(name|full\s+name|signature)\b/i, conf: 0.82 },
  { type: 'date',      re: /\b(insert\s+)?date\b/i, conf: 0.86 },
  { type: 'initial',   re: /\binitial(s)?\b/i, conf: 0.84 },
  { type: 'text',      re: /\binsert\s+/i, conf: 0.6 },  // generic [Insert X] fallback
  { type: 'text',      re: /\b(specify|describe|provide|enter)\b/i, conf: 0.55 },
];

// ---- Primary signature block heuristics -------------------------------------
// Pass 6 walks pages from the end of the document and identifies the
// dedicated signature block (the final cluster of party-role labels and
// date lines). Fields inside that block are marked primary=true; everything
// else stays in the output but with primary=false so the UI can hide
// inline body fill-ins by default and surface them on demand.

// Headers that almost always introduce the final signature block.
const SIG_BLOCK_HEADER = /^(signatures?(\s+and\s+date)?|signed\s+by|in\s+witness\s+whereof|signature\s+page|execution\s+page)\.?\s*$/i;

// ---- Pdf.js op codes ---------------------------------------------------------

const FN_MOVE_TO = OPS.moveTo;
const FN_LINE_TO = OPS.lineTo;
const FN_RECTANGLE = OPS.rectangle;

// ---- Public API --------------------------------------------------------------

export async function detectFields(pdfData, opts = {}) {
  const verbose = !!opts.verbose;
  const doc = await getDocument({
    data: pdfData,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const allFields = [];
  // Per-page orphan labels: signature/date/initial labels in the bottom
  // band of a page that did NOT pair with any detected line. These feed
  // pass 5.5 cross-page propagation.
  const orphanLabelsByPage = new Map();

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const pageWidth = viewport.width;

    // Pass 1: AcroForm widget annotations.
    const annotations = await page.getAnnotations();
    const widgetFields = [];
    for (const a of annotations) {
      if (a.subtype !== 'Widget') continue;
      const f = widgetToField(a, pageNum);
      if (f) widgetFields.push(f);
    }

    // Pass 2: extract text items with positions.
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str && it.str.length > 0)
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: it.height || 11,
      }));

    // Pass 3: extract horizontal lines and rectangles from the operator stream.
    const opList = await page.getOperatorList();
    const { lines: drawnLines, rects } = extractGeometry(opList);

    // Pass 3b: harvest text-rendered underscore runs as synthetic baselines.
    // Many real-world contracts draw their fill-in lines as long underscore
    // strings rather than stroked paths.
    const underscoreLines = extractUnderscoreLines(items);

    const lines = [...drawnLines, ...underscoreLines];

    if (verbose) {
      console.error(
        `page ${pageNum}: ${items.length} text items, ${drawnLines.length} drawn lines, ` +
        `${underscoreLines.length} underscore lines, ${rects.length} rects, ` +
        `${widgetFields.length} widgets`,
      );
    }

    // Pass 4: classify lines and rects using nearby text labels.
    const lineFields = classifyLines(items, lines, pageNum, pageWidth);
    const rectFields = classifyRects(items, rects, pageNum);

    // Pass 5: bracket-placeholder tokens. Some templates use [Insert Date]
    // or [Seller's Name] instead of underscore lines. We only fall back to
    // brackets when the rule-based passes returned little or nothing on
    // this page, to avoid double-counting documents that have both styles.
    const haveStrongLines = lineFields.length >= 2;
    const bracketFields = haveStrongLines
      ? []
      : classifyBracketPlaceholders(items, pageNum);

    // Merge per-page, prefer widget > line > rect > bracket when overlapping.
    const merged = mergePageFields(
      [...widgetFields, ...lineFields, ...rectFields, ...bracketFields],
    );

    // Pass 4.5: implicit fields from orphan labels. Catches release-form
    // patterns where a signature/date label is printed with no underline
    // or widget under it (the form expects a hand-drawn signature in the
    // adjacent whitespace).
    const implicit = findImplicitFields(items, merged, pageNum, pageWidth);
    const mergedWithImplicit = implicit.length
      ? mergePageFields([...merged, ...implicit])
      : merged;

    allFields.push(...mergedWithImplicit);

    // Harvest orphan labels for cross-page propagation. A signature or
    // date label at the bottom of the page whose underlying line was
    // not detected (no merged field within ~25 PDF units of the label's
    // mid-x and y) will be matched to bare lines at the top of the
    // next page.
    const bottomLabels = findOrphanLabels(items, mergedWithImplicit, pageNum, pageHeight);
    if (bottomLabels.length > 0) {
      orphanLabelsByPage.set(pageNum, bottomLabels);
    }
  }

  // Pass 5.5: cross-page label propagation. Bare unlabeled lines at the
  // top of page N+1 inherit type/label from orphan labels at the bottom
  // of page N (collected during the per-page loop above).
  const fieldsWithPropagation = propagateLabelsAcrossPages(allFields, orphanLabelsByPage);

  // Pass 6: walk all detected fields, identify the dedicated signature
  // block at the end of the document, mark its fields primary=true. All
  // other fields get primary=false. The UI can show primary fields by
  // default and offer an "show all" toggle for the rest.
  const fieldsWithPrimary = markPrimarySignatureBlock(fieldsWithPropagation, doc.numPages);

  return {
    pageCount: doc.numPages,
    fields: fieldsWithPrimary,
  };
}

// ---- Widget annotations ------------------------------------------------------

function widgetToField(a, pageNum) {
  if (!a.rect || a.rect.length !== 4) return null;
  const [x1, y1, x2, y2] = a.rect;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  const name = (a.fieldName || '').toLowerCase();
  let type = 'text';
  if (a.fieldType === 'Btn') {
    type = 'checkbox';
  } else if (a.fieldType === 'Sig') {
    type = 'signature';
  } else if (a.fieldType === 'Tx') {
    if (/sig/.test(name)) type = 'signature';
    else if (/init/.test(name)) type = 'initial';
    else if (/date/.test(name)) type = 'date';
    else type = 'text';
  }

  return {
    type,
    label: a.fieldName || null,
    page: pageNum,
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
    confidence: 1.0,
    source: 'acroform',
  };
}

// ---- Geometry extraction -----------------------------------------------------

/**
 * Walk the operator list and pull out:
 *  - horizontal lines (moveTo + lineTo with matching y)
 *  - rectangles (rectangle op)
 *
 * pdf.js encodes path ops inside a single `constructPath` op:
 *   argsArray[i] = [fnCodes[], pointArgs[], minMaxBbox[]]
 *
 * For a single horizontal line drawn with c.moveTo + c.lineTo:
 *   fnCodes = [13, 14]                       (moveTo, lineTo)
 *   pointArgs = [x1, y1, x2, y2]
 *
 * For a rectangle drawn with c.rect(x, y, w, h):
 *   fnCodes = [19]                            (rectangle)
 *   pointArgs = [x, y, w, h]
 */
function extractGeometry(opList) {
  const lines = [];
  const rects = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn !== OPS.constructPath) continue;
    const args = opList.argsArray[i];
    if (!args || args.length < 2) continue;
    const fnCodes = args[0];
    const points = args[1];
    if (!Array.isArray(fnCodes) || !Array.isArray(points)) continue;

    // Walk fnCodes consuming points.
    let p = 0;
    let lastX = null;
    let lastY = null;
    for (const code of fnCodes) {
      if (code === FN_MOVE_TO) {
        lastX = points[p++];
        lastY = points[p++];
      } else if (code === FN_LINE_TO) {
        const nx = points[p++];
        const ny = points[p++];
        if (lastX !== null && Math.abs(ny - lastY) < 0.5 && Math.abs(nx - lastX) > 8) {
          // Horizontal line of meaningful length.
          lines.push({
            x: Math.min(lastX, nx),
            y: ny,
            width: Math.abs(nx - lastX),
            height: 12, // assumed field height for signature-line baseline
          });
        }
        lastX = nx;
        lastY = ny;
      } else if (code === FN_RECTANGLE) {
        const rx = points[p++];
        const ry = points[p++];
        const rw = points[p++];
        const rh = points[p++];
        rects.push({ x: rx, y: ry, width: rw, height: rh });
      } else {
        // Skip op we don't care about; consume no points by default.
        // pdf.js path ops we care about are moveTo/lineTo/rectangle only.
      }
    }
  }

  return { lines, rects };
}

/**
 * Walk text items and synthesize baselines from runs of underscore characters.
 *
 * Two cases:
 *  - The whole item is underscores (typical of a final signature block):
 *      str = "_______________________________"
 *  - The underscores are embedded inside a longer mixed item, which is
 *    how body fill-in fields usually arrive from pdfjs:
 *      str = "entered into on ________________ (the Effective Date)..."
 *
 * In the second case we compute the underscore run's x position from
 * its character index using an average character width derived from
 * the item's total width. This is approximate but underscores have
 * consistent enough metrics for the position to be usable.
 *
 * Five or more underscores in a run qualify; shorter runs are usually
 * stylistic typography rather than fill-in fields.
 */
function extractUnderscoreLines(items) {
  const out = [];
  const runRe = /_{5,}/g;
  for (const it of items) {
    const s = it.str || '';
    if (!s.includes('_')) continue;
    const itemWidth = it.w || 0;
    const itemLen = s.length;
    if (itemLen === 0 || itemWidth === 0) continue;
    const charWidth = itemWidth / itemLen;

    runRe.lastIndex = 0;
    let m;
    while ((m = runRe.exec(s)) !== null) {
      const startIdx = m.index;
      const runLen = m[0].length;
      out.push({
        x: it.x + startIdx * charWidth,
        y: it.y,
        width: runLen * charWidth,
      });
    }
  }
  return out;
}

/**
 * Returns true when a string is dominantly underscores (a rendered
 * baseline). Used to keep these items from acting as labels for
 * adjacent baselines.
 */
function isUnderscoreItem(s) {
  if (!s) return false;
  const trimmed = s.replace(/[.,;:)\s]+/g, '');
  if (trimmed.length < 5) return false;
  const underscoreCount = (trimmed.match(/_/g) || []).length;
  return underscoreCount / trimmed.length >= 0.8;
}

// ---- Line classification -----------------------------------------------------

function classifyLines(items, lines, pageNum, pageWidth) {
  const fields = [];

  for (const line of lines) {
    // Find a label item adjacent to the line. Pass the lines array so
    // the binder can recognize column-header rows (multiple lines on
    // the same baseline) and widen its below-side lookup window.
    const label = findLabelForLine(items, line, lines);
    const { type, confidence, labelText, source } = inferTypeFromLabel(label);

    fields.push({
      type,
      label: labelText,
      page: pageNum,
      x: round(line.x),
      y: round(line.y),
      width: round(line.width),
      height: 14, // baseline area; large enough for input, small enough not to overlap adjacent rows
      confidence,
      source,
    });
  }

  return fields;
}

/**
 * For a horizontal line, gather candidate labels from all four sides and
 * return the one that produces the strongest type signal. This is what
 * makes "X _______ (date)" classify as a date field rather than a signature.
 */
/**
 * For a horizontal line, gather candidate labels from all four sides and
 * return the one that produces the strongest type signal. This is what
 * makes "X _______ (date)" classify as a date field rather than a signature.
 *
 * The `siblings` array (other lines on the same page) lets the binder
 * detect the column-header convention: when this line has 1+ peers at
 * approximately the same y, its labels are likely the column headers
 * printed on the row below (Name / Signature / Date). In that case the
 * below lookup window widens to 30 PDF units. For solitary lines the
 * window stays tight at 20 so labels from a different row do not bleed
 * across (e.g. an inline "(date)" label belonging to the row below
 * should not classify the row above as a date).
 *
 * Below candidates are further suppressed in scoring whenever any
 * non-below candidate produces a recognized type signal -- this is
 * what makes two-row two-column signature blocks work: BRAND AMBASSADOR
 * above wins over DATE below.
 */
function findLabelForLine(items, line, siblings) {
  const lineEndX = line.x + line.width;
  const candidates = [];

  // Column-header detection: does this line have a peer at the same y
  // with meaningful x-separation? Same-y AND adjacent-x is just a
  // continuation of the same visual line (some PDFs render long
  // underscore runs as two stroked paths joined end to end).
  let isMultiColumnRow = false;
  if (Array.isArray(siblings)) {
    for (const other of siblings) {
      if (other === line) continue;
      if (Math.abs(other.y - line.y) > 2) continue;
      const otherEndX = other.x + other.width;
      const gap = Math.min(
        Math.abs(other.x - lineEndX),
        Math.abs(line.x - otherEndX),
      );
      if (gap > 20) { isMultiColumnRow = true; break; }
    }
  }
  const belowWindow = isMultiColumnRow ? 30 : 20;

  for (const it of items) {
    // Skip items that are themselves underscore baselines. They show up
    // as left/right neighbors of other lines on the same row of a
    // signature block and would otherwise be mistaken for labels.
    if (isUnderscoreItem(it.str)) continue;
    // Skip whitespace-only or near-empty items. Pdf.js emits zero-width
    // and whitespace tokens; without this guard they win as low-confidence
    // 'label-unknown' candidates and crowd out real labels.
    if (!it.str || it.str.trim().length < 2) continue;

    const baselineDelta = Math.abs(it.y - line.y);
    const itemEndX = it.x + it.w;

    // Left of line at the same baseline.
    if (baselineDelta <= 6) {
      const gap = line.x - itemEndX;
      if (gap >= -2 && gap < 80) {
        candidates.push({ side: 'left', str: it.str.trim(), dist: gap });
      }
    }

    // Above the line. Window stretches up to 32 units to catch the wider
    // line-spacing used in formal signature blocks (label on one line,
    // baseline on the next).
    const yAbove = it.y - line.y;
    if (yAbove > 2 && yAbove < 32 && it.x + it.w > line.x - 10 && it.x < lineEndX + 10) {
      candidates.push({ side: 'above', str: it.str.trim(), dist: yAbove });
    }

    // Right of line at the same baseline.
    if (baselineDelta <= 6) {
      const gap = it.x - lineEndX;
      if (gap >= -2 && gap < 60) {
        candidates.push({ side: 'right', str: it.str.trim(), dist: gap });
      }
    }

    // Below the line. Window is 20 by default; widened to 30 when this
    // line is part of a multi-column row.
    const yBelow = line.y - it.y;
    if (yBelow > 4 && yBelow < belowWindow && it.x + it.w > line.x - 10 && it.x < lineEndX + 10) {
      candidates.push({ side: 'below', str: it.str.trim(), dist: yBelow });
    }
  }

  if (candidates.length === 0) return null;

  // If any non-below candidate produces a recognized type signal
  // (date/signature/initial label match, or party-role match), drop all
  // below candidates from consideration. This prevents the next row's
  // label in a two-row two-column signature block (line, then below it
  // a row of DATE labels) from beating the correct above/left label.
  // Below candidates only matter for column-header layouts that have
  // no other labels around the line at all.
  const recognizedNonBelow = candidates.some(c => {
    if (c.side === 'below') return false;
    const inf = inferTypeFromLabel(c);
    return inf.source === 'label-match' || inf.source === 'party-role';
  });
  const scored = recognizedNonBelow
    ? candidates.filter(c => c.side !== 'below')
    : candidates;

  // Score every candidate and pick the strongest.
  let best = null;
  let bestScore = -1;
  for (const c of scored) {
    const inferred = inferTypeFromLabel(c);

    // Side weighting: left labels are the dominant convention in printed
    // forms and almost always authoritative when present.
    const sideBonus =
      c.side === 'left' ? 0.4
        : c.side === 'right' ? 0.0
          : c.side === 'above' ? -0.1
            : -0.2;

    // Source weighting: we trust a confirmed type match more than a
    // semantically adjacent label and much more than a guess.
    const sourceBonus =
      inferred.source === 'label-match' ? 0.1
        : inferred.source === 'label-adjacent' ? 0.0
          : -0.3;

    // Parenthetical labels are explicit field markers and override
    // position bias when present.
    const parenBonus = /^\s*\(.+\)\s*$/.test(c.str) ? 0.3 : 0;

    const score = inferred.confidence + sideBonus + sourceBonus + parenBonus;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function inferTypeFromLabel(label) {
  if (!label) {
    return {
      type: 'signature',
      confidence: 0.45,
      labelText: null,
      source: 'unlabeled-line',
    };
  }
  const s = label.str || '';

  for (const p of DATE_PATTERNS) {
    if (p.re.test(s)) {
      return { type: 'date', confidence: p.conf, labelText: s, source: 'label-match' };
    }
  }
  for (const p of INITIAL_PATTERNS) {
    if (p.re.test(s)) {
      return { type: 'initial', confidence: p.conf, labelText: s, source: 'label-match' };
    }
  }
  for (const p of SIGNATURE_PATTERNS) {
    if (p.re.test(s)) {
      return { type: 'signature', confidence: p.conf, labelText: s, source: 'label-match' };
    }
  }
  for (const re of SIGNATURE_ADJACENT_LABELS) {
    if (re.test(s)) {
      return {
        type: 'text',
        confidence: 0.7,
        labelText: s,
        source: 'label-adjacent',
      };
    }
  }
  // Short all-uppercase labels that we don't otherwise recognize are
  // almost always party-role labels above a signature line:
  // BRAND AMBASSADOR, HUSBAND, COMPANY, PARTY A, SHAREHOLDER, etc.
  // We require 1 to 4 words of letters and spaces only, with no digits
  // or punctuation, so section headers followed by body paragraphs do
  // not get matched (those are excluded geometrically anyway, but the
  // restriction adds defense in depth).
  const stripped = s.replace(/[.:]+\s*$/, '').trim();
  if (PARTY_ROLE_LABEL.test(stripped)) {
    return {
      type: 'signature',
      confidence: 0.78,
      labelText: stripped,
      source: 'party-role',
    };
  }
  // Fallback for any label we can read but don't recognize.
  return { type: 'text', confidence: 0.5, labelText: s, source: 'label-unknown' };
}

// ---- Rectangle classification -----------------------------------------------

function classifyRects(items, rects, pageNum) {
  const fields = [];
  for (const r of rects) {
    // Tiny rect: probably a checkbox.
    const isCheckboxSize = r.width >= 6 && r.width <= 18 && r.height >= 6 && r.height <= 18;
    if (!isCheckboxSize) continue;

    // Find the label to the right.
    const label = findRightLabel(items, r);
    fields.push({
      type: 'checkbox',
      label: label ? label.trim() : null,
      page: pageNum,
      x: round(r.x),
      y: round(r.y),
      width: round(r.width),
      height: round(r.height),
      confidence: label ? 0.88 : 0.62,
      source: label ? 'rect-with-label' : 'rect-only',
    });
  }
  return fields;
}

function findRightLabel(items, rect) {
  let best = null;
  let bestDist = Infinity;
  for (const it of items) {
    if (Math.abs(it.y - rect.y) > 8) continue;
    const gap = it.x - (rect.x + rect.width);
    if (gap >= -2 && gap < 30 && gap < bestDist) {
      bestDist = gap;
      best = it.str;
    }
  }
  return best;
}

// ---- Cross-page label propagation (Pass 5.5) --------------------------------

// ---- Implicit fields from orphan labels (Pass 4.5) -------------------------

/**
 * Synthesize fields next to high-confidence signature/date/initial labels
 * that have no underline, rectangle, or widget under or beside them.
 *
 * Release/waiver forms commonly print a label like "Participant's
 * Signature" followed by whitespace, with the field expected to be
 * hand-drawn in the gap. The geometry-based passes (lines, rects,
 * widgets, brackets) miss these entirely because nothing is drawn.
 * This pass scans the items for label-match patterns and, when no
 * already-detected field of the right type sits within reach of the
 * label's right edge at the same baseline, adds a synthetic field.
 *
 * Conservative gates to avoid body-text false positives:
 *   - inferTypeFromLabel must return source='label-match' (an explicit
 *     date/signature/initial regex hit, not the party-role or
 *     unlabeled-line fallbacks).
 *   - Confidence must be >= 0.85.
 *   - Item text trimmed must be <= 40 chars (real labels are short;
 *     this excludes prose like "...signed by the parties hereto...").
 *   - The width to the next x-aligned item caps the field, so adjacent
 *     "Signature   Date:" produces two fields with the right spacing.
 */
function findImplicitFields(items, mergedFields, pageNum, pageWidth) {
  const out = [];
  const RIGHT_MARGIN = 50;          // PDF units kept clear of page edge
  const MIN_WIDTH = 40;             // skip if there isn't room for a usable field
  const MAX_WIDTH = 220;
  const GAP_AFTER_LABEL = 4;

  for (const it of items) {
    const text = (it.str || '').trim();
    if (!text || text.length > 40) continue;
    if (isUnderscoreItem(it.str)) continue;

    const inferred = inferTypeFromLabel({ str: text });
    if (inferred.source !== 'label-match') continue;
    if (inferred.type !== 'signature' && inferred.type !== 'date' && inferred.type !== 'initial') continue;
    if (inferred.confidence < 0.85) continue;

    const labelEndX = it.x + (it.w || 0);
    const labelY = it.y;

    // Skip if a detected field of the matching type already sits next
    // to this label. Two cases count as "already paired":
    //   1. A field whose center is to the right of the label, within
    //      250 PDF units, at approximately the same baseline.
    //   2. A field whose x-range overlaps the label and whose y is
    //      within ~32 units (covers the label-above-line convention).
    const alreadyPaired = mergedFields.some(f => {
      if (f.type !== inferred.type) return false;
      const fMid = f.x + f.width / 2;
      const fEnd = f.x + f.width;
      const sameBaselineRight =
        Math.abs(f.y - labelY) <= 15 && fMid > labelEndX && fMid < labelEndX + 250;
      const labelAboveOrBelowField =
        Math.abs(f.y - labelY) <= 32 &&
        fEnd > it.x - 10 && f.x < labelEndX + 10;
      return sameBaselineRight || labelAboveOrBelowField;
    });
    if (alreadyPaired) continue;

    // Cap the synthesized field's width using whichever comes first:
    // the next text item on the same baseline, the right margin, or
    // the absolute MAX_WIDTH.
    let rightBound = pageWidth - RIGHT_MARGIN;
    for (const other of items) {
      if (other === it) continue;
      if (Math.abs(other.y - labelY) > 4) continue;
      if (other.x <= labelEndX + GAP_AFTER_LABEL) continue;
      const trimmed = (other.str || '').trim();
      if (trimmed.length < 2) continue;
      if (other.x < rightBound) rightBound = other.x;
    }

    const xStart = labelEndX + GAP_AFTER_LABEL;
    const width = Math.min(rightBound - xStart - 4, MAX_WIDTH);
    if (width < MIN_WIDTH) continue;

    out.push({
      type: inferred.type,
      label: text,
      page: pageNum,
      // Field sits just to the right of the label, on the same baseline.
      x: round(xStart),
      y: round(labelY),
      width: round(width),
      height: 14,
      // Discount confidence slightly: this is a heuristic placement,
      // not a confirmed underline. Still above the 0.7 bar that
      // markPrimarySignatureBlock requires.
      confidence: round(inferred.confidence * 0.9),
      source: 'implicit-label',
    });
  }
  return out;
}

/**
 * Find signature/date/initial labels at the bottom of a page whose
 * underlying baseline did NOT pair with any detected field. These are
 * the candidates for cross-page propagation: their real underline lives
 * at the top of the next page.
 *
 * "Bottom of page" means y < 200 PDF units (about 2.8 inches from the
 * bottom edge on a US Letter page). We do NOT require the label's y to
 * be the lowest on the page, since some documents have footer text
 * lower than the orphaned signature labels.
 */
function findOrphanLabels(items, mergedFields, pageNum, pageHeight) {
  const orphans = [];
  for (const it of items) {
    if (it.y > 200) continue;  // skip everything above the bottom band
    const text = (it.str || '').trim();
    if (!text) continue;

    // Try to classify this text as a sig/date/initial label.
    const inferred = inferTypeFromLabel({ str: text, side: 'standalone' });
    if (!inferred || (inferred.type !== 'date' && inferred.type !== 'signature' && inferred.type !== 'initial')) {
      continue;
    }
    if (inferred.confidence < 0.75) continue;

    // Skip if any merged field on this page already sits within ~25
    // units horizontally and ~30 units vertically (already paired).
    const midX = it.x + (it.w || 0) / 2;
    const labelY = it.y;
    const alreadyPaired = mergedFields.some(f => {
      const fMid = f.x + f.width / 2;
      const dxOk = Math.abs(fMid - midX) <= 30;
      const dyOk = Math.abs(f.y - labelY) <= 35;
      return dxOk && dyOk && (f.type === inferred.type);
    });
    if (alreadyPaired) continue;

    orphans.push({
      type: inferred.type,
      label: text,
      x: it.x,
      y: it.y,
      w: it.w || 30,
      midX,
      page: pageNum,
    });
  }
  return orphans;
}

/**
 * For documents whose signature block runs over a page break, orphan
 * labels on page N (bare labels at the bottom with no underlying line)
 * get matched to bare unlabeled lines at the top of page N+1 in the
 * same x-column. Matched lines have their type and label upgraded.
 *
 * Real example: Shareholders Agreement has DATE labels at y=77 on page
 * 4 with no underline. Page 5 starts with bare lines at y=708 in the
 * same x-columns. Propagation re-classifies those bare lines as dates.
 */
function propagateLabelsAcrossPages(fields, orphanLabelsByPage) {
  if (orphanLabelsByPage.size === 0) return fields;

  // Group fields by page for fast access.
  const byPage = new Map();
  for (const f of fields) {
    if (!byPage.has(f.page)) byPage.set(f.page, []);
    byPage.get(f.page).push(f);
  }

  const out = fields.slice();

  for (const [pageN, orphans] of orphanLabelsByPage) {
    const pageNext = pageN + 1;
    const nextFields = byPage.get(pageNext);
    if (!nextFields || nextFields.length === 0) continue;
    const maxNextY = Math.max(...nextFields.map(f => f.y));

    // Bare lines at the top of page N+1 (within ~60 units of maxNextY).
    const topBares = nextFields.filter(f =>
      f.source === 'unlabeled-line'
      && f.type === 'signature'
      && f.y >= maxNextY - 60
      && f.width >= 20 && f.width <= 250,
    );
    if (topBares.length === 0) continue;

    for (const bare of topBares) {
      const bareMid = bare.x + bare.width / 2;
      // For each candidate orphan label, compute column distance. Among
      // viable matches, prefer the orphan with the lowest y (closest to
      // the page break) since those are the labels that physically
      // run onto the next page.
      let bestOrphan = null;
      let bestScore = -Infinity;
      for (const orphan of orphans) {
        const dx = Math.abs(orphan.midX - bareMid);
        if (dx > 30) continue;
        // Higher score wins. Reward column closeness and reward low y
        // (closer to the page break). y values around 0-200 here.
        const score = -dx - orphan.y * 0.5;
        if (score > bestScore) {
          bestScore = score;
          bestOrphan = orphan;
        }
      }
      if (!bestOrphan) continue;

      const idx = out.indexOf(bare);
      if (idx === -1) continue;
      out[idx] = {
        ...bare,
        type: bestOrphan.type,
        label: bestOrphan.label,
        confidence: 0.78,
        source: 'cross-page-propagation',
      };
    }
  }
  return out;
}

// ---- Bracket placeholder classification (Pass 5) ----------------------------

/**
 * Scan text items on a page for [bracketed] placeholder tokens. For each
 * match, classify the inner keyword and emit a field positioned over the
 * bracket. Used as a fallback when the underscore-line passes returned
 * little for this page; documents like Land-Purchase-Agreement use these
 * exclusively.
 */
function classifyBracketPlaceholders(items, pageNum) {
  const fields = [];
  for (const it of items) {
    BRACKET_PLACEHOLDER.lastIndex = 0;  // global regex state safety
    let m;
    while ((m = BRACKET_PLACEHOLDER.exec(it.str)) !== null) {
      const inner = m[1].trim();
      if (!inner) continue;

      // Skip URLs, numeric citations, and section refs like [1], [2.3].
      if (/^\d[\d.\s]*$/.test(inner)) continue;
      if (/^https?:/i.test(inner)) continue;

      const inferred = inferBracketType(inner);
      if (!inferred) continue;

      // Position the field over the bracket substring. We approximate
      // bracket width from character ratio of the item; close enough
      // for click-target purposes.
      const total = it.str.length || 1;
      const xOffset = (m.index / total) * it.w;
      const matchWidth = ((m[0].length) / total) * it.w;
      fields.push({
        type: inferred.type,
        label: inner,
        page: pageNum,
        x: round(it.x + xOffset),
        y: round(it.y),
        width: round(Math.max(matchWidth, 60)),  // widen to be a usable target
        height: 14,
        confidence: inferred.conf,
        source: 'bracket-placeholder',
      });
    }
  }
  return fields;
}

function inferBracketType(inner) {
  for (const p of BRACKET_KEYWORD_PATTERNS) {
    if (p.re.test(inner)) {
      return { type: p.type, conf: p.conf };
    }
  }
  return null;
}

// ---- Primary signature block (Pass 6) ---------------------------------------

/**
 * Identify which fields belong to the dedicated signature block at the
 * end of the document, vs body inline fill-ins. Returns a new array with
 * `primary: true|false` added to each field; nothing is removed.
 *
 * Strategy: walk pages from the last page backwards, find the highest-
 * confidence signature+date cluster, and treat fields below that cluster's
 * top y-coordinate (on its page and later pages) as primary. Stop the
 * walk once we've passed a header like "SIGNATURE AND DATE" or once two
 * full pages above the cluster have no signature-block characteristics.
 *
 * If no clear cluster is found, every field is marked primary=true (the
 * conservative fallback; matches prior behavior).
 */
function markPrimarySignatureBlock(fields, pageCount) {
  if (fields.length === 0) return fields;

  // Walk from the last page backwards. A "signature block" page has at
  // least two signature-or-date fields with a high-confidence signature
  // among them.
  //
  // In PDF coordinates the origin is bottom-left, so larger y means
  // higher on the page. The primary block is the y-band containing the
  // high-confidence cluster (typically a row of party-role signatures
  // and a row of dates immediately below them). We compute the
  // band's min and max y and accept fields inside the band on the
  // identified page, plus any field on a later page.
  let primaryPage = null;
  let bandMinY = 0;
  let bandMaxY = 0;

  for (let p = pageCount; p >= 1; p--) {
    const pageFields = fields.filter(f => f.page === p);
    const hiConfSigs = pageFields.filter(f => f.type === 'signature' && f.confidence >= 0.7);
    const hiConfDates = pageFields.filter(f => f.type === 'date' && f.confidence >= 0.7);
    if (hiConfSigs.length + hiConfDates.length >= 2 && hiConfSigs.length >= 1) {
      primaryPage = p;
      const blockFields = [...hiConfSigs, ...hiConfDates];
      const ys = blockFields.map(f => f.y);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      // Expand the band by ~120 PDF units (about 1.7 inches) on the
      // bottom side to catch a trailing date row beneath the signature
      // row, and ~40 units on top for any "SIGNATURE AND DATE" header.
      bandMinY = minY - 120;
      bandMaxY = maxY + 40;
      break;
    }
  }

  if (primaryPage === null) {
    return fields.map(f => ({ ...f, primary: true }));
  }

  return fields.map(f => {
    const isPrimary =
      f.page > primaryPage ||
      (f.page === primaryPage && f.y >= bandMinY && f.y <= bandMaxY);
    return { ...f, primary: isPrimary };
  });
}

// ---- De-duplication ---------------------------------------------------------

/**
 * Drop fields that overlap a higher-priority field of the same type on the
 * same page. Source priority: acroform > label-match > rect-with-label >
 * rect-only > unlabeled-line.
 */
function mergePageFields(fields) {
  const priority = {
    acroform: 5,
    'label-match': 4,
    'cross-page-propagation': 3,
    'rect-with-label': 3,
    'label-adjacent': 2,
    'rect-only': 2,
    'bracket-placeholder': 2,
    'label-unknown': 1,
    'unlabeled-line': 0,
  };

  // Sort highest priority first so earlier fields win.
  const sorted = [...fields].sort(
    (a, b) => (priority[b.source] ?? 0) - (priority[a.source] ?? 0),
  );
  const kept = [];
  for (const f of sorted) {
    const overlap = kept.some(k => boxesOverlap(k, f) && k.type === f.type);
    if (!overlap) kept.push(f);
  }
  // Re-sort kept by page, y desc, x asc for stable output.
  return kept.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 2) return b.y - a.y;
    return a.x - b.x;
  });
}

function boxesOverlap(a, b) {
  const xOverlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const yOverlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  if (xOverlap === 0 || yOverlap === 0) return false;
  const overlapArea = xOverlap * yOverlap;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  if (minArea === 0) return false;
  return overlapArea / minArea > 0.5;
}

// ---- Utility ----------------------------------------------------------------

function round(n) {
  return Math.round(n * 100) / 100;
}
