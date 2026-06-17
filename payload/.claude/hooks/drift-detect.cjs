#!/usr/bin/env node
'use strict';

// WRXN drift-detect hook — reactive provenance-drift nudge (sync-07).
// PostToolUse (Edit|Write). When an edit touches a SOURCE file that downstream wiki docs declare
// `derived_from:`, it injects a <drift> nudge naming the affected doc(s) — so drift surfaces the moment
// the source moves, not only at the next batch `wrxn sync`.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib OR recon (node stdlib only).
// Mechanical: a pure fs + string frontmatter scan, NO LLM call. Independent of sync-01 — it never reads
// a `synced_to:` watermark and never writes; detection NUDGE only.
//
// Fail-open: any fault (no install root, unreadable wiki, a corrupt page, a missing dir) emits {} and
// NEVER blocks the edit.
//
// Contract: PostToolUse event JSON on stdin → envelope JSON on stdout (exit 0).

const fs = require('fs');
const path = require('path');

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

// Normalize a path-ish value to an install-root-relative POSIX path. Drops a `#symbol` anchor
// (sync's `derived_from: path#symbol` form), then resolves relative/absolute/`./`-prefixed forms to
// the same canonical key so same-path and relative-path declarations both match. Returns '' on empty.
function relTo(root, p) {
  const s = String(p == null ? '' : p).split('#')[0].trim();
  if (!s) return '';
  const abs = path.isAbsolute(s) ? s : path.resolve(root, s);
  return path.relative(root, abs).split(path.sep).join('/');
}

function unquote(s) {
  return String(s).trim().replace(/^["']|["']$/g, '').trim();
}

// Extract the frontmatter block (between the leading `---` fence and the next `---`). A page without a
// closed fence yields '' — its provenance is unreadable, so it simply contributes no declaration.
function frontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return m ? m[1] : '';
}

// Parse the `derived_from:` declaration(s) from a page's frontmatter. Handles a scalar, an inline list
// (`[a, b]`), and a block list (`- item` lines). Returns the raw value strings (anchors intact).
function parseDerivedFrom(content) {
  const fm = frontmatter(content);
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^derived_from:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const val = m[1].trim();
    if (val.startsWith('[')) {
      // inline list: [a, b, c]
      for (const part of val.replace(/^\[|\]$/g, '').split(',')) {
        const v = unquote(part);
        if (v) out.push(v);
      }
    } else if (val) {
      out.push(unquote(val));
    } else {
      // block list: subsequent `  - item` lines until the first non-item line
      for (let j = i + 1; j < lines.length; j++) {
        const li = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (!li) break;
        const v = unquote(li[1]);
        if (v) out.push(v);
      }
    }
  }
  return out;
}

// Collect every .md page under <root>/.wrxn/wiki/ (recursively). A missing/unreadable dir yields [].
function collectDocs(wikiDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch {
    return acc; // missing/unreadable tree → no docs
  }
  for (const e of entries) {
    const full = path.join(wikiDir, e.name);
    if (e.isDirectory()) collectDocs(full, acc);
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

// The set of doc relpaths whose frontmatter declares `derived_from:` the edited path.
function affectedDocs(root, editedRel) {
  const wikiDir = path.join(root, '.wrxn', 'wiki');
  const hits = new Set();
  for (const file of collectDocs(wikiDir, [])) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // skip an unreadable page (fail-open per-file)
    }
    const docRel = path.relative(root, file).split(path.sep).join('/');
    if (docRel === editedRel) continue; // never flag the edited file against itself
    for (const raw of parseDerivedFrom(content)) {
      if (relTo(root, raw) === editedRel) {
        hits.add(docRel);
        break;
      }
    }
  }
  return [...hits].sort();
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    emit({});
  }

  const root = findInstallRoot();
  if (!root) emit({});

  const filePath = event.tool_input && event.tool_input.file_path;
  if (!filePath || typeof filePath !== 'string') emit({}); // not a file-touching tool

  const editedRel = relTo(root, filePath);
  if (!editedRel) emit({});

  const docs = affectedDocs(root, editedRel);
  if (docs.length === 0) emit({}); // no downstream provenance → silent

  const ctx = [
    '<drift>',
    `Edited ${editedRel} — ${docs.length} downstream doc(s) declare derived_from it and may now be stale:`,
    ...docs.map((d) => `  - ${d}`),
    'Re-derive the affected doc(s), or run `wrxn sync` to confirm the drift set.',
    '</drift>',
  ].join('\n');

  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } });
}

try {
  main();
} catch {
  emit({});
}
