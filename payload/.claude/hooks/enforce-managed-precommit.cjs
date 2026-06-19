#!/usr/bin/env node
'use strict';

// WRXN managed hook — the commit-side half of the managed-files heads-up.
// PreToolUse:Bash. When a `git commit` stages any MANAGED kernel file it surfaces an ADVISORY
// (never a block): managed-integrity is enforced server-side in CI (gate-redesign gate-04), so the
// local hook only nudges. Seeded + state files are silent. Self-contained.
//
// Contract: PreToolUse event JSON on stdin → JSON on stdout (exit 0). It NEVER blocks:
//   silent → {}     advisory → { "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "..." } }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

function findInstallRoot() {
  let dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function managedSet(root) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
    return new Set((receipt.files || []).filter((f) => f.class === 'managed').map((f) => f.path));
  } catch {
    return new Set();
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return emit({});
  }

  const command = (event.tool_input && event.tool_input.command) || '';
  if (!/\bgit\s+commit\b/.test(command)) return emit({}); // not a commit

  const root = findInstallRoot();
  if (!root) return emit({});

  let staged = [];
  try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return emit({}); // not a git repo / git unavailable → fail open
  }

  const managed = managedSet(root);
  const hits = staged.filter((f) => managed.has(f));
  if (hits.length === 0) return emit({});

  // Non-blocking advisory only (gate-04): never block, and the WRXN_MANAGED_CONFIRM token is retired.
  return emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Heads-up: this commit stages MANAGED kernel file(s): ${hits.join(', ')}. Managed files are verified byte-for-byte by the server-side CI managed-integrity check — commit them only as a deliberate kernel change that will land through the PR + CI gate.`,
    },
  });
}

main();
