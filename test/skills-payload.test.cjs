'use strict';

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

// The dev-pipeline skills this track ships into the install payload (tdd is shipped
// by a sibling track; code-review/security-review are global slash-skills with no file).
const PIPELINE_SKILLS = [
  'grill-me',
  'grill-with-docs',
  'to-prd',
  'to-issues',
  'triage',
  'diagnose',
  'handoff',
  'prototype',
  'qa-walk',
  'improve-codebase-architecture',
  'synapse',
  'skill-creator',
  'write-a-skill',
  'tech-search',
  'setup-matt-pocock-skills',
];

// ── skills are listed + invocable in a fresh install ─────────────────────────

test('init lays every pipeline skill with a SKILL.md', () => {
  const target = tmp('wrxn-skills-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  for (const skill of PIPELINE_SKILLS) {
    const skillMd = path.join(target, '.claude', 'skills', skill, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), `.claude/skills/${skill}/SKILL.md not laid`);
  }
});

// ── grill-with-docs is present + parseable (frontmatter) ─────────────────────

test('grill-with-docs SKILL.md is present and parseable', () => {
  const target = tmp('wrxn-grilldocs-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const skillMd = path.join(target, '.claude', 'skills', 'grill-with-docs', 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'grill-with-docs/SKILL.md missing');
  const body = fs.readFileSync(skillMd, 'utf8');
  // a valid skill opens with YAML frontmatter carrying its name
  assert.match(body, /^---/, 'no frontmatter block');
  assert.match(body, /name:\s*grill-with-docs/, 'frontmatter does not name the skill');
});

// ── tracker config: local-markdown .scratch/ convention ──────────────────────

test('issue-tracker.md names the local-markdown .scratch/ convention', () => {
  const target = tmp('wrxn-tracker-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const tracker = path.join(target, 'docs', 'agents', 'issue-tracker.md');
  assert.ok(fs.existsSync(tracker), 'docs/agents/issue-tracker.md not laid');
  const body = fs.readFileSync(tracker, 'utf8');
  assert.match(body, /\.scratch\//, 'tracker does not reference the .scratch/ convention');
});

// ── triage-labels: the 5 canonical role strings ─────────────────────────────

test('triage-labels.md contains the 5 canonical role strings', () => {
  const target = tmp('wrxn-labels-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const labels = path.join(target, 'docs', 'agents', 'triage-labels.md');
  assert.ok(fs.existsSync(labels), 'docs/agents/triage-labels.md not laid');
  const body = fs.readFileSync(labels, 'utf8');
  for (const role of ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']) {
    assert.match(body, new RegExp(role), `missing canonical role "${role}"`);
  }
});

// ── domain doc is laid (single-context layout) ───────────────────────────────

test('domain.md is laid for the install', () => {
  const target = tmp('wrxn-domain-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const domain = path.join(target, 'docs', 'agents', 'domain.md');
  assert.ok(fs.existsSync(domain), 'docs/agents/domain.md not laid');
});

// ── domain doc is honest: no dead-context references (foundation-honesty-05) ──

test('domain.md ships with no dead-context references', () => {
  const target = tmp('wrxn-domain-honest-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const domain = path.join(target, 'docs', 'agents', 'domain.md');
  const body = fs.readFileSync(domain, 'utf8').toLowerCase();
  for (const marker of ['squad', 'aiox-core', 'context-map']) {
    assert.ok(!body.includes(marker), `domain.md must not reference dead context "${marker}"`);
  }
});
