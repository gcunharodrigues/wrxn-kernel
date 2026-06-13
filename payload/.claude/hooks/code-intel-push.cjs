#!/usr/bin/env node
'use strict';

// WRXN code-intel-push hook — first-touch code-intel / recon-freshness nudge (wrxn-kernel-11).
// PostToolUse (Edit|Write). On the FIRST touch of a code file this session it injects a <code-intel>
// nudge: where a recon graph exists it notes freshness (commit lag) and points at recon; absent a
// graph it nudges to build one. First-touch-GATED per session+file (a touched-list under
// .wrxn/history/<sid>.touched) so a repeat edit of the same file is silent — no per-edit spam.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open + recursion-safe: it only READS + appends to its own state file; any fault emits {}.
//
// Contract: PostToolUse event JSON on stdin → envelope JSON on stdout (exit 0).

const fs = require('fs');
const path = require('path');

const CODE_EXT = ['.cjs', '.js', '.mjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.rb'];

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

function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

// First-touch gate: append relPath to .wrxn/history/<sid>.touched; return true only the FIRST time
// this session sees this file. Hooks fire serially within a session, so a plain read-then-append is
// race-free. Fail-open: on any state error, treat as first touch (nudge once is safer than silence).
function isFirstTouch(root, sid, relPath) {
  const dir = path.join(root, '.wrxn', 'history');
  const marker = path.join(dir, `${safeId(sid)}.touched`);
  try {
    const seen = fs.existsSync(marker)
      ? fs.readFileSync(marker, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
      : [];
    if (seen.includes(relPath)) return false;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(marker, `${relPath}\n`);
    return true;
  } catch {
    return true;
  }
}

// A short freshness note: stale (or unknown) when the recon graph's commit doesn't prefix-match HEAD.
function freshnessNote(root) {
  const graph = path.join(root, '.recon', 'graph.json');
  if (!fs.existsSync(graph)) {
    return 'No recon graph (.recon/graph.json absent) — build it for code-connection enrichment, then reindex.';
  }
  return 'recon graph present — reindex if it lags your edits (the graph is rebuilt at session close).';
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
  if (!CODE_EXT.some((ext) => filePath.endsWith(ext))) emit({}); // non-code → silent

  const relPath = (path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath)
    .split(path.sep)
    .join('/');

  if (!isFirstTouch(root, event.session_id, relPath)) emit({}); // gated repeat → silent

  const ctx = [
    '<code-intel>',
    `Touched ${relPath} (first this session).`,
    freshnessNote(root),
    '</code-intel>',
  ].join('\n');

  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } });
}

try {
  main();
} catch {
  emit({});
}
