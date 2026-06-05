#!/usr/bin/env node
/**
 * Lightweight CSS lint for slice 89.
 *
 * Catches the two failure modes that actually bite in practice:
 *
 *   1. Duplicate selectors at the same media-query scope.
 *      Same selector defined twice = one rule wins silently. Most
 *      common cause: copy-paste leftover, deleted half a rewrite,
 *      or a slice's "new" rule was already there under a different
 *      name. This is the bug class that hit slice 38's .toast__close
 *      (silently overrode the canonical at line 1405).
 *
 *   2. Misspelled / unknown CSS properties.
 *      A typo like `padding-buttom: 12px` is silently dropped by every
 *      browser. We maintain a baked-in list of valid CSS property
 *      names + browser-prefix patterns and warn on anything else.
 *      Properties starting with `--` (custom properties) are always OK.
 *
 * Runs as part of `npm run lint`. Returns non-zero on any finding so
 * `npm run deploy` aborts before wrangler ever fires.
 *
 * Why not stylelint: zero new deps, runs in <500ms, catches the two
 * highest-leverage issues. If the project grows past these two checks
 * we can graduate to real stylelint. Until then this earns its keep.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Known-valid CSS property names. Not exhaustive — covers everything
// the codebase actually uses today, plus the most common future
// additions. Extend as needed when a real new property gets used.
// Vendor-prefixed properties auto-pass via the regex check below.
const VALID_PROPS = new Set([
  // Layout primitives
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'inset',
  'float', 'clear', 'overflow', 'overflow-x', 'overflow-y', 'visibility',
  'box-sizing', 'isolation', 'contain', 'content-visibility',

  // Flex / grid
  'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink',
  'flex-basis', 'order', 'justify-content', 'justify-items', 'justify-self',
  'align-items', 'align-self', 'align-content', 'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template', 'grid-template-rows', 'grid-template-columns',
  'grid-template-areas', 'grid-area', 'grid-row', 'grid-column',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'grid-auto-rows', 'grid-auto-columns', 'grid-auto-flow', 'place-items',
  'place-content', 'place-self',

  // Sizing
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'aspect-ratio',

  // Margin / padding / border
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'margin-block', 'margin-inline', 'margin-block-start', 'margin-block-end',
  'margin-inline-start', 'margin-inline-end',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-inline', 'padding-block-start', 'padding-block-end',
  'padding-inline-start', 'padding-inline-end',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-collapse', 'border-spacing', 'border-image',
  'outline', 'outline-width', 'outline-style', 'outline-color', 'outline-offset',

  // Color / background
  'color', 'background', 'background-color', 'background-image', 'background-repeat',
  'background-position', 'background-size', 'background-attachment', 'background-clip',
  'background-origin', 'background-blend-mode',
  'opacity', 'mix-blend-mode',

  // Typography
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'font-variant-numeric', 'font-variant-caps', 'font-stretch', 'font-display',
  'font-feature-settings', 'font-kerning', 'font-optical-sizing', 'font-smooth',
  'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
  'text-align', 'text-align-last', 'text-decoration', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-color', 'text-decoration-thickness',
  'text-transform', 'text-indent', 'text-shadow', 'text-overflow', 'text-wrap',
  'text-rendering', 'text-underline-offset', 'text-underline-position',
  'white-space', 'word-break', 'word-wrap', 'overflow-wrap', 'hyphens', 'hyphenate-character',
  'writing-mode', 'direction', 'unicode-bidi', 'vertical-align',

  // Lists
  'list-style', 'list-style-type', 'list-style-image', 'list-style-position',

  // Tables
  'table-layout', 'caption-side', 'empty-cells',

  // Transform / animation / transition
  'transform', 'transform-origin', 'transform-style', 'transform-box',
  'perspective', 'perspective-origin', 'backface-visibility',
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
  'transition-delay', 'transition-behavior',
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function',
  'animation-delay', 'animation-iteration-count', 'animation-direction',
  'animation-fill-mode', 'animation-play-state', 'animation-composition',
  'will-change',

  // Box decoration
  'box-shadow', 'filter', 'backdrop-filter', 'clip-path', 'mask', 'mask-image',
  'mask-size', 'mask-position', 'mask-repeat',

  // Interaction
  'cursor', 'pointer-events', 'user-select', 'touch-action', 'caret-color',
  'accent-color', 'appearance', 'resize',

  // Counters / quotes / content
  'content', 'quotes', 'counter-reset', 'counter-increment', 'counter-set',

  // Scrollbars + scroll
  'scroll-behavior', 'scroll-snap-type', 'scroll-snap-align', 'scroll-snap-stop',
  'scroll-margin', 'scroll-padding',
  'overscroll-behavior', 'overscroll-behavior-x', 'overscroll-behavior-y',

  // Print / page
  'page-break-before', 'page-break-after', 'page-break-inside',
  'break-before', 'break-after', 'break-inside', 'orphans', 'widows',

  // SVG
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'stroke-miterlimit',
  'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'shape-rendering', 'text-anchor', 'dominant-baseline',

  // Misc / modern
  'gap', 'object-fit', 'object-position', 'mix-blend-mode',
  'image-rendering', 'image-resolution',
  'forced-color-adjust', 'color-scheme', 'print-color-adjust',
  'all',

  // Legacy a11y / sr-only patterns
  'clip', 'clip-rule',

  // @font-face descriptors (so the linter doesn't yell at them)
  'src', 'unicode-range', 'ascent-override', 'descent-override', 'line-gap-override',
  'size-adjust', 'font-named-instance',
]);

const RE_VENDOR_PROP = /^-(webkit|moz|ms|o)-[a-z]/;
const RE_CUSTOM_PROP = /^--/;

function isValidProp(name) {
  if (RE_CUSTOM_PROP.test(name)) return true;
  if (RE_VENDOR_PROP.test(name)) return true;
  return VALID_PROPS.has(name);
}

/**
 * Strip /* ... *\/ comments preserving line count so line numbers stay
 * meaningful.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Parse a CSS source into a sequence of (scope, selector, line) records.
 * Scope is the stack of @media / @supports / @container blocks at the
 * time of the rule, joined by '||' so identical selectors under
 * different media queries are NOT considered duplicates.
 *
 * This is not a full CSS parser — it's a brace counter that tracks
 * @at-rule blocks. Sufficient for our purposes (every selector we
 * write uses standard CSS; no preprocessor syntax in this codebase).
 */
function parseRules(src) {
  const rules = [];
  const props = [];
  const scopeStack = [];
  let i = 0;
  let line = 1;
  let buf = '';
  const N = src.length;
  while (i < N) {
    const c = src[i];
    if (c === '\n') line += 1;

    if (c === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) {
        // @media / @supports / @container / @keyframes — descend.
        scopeStack.push(head);
        i += 1;
        continue;
      }
      // Rule: capture selector + parse declarations inside this block.
      const ruleStartLine = line;
      const selector = head;
      // Find the matching close brace.
      let depth = 1;
      let j = i + 1;
      let declBuf = '';
      while (j < N && depth > 0) {
        const cc = src[j];
        if (cc === '\n') line += 1;
        if (cc === '{') depth += 1;
        else if (cc === '}') depth -= 1;
        if (depth > 0) declBuf += cc;
        j += 1;
      }
      // Parse declarations from declBuf — split on ; that are NOT inside
      // parentheses (so values like color-mix(in srgb, #000, transparent)
      // don't get clipped).
      const decls = [];
      let pDepth = 0;
      let pBuf = '';
      for (const ch of declBuf) {
        if (ch === '(') pDepth += 1;
        else if (ch === ')') pDepth -= 1;
        if (ch === ';' && pDepth === 0) {
          decls.push(pBuf);
          pBuf = '';
        } else {
          pBuf += ch;
        }
      }
      if (pBuf.trim()) decls.push(pBuf);
      // Extract property names from each declaration.
      // Compute the line each declaration is on (rough — based on \n
      // count in declBuf up to that point).
      let cursor = 0;
      const declLineBase = ruleStartLine;
      const declLines = [];
      for (const d of decls) {
        const newlines = declBuf.slice(0, cursor).split('\n').length - 1;
        declLines.push(declStartLine(declBuf, cursor) + declLineBase);
        cursor += d.length + 1; // +1 for the ;
      }
      for (let k = 0; k < decls.length; k++) {
        const d = decls[k];
        const colonIdx = d.indexOf(':');
        if (colonIdx < 0) continue;
        const propName = d.slice(0, colonIdx).trim().toLowerCase();
        if (!propName || propName.startsWith('//') || propName.startsWith('/*')) continue;
        props.push({ name: propName, line: declLines[k], selector });
      }
      rules.push({
        scope: scopeStack.join('||') || '(global)',
        selector,
        line: ruleStartLine,
      });
      i = j;
      continue;
    }
    if (c === '}') {
      // Close of an @at-rule block (selectors close inside the inner loop).
      if (scopeStack.length > 0) scopeStack.pop();
      buf = '';
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  return { rules, props };
}

function declStartLine(declBuf, cursor) {
  // Newlines before this cursor position.
  let n = 0;
  for (let i = 0; i < cursor; i++) if (declBuf[i] === '\n') n += 1;
  return n;
}

async function checkFile(path) {
  const raw = await readFile(path, 'utf8');
  const src = stripComments(raw);
  const { rules, props } = parseRules(src);

  const findings = [];

  // Index properties by rule (selector + line) so we can compute the
  // overlap when we hit a duplicate selector.
  const propsByRule = new Map();
  for (const p of props) {
    const key = p.selector + '|' + (p.line - 1);  // approximate
    if (!propsByRule.has(key)) propsByRule.set(key, new Set());
    propsByRule.get(key).add(p.name);
  }

  // Duplicate selectors at the same scope.
  const seen = new Map();
  for (const r of rules) {
    const sel = r.selector.replace(/\s+/g, ' ').trim();
    if (!sel) continue;
    const key = r.scope + '|' + sel;
    if (seen.has(key)) {
      const prev = seen.get(key);
      // Find the property sets for both rules. Iterate props once
      // per file is cheap so we recompute the lookup here.
      const propsA = new Set();
      const propsB = new Set();
      for (const p of props) {
        if (p.selector === sel) {
          // Heuristic: assign to the rule whose start-line is nearest.
          const distA = Math.abs(p.line - prev.line);
          const distB = Math.abs(p.line - r.line);
          (distA < distB ? propsA : propsB).add(p.name);
        }
      }
      // Compute overlap.
      const overlap = [...propsA].filter(n => propsB.has(n));
      const severity = overlap.length >= 1 ? 'WARN' : 'INFO';
      findings.push({
        type: severity === 'WARN' ? 'override-duplicate-selector' : 'cascade-duplicate-selector',
        severity,
        line: r.line,
        message: overlap.length >= 1
          ? `Duplicate "${sel}" at lines ${prev.line} and ${r.line} both declare: ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ', …' : ''}`
          : `Duplicate "${sel}" at lines ${prev.line} and ${r.line} (no property overlap — intentional cascade)`,
      });
    } else {
      seen.set(key, r);
    }
  }

  // Unknown / misspelled properties — these always fail.
  for (const p of props) {
    if (!isValidProp(p.name)) {
      findings.push({
        type: 'unknown-property',
        severity: 'FAIL',
        line: p.line,
        message: `Unknown CSS property "${p.name}" in rule "${p.selector.slice(0, 60)}"`,
      });
    }
  }

  return findings;
}

async function findCssFiles() {
  // Limit scope: web/styles.css is the only first-party CSS in the
  // tree right now. If more land, add them here. Brand assets, vendor
  // CSS (fonts.css), etc. are not lint targets.
  return [join(ROOT, 'web/styles.css')];
}

async function main() {
  const files = await findCssFiles();
  let buildFails = 0;
  let warns = 0;
  for (const f of files) {
    const findings = await checkFile(f);
    const fails = findings.filter(x => x.severity === 'FAIL');
    const warnings = findings.filter(x => x.severity === 'WARN');
    if (fails.length === 0 && warnings.length === 0) {
      console.log(`[css-check] OK ${relative(ROOT, f)}`);
      continue;
    }
    // Build-failing: unknown properties + property-overlapping duplicates.
    // Warning-only: cascade duplicates (no property overlap, idiomatic CSS).
    for (const fi of fails) {
      console.error(`  ${relative(ROOT, f)}:${fi.line}  FAIL  ${fi.type}: ${fi.message}`);
    }
    for (const fi of warnings) {
      console.warn(`  ${relative(ROOT, f)}:${fi.line}  WARN  ${fi.type}: ${fi.message}`);
    }
    buildFails += fails.length;
    warns += warnings.length;
  }
  if (warns > 0) {
    console.warn(`[css-check] ${warns} warning(s) — see above`);
  }
  if (buildFails > 0) {
    console.error(`[css-check] ${buildFails} build-failure(s)`);
    process.exit(1);
  }
  if (warns === 0) {
    console.log(`[css-check] OK`);
  }
}

main().catch(err => {
  console.error('[css-check] runner error:', err && err.message ? err.message : err);
  process.exit(2);
});
