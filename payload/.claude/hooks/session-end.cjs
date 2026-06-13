#!/usr/bin/env node
'use strict';

// WRXN session-end hook — the episodic writer (wrxn-kernel-10).
// SessionEnd. Writes a dated session page into the install's own wiki sessions tier from the
// captured turn trail, then clears the trail. CONTINUITY DOCTRINE: this writer touches ONLY
// dated session pages — it NEVER writes the continuity baton (.wrxn/continuity/latest.md).
// That slot has a single writer (the handoff skill); keeping the paths disjoint is the
// structural fix for the clobber observed live 2026-06-12.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open + side-effect-only: emits nothing useful, never blocks; any fault exits 0 silently.
//
// Contract: SessionEnd event JSON on stdin → exit 0. Side effect: a sessions/<date>-<sid>.md page.

const fs = require('fs');
const path = require('path');

function done() {
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

function nowISO() {
  return process.env.WRXN_NOW || new Date().toISOString();
}

// Sanitize a session id into a kebab slug fragment (the page + trail FILE name).
function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

// Collapse any whitespace run (incl. newlines/tabs) to a single space — keeps a value safe to
// embed on a single frontmatter line (the wiki adapter + synapse engine PARSE these pages, so
// a stray newline would corrupt the frontmatter and break wiki query).
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Read + consume the captured turn trail for this session (one `<iso>\t<line>` per turn).
function readTrail(root, sid) {
  const trail = path.join(root, '.wrxn', 'history', `${safeId(sid)}.trail`);
  let raw;
  try {
    raw = fs.readFileSync(trail, 'utf8');
  } catch {
    return { turns: [], trail };
  }
  const turns = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return { turns, trail };
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    /* no/garbled stdin → write a minimal page anyway */
  }

  const root = findInstallRoot();
  if (!root) done();

  const sid = oneLine(event.session_id || 'session');
  const reason = oneLine(event.reason || 'unknown');
  const date = nowISO().slice(0, 10); // YYYY-MM-DD
  const slug = `${date}-${safeId(event.session_id)}`;

  const { turns, trail } = readTrail(root, event.session_id);
  const trailLines = turns.length
    ? turns.map((t, i) => {
        const tab = t.indexOf('\t');
        const line = tab > -1 ? t.slice(tab + 1) : t;
        return `${i + 1}. ${line}`;
      })
    : ['_(no turns captured)_'];

  const page = [
    '---',
    `name: ${slug}`,
    `description: Session ${sid} — ${turns.length} turn(s), ended ${reason}`,
    'tier: sessions',
    'source: session-end-hook',
    '---',
    '',
    `# Session ${date} (${sid})`,
    '',
    `- Ended: ${reason}`,
    `- Turns: ${turns.length}`,
    '',
    '## Turn trail',
    ...trailLines,
    '',
  ].join('\n');

  const dir = path.join(root, '.wrxn', 'wiki', 'sessions');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), page);
    // Consume the trail so the next session starts clean.
    try {
      fs.rmSync(trail, { force: true });
    } catch {
      /* trail cleanup is best-effort */
    }
  } catch {
    /* page write failed → fail-open, never block session close */
  }

  done();
}

try {
  main();
} catch {
  done();
}
