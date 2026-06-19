'use strict';

// Tests for the compass coverage guard (flow-04). compass/SKILL.md carries a static ```buckets``` block
// routing every installed skill to a flow bucket; the runtime live-read is the resilience layer, this is
// the drift-guard on the static map. These prove the map can't silently fall behind a newly-added skill
// (orphan), and that the single skill-creation route points at write-a-skill (skill-creator legacy).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { parseBuckets, compassCoverage } = require('../lib/compass-coverage.cjs');
const SKILLS_DIR = path.join(PKG_ROOT, 'payload', '.claude', 'skills');
const COMPASS = path.join(SKILLS_DIR, 'compass', 'SKILL.md');

function installedSkills() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function compassMd() {
  return fs.readFileSync(COMPASS, 'utf8');
}

// ── coverage: no installed skill is left unrouted (Seam 1c) ───────────────────

test('every installed skill is routed to a compass bucket (no orphan)', () => {
  const buckets = parseBuckets(compassMd());
  const r = compassCoverage(installedSkills(), buckets);
  assert.equal(r.ok, true, `unrouted skills: ${r.orphans.join(', ')}`);
});

test('a skill absent from every bucket is reported as an orphan', () => {
  const buckets = parseBuckets(compassMd());
  const r = compassCoverage([...installedSkills(), 'synthetic-unrouted-skill'], buckets);
  assert.equal(r.ok, false);
  assert.ok(r.orphans.includes('synthetic-unrouted-skill'), 'names the orphan skill');
});

// ── routing doctrine: one skill-creation route, skill-creator legacy ──────────

test('"create a skill" routes to write-a-skill only; skill-creator is marked legacy', () => {
  const md = compassMd();
  assert.match(md, /create a skill\b[\s\S]{0,60}?write-a-skill/i, 'create-a-skill route names write-a-skill');
  assert.match(md, /skill-creator[\s\S]{0,40}?\blegacy\b/i, 'skill-creator marked legacy');
});
