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

// ── synapse skill tells the truth about the real engine (regression guard) ───
//
// The synapse skill once documented a DELETED architecture — an 8-layer pipeline,
// star-commands, context brackets, squads, aiox-core/aiox-pro modules, and a `.js`
// engine file. The real engine (.claude/hooks/synapse-engine.cjs) is three layers
// (L0 constitution / L1 always-on / L6 keyword-recall) plus one flat token budget
// and a non-blocking handoff directive. This guard fails the build if any
// deleted-architecture marker reappears in ANY shipped synapse skill file, so the
// lie cannot return on a future install.

test('the shipped synapse skill carries no deleted-architecture markers', () => {
  const target = tmp('wrxn-synapse-truth-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  // every markdown file the install actually ships under the synapse skill
  const skillDir = path.join(target, '.claude', 'skills', 'synapse');
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) files.push(p);
    }
  })(skillDir);
  assert.ok(files.length > 0, 'no synapse skill files were laid');

  // literal substrings from the deleted design (matched case-insensitively)
  const FORBIDDEN_LITERALS = [
    '8-layer',
    'star-command',
    '*synapse',
    '*brief',
    '*dev',
    'squad',
    'aiox-core',
    'aiox-pro',
    'synapse-engine.js',
  ];
  // the 4 deleted context-bracket NAMES. Matched as WHOLE-WORD, UPPERCASE tokens — the deleted
  // design always wrote them uppercase (e.g. "[CONTEXT BRACKET: MODERATE]", "→ FRESH"), so this
  // catches every regression while NOT banning the ordinary English words. That matters: the real
  // engine's own handoff directive emits "open a fresh session", and "critical" is common prose —
  // a case-insensitive ban here would punish accurate documentation.
  const FORBIDDEN_BRACKETS = ['FRESH', 'MODERATE', 'DEPLETED', 'CRITICAL'];

  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8');
    const lower = body.toLowerCase();
    const rel = path.relative(target, file);
    for (const marker of FORBIDDEN_LITERALS) {
      assert.ok(
        !lower.includes(marker.toLowerCase()),
        `${rel} contains deleted-architecture marker "${marker}"`
      );
    }
    for (const name of FORBIDDEN_BRACKETS) {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(body),
        `${rel} contains deleted context-bracket "${name}"`
      );
    }
  }
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

// ── routing seed is honest: no devops-role authority wording (foundation-honesty-06) ──
//
// The seeded `routing` domain once asserted that git push "goes through the devops role only" —
// a fictional authority (the real gate is a self-toggled confirmation flag). This guards the seed
// from regressing back to the role-authority framing on a future install.

test('routing seed ships with no devops-role authority wording', () => {
  const target = tmp('wrxn-routing-honest-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const routing = path.join(target, '.synapse', 'routing');
  const body = fs.readFileSync(routing, 'utf8');
  assert.equal(body.toLowerCase().includes('devops role'), false, 'routing must not assert a fictional "devops role" authority');
  assert.match(body, /^ROUTING_RULE_0=/m, 'routing still defines ROUTING_RULE_0');
});
