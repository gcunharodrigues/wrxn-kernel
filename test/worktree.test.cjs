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

// A real git repo on `main` with one base commit.
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

// Commit a single new file on whatever branch a worktree currently has checked out.
function commitFileIn(wtPath, file, content) {
  const git = (...args) => execFileSync('git', args, { cwd: wtPath, encoding: 'utf8' });
  fs.writeFileSync(path.join(wtPath, file), content);
  git('add', file);
  git('commit', '-q', '-m', `add ${file}`);
}

// ── AC-2: the disjoint-file check refuses an overlapping split ──────────────────

test('verifyDisjoint passes for disjoint file lists', () => {
  const r = wt.verifyDisjoint([
    { name: 'a', files: ['src/a.js', 'test/a.test.js'] },
    { name: 'b', files: ['src/b.js', 'test/b.test.js'] },
  ]);
  assert.equal(r.ok, true);
});

test('verifyDisjoint REFUSES an overlapping split and names the collision', () => {
  assert.throws(
    () => wt.verifyDisjoint([
      { name: 'a', files: ['src/shared.js', 'src/a.js'] },
      { name: 'b', files: ['src/shared.js', 'src/b.js'] },
    ]),
    /shared\.js/
  );
});

// ── AC-1 + AC-3: two disjoint tracks integrate back to base; worktrees auto-prune ─

test('two disjoint tracks build in parallel worktrees and both integrate back to base', () => {
  const { dir, git } = gitRepo('wrxn-wt-integ-');
  const a = wt.createWorktree(dir, 'feat-a', { path: path.join(tmp('wt-a-'), 'wt') });
  const b = wt.createWorktree(dir, 'feat-b', { path: path.join(tmp('wt-b-'), 'wt') });
  assert.equal(a.branch, 'track/feat-a');

  commitFileIn(a.path, 'a.txt', 'A\n');
  commitFileIn(b.path, 'b.txt', 'B\n');

  wt.integrateWorktree(dir, 'feat-a', { base: 'main' });
  wt.integrateWorktree(dir, 'feat-b', { base: 'main' });

  // base now carries both tracks' files
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));

  // AC-3: no zombie branches, no leftover worktrees
  const branches = git('branch', '--list', 'track/*').trim();
  assert.equal(branches, '');
  const list = wt.listWorktrees(dir).map((w) => w.branch);
  assert.ok(!list.includes('track/feat-a'));
  assert.ok(!list.includes('track/feat-b'));
});

// ── AC-4: unmerged work is never deleted ────────────────────────────────────────

test('prune REFUSES to delete a worktree with unmerged commits (safety)', () => {
  const { dir, git } = gitRepo('wrxn-wt-safety-');
  const c = wt.createWorktree(dir, 'risky', { path: path.join(tmp('wt-c-'), 'wt') });
  commitFileIn(c.path, 'risky.txt', 'unmerged work\n');

  assert.throws(() => wt.pruneWorktree(dir, 'risky', { force: false }), /unmerged|not.*merged|refus/i);

  // the branch + its commit survive
  const branches = git('branch', '--list', 'track/risky').trim();
  assert.match(branches, /track\/risky/);
  assert.ok(fs.existsSync(path.join(c.path, 'risky.txt')));
});

test('a clean (no-commit) worktree prunes without force', () => {
  const { dir, git } = gitRepo('wrxn-wt-cleanprune-');
  wt.createWorktree(dir, 'empty', { path: path.join(tmp('wt-e-'), 'wt') });
  wt.pruneWorktree(dir, 'empty', { force: false });
  assert.equal(git('branch', '--list', 'track/empty').trim(), '');
});

// ── CLI face (Constitution: every feature works via CLI) ────────────────────────

test('wrxn worktree list runs via the CLI', () => {
  const { dir } = gitRepo('wrxn-wt-cli-');
  const BIN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');
  const out = execFileSync('node', [BIN, 'worktree', 'list', '--root', dir], { encoding: 'utf8' });
  assert.match(out, /worktree|main/i);
});
