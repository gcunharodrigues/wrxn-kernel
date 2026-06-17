#!/usr/bin/env node
'use strict';

// WRXN memory-wiki adapter — the install-local CLI over the file-based memory tiers.
// Self-contained: this ships INTO an install and MUST NOT import the kernel lib (node stdlib only).
//
// Tiers live under <installRoot>/.wrxn/wiki/<tier>/ where tier ∈ {concepts, decisions, gotchas, sessions, _rules, _slots}.
// Each page is a plain markdown file. Empty tiers are the fresh-install default — every read path
// must return cleanly (no crash) over an empty wiki.
//
// Subcommands:
//   query <text...>              grep-style substring search → JSON {query, tier, total, hits[]}
//   recall <text...>             alias of query (page-level recall; same substring engine)
//   write-page <tier> <slug>     create <tier>/<slug>.md (refuses to overwrite); prints the path.
//                                --force overwrites in place, but ONLY for the `_slots` focus slot.
//   delete-page <tier> <slug>    delete <tier>/<slug>.md (harvest-03 merge: the absorbed-page removal).
//                                Confined to the wiki tiers BY CONSTRUCTION (tier ∈ TIERS + kebab slug),
//                                so the path can never escape .wrxn/wiki/. Errors if the page is absent.
//
// Flags: --tier <concepts|decisions|gotchas|sessions|_rules|_slots|all> (default all) · --limit <N> (default 20)
//        --force (write-page only; overwrite the `_slots` slot in place) · --root <dir> (test override)

const fs = require('fs');
const path = require('path');

// `_rules` is the dream-written tier (durable always/never project conventions) — recalled like the
// prose tiers, but machine-written by the dream adapter (dream-03), hence the `_` prefix.
// `_slots` (dream-04) holds the durable standing-focus page (`_slots/current-focus.md`) — the LONE
// wiki page that may be overwritten in place, and only via `write-page --force`.
const TIERS = ['concepts', 'decisions', 'gotchas', 'sessions', '_rules', '_slots'];
// The one page `--force` may overwrite — `_slots/current-focus.md`, the durable focus slot. Every other
// page (any other tier, or any other slug in `_slots`) stays create-only / refuse-overwrite.
const OVERWRITABLE_TIER = '_slots';
const OVERWRITABLE_SLUG = 'current-focus';

// ── install-root resolution (walk up to the wrxn.install.json receipt) ────────
// Mirrors payload/.claude/hooks/enforce-managed-guard.cjs findInstallRoot.
function findInstallRoot(start) {
  let dir = start || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function wikiRoot() {
  const override = flag('root');
  const root = override || findInstallRoot();
  if (!root) {
    fail('cannot resolve the install root — run inside a wrxn install (no wrxn.install.json found walking up) or pass --root <dir>');
  }
  return path.join(root, '.wrxn', 'wiki');
}

function fail(msg) {
  process.stderr.write(`wiki: ${msg}\n`);
  process.exit(2);
}

// positional args after the subcommand, up to the first --flag
function positionals() {
  const out = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    out.push(process.argv[i]);
  }
  return out;
}

function tierDirs(root, tierFlag) {
  if (!tierFlag || tierFlag === 'all') return TIERS.map((t) => [t, path.join(root, t)]);
  if (!TIERS.includes(tierFlag)) fail(`unknown tier "${tierFlag}" — one of ${TIERS.join(', ')}, all`);
  return [[tierFlag, path.join(root, tierFlag)]];
}

function listPages(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // tier dir absent → empty, no crash
  }
  return names.filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n));
}

// ── query / recall (shared substring engine) ─────────────────────────────────
function runQuery() {
  const terms = positionals();
  if (terms.length === 0) {
    process.stdout.write('Usage: node .wrxn/wiki.cjs query <search-term...> [--tier all|concepts|decisions|gotchas|sessions|_rules|_slots] [--limit N]\n');
    process.exit(2);
  }
  const needle = terms.join(' ').toLowerCase();
  const tierFlag = flag('tier') || 'all';
  const limit = Number(flag('limit')) || 20;
  const root = wikiRoot();

  const hits = [];
  for (const [tier, dir] of tierDirs(root, tierFlag)) {
    for (const file of listPages(dir)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let n = 0; n < lines.length; n++) {
        if (lines[n].toLowerCase().includes(needle)) {
          hits.push({ tier, file: path.relative(root, file), line: n + 1, snippet: lines[n].trim() });
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }

  process.stdout.write(
    JSON.stringify({ query: terms.join(' '), tier: tierFlag, total: hits.length, returned: hits.length, hits }, null, 2) + '\n'
  );
}

// ── write-page ────────────────────────────────────────────────────────────────
function runWritePage() {
  const [tier, slug] = positionals();
  if (!tier || !slug) {
    process.stdout.write('Usage: node .wrxn/wiki.cjs write-page <tier> <slug> [--description "..."] [--body "..."] [--force]\n');
    process.exit(2);
  }
  if (!TIERS.includes(tier)) fail(`unknown tier "${tier}" — one of ${TIERS.join(', ')}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`slug must be kebab-case ([a-z0-9-]): "${slug}"`);

  // `--force` is the LONE overwrite-exception (dream-04): it overwrites a page in place, and ONLY for
  // the single `_slots/current-focus` slot. Every other write-page (no `--force`, any other tier, or any
  // other slug in `_slots`) still refuses to clobber — so the wiki stays additive/curated and only the
  // one standing-focus page may be updated (dream-qa-07: path-scoped, not tier-scoped).
  const force = process.argv.includes('--force');
  if (force && (tier !== OVERWRITABLE_TIER || slug !== OVERWRITABLE_SLUG)) {
    fail(`--force overwrite is only permitted for the ${OVERWRITABLE_TIER}/${OVERWRITABLE_SLUG} focus slot (the lone update-exception), not "${tier}/${slug}"`);
  }

  const root = wikiRoot();
  const dir = path.join(root, tier);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${slug}.md`);
  if (fs.existsSync(dest) && !force) fail(`page already exists, refusing to overwrite: ${path.relative(root, dest)}`);

  const description = flag('description') || '';
  const body = flag('body') || '';
  // Prepend the `# <slug>` heading ONLY when the body does not already open with its own H1. The dream
  // gate mandates every proposal body start with `# Title`, so an always-prepend would stack two H1s on
  // committed pages (qa-finding dream-06). A heading-less or empty body still gets `# <slug>` (backward-compat).
  const heading = body.trimStart().startsWith('# ') ? [] : [`# ${slug}`, ''];
  const page = [
    '---',
    `name: ${slug}`,
    `description: ${description}`,
    `tier: ${tier}`,
    'source: wiki-cli-write-page',
    '---',
    '',
    ...heading,
    body,
    '',
  ].join('\n');

  fs.writeFileSync(dest, page);
  process.stdout.write(JSON.stringify({ written: path.relative(root, dest), tier }, null, 2) + '\n');
}

// ── delete-page (harvest-03) ────────────────────────────────────────────────────
// The delete-by-reference path for harvest's merge: remove an absorbed near-dup page after the survivor
// is written. Confinement is structural — the page is addressed by <tier>/<slug>, where tier is checked
// against the TIERS allowlist and slug must be kebab-case (no `/`, no `..`, no `.`), so the constructed
// path can never traverse out of .wrxn/wiki/. Errors on a missing page (the symmetric inverse of
// write-page refusing an existing one), so a no-op delete is observable to the caller.
function runDeletePage() {
  const [tier, slug] = positionals();
  if (!tier || !slug) {
    process.stdout.write('Usage: node .wrxn/wiki.cjs delete-page <tier> <slug>\n');
    process.exit(2);
  }
  if (!TIERS.includes(tier)) fail(`unknown tier "${tier}" — one of ${TIERS.join(', ')}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`slug must be kebab-case ([a-z0-9-]): "${slug}"`);

  const root = wikiRoot();
  const dest = path.join(root, tier, `${slug}.md`);
  if (!fs.existsSync(dest)) fail(`page does not exist, nothing to delete: ${path.relative(root, dest)}`);
  fs.unlinkSync(dest);
  process.stdout.write(JSON.stringify({ deleted: path.relative(root, dest), tier }, null, 2) + '\n');
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'query':
    case 'recall':
      return runQuery();
    case 'write-page':
      return runWritePage();
    case 'delete-page':
      return runDeletePage();
    default:
      process.stdout.write('Usage: node .wrxn/wiki.cjs <query|recall|write-page|delete-page> ...\n');
      process.exit(cmd ? 2 : 0);
  }
}

main();
