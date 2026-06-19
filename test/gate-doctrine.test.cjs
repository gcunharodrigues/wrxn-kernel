'use strict';

// gate-redesign gate-04 — the LIVE shipped doctrine matches the PR + CI + auto-merge model (ADR 0007)
// with NO surviving reference to the retired WRXN_ACTIVE_AGENT / settings.local.json env-flag dance.
// The durable regression guard for the repo-wide grep-clean AC on the payload doctrine: constitution
// + synapse (global/routing/pipeline).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PAYLOAD = path.join(__dirname, '..', 'payload');
const read = (rel) => fs.readFileSync(path.join(PAYLOAD, rel), 'utf8');

const DOCTRINE = ['.claude/constitution.md', '.synapse/global', '.synapse/routing', '.synapse/pipeline'];

test('no shipped doctrine references the retired WRXN_ACTIVE_AGENT / settings.local.json dance', () => {
  for (const rel of DOCTRINE) {
    const body = read(rel);
    assert.doesNotMatch(body, /WRXN_ACTIVE_AGENT/, `${rel} still names the retired env flag`);
    assert.doesNotMatch(body, /settings\.local\.json/, `${rel} still names the retired settings.local.json dance`);
  }
});

test('the constitution describes the PR + CI + auto-merge promote model', () => {
  const c = read('.claude/constitution.md');
  assert.match(c, /wrxn ship/, 'Art. I names the `wrxn ship` promote path');
  assert.match(c, /auto-merge/i, 'Art. I describes auto-merge');
  assert.match(c, /\bCI\b/, 'Art. III names CI as the gate');
});

test('the synapse global + routing rules describe the new promote model', () => {
  for (const rel of ['.synapse/global', '.synapse/routing']) {
    assert.match(read(rel), /auto-merge/i, `${rel} must describe the auto-merge promote model`);
  }
});

test('the slice-07 pipeline-adherence rule (PIPELINE_RULE_5) survives', () => {
  const p = read('.synapse/pipeline');
  assert.match(p, /^PIPELINE_RULE_5=/m, 'PIPELINE_RULE_5 must remain');
  assert.match(p, /enforce-pipeline-adherence/, 'it names the adherence hook');
});

// gate-04 retired WRXN_MANAGED_CONFIRM: the managed guard no longer reads it (it is an advisory now,
// the server-side CI managed-integrity check is the teeth). No agent spec may keep telling agents to
// gate a managed-file edit behind that inert token (SEC-LOW-1) — a doctrine-vs-reality contradiction.
const AGENT_SPECS = ['builder', 'devops', 'qa-walker', 'researcher', 'reviewer', 'security']
  .map((n) => `.claude/agents/${n}.md`);

test('no agent spec cites the retired managed-confirm token (gate-04 demoted the guard to advisory)', () => {
  for (const rel of AGENT_SPECS) {
    const body = read(rel);
    assert.doesNotMatch(body, /managed-confirm/i, `${rel} still cites the retired managed-confirm token`);
    assert.doesNotMatch(body, /WRXN_MANAGED_CONFIRM/, `${rel} still names the retired WRXN_MANAGED_CONFIRM flag`);
  }
});
