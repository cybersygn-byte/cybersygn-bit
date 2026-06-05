/**
 * CyberSygn preview, prototype: signing capture.
 *
 * Responsible for the second half of the experience: once detection has
 * found the fields, this module turns them into a signable document.
 *
 *   - SignaturePad: smooth-stroke canvas drawing with mouse and touch
 *   - openCaptureModal: routes by field type to the right capture UI
 *   - fillStore: tracks which fields have been filled with what
 *   - flattenAndDownload: uses pdf-lib to bake the captures into the
 *     original PDF and triggers a browser download
 *
 * Detection coordinates stay in PDF user units (origin bottom-left), so
 * pdf-lib's drawImage and drawText receive them directly.
 */

import { PDFDocument, rgb, StandardFonts } from '../vendor/pdf-lib.mjs';

// ---------------------------------------------------------------------------
// Viral footer
// ---------------------------------------------------------------------------

/**
 * Stamp a discreet "Signed with CyberSygn" line in the bottom margin of
 * every page in the PDF. Clickable URI annotation pointing to the
 * homepage. Paid users can disable this via the localStorage flag
 * 'cybersygn.viralFooter' = 'off' (the dashboard settings panel sets
 * this when the user is on Solo / Origin / Studio).
 *
 * Free-tier users cannot disable — the footer is the price of free.
 *
 * Why this is in PDF user units: pdf-lib uses the original PDF
 * coordinate system (origin bottom-left, points). 12pt from the bottom
 * + 12pt from the right is a polite margin that virtually no contract
 * footer overlaps with.
 *
 * Why a URI annotation, not just text: signers who receive a PDF in
 * email often click links. A real annotation gives us the click.
 */
async function drawViralFooter(pdfDoc, font) {
  // Paid-tier off-switch.
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('cybersygn.viralFooter') === 'off') return;
  } catch (e) {}

  const pages = pdfDoc.getPages();
  const url = 'https://cybersygn.io/?ref=footer';
  const label = 'Signed with CyberSygn';
  const arrow = '↗';
  const text = `${label} ${arrow}`;
  const size = 7;
  // Brand cyan, slightly desaturated for paper friendliness.
  const fg = rgb(0.00, 0.55, 0.72);

  for (const page of pages) {
    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, size);
    const x = width - textWidth - 14;
    const y = 8;

    // Draw the visible text.
    page.drawText(text, { x, y, size, font, color: fg });

    // Add an invisible URI annotation rectangle over the text so a PDF
    // reader treats it as a clickable link. pdf-lib supports raw
    // annotations via context.obj() — minimal Link annotation.
    try {
      const linkAnnot = pdfDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x - 2, y - 1, x + textWidth + 2, y + size + 1],
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'URI',
          URI: pdfDoc.context.obj(url),
        },
      });
      const annotRef = pdfDoc.context.register(linkAnnot);
      const node = page.node;
      let annots = node.Annots();
      if (!annots) {
        annots = pdfDoc.context.obj([]);
        node.set(pdfDoc.context.obj('Annots'), annots);
      }
      annots.push(annotRef);
    } catch (e) {
      // If the annotation can't be written for any reason (corrupted
      // PDF dictionary, e.g.) the text-only footer still ships. We do
      // NOT throw — the download must succeed.
    }
  }
}

// ---------------------------------------------------------------------------
// Fill store
// ---------------------------------------------------------------------------

/**
 * Map of fieldId -> filled value object. Values look like:
 *   { kind: 'signature', dataUrl: 'data:image/png;base64,...' }
 *   { kind: 'date',      text: 'May 24, 2026' }
 *   { kind: 'checkbox',  checked: true }
 *   { kind: 'text',      text: 'Nathan Wilson' }
 */
export function createFillStore() {
  const map = new Map();
  const listeners = new Set();

  function set(id, value) {
    if (value == null) map.delete(id);
    else map.set(id, value);
    listeners.forEach(fn => fn());
  }
  function get(id) { return map.get(id) || null; }
  function clear() { map.clear(); listeners.forEach(fn => fn()); }
  function entries() { return [...map.entries()]; }
  function size() { return map.size; }
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { set, get, clear, entries, size, onChange };
}

// ---------------------------------------------------------------------------
// Signature pad
// ---------------------------------------------------------------------------

/**
 * Canvas signature pad with smooth strokes via quadratic curves between
 * midpoints. Returns a transparent-background PNG data URL.
 */
export class SignaturePad {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = '#15151A';
    this.minWidth = 1.4;
    this.maxWidth = 3.0;
    this.points = [];
    this.isDrawing = false;
    this.dirty = false;

    // Account for device pixel ratio so strokes stay crisp on retina.
    this._configureForDpr();
    this._bind();
    this.clear();
  }

  _configureForDpr() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width || this.canvas.clientWidth || 480);
    const h = Math.round(rect.height || this.canvas.clientHeight || 180);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.scale(dpr, dpr);
    this._cssW = w;
    this._cssH = h;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._start(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup',   e => this._end(e));
    c.addEventListener('pointercancel', e => this._end(e));
    c.addEventListener('pointerleave',  e => this._end(e));
    // Prevent the page from scrolling while drawing on touch.
    c.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
  }

  _coords(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _start(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.isDrawing = true;
    this.points = [this._coords(e)];
    this.dirty = true;
  }

  _move(e) {
    if (!this.isDrawing) return;
    e.preventDefault();
    this.points.push(this._coords(e));
    this._renderStroke();
  }

  _end(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    this.points = [];
  }

  _renderStroke() {
    const pts = this.points;
    if (pts.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = this.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (this.minWidth + this.maxWidth) / 2;

    // Draw the last segment using a quadratic curve through the midpoint
    // of the previous two points. Cheap and reads as smooth on screen.
    const n = pts.length;
    const p0 = pts[n - 3] || pts[n - 2];
    const p1 = pts[n - 2];
    const p2 = pts[n - 1];
    const mid1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const mid2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(mid1.x, mid1.y);
    ctx.quadraticCurveTo(p1.x, p1.y, mid2.x, mid2.y);
    ctx.stroke();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = false;
  }

  isEmpty() { return !this.dirty; }

  toDataURL() { return this.canvas.toDataURL('image/png'); }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * Build a modal overlay, return a Promise that resolves to the captured
 * value or null on cancel. The modal is removed from the DOM on close.
 *
 * Field type routing:
 *   signature -> signature pad
 *   initial   -> compact signature pad (smaller stroke)
 *   date      -> today by default, with an inline picker
 *   checkbox  -> toggled inline (no modal); caller does not invoke this
 *   text      -> text input
 */
export function openCaptureModal(field, currentValue) {
  return new Promise(resolve => {
    const overlay = el('div', 'modal-overlay');
    overlay.tabIndex = -1;

    const card = el('div', 'modal-card');
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    function close(value) {
      document.body.style.overflow = '';
      overlay.remove();
      window.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
    }
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close(null);
    });
    window.addEventListener('keydown', onKey);

    // Header common to all captures.
    const head = el('header', 'modal-card__head');
    head.appendChild(textEl('span', 'modal-card__kicker',
      field.type === 'initial' ? 'Initials.'
      : field.type === 'signature' ? 'Signature.'
      : field.type === 'date' ? 'Date.'
      : field.type === 'text' ? 'Text entry.'
      : 'Field.'));
    head.appendChild(textEl('h2', 'modal-card__title',
      field.label ? trim(field.label, 60) : `Page ${field.page} field`));
    const closeBtn = el('button', 'modal-card__close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => close(null));
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = el('div', 'modal-card__body');
    card.appendChild(body);

    const footer = el('footer', 'modal-card__footer');
    card.appendChild(footer);

    if (field.type === 'signature' || field.type === 'initial') {
      buildSignatureCapture(body, footer, field, currentValue, close);
    } else if (field.type === 'date') {
      buildDateCapture(body, footer, field, currentValue, close);
    } else if (field.type === 'text') {
      buildTextCapture(body, footer, field, currentValue, close);
    } else {
      // Unknown type: just give a text field.
      buildTextCapture(body, footer, field, currentValue, close);
    }

    // Focus the first interactive element inside the modal for keyboard users.
    setTimeout(() => {
      const focusable = card.querySelector('input, textarea, canvas, button:not([data-skip-focus])');
      if (focusable) focusable.focus();
    }, 30);
  });
}

function buildSignatureCapture(body, footer, field, currentValue, close) {
  const canvasWrap = el('div', 'sigpad');
  const canvas = document.createElement('canvas');
  canvas.className = 'sigpad__canvas';
  canvasWrap.appendChild(canvas);

  const hint = textEl('p', 'sigpad__hint',
    field.type === 'initial'
      ? 'Draw your initials in the box. Mouse, trackpad, or touch.'
      : 'Sign in the box below. Mouse, trackpad, or touch.');
  body.appendChild(hint);
  body.appendChild(canvasWrap);

  const pad = new SignaturePad(canvas);
  if (currentValue && currentValue.kind === 'signature') {
    // Re-load existing signature for editing.
    const img = new Image();
    img.onload = () => {
      pad.ctx.drawImage(img, 0, 0, pad._cssW, pad._cssH);
      pad.dirty = true;
    };
    img.src = currentValue.dataUrl;
  }

  const clearBtn = button('Clear', 'btn btn--ghost btn--sm');
  clearBtn.addEventListener('click', () => pad.clear());

  const cancelBtn = button('Cancel', 'btn btn--ghost');
  cancelBtn.addEventListener('click', () => close(null));

  const saveBtn = button('Save signature', 'btn btn--primary');
  saveBtn.addEventListener('click', () => {
    if (pad.isEmpty()) {
      pad.canvas.classList.add('sigpad__canvas--shake');
      setTimeout(() => pad.canvas.classList.remove('sigpad__canvas--shake'), 400);
      return;
    }
    close({ kind: 'signature', dataUrl: pad.toDataURL() });
  });

  const left = el('div', 'modal-card__footer-left');
  left.appendChild(clearBtn);
  footer.appendChild(left);
  const right = el('div', 'modal-card__footer-right');
  right.appendChild(cancelBtn);
  right.appendChild(saveBtn);
  footer.appendChild(right);
}

function buildDateCapture(body, footer, field, currentValue, close) {
  body.appendChild(textEl('p', 'modal-card__lede',
    'Use today, or pick another date. CyberSygn prints it onto the document at the moment of sending.'));

  const today = new Date();
  const initialIso = (currentValue && currentValue.iso) || toIsoDate(today);

  const wrap = el('div', 'date-capture');
  const input = document.createElement('input');
  input.type = 'date';
  input.className = 'date-capture__input field__input';
  input.value = initialIso;
  wrap.appendChild(input);

  const preview = el('div', 'date-capture__preview');
  const previewLabel = textEl('span', 'date-capture__preview-label', 'Will be stamped as:');
  const previewValue = textEl('strong', 'date-capture__preview-value', formatDateLong(initialIso));
  preview.appendChild(previewLabel);
  preview.appendChild(previewValue);
  wrap.appendChild(preview);

  input.addEventListener('input', () => {
    previewValue.textContent = formatDateLong(input.value);
  });

  body.appendChild(wrap);

  const todayBtn = button('Today', 'btn btn--ghost btn--sm');
  todayBtn.addEventListener('click', () => {
    input.value = toIsoDate(new Date());
    previewValue.textContent = formatDateLong(input.value);
  });

  const cancelBtn = button('Cancel', 'btn btn--ghost');
  cancelBtn.addEventListener('click', () => close(null));

  const saveBtn = button('Stamp date', 'btn btn--primary');
  saveBtn.addEventListener('click', () => {
    const iso = input.value;
    if (!iso) return;
    close({ kind: 'date', iso, text: formatDateLong(iso) });
  });

  const left = el('div', 'modal-card__footer-left');
  left.appendChild(todayBtn);
  footer.appendChild(left);
  const right = el('div', 'modal-card__footer-right');
  right.appendChild(cancelBtn);
  right.appendChild(saveBtn);
  footer.appendChild(right);
}

function buildTextCapture(body, footer, field, currentValue, close) {
  body.appendChild(textEl('p', 'modal-card__lede',
    field.label ? `Fill in: ${trim(field.label, 80)}` : 'Type the value for this field.'));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field__input field__input--solo';
  input.placeholder = 'Type here.';
  input.value = (currentValue && currentValue.text) || '';
  body.appendChild(input);

  const cancelBtn = button('Cancel', 'btn btn--ghost');
  cancelBtn.addEventListener('click', () => close(null));
  const saveBtn = button('Save', 'btn btn--primary');
  saveBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    close({ kind: 'text', text });
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveBtn.click();
  });

  const right = el('div', 'modal-card__footer-right');
  right.appendChild(cancelBtn);
  right.appendChild(saveBtn);
  footer.appendChild(el('div', 'modal-card__footer-left'));
  footer.appendChild(right);
}

// ---------------------------------------------------------------------------
// Visual rendering on the page for a filled field
// ---------------------------------------------------------------------------

/**
 * Mutate a field-box element to reflect its current fill state. The box
 * keeps the same geometry; only its inner contents and modifier classes
 * change.
 */
export function renderBoxForFill(box, field, value) {
  // Reset any prior fill contents but keep the field-box__tag.
  box.querySelectorAll('.field-box__fill').forEach(el => el.remove());
  box.classList.toggle('field-box--filled', Boolean(value));

  if (!value) return;

  const fill = el('div', 'field-box__fill');
  if (value.kind === 'signature') {
    const img = document.createElement('img');
    img.src = value.dataUrl;
    img.className = 'field-box__signature';
    img.alt = '';
    fill.appendChild(img);
  } else if (value.kind === 'date' || value.kind === 'text') {
    fill.classList.add('field-box__fill--text');
    fill.textContent = value.text;
  } else if (value.kind === 'checkbox') {
    fill.classList.add('field-box__fill--check');
    fill.textContent = value.checked ? '✓' : '';
  }
  box.appendChild(fill);
}

// ---------------------------------------------------------------------------
// Flatten + download
// ---------------------------------------------------------------------------

/**
 * Use pdf-lib to bake every filled value into the original PDF and
 * trigger a browser download. The original detection geometry is in PDF
 * user units, which is what pdf-lib expects, so the coordinates pass
 * through unchanged.
 */
export async function flattenAndDownload({ originalBytes, fields, fillStore, filename }) {
  const pdfDoc = await PDFDocument.load(originalBytes);
  const pages = pdfDoc.getPages();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const field of fields) {
    const value = fillStore.get(field.id);
    if (!value) continue;
    const page = pages[field.page - 1];
    if (!page) continue;

    if (value.kind === 'signature') {
      try {
        const pngImage = await pdfDoc.embedPng(value.dataUrl);
        // Fit the signature inside the box while preserving aspect ratio.
        const box = { w: field.width, h: field.height + 8 }; // a hair taller for stroke flourishes
        const imgAspect = pngImage.width / pngImage.height;
        const boxAspect = box.w / box.h;
        let drawW, drawH;
        if (imgAspect > boxAspect) {
          drawW = box.w;
          drawH = box.w / imgAspect;
        } else {
          drawH = box.h;
          drawW = box.h * imgAspect;
        }
        page.drawImage(pngImage, {
          x: field.x + (box.w - drawW) / 2,
          y: field.y + (box.h - drawH) / 2 - 2,
          width: drawW,
          height: drawH,
        });
      } catch (err) {
        console.warn(`Could not embed signature for field ${field.id}:`, err);
      }
    } else if (value.kind === 'date' || value.kind === 'text') {
      const size = Math.max(9, Math.min(field.height - 2, 12));
      page.drawText(value.text, {
        x: field.x + 4,
        y: field.y + 3,
        size,
        font: helvetica,
        color: rgb(0.08, 0.08, 0.1),
      });
    } else if (value.kind === 'checkbox' && value.checked) {
      const size = Math.max(10, Math.min(field.height - 2, 14));
      page.drawText('X', {
        x: field.x + 2,
        y: field.y + 1,
        size,
        font: helvetica,
        color: rgb(0.72, 0.20, 0.15),
      });
    }
  }

  // Viral footer. Add a discreet "Signed with CyberSygn" line in the
  // bottom margin of every page, clickable, brand-colored. Required for
  // free tier (paid users can disable via localStorage flag — toggled
  // from /dashboard/ settings panel). The marker text + URL both go to
  // the page so search engines indexing PDFs see the brand mention.
  await drawViralFooter(pdfDoc, helvetica);

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { bytes: bytes.byteLength };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag, className, text) {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function button(label, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

function trim(s, n) {
  s = String(s).trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function downloadName(original) {
  const base = String(original || 'document').replace(/\.pdf$/i, '');
  return `${base}-signed.pdf`;
}
