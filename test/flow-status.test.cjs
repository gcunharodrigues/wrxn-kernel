'use strict';

// Tests for the flow-status pure aggregator (wrxn-kernel flow-05).
// flowStatus(issues, artifacts) reconstructs per-slice gate progress from durable artifacts.
// No I/O, no time, no git — the CLI wraps this with actual reads. Prior art: executor.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { flowStatus } = require('../lib/flow-status.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [WRXN, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

// Fixture issues — three slices with varying blocked-by state
const ISSUE_A = { id: 'flow-01', title: 'Compass router' };
const ISSUE_B = { id: 'flow-02', title: 'Flow status', blockedBy: [] };        // empty blockedBy = not blocked
const ISSUE_C = { id: 'flow-03', title: 'Blocked slice', blockedBy: ['flow-01'] };

// Full artifact set — all four gate artifacts present
const FULL = {
  greenCommit: 'abc1234',
  reviewMarker: 'review-flow-01.md',
  securityReport: 'security-flow-01.md',
  walkFindings: 'walk-flow-01.md',
};

// ── full artifact set → all done ─────────────────────────────────────────────

test('full artifact set yields state=done and every gate done', () => {
  const board = flowStatus([ISSUE_A], { 'flow-01': FULL });
  assert.equal(board.length, 1);
  const s = board[0];
  assert.equal(s.id, 'flow-01');
  assert.equal(s.title, 'Compass router');
  assert.equal(s.state, 'done');
  assert.equal(s.gates.build, 'done');
  assert.equal(s.gates.review, 'done');
  assert.equal(s.gates.security, 'done');
  assert.equal(s.gates.qa, 'done');
});

// ── empty artifacts → all queued ─────────────────────────────────────────────

test('no artifacts for an issue yields state=queued and all gates pending', () => {
  const board = flowStatus([ISSUE_A], {});
  const s = board[0];
  assert.equal(s.state, 'queued');
  assert.equal(s.gates.build, 'pending');
  assert.equal(s.gates.review, 'pending');
  assert.equal(s.gates.security, 'pending');
  assert.equal(s.gates.qa, 'pending');
});

// ── blocked issue → queued, even with artifacts ───────────────────────────────

test('a blocked issue yields queued regardless of present artifacts', () => {
  const board = flowStatus([ISSUE_C], { 'flow-03': FULL });
  const s = board[0];
  assert.equal(s.id, 'flow-03');
  assert.equal(s.state, 'queued', 'blocked must be queued');
});

// ── empty blockedBy array is not blocked ──────────────────────────────────────

test('empty blockedBy array is not blocked (state follows gates)', () => {
  const board = flowStatus([ISSUE_B], { 'flow-02': FULL });
  const s = board[0];
  assert.equal(s.state, 'done', 'empty blockedBy [] is not blocked');
});

// ── stalled: build done, review missing ──────────────────────────────────────

test('build done but review absent yields state=stalled', () => {
  const board = flowStatus([ISSUE_A], { 'flow-01': { greenCommit: 'abc1234' } });
  const s = board[0];
  assert.equal(s.state, 'stalled');
  assert.equal(s.gates.build, 'done');
  assert.equal(s.gates.review, 'pending');
  assert.equal(s.gates.security, 'pending');
  assert.equal(s.gates.qa, 'pending');
});

// ── in-progress: build + review done ─────────────────────────────────────────

test('build+review done yields state=in-progress', () => {
  const board = flowStatus([ISSUE_A], {
    'flow-01': { greenCommit: 'abc1234', reviewMarker: 'review-flow-01.md' },
  });
  const s = board[0];
  assert.equal(s.state, 'in-progress');
  assert.equal(s.gates.build, 'done');
  assert.equal(s.gates.review, 'done');
  assert.equal(s.gates.security, 'pending');
  assert.equal(s.gates.qa, 'pending');
});

// ── in-progress: build + review + security done ───────────────────────────────

test('build+review+security done yields state=in-progress', () => {
  const board = flowStatus([ISSUE_A], {
    'flow-01': { greenCommit: 'abc1234', reviewMarker: 'r.md', securityReport: 's.md' },
  });
  const s = board[0];
  assert.equal(s.state, 'in-progress');
  assert.equal(s.gates.security, 'done');
  assert.equal(s.gates.qa, 'pending');
});

// ── missing/falsy artifacts never yield a false gate pass ─────────────────────

test('falsy artifact values never cause a false gate pass', () => {
  const board = flowStatus([ISSUE_A], {
    'flow-01': { greenCommit: '', reviewMarker: null, securityReport: undefined, walkFindings: 0 },
  });
  const s = board[0];
  assert.equal(s.gates.build, 'pending', 'empty string greenCommit is pending');
  assert.equal(s.gates.review, 'pending', 'null reviewMarker is pending');
  assert.equal(s.gates.security, 'pending', 'undefined securityReport is pending');
  assert.equal(s.gates.qa, 'pending', 'numeric 0 walkFindings is pending');
  assert.equal(s.state, 'queued');
});

// ── multiple issues with mixed states ─────────────────────────────────────────

test('multiple issues yield correct per-slice states (done/stalled/queued)', () => {
  const board = flowStatus(
    [ISSUE_A, ISSUE_B, ISSUE_C],
    {
      'flow-01': FULL,                              // done
      'flow-02': { greenCommit: 'def5678' },        // stalled (build only)
      // flow-03 blocked → queued (artifacts irrelevant)
    }
  );
  assert.equal(board.length, 3);
  assert.equal(board[0].state, 'done');
  assert.equal(board[1].state, 'stalled');
  assert.equal(board[2].state, 'queued');
});

// ── empty issues list ─────────────────────────────────────────────────────────

test('empty issues list returns an empty board', () => {
  const board = flowStatus([], {});
  assert.deepEqual(board, []);
});

// ── CLI: wrxn flow status <prd> prints a readable board ──────────────────────

function gitRepo(prefix) {
  const dir = tmp(prefix);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

test('CLI: wrxn flow status <prd> prints a board with correct gate symbols', () => {
  const { dir, git } = gitRepo('wrxn-flow-status-cli-');

  // Create issue files in .scratch/myprd/issues/
  const issuesDir = path.join(dir, '.scratch', 'myprd', 'issues');
  fs.mkdirSync(issuesDir, { recursive: true });
  fs.writeFileSync(path.join(issuesDir, '01-slice-one.md'), '# 01 — Slice one\n\nStatus: ready-for-agent\n');
  fs.writeFileSync(path.join(issuesDir, '02-slice-two.md'), '# 02 — Slice two\n\nStatus: ready-for-agent\n## Blocked by\n\n- myprd-01\n');

  // Commit referencing myprd-01 (greenCommit artifact for slice 01)
  fs.writeFileSync(path.join(dir, 'work.txt'), 'work\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feat(slice): implement slice one [myprd-01]');

  // Place a review marker for slice 01
  fs.writeFileSync(path.join(dir, 'review-myprd-01.md'), '## Review\nAPPROVED\n');

  const { code, stdout } = runCli(['flow', 'status', 'myprd', '--root', dir]);
  assert.equal(code, 0, `exit 0; stderr: ${stdout}`);

  // myprd-01: build✓ review✓ sec· qa· → in-progress
  assert.match(stdout, /myprd-01/, 'slice 01 id in output');
  assert.match(stdout, /build✓/, 'build gate done for slice 01');
  assert.match(stdout, /review✓/, 'review gate done for slice 01');
  assert.match(stdout, /in-progress/, 'slice 01 is in-progress');

  // myprd-02: blocked → queued
  assert.match(stdout, /myprd-02/, 'slice 02 id in output');
  assert.match(stdout, /queued/, 'slice 02 is queued (blocked)');
});

test('CLI: wrxn flow status exits non-zero without a prd argument', () => {
  const { code } = runCli(['flow', 'status']);
  assert.notEqual(code, 0);
});
