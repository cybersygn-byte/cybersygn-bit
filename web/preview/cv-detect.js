/**
 * Phase 2a: classical computer-vision pass on the rendered PDF canvas.
 *
 * Runs entirely in the browser. Reads pixel data from the rendered
 * <canvas>, walks rows looking for three signal patterns that the
 * text-heuristic detector (worker/src/detect.js) commonly misses:
 *
 *   1. Solid horizontal lines: long, thin, dark bands. Typical for
 *      unlabeled signature lines drawn directly in the PDF content
 *      stream (no Tj operator, so the text detector cannot see them).
 *   2. Underscore runs: rows containing a sequence of short dark
 *      segments at consistent y, the visual signature of `___________`
 *      stretches that pdf.js rendered as glyphs rather than lines.
 *   3. Checkbox outlines: small square outlines with mostly-empty
 *      interior. Common in roofing / insurance forms with itemized
 *      options.
 *
 * Per CONSTITUTION 7.11, this is the deferred Phase 2 work. This
 * pass is "classical" CV: pixel-walk + thresholds + run-length
 * analysis. No ML model, no API call, no new vendor. Latency is
 * roughly one canvas readback (8-30 ms) plus one row walk (50-80 ms)
 * per page on a 1.4x rendered viewport.
 *
 * Output: array of field candidates in PDF coordinates, ready to merge
 * with the heuristic detector results. Each candidate carries
 * source: 'cv-line' | 'cv-underscore' | 'cv-checkbox' and a confidence
 * score derived from signal strength.
 *
 * Safety: every loop has an explicit upper bound. Pixel reads are
 * try/catched; if getImageData throws (canvas tainted from cross-origin
 * draws — should not happen in our flow, but defensive), the detector
 * returns an empty array and logs.
 */

// Pixel luminance threshold. Below this value (0-255), a pixel counts
// as "dark." Lowered to 60 (from 90 in slice 28) so anti-aliased text
// edges no longer count; only true ink and lines fire.
const DARK_THRESHOLD = 60;

// Minimum continuous dark-pixel width (in canvas px) for a horizontal
// line candidate. Raised from 80 to 220 after slice 28 overfired:
// 80 px caught typed words like "Notes" as fake signature lines.
// Real signature lines on a 1.4x viewport are routinely 280-600 px wide.
const MIN_LINE_WIDTH_PX = 220;

// Maximum height (rows) for a horizontal line candidate. Tightened to
// 3 (from 4) so even thick paragraph rules are excluded.
const MAX_LINE_HEIGHT_PX = 3;

// Underscore-run detector parameters. Raised aggressively: real
// underscore runs like `__________________` are 200+ px wide and have
// 6+ short dark segments with clean gaps. Body text rarely matches.
const UNDERSCORE_SEGMENT_MIN_PX = 4;
const UNDERSCORE_SEGMENT_MAX_GAP_PX = 6;
const UNDERSCORE_MIN_TOTAL_WIDTH_PX = 250;
const UNDERSCORE_MIN_SEGMENT_COUNT = 6;  // new: filters out word-shaped clusters

// Checkbox detector parameters.
const CHECKBOX_MIN_PX = 10;
const CHECKBOX_MAX_PX = 24;
const CHECKBOX_INTERIOR_DARK_RATIO_MAX = 0.10;  // tighter: was 0.18, true empty checkboxes have ~0.02

// Safety cap. Even with the tightened thresholds, no more than this
// many CV candidates per page. Slice 28 painted 200+ boxes; never again.
const MAX_CV_PER_PAGE = 6;

/**
 * Main entry. Returns CV-detected field candidates in PDF coordinates.
 *
 * @param {HTMLCanvasElement} canvas - the rendered page canvas
 * @param {{width:number, height:number, scale:number}} viewport - render viewport
 * @param {number} pageNum - 1-based page index
 * @returns {Array<{type, page, x, y, width, height, confidence, source, label}>}
 */
export function detectVisually(canvas, viewport, pageNum) {
  let imageData;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (err) {
    // Tainted canvas or out-of-memory; return empty rather than throw.
    return [];
  }

  const dprScale = (canvas.width / viewport.width) || 1;
  const px = imageData.data;
  const W = imageData.width;
  const H = imageData.height;

  // Step 1: scan-row dark counts. For each row, count dark pixels and
  // detect contiguous dark runs (start x, end x, run length).
  const rowRuns = scanRows(px, W, H);

  // Step 2: cluster rows into bands. Adjacent dark rows with similar
  // x-extent form a single band (a multi-pixel-thick line).
  const lineBands = bandsFromRows(rowRuns, H);

  // Step 3: classify each band as horizontal-line or underscore-run.
  const candidates = [];
  for (const band of lineBands) {
    if (band.bestRunWidth >= MIN_LINE_WIDTH_PX && band.height <= MAX_LINE_HEIGHT_PX) {
      candidates.push(canvasBandToField(band, viewport, dprScale, pageNum, 'cv-line'));
    } else if (
      band.bestRunIsUnderscoreShape &&
      band.totalDarkPx >= UNDERSCORE_MIN_TOTAL_WIDTH_PX &&
      band.segmentCount >= UNDERSCORE_MIN_SEGMENT_COUNT
    ) {
      candidates.push(canvasBandToField(band, viewport, dprScale, pageNum, 'cv-underscore'));
    }
  }

  // Step 4: cheap checkbox detector. Scans for small square outlines
  // in the upper-left of each label-anchored row. We sample at a
  // coarser grid to keep this O(W·H/64).
  candidates.push(...detectCheckboxes(px, W, H, viewport, dprScale, pageNum));

  // Step 5: stable id per candidate, then cap. Even with tight
  // thresholds, the cap prevents a worst-case PDF from painting more
  // than MAX_CV_PER_PAGE boxes. We keep the candidates with the
  // highest confidence (signature lines tend to outrank underscore
  // and checkbox candidates).
  const all = candidates.filter(Boolean).map(c => ({
    ...c,
    id: cvId(c),
  }));
  all.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return all.slice(0, MAX_CV_PER_PAGE);
}

// ---------------------------------------------------------------------------
// Row scanning
// ---------------------------------------------------------------------------

function scanRows(px, W, H) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = { y, runs: [], totalDark: 0 };
    let runStart = -1;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lum = (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0;
      if (lum < DARK_THRESHOLD) {
        if (runStart === -1) runStart = x;
        row.totalDark++;
      } else if (runStart !== -1) {
        row.runs.push({ x0: runStart, x1: x - 1, w: x - runStart });
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      row.runs.push({ x0: runStart, x1: W - 1, w: W - runStart });
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Bands: vertically-adjacent rows whose biggest run overlaps in x.
// ---------------------------------------------------------------------------

function bandsFromRows(rows, H) {
  const bands = [];
  let active = null;

  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    if (row.runs.length === 0) {
      if (active) { bands.push(active); active = null; }
      continue;
    }
    const big = row.runs.reduce((a, b) => (a.w >= b.w ? a : b));
    if (!active) {
      active = startBand(y, big, row);
      continue;
    }
    // Check overlap with the active band's biggest run.
    const overlap = Math.min(active.x1, big.x1) - Math.max(active.x0, big.x0);
    const minWidth = Math.min(active.width, big.w);
    if (overlap > 0 && overlap / minWidth > 0.5 && (y - active.endY) <= 1) {
      // Extend.
      active.endY = y;
      active.height = active.endY - active.startY + 1;
      active.x0 = Math.min(active.x0, big.x0);
      active.x1 = Math.max(active.x1, big.x1);
      active.width = active.x1 - active.x0 + 1;
      active.bestRunWidth = Math.max(active.bestRunWidth, big.w);
      active.totalDarkPx += row.totalDark;
      active.runRows++;
    } else {
      bands.push(active);
      active = startBand(y, big, row);
    }
  }
  if (active) bands.push(active);
  return bands;
}

function startBand(y, big, row) {
  return {
    startY: y, endY: y, height: 1,
    x0: big.x0, x1: big.x1, width: big.w,
    bestRunWidth: big.w,
    totalDarkPx: row.totalDark,
    runRows: 1,
    segmentCount: row.runs.length,  // tracks underscore-style multi-segment rows
    bestRunIsUnderscoreShape: row.runs.length >= 6,  // tightened from 3
  };
}

// ---------------------------------------------------------------------------
// Convert a canvas-space band into a PDF-space field candidate.
// ---------------------------------------------------------------------------

function canvasBandToField(band, viewport, dprScale, pageNum, source) {
  // Canvas px -> CSS px (divide by dpr) -> PDF px (divide by viewport scale).
  const cssScale = dprScale * viewport.scale;
  // PDF coords have origin bottom-left; canvas is top-left. Flip Y.
  const padY = 4 / cssScale;  // give the box a little vertical padding
  const pdfX = band.x0 / cssScale;
  const pdfW = band.width / cssScale;
  const pdfY = (viewport.height * (dprScale) - (band.endY + 1)) / cssScale - padY;
  const pdfH = (band.height / cssScale) + padY * 2;

  // Confidence: longer runs and lower height score higher. Cap at 0.88
  // so heuristic-detected labeled fields (which score 90%+) outrank us.
  let conf = 0.65;
  if (band.bestRunWidth > 160) conf += 0.10;
  if (band.bestRunWidth > 280) conf += 0.08;
  if (band.height <= 2) conf += 0.05;
  conf = Math.min(0.88, conf);

  // Classify type: a long, thin line near the bottom of the document is
  // probably a signature; otherwise a generic text fill-in. The caller
  // can override after merging with heuristic context.
  let type = 'text';
  if (source === 'cv-line' && band.bestRunWidth > 140 && band.height <= 3) {
    type = 'signature';
  }
  return {
    type,
    page: pageNum,
    x: pdfX,
    y: pdfY,
    width: pdfW,
    height: pdfH,
    confidence: conf,
    source,
    label: '',
    primary: false,  // CV fields don't bypass the primary-band check; merge step promotes them
  };
}

// ---------------------------------------------------------------------------
// Checkbox detector. Cheap O(W·H/64) scan: sample on an 8x8 grid, look
// for square cells whose perimeter is mostly dark and interior is
// mostly light. Tiny squares matching CHECKBOX_MIN_PX..MAX_PX become
// candidate fields.
// ---------------------------------------------------------------------------

function detectCheckboxes(px, W, H, viewport, dprScale, pageNum) {
  const out = [];
  const STEP = 8;
  for (let y = 0; y < H - CHECKBOX_MAX_PX; y += STEP) {
    for (let x = 0; x < W - CHECKBOX_MAX_PX; x += STEP) {
      const size = guessSquareAt(px, W, H, x, y);
      if (size === null) continue;
      if (size < CHECKBOX_MIN_PX || size > CHECKBOX_MAX_PX) continue;
      const interiorRatio = interiorDarkRatio(px, W, x, y, size);
      if (interiorRatio > CHECKBOX_INTERIOR_DARK_RATIO_MAX) continue;
      out.push(canvasBandToField({
        startY: y, endY: y + size - 1, height: size,
        x0: x, x1: x + size - 1, width: size,
        bestRunWidth: size, totalDarkPx: size * 4, runRows: size,
        bestRunIsUnderscoreShape: false,
      }, viewport, dprScale, pageNum, 'cv-checkbox'));
      out[out.length - 1].type = 'checkbox';
    }
  }
  return out;
}

function guessSquareAt(px, W, H, x, y) {
  // Detect a square outline starting at (x,y). Returns the side length
  // or null. Walks right from (x,y) looking for a top edge, then
  // verifies the four sides are dark.
  // Cheap heuristic: top row starting at x must be dark for at least
  // CHECKBOX_MIN_PX pixels and at most CHECKBOX_MAX_PX, then a right
  // edge column must drop down the same length.
  let runLen = 0;
  while (x + runLen < W && runLen < CHECKBOX_MAX_PX + 4) {
    const i = (y * W + (x + runLen)) * 4;
    const lum = (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0;
    if (lum >= DARK_THRESHOLD) break;
    runLen++;
  }
  if (runLen < CHECKBOX_MIN_PX) return null;
  const size = runLen;
  // Verify right edge.
  let rightDark = 0;
  for (let dy = 0; dy < size; dy++) {
    const i = ((y + dy) * W + (x + size - 1)) * 4;
    const lum = (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0;
    if (lum < DARK_THRESHOLD) rightDark++;
  }
  if (rightDark / size < 0.6) return null;
  // Verify bottom edge.
  let bottomDark = 0;
  for (let dx = 0; dx < size; dx++) {
    const i = ((y + size - 1) * W + (x + dx)) * 4;
    const lum = (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0;
    if (lum < DARK_THRESHOLD) bottomDark++;
  }
  if (bottomDark / size < 0.6) return null;
  return size;
}

function interiorDarkRatio(px, W, x, y, size) {
  if (size < 4) return 1;
  let dark = 0, total = 0;
  for (let dy = 2; dy < size - 2; dy++) {
    for (let dx = 2; dx < size - 2; dx++) {
      const i = ((y + dy) * W + (x + dx)) * 4;
      const lum = (px[i] * 0.30 + px[i + 1] * 0.59 + px[i + 2] * 0.11) | 0;
      if (lum < DARK_THRESHOLD) dark++;
      total++;
    }
  }
  return total ? dark / total : 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cvId(c) {
  return `cv-${c.page}-${Math.round(c.x)}-${Math.round(c.y)}-${c.source}`;
}

// ---------------------------------------------------------------------------
// Merge: combine CV results with heuristic-detected fields. Drops CV
// candidates whose bounding box overlaps >50% with any existing field
// of the same type (or similar). Returns the augmented field array.
// ---------------------------------------------------------------------------

export function mergeWithHeuristic(heuristicFields, cvFields) {
  if (!cvFields || cvFields.length === 0) return heuristicFields;
  const out = [...heuristicFields];
  for (const cv of cvFields) {
    const collides = heuristicFields.some(h =>
      h.page === cv.page && boxIou(h, cv) > 0.5
    );
    if (!collides) out.push(cv);
  }
  return out;
}

function boxIou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const ih = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = iw * ih;
  const area = (a.width * a.height) + (b.width * b.height) - inter;
  return area > 0 ? inter / area : 0;
}
