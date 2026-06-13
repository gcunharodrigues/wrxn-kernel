'use strict';

// Tests for the remaining five executors (wrxn-kernel-19) — reviewer, security, qa-walker,
// researcher, devops, built on the wrxn-kernel-18 dispatch-harness pattern. Acceptance is BEHAVIOR
// per executor encoded deterministically: each type produces the right artifact contract, reviewer
// + security are isolated by construction, and devops is the ONLY type that passes the push gate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { buildDispatchSpec, validateReport, EXECUTOR_TYPES } = require('../lib/executor.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

const FIXTURE = [
  '---',
  'id: wrxn-kernel-99',
  'title: "Fixture task"',
  'labels: [ready-for-agent]',
  '---',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] does the thing',
  '',
].join('\n');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// A generic (non-builder) completion report.
function artifactReport(extra) {
  return { issueId: 'wrxn-kernel-99', status: 'completed', artifact: 'produced', pushed: false, summary: 'done', ...extra };
}

// ── AC-1: each executor type carries its artifact contract in the spec ─────────

test('every executor type builds a spec naming its artifact', () => {
  const expected = {
    reviewer: /review.?marker/i,
    security: /security.?report/i,
    'qa-walker': /walk.?findings/i,
    researcher: /research.?summary/i,
    devops: /push/i,
  };
  for (const [type, re] of Object.entries(expected)) {
    const spec = buildDispatchSpec(FIXTURE, type);
    assert.equal(spec.executor, type);
    assert.match(spec.artifact, re, `${type} artifact`);
    assert.equal(spec.issue.id, 'wrxn-kernel-99');
  }
});

test('reviewer + security have NO local skill (global slash-skills) — instructions instead', () => {
  for (const type of ['reviewer', 'security']) {
    const spec = buildDispatchSpec(FIXTURE, type);
    assert.equal(spec.skill, null, `${type} has no local skill file`);
    assert.ok(Array.isArray(spec.instructions) && spec.instructions.length, `${type} carries explicit instructions`);
  }
});

test('qa-walker + researcher point at their real local skill files', () => {
  assert.match(buildDispatchSpec(FIXTURE, 'qa-walker').skill, /qa-walk\/SKILL\.md$/);
  assert.match(buildDispatchSpec(FIXTURE, 'researcher').skill, /tech-search\/SKILL\.md$/);
});

// ── AC-2: reviewer + security run isolated (fresh eyes by construction) ────────

test('reviewer + security declare fresh-context isolation', () => {
  for (const type of ['reviewer', 'security']) {
    assert.match(buildDispatchSpec(FIXTURE, type).isolation, /fresh/i, `${type} isolated`);
  }
});

// ── AC-3: devops is the ONLY type that passes the push gate ────────────────────

test('non-devops executors are BLOCKED from pushing; devops is allowed', () => {
  for (const type of ['reviewer', 'security', 'qa-walker', 'researcher']) {
    const r = validateReport(artifactReport({ pushed: true }), type);
    assert.equal(r.ok, false, `${type} must not push`);
    assert.ok(r.errors.some((e) => /push/i.test(e)));
  }
  // devops MAY push — a devops completion records the authorized push.
  const ok = validateReport(artifactReport({ pushed: true, artifact: 'origin/main@abc1234' }), 'devops');
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('a devops completion that did NOT push is invalid (it is the push path)', () => {
  const r = validateReport(artifactReport({ pushed: false }), 'devops');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /push/i.test(e)));
});

// ── generic completion contract: artifact required when completed ──────────────

test('a generic completed report requires a non-empty artifact', () => {
  assert.equal(validateReport(artifactReport({ artifact: '' }), 'reviewer').ok, false);
  assert.equal(validateReport(artifactReport(), 'reviewer').ok, true);
});

test('a blocked executor report is valid without an artifact', () => {
  const r = validateReport({ issueId: 'x', status: 'blocked', artifact: '', pushed: false, summary: 'escalated' }, 'security');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('an unknown executor type is rejected', () => {
  assert.throws(() => buildDispatchSpec(FIXTURE, 'wizard'), /unknown executor/i);
  assert.ok(EXECUTOR_TYPES.includes('builder') && EXECUTOR_TYPES.includes('devops'));
});

// ── CLI: --executor selects the type ───────────────────────────────────────────

function runCli(args) {
  try {
    return { code: 0, stdout: execFileSync('node', [WRXN, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI: wrxn dispatch --executor devops prints the devops spec', () => {
  const d = tmp('wrxn-batch-cli-');
  const issuePath = path.join(d, 'issue.md');
  fs.writeFileSync(issuePath, FIXTURE);
  const { code, stdout } = runCli(['dispatch', issuePath, '--executor', 'devops']);
  assert.equal(code, 0);
  const spec = JSON.parse(stdout);
  assert.equal(spec.executor, 'devops');
  assert.match(spec.artifact, /push/i);
});

test('CLI: --check-report --executor reviewer rejects a reviewer push', () => {
  const d = tmp('wrxn-batch-check-');
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify(artifactReport({ pushed: true })));
  const r = runCli(['dispatch', '--check-report', bad, '--executor', 'reviewer']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /push/i);
});
