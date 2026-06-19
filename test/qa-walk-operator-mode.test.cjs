'use strict';

// ── qa-walk operator-mode contract (flow-06) ──────────────────────────────────
//
// ADR 0006 decision 3: the qa-walk skill gains an operator-mode section for the
// human qa-walk (whole assembled artifact vs all PRD stories, story-level) that is
// explicitly distinct from the agent per-slice AC-level walk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('qa-walk SKILL.md has an operator-mode section', () => {
  const target = tmp('wrxn-qa-walk-opmode-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const skillMd = path.join(target, '.claude', 'skills', 'qa-walk', 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'qa-walk/SKILL.md not laid');
  const body = fs.readFileSync(skillMd, 'utf8');

  // must have a dedicated operator-mode heading
  assert.match(body, /operator.mode/i, 'qa-walk/SKILL.md missing an operator-mode section');
});

test('qa-walk operator-mode section names the whole-artifact / all-PRD-stories scope', () => {
  const target = tmp('wrxn-qa-walk-scope-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const body = fs.readFileSync(
    path.join(target, '.claude', 'skills', 'qa-walk', 'SKILL.md'),
    'utf8'
  );

  assert.match(body, /whole assembled artifact/i,
    'operator-mode must name "whole assembled artifact"');
  assert.match(body, /all PRD stories/i,
    'operator-mode must name "all PRD stories"');
  assert.match(body, /story.level/i,
    'operator-mode must be described as story-level');
});

test('qa-walk operator-mode section contrasts with the agent per-slice AC-level walk', () => {
  const target = tmp('wrxn-qa-walk-contrast-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const body = fs.readFileSync(
    path.join(target, '.claude', 'skills', 'qa-walk', 'SKILL.md'),
    'utf8'
  );

  // must make the per-slice / AC-level distinction explicit
  assert.match(body, /per.slice/i,
    'operator-mode must contrast with per-slice agent walk');
  assert.match(body, /AC.level|acceptance.criteri/i,
    'operator-mode must contrast with AC-level walk');
});

test('qa-walk operator-mode section states findings are filed as tracker issues', () => {
  const target = tmp('wrxn-qa-walk-findings-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const body = fs.readFileSync(
    path.join(target, '.claude', 'skills', 'qa-walk', 'SKILL.md'),
    'utf8'
  );

  assert.match(body, /tracker issue|filed.*issue|issue.*filed/i,
    'operator-mode must state that findings are filed as tracker issues');
});
