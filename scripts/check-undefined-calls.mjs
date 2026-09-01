/**
 * Catch a cross-module function that is CALLED but never IMPORTED.
 *
 * deliverDeclineNotice shipped exactly this way: exported from email.js,
 * called once in index.js, imported nowhere. It threw a ReferenceError on the
 * decline path, the surrounding try/catch turned it into a console.error, and
 * every decline notification silently failed for as long as the code existed.
 * Nothing caught it: `node --check` only parses, no test covered the path, and
 * check:integrity checks wiring rather than identifiers.
 *
 * Scope note, deliberately narrow. A general "is this identifier bound?" check
 * needs a real JS parser; approximating one with regexes produced dozens of
 * false alarms from regex literals and prose inside strings, and a check that
 * cries wolf gets disabled, which is worse than no check. So this asks one
 * precise question instead: if a name is EXPORTED BY ANOTHER MODULE in this
 * codebase and CALLED here, is it imported or declared here? That is the shape
 * the bug actually took, and the candidate names are distinctive enough that a
 * stray match in a string is implausible.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['worker/src', 'web/preview', 'web/shared', 'web/dashboard'];
const REPO = new URL('..', import.meta.url).pathname;

const files = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== 'dist' && e !== 'node_modules') walk(p); continue; }
    if (e.endsWith('.js') || e.endsWith('.mjs')) files.push(p);
  }
}
for (const r of ROOTS) { try { walk(join(REPO, r)); } catch (e) {} }

// Strip line and block comments only. Strings are left alone on purpose: the
// names we look for are distinctive exported function names.
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// name -> module that exports it
const exportedBy = new Map();
const sources = new Map();
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  sources.set(f, raw);
  const code = decomment(raw);
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    if (!exportedBy.has(m[1])) exportedBy.set(m[1], f);
  }
}

const offenders = [];
for (const f of files) {
  const raw = sources.get(f);
  const code = decomment(raw);

  const imported = new Set();
  for (const m of code.matchAll(/import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const as = t.split(/\s+as\s+/);
      imported.add((as[1] || as[0]).trim());
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) imported.add(m[1]);
  for (const m of code.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) imported.add(m[1]);

  // Anything declared locally shadows the cross-module export.
  const declared = new Set();
  for (const m of code.matchAll(/\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // Destructuring patterns, including nested and array forms. Balance the
  // brackets rather than regex the inside: ambassador-email.js binds its
  // helpers as `const [{ tierFor, TIERS: LADDER }, { passActive }] = await
  // Promise.all([...])`, and a flat {…} match reads those as unbound calls.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([[{])/g)) {
    let i = m.index + m[0].length - 1, depth = 0;
    const start = i;
    while (i < code.length) {
      const c = code[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) break; }
      i++;
    }
    const pattern = code.slice(start, i + 1);
    // In a binding pattern every identifier binds, EXCEPT a key written
    // `key: binding`, where the key is a property name and only the right
    // side is the new name.
    for (const id of pattern.matchAll(/([A-Za-z_$][\w$]*)\s*(:?)/g)) {
      if (id[2] !== ':') declared.add(id[1]);
    }
  }

  const flagged = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (flagged.has(name)) continue;
    if (!exportedBy.has(name)) continue;          // not a cross-module export, out of scope
    if (exportedBy.get(name) === f) continue;      // defined right here
    if (imported.has(name) || declared.has(name)) continue;
    flagged.add(name);
    const at = raw.indexOf(name + '(');
    offenders.push({
      file: relative(REPO, f),
      line: raw.slice(0, at < 0 ? 0 : at).split('\n').length,
      name,
      from: relative(REPO, exportedBy.get(name)),
    });
  }
}

if (offenders.length) {
  console.error('check:undefined-calls FAILED\n');
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.name}(...) is called here but never imported.`);
    console.error(`      It is exported by ${o.from}. At runtime this throws a ReferenceError,`);
    console.error(`      which a surrounding try/catch will happily swallow.`);
  }
  process.exit(1);
}
console.log(`check:undefined-calls: ${files.length} modules, every cross-module call is imported.`);
