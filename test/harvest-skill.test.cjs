'use strict';

// harvest-06 (H6) — the operator-facing harvest skill that ties the loop together (check → propose →
// confirm) plus kernel ADR 0005 + the CONTEXT.md glossary additions. These tests pin the TESTABLE parts:
// the skill ships + is laid + is registered managed/project (mirroring the sibling dream entry), the skill
// drives the REAL harvest.cjs verbs by their actual CLI surface (not a paraphrase), the merge reflection
// rubric is explicit, and the docs (ADR 0005 + CONTEXT glossary) carry their key content. The adapter
// logic itself lives in H2/H3/H4 (harvest.cjs) — H6 integrates + documents, it does not re-implement.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const SKILL_REL = '.claude/skills/harvest/SKILL.md';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function skillBody() {
  return fs.readFileSync(path.join(PKG_ROOT, 'payload', SKILL_REL), 'utf8');
}

// ── AC1: the skill ships, a project init lays it, and it is registered managed/project ──

test('AC1 the harvest skill ships in the payload + a project init lays it', () => {
  assert.ok(fs.existsSync(path.join(PKG_ROOT, 'payload', SKILL_REL)), 'payload harvest SKILL.md missing');
  const target = tmp('wrxn-harvest-skill-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(fs.existsSync(path.join(target, SKILL_REL)), 'init did not lay the harvest skill');
});

test('AC1 the harvest SKILL.md is parseable + names itself + is operator-invocable', () => {
  const body = skillBody();
  assert.match(body, /^---/, 'no frontmatter block');
  assert.match(body, /name:\s*harvest/, 'frontmatter does not name the skill');
  assert.match(body, /user-invocable:\s*true/, 'skill is not operator-invocable');
});

test('AC1 the harvest skill is registered managed/project, mirroring the dream entry', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === SKILL_REL);
  assert.ok(entry, 'harvest skill absent from manifest');
  assert.equal(entry.class, 'managed', 'harvest skill must be class: managed');
  // mirror the sibling dream skill entry exactly (class + profile)
  const dream = manifest.files.find((f) => f.path === '.claude/skills/dream/SKILL.md');
  assert.ok(dream, 'dream skill entry missing (the mirror reference)');
  assert.equal(entry.profile, dream.profile, 'harvest skill profile must match dream');
  assert.equal(entry.profile, 'project', 'harvest skill profile must be project');
});

// ── AC2: the skill drives the REAL adapter verbs by their actual CLI surface (not a paraphrase) ──

test('AC2 the skill drives the real harvest.cjs verbs by their actual CLI surface', () => {
  const body = skillBody();
  assert.match(body, /node \.wrxn\/harvest\.cjs check/, 'does not drive the real `check` verb');
  assert.match(body, /node \.wrxn\/harvest\.cjs stage/, 'does not drive the real `stage` verb');
  assert.match(body, /node \.wrxn\/harvest\.cjs commit/, 'does not drive the real `commit` verb');
  assert.match(body, /node \.wrxn\/harvest\.cjs decay propose/, 'does not drive the real `decay propose` verb');
  assert.match(body, /node \.wrxn\/harvest\.cjs decay confirm/, 'does not drive the real `decay confirm` verb');
});

// ── AC3: the merge reflection rubric is explicit in the skill ──

test('AC3 the skill carries an explicit merge reflection rubric', () => {
  const body = skillBody();
  assert.match(body, /reflection/i, 'no reflection rubric section');
  assert.match(body, /traces to a source page/i, 'rubric does not require every survivor line to trace to a source page');
  assert.match(body, /no invented facts/i, 'rubric does not forbid invented facts');
  assert.match(body, /no dropped facts/i, 'rubric does not forbid dropped facts');
  assert.match(body, /union of evidence/i, 'rubric does not require the union of evidence be preserved');
});

// ── AC4: kernel ADR 0005 + the CONTEXT.md glossary additions ──

test('AC4 kernel ADR 0005 documents the harvest curation loop', () => {
  const adr = path.join(PKG_ROOT, 'docs', 'adr', '0005-harvest-curation-loop.md');
  assert.ok(fs.existsSync(adr), 'ADR 0005 missing');
  const body = fs.readFileSync(adr, 'utf8');
  assert.match(body, /merge-then-delete/i, 'ADR does not explain merge-then-delete as the only sanctioned deletion');
  assert.match(body, /propose.{0,3}confirm/i, 'ADR does not explain propose→confirm');
  assert.match(body, /by.reference/i, 'ADR does not explain commit-by-reference');
  assert.match(body, /session.capture/i, 'ADR does not explain why session-capture was retired for handoff-dream');
});

test('AC4 CONTEXT.md gains the harvest glossary terms', () => {
  const ctx = fs.readFileSync(path.join(PKG_ROOT, 'CONTEXT.md'), 'utf8');
  assert.match(ctx, /\*\*harvest\*\*/, 'no **harvest** glossary term');
  assert.match(ctx, /\*\*Health-check\*\*/, 'no **Health-check** glossary term');
  assert.match(ctx, /\*\*Decay\*\*/, 'no **Decay** glossary term');
  assert.match(ctx, /\*\*Reinforcement\*\*/, 'no **Reinforcement** glossary term');
});
