#!/usr/bin/env node
'use strict';

// WRXN memory-wiki adapter — the install-local CLI over the file-based memory tiers.
// Self-contained: this ships INTO an install and MUST NOT import the kernel lib (node stdlib only).
//
// Tiers live under <installRoot>/.wrxn/wiki/<tier>/ where tier ∈ {concepts, decisions, gotchas, sessions}.
// Each page is a plain markdown file. Empty tiers are the fresh-install default — every read path
// must return cleanly (no crash) over an empty wiki.
//
// Subcommands:
//   query <text...>              grep-style substring search → JSON {query, tier, total, hits[]}
//   recall <text...>             alias of query (page-level recall; same substring engine)
//   write-page <tier> <slug>     create <tier>/<slug>.md (refuses to overwrite); prints the path
//
// Flags: --tier <concepts|decisions|gotchas|sessions|all> (default all) · --limit <N> (default 20)
//        --root <dir> (override the install-root walk-up; mainly for tests)

const fs = require('fs');
const path = require('path');

const TIERS = ['concepts', 'decisions', 'gotchas', 'sessions'];

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
    process.stdout.write('Usage: node .wrxn/wiki.cjs query <search-term...> [--tier all|concepts|decisions|gotchas|sessions] [--limit N]\n');
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
    process.stdout.write('Usage: node .wrxn/wiki.cjs write-page <tier> <slug> [--description "..."] [--body "..."]\n');
    process.exit(2);
  }
  if (!TIERS.includes(tier)) fail(`unknown tier "${tier}" — one of ${TIERS.join(', ')}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`slug must be kebab-case ([a-z0-9-]): "${slug}"`);

  const root = wikiRoot();
  const dir = path.join(root, tier);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${slug}.md`);
  if (fs.existsSync(dest)) fail(`page already exists, refusing to overwrite: ${path.relative(root, dest)}`);

  const description = flag('description') || '';
  const body = flag('body') || '';
  const page = [
    '---',
    `name: ${slug}`,
    `description: ${description}`,
    `tier: ${tier}`,
    'source: wiki-cli-write-page',
    '---',
    '',
    `# ${slug}`,
    '',
    body,
    '',
  ].join('\n');

  fs.writeFileSync(dest, page);
  process.stdout.write(JSON.stringify({ written: path.relative(root, dest), tier }, null, 2) + '\n');
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'query':
    case 'recall':
      return runQuery();
    case 'write-page':
      return runWritePage();
    default:
      process.stdout.write('Usage: node .wrxn/wiki.cjs <query|recall|write-page> ...\n');
      process.exit(cmd ? 2 : 0);
  }
}

main();
