#!/usr/bin/env node
'use strict';

// WRXN session-end hook — the episodic writer + session janitor (wrxn-kernel-10, foundation-honesty-02).
// SessionEnd. Writes a dated session page into the install's own wiki sessions tier from the
// captured turn trail, then reaps the session's scratch state. Hygiene (foundation-honesty-02):
//   - skip-empty: a session that captured no turns writes NO page;
//   - reap: the consumed trail AND the first-touch marker (.wrxn/history/<sid>.touched, written by
//     code-intel-push) are removed so .wrxn/history/ can't grow without bound;
//   - bound: the sessions tier is capped (WRXN_SESSIONS_MAX, default 50) — oldest pages rotate out.
// CONTINUITY DOCTRINE: this writer touches ONLY the sessions tier + the session's own history
// scratch — it NEVER writes OR deletes the continuity baton (.wrxn/continuity/latest.md). That slot
// has a single writer (the handoff skill); keeping the paths disjoint is the structural fix for the
// clobber observed live 2026-06-12.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open + side-effect-only: emits nothing useful, never blocks; any fault exits 0 silently.
//
// Contract: SessionEnd event JSON on stdin → exit 0. Side effect: a sessions/<date>-<sid>.md page
// for a non-empty session, plus reaping of that session's trail + touched marker.

const fs = require('fs');
const path = require('path');

// Bound the sessions tier to the most-recent N pages (override: WRXN_SESSIONS_MAX).
const DEFAULT_SESSIONS_MAX = 50;

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

// Best-effort removal — `force` ignores a missing file; any other fault is swallowed (fail-open).
function rmQuiet(p) {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    /* best-effort cleanup, never block session close */
  }
}

// Bound the sessions tier: keep at most `max` most-recent dated pages, reaping the oldest. Dated
// `YYYY-MM-DD-…` slugs sort chronologically, so the oldest are the lexicographically-first ones.
// Cap = WRXN_SESSIONS_MAX (env) or DEFAULT_SESSIONS_MAX. Self-contained: never throws.
function capSessions(dir) {
  const max = Number(process.env.WRXN_SESSIONS_MAX) || DEFAULT_SESSIONS_MAX;
  if (!Number.isFinite(max) || max <= 0) return;
  let pages;
  try {
    pages = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f)).sort();
  } catch {
    return;
  }
  for (let i = 0; i < pages.length - max; i++) {
    rmQuiet(path.join(dir, pages[i]));
  }
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

  const { turns, trail } = readTrail(root, event.session_id);

  // Skip-empty: a session that captured no turns leaves NO page — the first half of bounding the
  // sessions tier. Only write the page (and only then consume its trail) when there is activity.
  if (turns.length) {
    const sid = oneLine(event.session_id || 'session');
    const reason = oneLine(event.reason || 'unknown');
    const date = nowISO().slice(0, 10); // YYYY-MM-DD
    const slug = `${date}-${safeId(event.session_id)}`;

    const trailLines = turns.map((t, i) => {
      const tab = t.indexOf('\t');
      const line = tab > -1 ? t.slice(tab + 1) : t;
      return `${i + 1}. ${line}`;
    });

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
      rmQuiet(trail);     // consume the trail only after its page has landed
      capSessions(dir);   // rotation: bound the sessions tier (reap the oldest beyond the cap)
    } catch {
      /* page write failed → fail-open; leave the trail intact for no-loss */
    }
  } else {
    rmQuiet(trail);       // empty session: nothing to write; drop any stray empty trail file
  }

  // The first-touch gate marker (written by code-intel-push) is pure per-session scratch — always
  // reap it so .wrxn/history/ can't grow without bound. NEVER touches the continuity baton.
  rmQuiet(path.join(root, '.wrxn', 'history', `${safeId(event.session_id)}.touched`));

  done();
}

try {
  main();
} catch {
  done();
}
