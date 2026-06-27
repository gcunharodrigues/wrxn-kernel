'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const SETTINGS = path.join(PKG_ROOT, 'payload', '.claude', 'settings.json');

// Collect every hook command string across all events in the payload settings.json.
function hookCommands() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const cmds = [];
  for (const groups of Object.values(cfg.hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type === 'command') cmds.push(hook.command);
      }
    }
  }
  return cmds;
}

test('payload settings.json is valid JSON with hook commands', () => {
  const cmds = hookCommands();
  assert.ok(cmds.length > 0, 'expected at least one hook command');
});

test('every hook command is anchored to $CLAUDE_PROJECT_DIR', () => {
  for (const cmd of hookCommands()) {
    assert.match(
      cmd,
      /\$CLAUDE_PROJECT_DIR/,
      `hook command not anchored to $CLAUDE_PROJECT_DIR: ${cmd}`
    );
  }
});

test('no hook command uses a bare relative node .claude/hooks/ path', () => {
  for (const cmd of hookCommands()) {
    assert.doesNotMatch(
      cmd,
      /node\s+\.claude\/hooks\//,
      `hook command uses a bare relative path: ${cmd}`
    );
  }
});

// ── gate-redesign gate-04: the three client-side push-gate hooks are retired ──
// They are superseded by the server-side `wrxn-main-gate` ruleset + CI (ADR 0007 choice 5). A
// client hook can never be hard enforcement (it gates one tool surface, not the repository) — so
// the push path is now PR + CI + auto-merge, and these three must be gone from the wiring.

const RETIRED_PUSH_HOOKS = ['enforce-push-authority', 'enforce-review-marker', 'enforce-tests-on-push'];

test('the retired push-gate hooks are absent from the settings wiring', () => {
  const joined = hookCommands().join('\n');
  for (const retired of RETIRED_PUSH_HOOKS) {
    assert.doesNotMatch(joined, new RegExp(retired), `${retired} must be unwired (retired in gate-04)`);
  }
});

test('the pipeline-adherence guard is wired under the PreToolUse Bash matcher (slice #90)', () => {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const bashGroups = (cfg.hooks.PreToolUse || []).filter((g) => g.matcher === 'Bash');
  const cmds = bashGroups.flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(
    cmds.some((c) => /enforce-pipeline-adherence\.cjs/.test(c)),
    'enforce-pipeline-adherence must be wired under the Bash matcher'
  );
});

test('the surviving hook wiring is intact after the push-gate retirement', () => {
  const joined = hookCommands().join('\n');
  // session/intel + synapse + the demoted managed-advisory + the slice-07 adherence guard all stay.
  for (const keep of [
    'session-start', 'synapse-engine', 'reference-detect', 'recall-surface',
    'enforce-managed-guard', 'enforce-managed-precommit', 'enforce-pipeline-adherence',
    'code-intel-push', 'drift-detect', 'wiki-lint',
  ]) {
    assert.match(joined, new RegExp(keep), `${keep} must remain wired`);
  }
});
