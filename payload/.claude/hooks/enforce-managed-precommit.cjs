#!/usr/bin/env node
'use strict';

// WRXN managed hook — the commit-side half of the managed-files guard.
// PreToolUse:Bash. Blocks a `git commit` that stages any MANAGED kernel file unless
// WRXN_MANAGED_CONFIRM is set. Seeded + state files commit freely. Self-contained.
//
// Contract: PreToolUse event JSON on stdin → decision JSON on stdout (exit 0).

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

  if (process.env.WRXN_MANAGED_CONFIRM) return emit({});

  return emit({
    decision: 'block',
    reason: `Commit stages MANAGED kernel file(s): ${hits.join(', ')}. Set WRXN_MANAGED_CONFIRM to confirm an intentional kernel change.`,
  });
}

main();
