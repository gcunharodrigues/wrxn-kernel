'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HOOKS = path.join(PKG_ROOT, 'payload', '.claude', 'hooks');
const AUTH = path.join(HOOKS, 'enforce-push-authority.cjs');
const TESTS = path.join(HOOKS, 'enforce-tests-on-push.cjs');
const REVIEW = path.join(HOOKS, 'enforce-review-marker.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function runHook(hookPath, event, env) {
  // Hook contract tests must be deterministic regardless of the developer's shell. The hooks read
  // operator config from WRXN_* env vars (WRXN_PUSH_RANGE, WRXN_REVIEW_MARKERS_DIR, WRXN_ACTIVE_AGENT,
  // WRXN_TEST_CMD, …); a leaked ambient value (e.g. a devops session's WRXN_PUSH_RANGE=HEAD..HEAD)
  // would hijack the hook under test. Strip all ambient WRXN_* first; each test re-adds exactly the
  // vars it intends via `env`.
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('WRXN_')) delete base[k];
  const out = execFileSync('node', [hookPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const PUSH = { tool_input: { command: 'git push origin HEAD:main' } };

// ── enforce-push-authority ────────────────────────────────────────────────────

test('push-authority BLOCKS a push for an unauthorized agent', () => {
  const d = runHook(AUTH, PUSH, { WRXN_ACTIVE_AGENT: '' });
  assert.equal(d.decision, 'block');
});

test('push-authority ALLOWS a push for the devops role', () => {
  const d = runHook(AUTH, PUSH, { WRXN_ACTIVE_AGENT: 'devops' });
  assert.deepEqual(d, {});
});

test('push-authority ignores a non-push command', () => {
  const d = runHook(AUTH, { tool_input: { command: 'git status' } }, { WRXN_ACTIVE_AGENT: '' });
  assert.deepEqual(d, {});
});

test('push-authority gate is a deliberate-push confirmation flag, not a devops-role authority', () => {
  // new framing: the block reason names the real way to satisfy the gate (set the flag in the
  // local settings file) and drops the multi-actor "authority" language.
  const blocked = runHook(AUTH, PUSH, { WRXN_ACTIVE_AGENT: '' });
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /settings\.local\.json/);
  assert.match(blocked.reason, /confirm/i);
  assert.doesNotMatch(blocked.reason, /devops role/i);
  assert.doesNotMatch(blocked.reason, /exclusive/i);

  // mechanism unchanged: an unflagged op is blocked, the flag value still allows it.
  assert.deepEqual(runHook(AUTH, PUSH, { WRXN_ACTIVE_AGENT: 'devops' }), {});
});

// ── enforce-tests-on-push ─────────────────────────────────────────────────────

test('tests-on-push BLOCKS a push when the suite is red', () => {
  const d = runHook(TESTS, PUSH, { WRXN_TEST_CMD: 'false' });
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /red/i);
});

test('tests-on-push ALLOWS a push when the suite is green', () => {
  const d = runHook(TESTS, PUSH, { WRXN_TEST_CMD: 'true' });
  assert.deepEqual(d, {});
});

test('tests-on-push ignores a non-push command', () => {
  const d = runHook(TESTS, { tool_input: { command: 'ls' } }, { WRXN_TEST_CMD: 'false' });
  assert.deepEqual(d, {});
});

// ── enforce-review-marker ─────────────────────────────────────────────────────

function gitRepoWithCommit(prefix, message) {
  const root = tmp(prefix);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'f.txt'), 'x');
  git('add', 'f.txt');
  git('commit', '-q', '-m', message);
  return { root, git };
}

test('review-marker BLOCKS a push whose commit references an unreviewed issue', () => {
  const { root } = gitRepoWithCommit('wrxn-rev-block-', 'feat: thing [feat-1]');
  const d = runHook(REVIEW, PUSH, { CLAUDE_PROJECT_DIR: root });
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /feat-1/);
});

test('review-marker ALLOWS the push once the review marker exists', () => {
  const { root } = gitRepoWithCommit('wrxn-rev-ok-', 'feat: thing [feat-1]');
  const dir = path.join(root, '.claude/ai/output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-feat-1.md'), '# reviewed\n');
  const d = runHook(REVIEW, PUSH, { CLAUDE_PROJECT_DIR: root });
  assert.deepEqual(d, {});
});

test('review-marker ALLOWS a push whose commit references no issue id', () => {
  const { root } = gitRepoWithCommit('wrxn-rev-noid-', 'chore: tidy up');
  const d = runHook(REVIEW, PUSH, { CLAUDE_PROJECT_DIR: root });
  assert.deepEqual(d, {});
});

// ── settings.json wires the boundary gates ────────────────────────────────────

test('settings.json registers the boundary hooks', () => {
  const root = tmp('wrxn-bnd-settings-');
  init({ pkgRoot: PKG_ROOT, target: root });
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  const commands = JSON.stringify(settings.hooks.PreToolUse);
  assert.match(commands, /enforce-push-authority\.cjs/);
  assert.match(commands, /enforce-tests-on-push\.cjs/);
  assert.match(commands, /enforce-review-marker\.cjs/);
});
