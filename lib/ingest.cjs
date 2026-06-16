'use strict';

// Distillation ingest harness (multiformat-distill-06) — the deterministic half of `wrxn ingest`.
//
// PRD decisions D/E (grill 2026-06-16) + [[karpathy-llm-wiki-pattern]] (raw → distill → wiki, Adler):
// a dropped source becomes a SUMMARY page + N NOTE pages in the memory wiki, each carrying a
// `derived_from:` link back to the raw source. Additive-only: ingest CREATES new pages and refuses
// to overwrite an existing one — editing existing knowledge + cross-source synthesis is the `dream`
// loop (out of scope here).
//
// TWO boundaries are INJECTED, mirroring lib/convert.cjs's injectable spawn, so the harness is
// deterministically testable WITHOUT a real binary OR a live LLM:
//   - convert(src) → markdown          slice-05 converter primitive (default: the real convert).
//   - distill(markdown, ctx) → pages   the LLM step. The `ingest` SKILL is the prompt that produces
//                                       this; the harness only consumes its structured output, so the
//                                       distillation QUALITY is validated by the feature QA-walk, not
//                                       here. defaultDistill refuses to fabricate — it points the
//                                       caller at the skill (or the CLI's --distillation feed).

const fs = require('fs');
const path = require('path');
const { convert: defaultConvert } = require('./convert.cjs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const TIERS = ['concepts', 'decisions', 'gotchas', 'sessions'];
const DEFAULT_TIER = 'concepts'; // distilled source knowledge lands in the concepts tier by default.

// The no-op default for the distill boundary: there is no deterministic LLM, so refuse rather than
// fabricate. The real distillation is the `ingest` skill; the CLI feeds its result via --distillation.
function defaultDistill() {
  throw new Error(
    'no distillation provided. The distillation step is the `ingest` skill (an LLM reads the ' +
    'converted markdown and produces a summary + notes). Run via the ingest skill, feed a result ' +
    'with --distillation <result.json>, or inject a distill boundary. See .claude/skills/ingest/SKILL.md.'
  );
}

/** Flatten the distillation result into an ordered page list, validating the contract. */
function normalizePages(result) {
  if (!result || typeof result !== 'object') throw new Error('wrxn ingest: distillation returned no result object');
  const summary = result.summary;
  if (!summary || !summary.slug || !summary.body) {
    throw new Error('wrxn ingest: distillation must include a summary page with { slug, body }');
  }
  const notes = Array.isArray(result.notes) ? result.notes : [];
  const pages = [{ ...summary, role: 'summary' }, ...notes.map((n) => ({ ...n, role: 'note' }))];
  for (const pg of pages) {
    if (!pg.slug || !SLUG_RE.test(pg.slug)) {
      throw new Error(`wrxn ingest: page slug must be kebab-case ([a-z0-9-]): "${pg.slug}"`);
    }
    pg.tier = pg.tier || DEFAULT_TIER;
    if (!TIERS.includes(pg.tier)) {
      throw new Error(`wrxn ingest: unknown tier "${pg.tier}" — one of ${TIERS.join(', ')}`);
    }
  }
  return pages;
}

/** Render one wiki page: frontmatter (with the derived_from provenance stamp) + body. */
function renderPage(pg, derivedFrom) {
  return [
    '---',
    `name: ${pg.slug}`,
    `description: ${(pg.description || '').replace(/\s+/g, ' ').trim()}`,
    `tier: ${pg.tier}`,
    `derived_from: ${derivedFrom}`,
    `role: ${pg.role}`,
    'source: wrxn-ingest',
    '---',
    '',
    `# ${pg.title || pg.slug}`,
    '',
    (pg.body || '').trim(),
    '',
  ].join('\n');
}

/**
 * Ingest a source file into the memory wiki as a summary + N note pages.
 * @param {string} srcPath
 * @param {{ root?: string, convert?: Function, distill?: Function }} [opts]
 *   root    — install root the wiki + raw zone live under (default: cwd).
 *   convert — injectable converter boundary (default: slice-05 convert, the real spawnSync path).
 *   distill — injectable distillation boundary (default: defaultDistill, which refuses to fabricate).
 * @returns {Promise<{source:string, raw:string, written:string[], skipped:string[]}>}
 */
async function ingest(srcPath, { root, convert = defaultConvert, distill = defaultDistill } = {}) {
  srcPath = path.resolve(srcPath);
  if (!fs.existsSync(srcPath)) throw new Error(`wrxn ingest: source not found: ${srcPath}`);
  root = path.resolve(root || process.cwd());

  // 1. convert source → markdown (slice 05).
  const markdown = await convert(srcPath);

  // 2. place/keep the raw source under .wrxn/raw/ (the drop-zone convention; git backstop). Keep an
  //    existing copy untouched so re-runs are idempotent and never disturb a hand-curated raw file.
  const rawDir = path.join(root, '.wrxn', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const rawDest = path.join(rawDir, path.basename(srcPath));
  if (!fs.existsSync(rawDest)) fs.copyFileSync(srcPath, rawDest);
  const derivedFrom = path.relative(root, rawDest).split(path.sep).join('/');

  // 3. distill the markdown → { summary, notes }.
  const pages = normalizePages(await distill(markdown, { srcPath, derivedFrom }));

  // 4. write pages ADDITIVELY — refuse to overwrite an existing wiki page (skip, never clobber).
  const written = [];
  const skipped = [];
  for (const pg of pages) {
    const dir = path.join(root, '.wrxn', 'wiki', pg.tier);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${pg.slug}.md`);
    const rel = path.relative(root, dest).split(path.sep).join('/');
    if (fs.existsSync(dest)) { skipped.push(rel); continue; }
    fs.writeFileSync(dest, renderPage(pg, derivedFrom));
    written.push(rel);
  }

  return {
    source: path.relative(root, srcPath).split(path.sep).join('/'),
    raw: derivedFrom,
    written,
    skipped,
  };
}

module.exports = { ingest, defaultDistill, normalizePages, DEFAULT_TIER, TIERS };
