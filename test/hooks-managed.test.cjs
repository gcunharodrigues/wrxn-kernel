'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const GUARD = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'enforce-managed-guard.cjs');
const PRECOMMIT = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'enforce-managed-precommit.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// Run a hook black-box: feed the PreToolUse event on stdin, return the parsed decision.
// Hooks always exit 0 with a decision (possibly {}) on stdout.
function runHook(hookPath, event, env) {
  const out = execFileSync('node', [hookPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return out.trim() ? JSON.parse(out) : {};
}

// The demoted guards surface a non-blocking advisory via hookSpecificOutput.additionalContext
// (the house style for PreToolUse context, e.g. code-intel-push) — never a block decision.
function advisory(d) {
  return (d.hookSpecificOutput && d.hookSpecificOutput.additionalContext) || '';
}

function freshInstall(prefix) {
  const dir = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target: dir });
  return dir;
}

// ── enforce-managed-guard (Edit|Write) ────────────────────────────────────────

// gate-redesign gate-04: the managed-guard is DEMOTED to a non-blocking advisory. Byte-level
// managed-integrity is now enforced server-side in CI (slice 01); a client hook can never be hard
// enforcement, so it must NEVER block — it only surfaces a heads-up. The WRXN_MANAGED_CONFIRM token
// is retired (the hook no longer reads it).

test('guard ADVISES (never blocks) on a managed-file edit', () => {
  const root = freshInstall('wrxn-guard-advise-');
  const d = runHook(
    GUARD,
    { tool_input: { file_path: path.join(root, '.claude/constitution.md') } },
    { CLAUDE_PROJECT_DIR: root }
  );
  assert.notEqual(d.decision, 'block', 'the demoted guard must never block');
  assert.match(advisory(d), /managed/i, 'it surfaces a non-blocking managed-file advisory');
});

test('guard advises identically whether or not WRXN_MANAGED_CONFIRM is set (token retired)', () => {
  const root = freshInstall('wrxn-guard-tokendead-');
  const ev = { tool_input: { file_path: path.join(root, '.claude/constitution.md') } };
  const withToken = runHook(GUARD, ev, { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '1' });
  const without = runHook(GUARD, ev, { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' });
  assert.notEqual(withToken.decision, 'block');
  assert.deepEqual(withToken, without, 'the confirm token no longer changes the decision');
});

test('guard ALLOWS a seeded file edit freely', () => {
  const root = freshInstall('wrxn-guard-seeded-');
  const d = runHook(
    GUARD,
    { tool_input: { file_path: path.join(root, '.claude/constitution.local.md') } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.deepEqual(d, {});
});

test('guard ALLOWS when not inside a wrxn install', () => {
  const bare = tmp('wrxn-guard-noinstall-');
  const d = runHook(
    GUARD,
    { tool_input: { file_path: path.join(bare, '.claude/constitution.md') } },
    { CLAUDE_PROJECT_DIR: bare, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.deepEqual(d, {});
});

// ── enforce-managed-precommit (Bash git commit) ───────────────────────────────

function gitInstall(prefix) {
  const root = freshInstall(prefix);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  return { root, git };
}

test('precommit ADVISES (never blocks) on a commit staging a managed file', () => {
  const { root, git } = gitInstall('wrxn-pc-advise-');
  git('add', '.claude/constitution.md');
  const d = runHook(
    PRECOMMIT,
    { tool_input: { command: 'git commit -m x' } },
    { CLAUDE_PROJECT_DIR: root }
  );
  assert.notEqual(d.decision, 'block', 'the demoted precommit guard must never block');
  assert.match(advisory(d), /constitution\.md/, 'the advisory names the staged managed file');
});

test('precommit advises identically whether or not WRXN_MANAGED_CONFIRM is set (token retired)', () => {
  const { root, git } = gitInstall('wrxn-pc-tokendead-');
  git('add', '.claude/constitution.md');
  const ev = { tool_input: { command: 'git commit -m x' } };
  const withToken = runHook(PRECOMMIT, ev, { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '1' });
  const without = runHook(PRECOMMIT, ev, { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' });
  assert.notEqual(withToken.decision, 'block');
  assert.deepEqual(withToken, without, 'the confirm token no longer changes the decision');
});

test('precommit ALLOWS a commit staging only seeded/state files', () => {
  const { root, git } = gitInstall('wrxn-pc-seeded-');
  git('add', '.claude/constitution.local.md');
  const d = runHook(
    PRECOMMIT,
    { tool_input: { command: 'git commit -m x' } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.deepEqual(d, {});
});

test('precommit ignores a non-commit bash command', () => {
  const { root } = gitInstall('wrxn-pc-noncommit-');
  const d = runHook(
    PRECOMMIT,
    { tool_input: { command: 'ls -la' } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.deepEqual(d, {});
});

// ── settings.json registers the shipped hooks ─────────────────────────────────

test('settings.json registers each managed-guard hook', () => {
  const root = freshInstall('wrxn-settings-');
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  const commands = JSON.stringify(settings.hooks.PreToolUse);
  assert.match(commands, /enforce-managed-guard\.cjs/);
  assert.match(commands, /enforce-managed-precommit\.cjs/);
});
