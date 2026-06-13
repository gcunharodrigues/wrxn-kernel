'use strict';

// Tests for wrxn init --workspace operator layer + the onboard scaffold (wrxn-kernel-20).
// AC-1: init --workspace lays project payload + the operator layer, profile recorded.
// AC-2: the onboard skill's deterministic scaffold actually RUNS in the temp workspace.
// AC-3: decisions log + connections registry are seeded (never overwritten on update).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const { scaffold } = require('../lib/onboard.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function workspaceInstall(p) {
  const target = tmp(p);
  init({ pkgRoot: PKG_ROOT, target, profile: 'workspace' });
  return target;
}
function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

// ── AC-1: init --workspace lays project + operator layer, records the profile ──

test('init --workspace lays the operator layer on top of the project payload', () => {
  const ws = workspaceInstall('wrxn-ws-layer-');
  // project payload still present...
  assert.ok(exists(ws, '.claude/hooks/synapse-engine.cjs'), 'project payload laid');
  // ...plus the operator layer:
  for (const rel of [
    '.claude/skills/onboard/SKILL.md',
    '.claude/skills/audit/SKILL.md',
    '.claude/skills/level-up/SKILL.md',
    'aios-intake.md',
    'decisions/log.md',
    'connections.md',
  ]) {
    assert.ok(exists(ws, rel), `operator-layer file laid: ${rel}`);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(ws, 'wrxn.install.json'), 'utf8'));
  assert.equal(receipt.profile, 'workspace', 'profile recorded in the receipt');
});

test('a project install does NOT lay the operator layer', () => {
  const proj = tmp('wrxn-proj-no-layer-');
  init({ pkgRoot: PKG_ROOT, target: proj, profile: 'project' });
  assert.ok(!exists(proj, 'aios-intake.md'), 'no intake in a project install');
  assert.ok(!exists(proj, '.claude/skills/onboard/SKILL.md'), 'no onboard skill in a project install');
});

// ── AC-2: the onboard scaffold actually RUNS in the workspace ──────────────────

function fillIntake(ws) {
  const p = path.join(ws, 'aios-intake.md');
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace('[Your answer here]', 'I run WRXN, an operator OS for ship-fast AI work.'); // Q1
  // fill Q3 too (priorities)
  t = t.replace('[Your answer here]', 'Ship the kernel to npm; land first external client.'); // Q3 (next placeholder)
  fs.writeFileSync(p, t);
}

test('wrxn onboard scaffolds the Day-1 context set from a filled intake (lib)', () => {
  const ws = workspaceInstall('wrxn-ws-onboard-lib-');
  fillIntake(ws);
  const report = scaffold(ws);
  assert.ok(report.scaffolded.includes(path.join('context', 'about-me.md')), 'about-me scaffolded from Q1');
  const aboutMe = fs.readFileSync(path.join(ws, 'context', 'about-me.md'), 'utf8');
  assert.match(aboutMe, /operator OS/, 'carries the Q1 answer');
});

test('CLI: wrxn onboard runs in the workspace and reports what it scaffolded', () => {
  const ws = workspaceInstall('wrxn-ws-onboard-cli-');
  fillIntake(ws);
  const out = execFileSync('node', [WRXN, 'onboard', '--root', ws], { encoding: 'utf8' });
  assert.match(out, /scaffolded context\/about-me\.md/);
  assert.ok(exists(ws, 'context/about-me.md'), 'context file actually written');
});

test('onboard errors cleanly when there is no intake (project install)', () => {
  const proj = tmp('wrxn-onboard-no-intake-');
  init({ pkgRoot: PKG_ROOT, target: proj, profile: 'project' });
  assert.throws(() => scaffold(proj), /intake/i);
});

test('onboard is idempotent — re-running regenerates context from the current intake', () => {
  const ws = workspaceInstall('wrxn-ws-onboard-idem-');
  fillIntake(ws);
  scaffold(ws);
  const first = fs.readFileSync(path.join(ws, 'context', 'about-me.md'), 'utf8');
  const second = (scaffold(ws), fs.readFileSync(path.join(ws, 'context', 'about-me.md'), 'utf8'));
  assert.equal(first, second, 're-run is stable');
});

// ── AC-3: decisions log + connections seeded, never overwritten on update ──────

test('decisions log + connections survive an update untouched (seeded class)', () => {
  const ws = workspaceInstall('wrxn-ws-seed-');
  // Operator edits the seeded files.
  fs.appendFileSync(path.join(ws, 'decisions', 'log.md'), '\n## 2026-06-13 — my decision\n');
  fs.appendFileSync(path.join(ws, 'connections.md'), '\n| Gmail | Communicate | live | |\n');
  const decBefore = fs.readFileSync(path.join(ws, 'decisions', 'log.md'), 'utf8');
  const connBefore = fs.readFileSync(path.join(ws, 'connections.md'), 'utf8');

  update({ pkgRoot: PKG_ROOT, target: ws });

  assert.equal(fs.readFileSync(path.join(ws, 'decisions', 'log.md'), 'utf8'), decBefore, 'decisions log preserved');
  assert.equal(fs.readFileSync(path.join(ws, 'connections.md'), 'utf8'), connBefore, 'connections preserved');
});
