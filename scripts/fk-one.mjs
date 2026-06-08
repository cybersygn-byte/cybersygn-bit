#!/usr/bin/env node
/**
 * Grade + keyword checker for a SINGLE blog-rewrite JSON, using the exact same
 * Flesch-Kincaid logic and body assembly as qc-blogs.mjs. Lets a rewrite agent
 * iterate a draft until it lands in the 8.5–13.0 band with its keywords present.
 *
 *   node scripts/fk-one.mjs blog-rewrites/<slug>.json
 *
 * Prints the grade, PASS/FAIL, and any reasons. Exit 0 if it would pass QC.
 */
import { readFile } from 'node:fs/promises';

const GRADE_MIN = 8.5;
const GRADE_MAX = 13.0;

function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}
function fkGrade(text) {
  const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length || 1;
  const words = (text.match(/\b[\w'-]+\b/g) || []);
  const wordCount = words.length || 1;
  const syll = words.reduce((s, w) => s + countSyllables(w), 0);
  return 0.39 * (wordCount / sentences) + 11.8 * (syll / wordCount) - 15.59;
}
function bodyOf(post) {
  const secs = (post.sections || []).map(s => `${s.heading || ''}. ${s.content || ''}`).join(' ');
  return `${post.hook || ''} ${post.intro || ''} ${secs} ${post.cta || ''}`.trim();
}

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/fk-one.mjs <path-to-rewrite.json>'); process.exit(2); }
const p = JSON.parse(await readFile(file, 'utf8'));
const body = bodyOf(p);
const grade = fkGrade(body);
const reasons = [];
if (grade < GRADE_MIN) reasons.push(`grade ${grade.toFixed(1)} < ${GRADE_MIN} — TOO SIMPLE: use longer sentences + more multi-syllable words`);
if (grade > GRADE_MAX) reasons.push(`grade ${grade.toFixed(1)} > ${GRADE_MAX} — TOO DENSE: shorten some sentences, simpler words`);
const hay = `${p.title || ''} ${p.metaDescription || ''} ${body}`.toLowerCase();
const pk = (p.primaryKeyword || '').toLowerCase();
if (pk) {
  if (!`${p.title || ''} ${p.metaDescription || ''}`.toLowerCase().includes(pk)) reasons.push('primary keyword not in title/meta');
  if (!body.toLowerCase().includes(pk)) reasons.push('primary keyword not in body');
}
const sk = (p.secondaryKeywords || []).map(s => s.toLowerCase());
if (sk.length) {
  const hits = sk.filter(k => hay.includes(k)).length;
  if (hits < Math.ceil(sk.length / 2)) reasons.push(`only ${hits}/${sk.length} secondary keywords present — weave more in`);
}
console.log(`grade ${grade.toFixed(2)}  (target ${GRADE_MIN}-${GRADE_MAX})  ${reasons.length ? 'FAIL' : 'PASS'}`);
for (const r of reasons) console.log('  - ' + r);
process.exit(reasons.length ? 1 : 0);
