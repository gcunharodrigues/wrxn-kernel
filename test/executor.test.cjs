'use strict';

// Tests for the builder-executor dispatch harness (wrxn-kernel-18).
// The kernel ships the executor CONTRACT deterministically: buildDispatchSpec turns a ready-for-agent
// issue into the structured order a thin builder subagent follows (read the tdd skill, build red→green,
// stay isolated, never push); validateReport enforces the structured return + the boundary gates. The
// live LLM execution is out of scope here — the harness is what this proves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { parseIssue, buildDispatchSpec, validateReport } = require('../lib/executor.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

const FIXTURE_ISSUE = [
  '---',
  'id: wrxn-kernel-99',
  'title: "Fixture: add a greeting helper"',
  'status: open',
  'labels: [ready-for-agent]',
  '---',
  '',
  '## What to build',
  '',
  'A greet(name) helper that returns "hello, <name>".',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] greet("world") returns "hello, world"',
  '- [ ] greet("") throws on empty input',
  '',
  '## Blocked by',
  '',
  '- wrxn-kernel-08',
  '',
].join('\n');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function goodReport() {
  return {
    issueId: 'wrxn-kernel-99',
    status: 'completed',
    redTest: true,
    greenCommit: 'abc1234',
    typesClean: true,
    pushed: false,
    summary: 'greet helper built tdd-first',
  };
}

// ── parseIssue ────────────────────────────────────────────────────────────────

test('parseIssue extracts id, title and the acceptance criteria', () => {
  const issue = parseIssue(FIXTURE_ISSUE);
  assert.equal(issue.id, 'wrxn-kernel-99');
  assert.match(issue.title, /greeting helper/);
  assert.equal(issue.acceptanceCriteria.length, 2, 'both ACs parsed');
  assert.match(issue.acceptanceCriteria[0], /hello, world/);
  // The "## Blocked by" bullets must NOT leak into the ACs.
  assert.ok(!issue.acceptanceCriteria.some((a) => /wrxn-kernel-08/.test(a)), 'blocked-by not captured as an AC');
});

// ── buildDispatchSpec (AC-1 tdd order, AC-2 isolation, AC-3 boundary) ─────────

test('buildDispatchSpec orders the tdd skill, isolation and the boundary constraints', () => {
  const spec = buildDispatchSpec(FIXTURE_ISSUE);
  assert.match(spec.skill, /tdd\/SKILL\.md$/, 'points at the real tdd skill file');
  assert.equal(spec.issue.id, 'wrxn-kernel-99');
  assert.ok(spec.acceptanceCriteria.length === 2, 'ACs carried into the spec');
  assert.match(spec.isolation, /fresh/i, 'runs isolated / fresh context (AC-2)');
  const procedure = spec.procedure.join(' ').toLowerCase();
  assert.ok(/red/.test(procedure) && /green/.test(procedure), 'procedure orders red→green tdd (AC-1)');
  const constraints = spec.constraints.join(' ').toLowerCase();
  assert.match(constraints, /push/, 'a no-push boundary constraint (AC-3)');
  assert.match(constraints, /review marker|review-/, 'review-marker-required-downstream constraint (AC-3)');
  assert.ok(Array.isArray(spec.reportSchema.required) && spec.reportSchema.required.includes('greenCommit'),
    'declares the structured report schema (AC-2)');
});

// ── devops push guidance honesty (foundation-honesty-01) ──────────────────────
// Regression: the devops dispatch spec told the agent to push with an INLINE
// `AIOX_ACTIVE_AGENT=devops` assignment — the wrong variable (the push-authority gate
// reads WRXN_ACTIVE_AGENT) AND an inline assignment scopes to the git child, never
// reaching the hook process. The flag must be set in settings.local.json so it reaches
// the gate; otherwise a correctly-dispatched devops push is rejected by the install's own gate.

test('devops dispatch spec authorizes the push via WRXN_ACTIVE_AGENT in settings.local.json', () => {
  const spec = buildDispatchSpec(FIXTURE_ISSUE, 'devops');
  const guidance = JSON.stringify(spec);
  assert.match(guidance, /WRXN_ACTIVE_AGENT/, 'references the variable the push-authority gate actually reads');
  assert.match(guidance, /settings\.local\.json/, 'sets the flag where it reaches the hook process');
  assert.ok(!/AIOX_ACTIVE_AGENT/.test(guidance), 'no legacy variable name');
  assert.ok(!/=devops/.test(guidance), 'no inline command-scoped assignment that never reaches the gate');
});

// ── validateReport (AC-2 structured, AC-1 completion, AC-3 boundary) ──────────

test('validateReport accepts a well-formed completion report', () => {
  const r = validateReport(goodReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReport REJECTS a report that claims a push (boundary gate, AC-3)', () => {
  const r = validateReport({ ...goodReport(), pushed: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /push/i.test(e)), 'flags the boundary violation');
});

test('validateReport REJECTS a completion missing the green commit / red test / types (AC-1)', () => {
  assert.equal(validateReport({ ...goodReport(), greenCommit: '' }).ok, false, 'no green commit');
  assert.equal(validateReport({ ...goodReport(), redTest: false }).ok, false, 'no red test');
  assert.equal(validateReport({ ...goodReport(), typesClean: false }).ok, false, 'types not clean');
});

test('validateReport accepts a blocked report without a green commit', () => {
  const r = validateReport({
    issueId: 'wrxn-kernel-99', status: 'blocked', redTest: false, greenCommit: '',
    typesClean: false, pushed: false, summary: 'blocked: ambiguous AC, escalating',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReport rejects a non-object / missing fields', () => {
  assert.equal(validateReport(null).ok, false);
  assert.equal(validateReport({}).ok, false);
});

// ── CLI (CLI-First) ───────────────────────────────────────────────────────────

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [WRXN, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI: wrxn dispatch <issue> prints a valid JSON dispatch spec', () => {
  const d = tmp('wrxn-exec-cli-');
  const issuePath = path.join(d, 'issue.md');
  fs.writeFileSync(issuePath, FIXTURE_ISSUE);
  const { code, stdout } = runCli(['dispatch', issuePath]);
  assert.equal(code, 0);
  const spec = JSON.parse(stdout);
  assert.equal(spec.issue.id, 'wrxn-kernel-99');
  assert.match(spec.skill, /tdd/);
});

test('CLI: wrxn dispatch --check-report exits 0 on a good report, non-zero on a push violation', () => {
  const d = tmp('wrxn-exec-check-');
  const good = path.join(d, 'good.json');
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(good, JSON.stringify(goodReport()));
  fs.writeFileSync(bad, JSON.stringify({ ...goodReport(), pushed: true }));

  assert.equal(runCli(['dispatch', '--check-report', good]).code, 0);
  const badRun = runCli(['dispatch', '--check-report', bad]);
  assert.notEqual(badRun.code, 0);
  assert.match(badRun.stderr, /push/i);
});
