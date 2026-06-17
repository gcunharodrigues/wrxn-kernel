#!/usr/bin/env node
'use strict';

// WRXN session-start hook — the orientation surface (wrxn-kernel-10).
// SessionStart. Injects identity + resume as additionalContext so every new session opens
// oriented. The resume surfaces the DELIBERATE handoff baton at .wrxn/continuity/latest.md (single
// writer = the handoff skill); absent a baton there is no prior handoff to resume. (The automatic
// episodic session-page fallback was retired with the session-capture subsystem in harvest-01.)
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any fault emits {} (no orientation) — the hook NEVER blocks a session opening.
//
// Contract: SessionStart event JSON on stdin → envelope JSON on stdout (exit 0).
//   inject → { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }
//   no-op  → {}

const fs = require('fs');
const path = require('path');

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

// Walk up from CLAUDE_PROJECT_DIR (or cwd) to the install root carrying wrxn.install.json.
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

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

function identityLine(root) {
  const name = path.basename(root);
  let version = '';
  let profile = 'project';
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
    version = receipt.kernelVersion ? ` v${receipt.kernelVersion}` : '';
    profile = receipt.profile || 'project';
  } catch {
    /* receipt unreadable → name-only identity */
  }
  return `Install: ${name}${version} (${profile} profile)`;
}

// The deliberate handoff baton — the intent-carrying continuity slot. Single writer: the
// handoff skill. Read-only here; its presence takes precedence over the episodic record.
function readBaton(root) {
  return readFileOr(path.join(root, '.wrxn', 'continuity', 'latest.md'), null);
}

function main() {
  let consumed = '';
  try {
    consumed = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin → still try to orient */
  }
  void consumed; // SessionStart carries no field we need beyond the install context

  const root = findInstallRoot();
  if (!root) emit({});

  const parts = [identityLine(root)];

  const baton = readBaton(root);
  if (baton && baton.trim()) {
    parts.push('', 'Resume — deliberate handoff baton (.wrxn/continuity/latest.md):', baton.trim());
  } else {
    parts.push('', 'Resume — no prior handoff.');
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: ['<wrxn-orientation>', ...parts, '</wrxn-orientation>'].join('\n'),
    },
  });
}

try {
  main();
} catch {
  emit({}); // fail-open: never block a session opening
}
