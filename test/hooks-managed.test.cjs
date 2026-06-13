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

function freshInstall(prefix) {
  const dir = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target: dir });
  return dir;
}

// ── enforce-managed-guard (Edit|Write) ────────────────────────────────────────

test('guard BLOCKS an edit to a managed file without the confirm token', () => {
  const root = freshInstall('wrxn-guard-block-');
  const d = runHook(
    GUARD,
    { tool_input: { file_path: path.join(root, '.claude/constitution.md') } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /managed/i);
});

test('guard ALLOWS a managed edit with the confirm token', () => {
  const root = freshInstall('wrxn-guard-confirm-');
  const d = runHook(
    GUARD,
    { tool_input: { file_path: path.join(root, '.claude/constitution.md') } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '1' }
  );
  assert.deepEqual(d, {});
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

test('precommit BLOCKS a commit staging a managed file', () => {
  const { root, git } = gitInstall('wrxn-pc-block-');
  git('add', '.claude/constitution.md');
  const d = runHook(
    PRECOMMIT,
    { tool_input: { command: 'git commit -m x' } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '' }
  );
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /constitution\.md/);
});

test('precommit ALLOWS the same commit with the confirm token', () => {
  const { root, git } = gitInstall('wrxn-pc-confirm-');
  git('add', '.claude/constitution.md');
  const d = runHook(
    PRECOMMIT,
    { tool_input: { command: 'git commit -m x' } },
    { CLAUDE_PROJECT_DIR: root, WRXN_MANAGED_CONFIRM: '1' }
  );
  assert.deepEqual(d, {});
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
