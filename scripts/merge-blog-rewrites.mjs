#!/usr/bin/env node
/**
 * Merge per-post blog rewrites back into scripts/blog-matrix.json.
 *
 * The rewrite workflow writes each rewritten post as blog-rewrites/<slug>.json
 * (a partial: any of title, metaDescription, hook, intro, sections, cta,
 * primaryKeyword, secondaryKeywords). This merges them in by slug, preserving
 * the fields a rewrite must NOT touch: slug, publishDate, category, audienceTier,
 * disclaimerNeeded, relatedSlugs.
 *
 * Run: node scripts/merge-blog-rewrites.mjs
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MATRIX = join(HERE, 'blog-matrix.json');
const REWRITES = join(ROOT, 'blog-rewrites');

// Fields a rewrite is allowed to replace. Everything else is preserved.
const MUTABLE = new Set([
  'title', 'metaDescription', 'hook', 'intro', 'sections', 'cta',
  'primaryKeyword', 'secondaryKeywords',
]);

async function main() {
  const matrix = JSON.parse(await readFile(MATRIX, 'utf8'));
  const bySlug = new Map((matrix.posts || []).map((p, i) => [p.slug, i]));

  if (!existsSync(REWRITES)) {
    console.error('No blog-rewrites/ directory.');
    process.exit(1);
  }
  const files = (await readdir(REWRITES)).filter(f => f.endsWith('.json'));
  let merged = 0, unknown = 0;

  for (const f of files) {
    const slug = f.replace(/\.json$/, '');
    const idx = bySlug.get(slug);
    if (idx === undefined) { unknown++; continue; }
    let rewrite;
    try {
      rewrite = JSON.parse(await readFile(join(REWRITES, f), 'utf8'));
    } catch (e) { console.warn(`skip ${f}: ${e.message}`); continue; }
    const post = matrix.posts[idx];
    for (const [k, v] of Object.entries(rewrite)) {
      if (MUTABLE.has(k) && v != null) post[k] = v;
    }
    merged++;
  }

  await writeFile(MATRIX, JSON.stringify(matrix, null, 2));
  console.log(`Merged ${merged} rewrites into blog-matrix.json (${matrix.posts.length} posts total).`);
  if (unknown) console.log(`Skipped ${unknown} rewrite files with no matching slug.`);
}

main().catch(e => { console.error(e); process.exit(1); });
