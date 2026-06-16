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
const crypto = require('crypto');
const { convert: defaultConvert } = require('./convert.cjs');

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const TIERS = ['concepts', 'decisions', 'gotchas', 'sessions'];
const DEFAULT_TIER = 'concepts'; // distilled source knowledge lands in the concepts tier by default.
const MAX_NOTES = 100;           // cap so a garbage distillation can't flood the wiki.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x1f]/;   // control chars (NL/CR/NUL/...) — illegal in a source filename.

// Collapse a value to a single safe frontmatter scalar: strip control chars, fold whitespace.
function safeScalar(v) {
  // eslint-disable-next-line no-control-regex
  return String(v || '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
}

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
  if (notes.length > MAX_NOTES) {
    throw new Error(`wrxn ingest: distillation produced ${notes.length} notes — cap is ${MAX_NOTES}. Refusing to flood the wiki.`);
  }
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
  // Intra-run dup: the DISTILLATION itself yielded two pages targeting one path. Distinct from the
  // legit pre-existing-page skip (handled at write time via the wx/O_EXCL EEXIST path).
  const seen = new Set();
  for (const pg of pages) {
    const key = `${pg.tier}/${pg.slug}`;
    if (seen.has(key)) throw new Error(`wrxn ingest: duplicate slug in distillation: "${pg.slug}" (tier ${pg.tier})`);
    seen.add(key);
  }
  return pages;
}

/** Render one wiki page: frontmatter (with the sanitized derived_from provenance stamp) + body. */
function renderPage(pg, derivedFrom) {
  return [
    '---',
    `name: ${pg.slug}`,
    `description: ${safeScalar(pg.description)}`,
    `tier: ${pg.tier}`,
    `derived_from: ${safeScalar(derivedFrom)}`,
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

  // ── fail-fast guards: everything cheap that can reject runs BEFORE convert + raw copy, so a pure
  //    error path leaves NO stray work (no spawned converter, no dropped raw file). ──
  const base = path.basename(srcPath);
  if (CTRL_RE.test(base)) {
    // a newline/control char in the filename would break out of the YAML frontmatter block.
    throw new Error(`wrxn ingest: source filename contains control characters (invalid): ${JSON.stringify(base)}`);
  }
  // refuse a symlinked source: copyFileSync would follow it and copy an arbitrary readable file.
  if (fs.lstatSync(srcPath).isSymbolicLink()) {
    throw new Error(`wrxn ingest: source is a symlink (refused): ${srcPath}`);
  }
  // validate the distill boundary up front — `wrxn ingest <file>` with no distillation must NOT
  // convert + drop a raw file before defaultDistill throws.
  if (distill === defaultDistill) defaultDistill();

  // 1. convert source → markdown (slice 05).
  const markdown = await convert(srcPath);

  // 2. place/keep the raw source under .wrxn/raw/. The filename is content-hash-namespaced so two
  //    DIFFERENT sources sharing a basename never collide (provenance stays correct), while the SAME
  //    bytes always map to the SAME name → idempotent re-run skips the copy.
  const rawDir = path.join(root, '.wrxn', 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const bytes = fs.readFileSync(srcPath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const rawName = `${stem}.${hash}${ext}`;
  const rawDest = path.join(rawDir, rawName);
  if (!fs.existsSync(rawDest)) fs.writeFileSync(rawDest, bytes);
  const derivedFrom = path.relative(root, rawDest).split(path.sep).join('/');

  // 3. distill the markdown → { summary, notes } (validated: contract, note cap, intra-run dup slug).
  const pages = normalizePages(await distill(markdown, { srcPath, derivedFrom }));

  // 4. write pages ADDITIVELY. The wx flag (O_EXCL) makes the check-and-create atomic AND refuses to
  //    follow a (dangling) symlink at the destination — EEXIST is the legit pre-existing-page skip.
  const written = [];
  const skipped = [];
  for (const pg of pages) {
    const dir = path.join(root, '.wrxn', 'wiki', pg.tier);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${pg.slug}.md`);
    const rel = path.relative(root, dest).split(path.sep).join('/');
    try {
      fs.writeFileSync(dest, renderPage(pg, derivedFrom), { flag: 'wx' });
      written.push(rel);
    } catch (err) {
      if (err.code === 'EEXIST') { skipped.push(rel); continue; }
      throw err;
    }
  }

  return {
    source: path.relative(root, srcPath).split(path.sep).join('/'),
    raw: derivedFrom,
    written,
    skipped,
  };
}

module.exports = { ingest, defaultDistill, normalizePages, DEFAULT_TIER, TIERS, MAX_NOTES };
