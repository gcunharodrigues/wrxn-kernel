#!/usr/bin/env node
'use strict';

// WRXN chat-search engine — on-demand retrieval over the Conversational log (kernel #83, slice 1).
// Self-contained: this ships INTO an install and MUST NOT import the kernel lib (node stdlib only).
//
// This slice scans the EVENT-LOG arm only — <root>/.wrxn/events/*.jsonl, the per-session, pre-redacted
// user-prompt records emit-event.cjs appends. (The harness-transcript arm + flags are #84/#85.) Pure
// in-process fs scan: no Brain, no embeddings, no recon/serve dependency (ADR 0008). Never wired as a
// per-prompt hook — it is invoked deliberately, by the operator or the agent (ADR 0002 boundary).

const fs = require('fs');
const path = require('path');

// Only prompt records carry text in the event arm, so only they can match. role is derived from kind:
// a user prompt is kind 'prompt' → role 'user'.
function roleFromKind(kind) {
  return kind === 'prompt' ? 'user' : String(kind || '');
}

// A snippet is the matching line plus ±1 line of context within the message text (`needle` is already
// lowercased). A single-line prompt collapses to just that line. A match that only spans a line boundary
// has no single matching line → fall back to the trimmed whole text (defensive; rare).
function snippetFor(text, needle) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => l.toLowerCase().includes(needle));
  if (i === -1) return String(text).trim();
  const from = Math.max(0, i - 1);
  const to = Math.min(lines.length - 1, i + 1);
  return lines.slice(from, to + 1).join('\n').trim();
}

// ── render: one hit → "timestamp · session (or 'this session') · role · snippet" ──
// The session column collapses to "this session" when the hit is from the caller's active session
// (opts.session), so a result set reads as scrollback relative to where the operator stands now.
function renderHit(hit, opts) {
  const active = opts && opts.session;
  const sessionLabel = active && hit.session === active ? 'this session' : hit.session;
  return `${hit.ts} · ${sessionLabel} · ${hit.role} · ${hit.snippet}`;
}

// ── locations (injectable — tests pass a temp root) ───────────────────────────
// The events dir for an install root, mirroring emit-event.cjs's eventsDir(root).
function eventsDirOf(root) {
  return path.join(root, '.wrxn', 'events');
}

// Normalize the roots arg to a list of install roots. A string is one root; an array is many. The seam
// stays pure/injectable — it never resolves cwd itself; the CLI passes the resolved root in.
function normalizeRoots(roots) {
  if (!roots) return [];
  return Array.isArray(roots) ? roots : [roots];
}

// Every <sid>.jsonl session log in an events dir. Absent dir → [] (no crash), mirroring wiki.cjs.
function listEventFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

// ── the engine seam ───────────────────────────────────────────────────────────
// searchConversationalLog(query, opts, roots): scan the event-log arm across the given roots' sessions
// and return the prompts whose text contains `query` (case-insensitive substring). Each hit is a
// structured record { ts, session, role, snippet }.
function searchConversationalLog(query, opts, roots) {
  const q = String(query == null ? '' : query);
  const needle = q.toLowerCase();
  const hits = [];

  for (const root of normalizeRoots(roots)) {
    for (const file of listEventFiles(eventsDirOf(root))) {
      let lines;
      try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
      } catch {
        continue; // an unreadable entry (EISDIR dir, EACCES, ENOENT/TOCTOU, broken symlink) → skip it, keep scanning
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // skip a malformed line, never crash the scan
        }
        if (!rec || typeof rec.text !== 'string') continue; // only text-bearing records can match
        if (!rec.text.toLowerCase().includes(needle)) continue;
        hits.push({ ts: rec.ts, session: rec.sid, role: roleFromKind(rec.kind), snippet: snippetFor(rec.text, needle) });
      }
    }
  }

  // Recency-first: newest timestamp on top. ISO-8601 stamps parse cleanly; an unparseable ts sorts last.
  hits.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));

  const found = hits.length > 0;
  const rendered = found
    ? hits.map((h) => renderHit(h, opts)).join('\n')
    : `chat-search: nothing found for "${q}" in the conversational log (event log).`;

  return { query: q, total: hits.length, found, hits, rendered };
}

// ── CLI: node .wrxn/chat-search.cjs <term...> [--root <dir>] ──────────────────
// The operator-invocable surface (/chat-search <term>). Resolves the install root by walking up to the
// wrxn.install.json receipt (mirrors wiki.cjs), or honors a --root override (tests). Prints the rendered
// result and exits 0 — a nothing-found result is a normal outcome, never an error exit.

// Mirrors wiki.cjs / emit-event.cjs findInstallRoot (no kernel-lib import in a shipped file).
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

// Positional search terms: argv from index 2 up to the first --flag.
function positionals() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    out.push(process.argv[i]);
  }
  return out;
}

function main() {
  const terms = positionals();
  if (terms.length === 0) {
    process.stdout.write('Usage: node .wrxn/chat-search.cjs <search-term...> [--root <dir>]\n');
    process.exit(2);
  }
  const root = flag('root') || findInstallRoot();
  if (!root) {
    process.stderr.write('chat-search: cannot resolve the install root — run inside a wrxn install or pass --root <dir>\n');
    process.exit(2);
  }
  // opts is empty here: the live current-session id (which the renderer collapses to "this session") has
  // no CLI source yet — it arrives with the transcript arm (#84). Not wired in this slice.
  const result = searchConversationalLog(terms.join(' '), {}, root);
  process.stdout.write(result.rendered + '\n');
  process.exit(0);
}

// Belt-and-suspenders fail-loud (mirrors emit-event.cjs's entrypoint wrap): the per-file read and root
// resolution are already guarded, so main() should not throw — but if any residual fault escapes, exit
// with a clean ONE-LINE diagnostic (a path-free error code only — never a Node stack or absolute path).
if (require.main === module) {
  try {
    main();
  } catch (err) {
    const code = err && err.code ? ` (${err.code})` : '';
    process.stderr.write(`chat-search: search failed unexpectedly${code}\n`);
    process.exit(1);
  }
}

module.exports = { searchConversationalLog, renderHit };
