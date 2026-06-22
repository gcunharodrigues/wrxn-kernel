#!/usr/bin/env node
'use strict';

// WRXN wiki-lint hook — session-close wiki-integrity flag (wrxn-kernel-11).
// Stop. At session close it sweeps the wiki tiers for MALFORMED pages — a page is malformed if it
// lacks a well-formed frontmatter block or is missing a required key (name / description / tier).
// When any malformed page exists it injects a <wiki-lint> flag naming them; otherwise silent.
// REPORT-ONLY: it never edits or deletes a page.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any fault emits {} — session close must NEVER hang or throw.
//
// Contract: Stop event JSON on stdin → envelope JSON on stdout (exit 0).

const fs = require('fs');
const path = require('path');

// The human-prose tiers only. The `_`-prefixed tiers (`_rules` and `_slots`) are machine-written by the
// dream adapter through wiki.cjs — they are deliberately OUTSIDE this human-prose frontmatter lint, not
// an omission (dream-03: no silent divergence).
const TIERS = ['concepts', 'decisions', 'gotchas', 'sessions'];
const REQUIRED_KEYS = ['name', 'description', 'tier'];
const MAX_FLAGGED = 20;

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

function findInstallRoot(startDir) {
  let dir = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// Return the reason a page is malformed, or null when it is well-formed.
function lintPage(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return 'no frontmatter';
  const end = src.indexOf('\n---', 3);
  if (end < 0) return 'unterminated frontmatter';
  const fm = src.slice(3, end);
  const missing = REQUIRED_KEYS.filter((k) => !new RegExp(`^${k}\\s*:`, 'm').test(fm));
  if (missing.length) return `missing ${missing.join('/')}`;
  return null;
}

// A page's identity is its `name:` frontmatter slug — it is the wikilink target ([[name]]), the
// filename, and the dedup key. Returns the slug, or null when the page has no readable name.
function pageName(text) {
  const m = /^name\s*:\s*(.+)$/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

// The body is everything after the frontmatter block (where prose [[wikilinks]] live).
function pageBody(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  return end < 0 ? '' : src.slice(end + 4);
}

// Wikilinks are written `[[slug]]` (Obsidian style), where slug equals a target page's `name:`. An
// optional `|alias` or `#anchor` is stripped to the bare target slug. Returns the distinct slugs.
function wikilinkTargets(body) {
  const out = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(String(body || '')))) {
    const slug = m[1].split('|')[0].split('#')[0].trim();
    if (slug) out.add(slug);
  }
  return [...out];
}

// Corpus-level checks (need every page, so they run over the swept corpus, not per-page).
// `corpus` is an array of { ref, name, body }; `ref` is the human-readable `tier/file.md` label.
// Returns dead-wikilink findings: a [[slug]] whose slug matches no existing page name.
function deadLinkFindings(corpus) {
  const names = new Set(corpus.map((p) => p.name).filter(Boolean));
  const findings = [];
  for (const page of corpus) {
    for (const slug of wikilinkTargets(page.body)) {
      if (!names.has(slug)) findings.push(`${page.ref} — dead wikilink [[${slug}]]`);
    }
  }
  return findings;
}

// Duplicate page titles: two+ pages sharing the same `name:` identity slug — an identity collision
// (write-page even refuses to overwrite by slug), the tell that the pages should have been merged.
// One finding per colliding title, naming every page that claims it.
function duplicateTitleFindings(corpus) {
  const byName = new Map();
  for (const page of corpus) {
    if (!page.name) continue; // a name-less page is already caught by the malformed check
    if (!byName.has(page.name)) byName.set(page.name, []);
    byName.get(page.name).push(page.ref);
  }
  const findings = [];
  for (const [name, refs] of byName) {
    if (refs.length > 1) findings.push(`duplicate title "${name}" — ${refs.join(', ')}`);
  }
  return findings;
}

function sweep(root) {
  const flagged = [];
  const corpus = [];
  for (const tier of TIERS) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      corpus.push({ ref: `${tier}/${name}`, name: pageName(text), body: pageBody(text) });
      const reason = lintPage(text);
      if (reason) {
        flagged.push(`${tier}/${name} — ${reason}`);
        if (flagged.length >= MAX_FLAGGED) return flagged;
      }
    }
  }
  // Corpus-level checks run after every page is read (they need the full set of page names).
  for (const f of [...deadLinkFindings(corpus), ...duplicateTitleFindings(corpus)]) {
    flagged.push(f);
    if (flagged.length >= MAX_FLAGGED) return flagged;
  }
  return flagged;
}

function main() {
  try {
    fs.readFileSync(0, 'utf8'); // drain stdin (Stop payload unused beyond presence)
  } catch {
    /* no stdin → still sweep */
  }

  const root = findInstallRoot();
  if (!root) emit({});

  const flagged = sweep(root);
  if (!flagged.length) emit({}); // clean wiki → silent

  const ctx = [
    '<wiki-lint>',
    `${flagged.length} wiki integrity issue(s) — malformed frontmatter, dead [[wikilinks]], or duplicate page titles:`,
    ...flagged.map((f) => `- ${f}`),
    '</wiki-lint>',
  ].join('\n');

  emit({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: ctx } });
}

try {
  main();
} catch {
  emit({});
}
