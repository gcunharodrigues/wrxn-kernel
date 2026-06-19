#!/usr/bin/env node
'use strict';

// WRXN managed hook — a non-blocking heads-up on MANAGED kernel files inside an install.
// PreToolUse:Edit|Write. When an agent edits/writes a file classified `managed` in the install
// receipt it surfaces an ADVISORY (never a block): a client hook can never be hard enforcement, so
// byte-level managed-integrity is enforced server-side in CI (gate-redesign gate-04). Seeded + state
// files (and anything outside the install) are silent. Self-contained: hooks ship into installs and
// cannot import the kernel lib.
//
// Contract: PreToolUse event JSON on stdin → JSON on stdout (exit 0). It NEVER blocks:
//   silent → {}     advisory → { "hookSpecificOutput": { "hookEventName": "PreToolUse", "additionalContext": "..." } }

const fs = require('fs');
const path = require('path');

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

// Walk up from CLAUDE_PROJECT_DIR (or cwd) to the install root carrying wrxn.install.json.
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

function managedPaths(root) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
    return (receipt.files || []).filter((f) => f.class === 'managed').map((f) => f.path);
  } catch {
    return [];
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return emit({}); // unparseable → fail open
  }

  const filePath = event.tool_input && event.tool_input.file_path;
  if (!filePath) return emit({}); // not a file write

  const root = findInstallRoot();
  if (!root) return emit({}); // not inside a wrxn install → nothing to guard

  const rel = path.relative(root, path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return emit({}); // outside the install

  if (!managedPaths(root).includes(rel)) return emit({}); // seeded/state/other → silent

  // Non-blocking advisory only (gate-04): never block, and the WRXN_MANAGED_CONFIRM token is retired.
  return emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `Heads-up: "${rel}" is a MANAGED kernel file — kernel-owned, overwritten on \`wrxn update\`, and verified byte-for-byte by the server-side CI managed-integrity check. Change it only as a deliberate kernel edit (it must land through the PR + CI gate). Seeded + state files edit freely.`,
    },
  });
}

main();
