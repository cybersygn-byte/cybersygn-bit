#!/usr/bin/env node
/**
 * Reading-level + SEO QC for the blog matrix.
 *
 * For every post in scripts/blog-matrix.json, estimates the Flesch-Kincaid grade
 * level of the body (intro + section content) and checks SEO keyword coverage.
 * The brand target is ~9th grade: compelling and easy, not dumbed-down.
 *
 *   PASS reading level: FK grade between 6.0 and 10.5
 *   PASS keywords: primaryKeyword appears in title OR metaDescription, AND
 *                  appears at least once in the body; at least half of
 *                  secondaryKeywords appear somewhere in title/meta/body.
 *
 * Run: node scripts/qc-blogs.mjs
 * Exit 0 if all pass, 1 otherwise.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MATRIX = join(HERE, 'blog-matrix.json');

// Founder directive: every post must read at Flesch-Kincaid grade 8.5 or above
// (true ninth-grade and up). That is the comprehension floor. The ceiling keeps
// it from drifting into dense, hard-to-finish college-level prose.
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

async function main() {
  const matrix = JSON.parse(await readFile(MATRIX, 'utf8'));
  const posts = matrix.posts || [];
  let pass = 0;
  const fails = [];
  let gradeSum = 0;

  for (const p of posts) {
    const body = bodyOf(p);
    const grade = fkGrade(body);
    gradeSum += grade;
    const reasons = [];
    if (grade < GRADE_MIN) reasons.push(`reading level ${grade.toFixed(1)} < ${GRADE_MIN} (too simple/choppy)`);
    if (grade > GRADE_MAX) reasons.push(`reading level ${grade.toFixed(1)} > ${GRADE_MAX} (too dense)`);

    const hay = `${p.title || ''} ${p.metaDescription || ''} ${body}`.toLowerCase();
    const pk = (p.primaryKeyword || '').toLowerCase();
    if (pk) {
      const inHead = `${p.title || ''} ${p.metaDescription || ''}`.toLowerCase().includes(pk);
      const inBody = body.toLowerCase().includes(pk);
      if (!inHead) reasons.push('primary keyword not in title/meta');
      if (!inBody) reasons.push('primary keyword not in body');
    }
    const sk = (p.secondaryKeywords || []).map(s => s.toLowerCase());
    if (sk.length) {
      const hits = sk.filter(k => hay.includes(k)).length;
      if (hits < Math.ceil(sk.length / 2)) reasons.push(`only ${hits}/${sk.length} secondary keywords present`);
    }

    if (reasons.length === 0) pass++;
    else fails.push({ slug: p.slug, grade: grade.toFixed(1), reasons });
  }

  // Emit the failing slugs (with reasons) so a targeted correction pass can
  // re-process only what failed, never the posts that already pass.
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(HERE, '_blog-qc-failures.json'),
      JSON.stringify({ slugs: fails.map(f => f.slug), detail: fails }, null, 2));
  } catch (_) {}

  console.log(`Posts: ${posts.length}`);
  console.log(`Avg reading grade: ${(gradeSum / (posts.length || 1)).toFixed(1)} (target ${GRADE_MIN}-${GRADE_MAX})`);
  console.log(`QC pass: ${pass}`);
  console.log(`QC fail: ${fails.length}`);
  if (fails.length) {
    console.log('\nFAILURES:');
    for (const f of fails) {
      console.log(`  ${f.slug}  (grade ${f.grade})`);
      for (const r of f.reasons) console.log(`      - ${r}`);
    }
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
