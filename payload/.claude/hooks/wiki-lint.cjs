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

function sweep(root) {
  const flagged = [];
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
      const reason = lintPage(text);
      if (reason) {
        flagged.push(`${tier}/${name} — ${reason}`);
        if (flagged.length >= MAX_FLAGGED) return flagged;
      }
    }
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
    `${flagged.length} malformed wiki page(s) — fix the frontmatter (name / description / tier):`,
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
