'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const wt = require('../lib/worktree.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function gitRepo(prefix) {
  const dir = tmp(prefix);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

function commitFileIn(wtPath, file, content) {
  const git = (...args) => execFileSync('git', args, { cwd: wtPath, encoding: 'utf8' });
  fs.writeFileSync(path.join(wtPath, file), content);
  git('add', file);
  git('commit', '-q', '-m', `add ${file}`);
}

// ── AC-1: a named durable worktree is created, persists, and lists with status ──

test('createNamedWorktree makes a wt/<name> worktree that a later list still finds (survives)', () => {
  const { dir } = gitRepo('wrxn-named-create-');
  const w = wt.createNamedWorktree(dir, 'feature-x', { path: path.join(tmp('named-x-'), 'wt') });
  assert.equal(w.branch, 'wt/feature-x');
  assert.ok(fs.existsSync(w.path), 'worktree dir exists on disk (durable)');
  // a fresh enumeration (a new "session") still finds it
  assert.ok(wt.listWorktrees(dir).some((e) => e.branch === 'wt/feature-x'));
});

test('worktreeStatus reports clean / dirty / ahead', () => {
  const { dir } = gitRepo('wrxn-named-status-');
  const w = wt.createNamedWorktree(dir, 'wip', { path: path.join(tmp('named-s-'), 'wt') });

  let st = wt.worktreeStatus(dir, 'wip', { prefix: 'wt/' });
  assert.equal(st.clean, true);
  assert.equal(st.ahead, 0);

  fs.writeFileSync(path.join(w.path, 'scratch.txt'), 'wip\n');
  st = wt.worktreeStatus(dir, 'wip', { prefix: 'wt/' });
  assert.equal(st.clean, false, 'uncommitted change → dirty');

  commitFileIn(w.path, 'scratch.txt', 'wip\n');
  st = wt.worktreeStatus(dir, 'wip', { prefix: 'wt/' });
  assert.equal(st.clean, true);
  assert.equal(st.ahead, 1, 'one commit ahead of base');
});

// ── AC-2: integrate-back + prune-refuses-unmerged, on the SAME engine (AC-3) ────

test('a named worktree integrates back to base on command', () => {
  const { dir } = gitRepo('wrxn-named-integ-');
  const w = wt.createNamedWorktree(dir, 'done-work', { path: path.join(tmp('named-i-'), 'wt') });
  commitFileIn(w.path, 'feature.txt', 'F\n');

  const r = wt.integrateWorktree(dir, 'done-work', { base: 'main', prefix: 'wt/' });
  assert.equal(r.merged, true);
  assert.ok(fs.existsSync(path.join(dir, 'feature.txt')));
  assert.ok(!wt.listWorktrees(dir).some((e) => e.branch === 'wt/done-work'), 'pruned after integrate');
});

test('prune refuses a named worktree with unmerged commits (shared safety engine)', () => {
  const { dir, git } = gitRepo('wrxn-named-safety-');
  const w = wt.createNamedWorktree(dir, 'risky', { path: path.join(tmp('named-r-'), 'wt') });
  commitFileIn(w.path, 'risky.txt', 'unmerged\n');

  assert.throws(() => wt.pruneWorktree(dir, 'risky', { base: 'main', prefix: 'wt/', force: false }), /unmerged|refus/i);
  assert.match(git('branch', '--list', 'wt/risky').trim(), /wt\/risky/);
  assert.ok(fs.existsSync(path.join(w.path, 'risky.txt')));
});

// ── CLI face ────────────────────────────────────────────────────────────────────

test('wrxn worktree new + status run via the CLI', () => {
  const { dir } = gitRepo('wrxn-named-cli-');
  const BIN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');
  const wtPath = path.join(tmp('named-cli-wt-'), 'wt');
  const outNew = execFileSync('node', [BIN, 'worktree', 'new', 'mytask', '--root', dir, '--path', wtPath], { encoding: 'utf8' });
  assert.match(outNew, /wt\/mytask/);
  const outStatus = execFileSync('node', [BIN, 'worktree', 'status', 'mytask', '--root', dir], { encoding: 'utf8' });
  assert.match(outStatus, /clean|wt\/mytask/i);
});
