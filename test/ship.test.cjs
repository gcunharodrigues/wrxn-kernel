'use strict';

// Tests for wrxn ship — the autonomous promote path (gate-redesign gate-03).
// Replaces the WRXN_ACTIVE_AGENT / settings.local.json env-flag dance with one command that
// pushes a reviewed branch, opens a PR, and arms auto-merge. The lib/ module boundary is the
// primary seam (PRD Testing Decisions): unit-test the PURE builder (buildShipPlan) and the
// run decision (ship via an INJECTED fake invoker — no real network); real git/gh only at the
// CLI layer, and there only NON-DESTRUCTIVELY (a read-only probe — never a real PR).
// Prior art: test/connect.test.cjs (the injectable-invoker shape this reuses), test/executor.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const ship = require('../lib/ship.cjs');
const WRXN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');

// ── buildShipPlan is PURE: branch/title → the ordered git + gh promote commands ──

test('buildShipPlan returns the ordered promote commands: push, gh pr create, gh pr merge --auto --squash', () => {
  const plan = ship.buildShipPlan({ branch: 'track/foo', title: 'feat: foo', base: 'main', body: 'why' });
  assert.deepEqual(
    plan.map((s) => [s.cmd, ...s.args]),
    [
      ['git', 'push', '-u', 'origin', '--', 'track/foo'],
      ['gh', 'pr', 'create', '--base', 'main', '--head', 'track/foo', '--title', 'feat: foo', '--body', 'why'],
      ['gh', 'pr', 'merge', '--auto', '--squash', '--', 'track/foo'],
    ],
    'the promote sequence is push → open PR → arm auto-merge'
  );
});

test('buildShipPlan defaults base to main and body to empty when omitted', () => {
  const plan = ship.buildShipPlan({ branch: 'track/foo', title: 'feat: foo' });
  const prCreate = plan.find((s) => s.label === 'pr-create');
  assert.deepEqual(
    prCreate.args,
    ['pr', 'create', '--base', 'main', '--head', 'track/foo', '--title', 'feat: foo', '--body', ''],
    'base defaults to main, body to "" (keeps gh non-interactive)'
  );
});

test('buildShipPlan THROWS on a missing branch or title (a malformed promote is never runnable)', () => {
  assert.throws(() => ship.buildShipPlan({ title: 'feat: foo' }), /branch is required/);
  assert.throws(() => ship.buildShipPlan({ branch: 'track/foo' }), /title is required/);
  assert.throws(() => ship.buildShipPlan({ branch: '   ', title: '   ' }), /branch is required|title is required/);
});

test('buildShipPlan fences a dash-leading branch behind an end-of-options "--" so it is never read as a flag (CF-6 / SEC-LOW-1)', () => {
  const branch = '--oops';
  const byLabel = Object.fromEntries(ship.buildShipPlan({ branch, title: 'feat: x' }).map((s) => [s.label, s.args]));
  // git push: options/remote first, then `--`, then the branch as a bare positional VALUE
  assert.deepEqual(byLabel.push, ['push', '-u', 'origin', '--', branch], 'push terminates options before the branch');
  // gh pr merge: the real flags MUST stay before `--` (so they still parse as flags), branch after it
  assert.deepEqual(byLabel['auto-merge'], ['pr', 'merge', '--auto', '--squash', '--', branch], 'merge keeps its flags, then --, then the branch');
  // structural invariant: wherever the branch is a bare positional, a `--` precedes it
  for (const args of [byLabel.push, byLabel['auto-merge']]) {
    const dd = args.indexOf('--');
    assert.ok(dd !== -1 && args.indexOf(branch) > dd, 'the branch sits after the -- terminator');
  }
});

// ── ship({ invoker }) runs the plan through an INJECTED invoker (no real network) ──

test('ship runs every planned step IN ORDER through the injected invoker', () => {
  const seen = [];
  const fakeInvoker = (step) => { seen.push([step.cmd, ...step.args]); return { ok: true, detail: `stub: ${step.label}` }; };
  const res = ship.ship({ invoker: fakeInvoker, branch: 'track/foo', title: 'feat: foo', base: 'main' });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [
    ['git', 'push', '-u', 'origin', '--', 'track/foo'],
    ['gh', 'pr', 'create', '--base', 'main', '--head', 'track/foo', '--title', 'feat: foo', '--body', ''],
    ['gh', 'pr', 'merge', '--auto', '--squash', '--', 'track/foo'],
  ], 'the injected invoker ran the planned commands in promote order');
  assert.deepEqual(res.steps.map((s) => s.step), ['push', 'pr-create', 'auto-merge']);
  assert.ok(res.steps.every((s) => s.ok));
});

test('ship STOPS at the first failing step — a failed push never opens a PR or arms auto-merge', () => {
  const seen = [];
  const failOnPush = (step) => {
    seen.push(step.label);
    return step.label === 'push' ? { ok: false, detail: 'stub: push rejected' } : { ok: true, detail: 'stub' };
  };
  const res = ship.ship({ invoker: failOnPush, branch: 'track/foo', title: 'feat: foo' });
  assert.equal(res.ok, false);
  assert.equal(res.failed, 'push');
  assert.deepEqual(seen, ['push'], 'pr-create and auto-merge are NEVER invoked after push fails');
});

// ── CLI surface (CLI-First) — exercised NON-DESTRUCTIVELY (never opens a real PR) ──

test('CLI: wrxn ship --dry-run prints the promote plan WITHOUT running it (non-destructive)', () => {
  const out = execFileSync(
    'node',
    [WRXN, 'ship', '--branch', 'track/foo', '--title', 'feat: foo', '--base', 'main', '--dry-run'],
    { encoding: 'utf8' }
  );
  const plan = JSON.parse(out);
  assert.deepEqual(plan.map((s) => [s.cmd, ...s.args]), [
    ['git', 'push', '-u', 'origin', '--', 'track/foo'],
    ['gh', 'pr', 'create', '--base', 'main', '--head', 'track/foo', '--title', 'feat: foo', '--body', ''],
    ['gh', 'pr', 'merge', '--auto', '--squash', '--', 'track/foo'],
  ], 'the CLI wires branch/title/base into the right promote commands');
});

test('CLI: wrxn ship without --title exits 2 (a PR needs a title; gh must never block interactively)', () => {
  assert.throws(
    () => execFileSync('node', [WRXN, 'ship', '--branch', 'track/foo'], { encoding: 'utf8', stdio: 'pipe' }),
    /requires --title/
  );
});

test('CLI: wrxn ship reaches the real gh by invocation, NON-DESTRUCTIVELY (gh --version, no PR opened)', () => {
  // The CLI promote runs git + gh through this exact real invoker (ship.defaultInvoke). Prove it can
  // reach the real gh read-only — never opening a PR. The full PR-open + auto-merge is verified in the
  // bootstrap self-host walk (PRD Further Notes), not here. Tolerant of a gh-less env (never throws).
  const r = ship.defaultInvoke({ label: 'gh-probe', cmd: 'gh', args: ['--version'] });
  assert.ok(r.ok || /did not run|ENOENT/.test(r.detail), 'gh either responded or was cleanly reported absent');
});

test('defaultInvoke rejects a missing binary by invocation (ENOENT → useful detail, never throws)', () => {
  const r = ship.defaultInvoke({ label: 'ghost', cmd: 'definitely-not-a-real-binary-xyz', args: [] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not run|ENOENT/);
});
