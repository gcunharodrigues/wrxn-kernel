'use strict';

// Tests for agent-contract conformance (wrxn-kernel flow-redesign flow-02).
// The kernel ships the executor CONTRACT (lib/executor.cjs); the native subagents in
// .claude/agents/ are THIN WRAPPERS of it. validateAgentFile confirms an executor agent
// definition is a faithful wrapper for its type: it declares least-privilege tools, a model,
// and an output contract that EQUALS that type's reportSchema (EXECUTORS[type].required).
// Pure transform — no live LLM. An agent .md declares its output contract in a fenced
// ```output-contract block (one required report field per line); the validator accepts the
// raw markdown OR a pre-parsed { tools, model, outputContract } object so it is unit-testable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { validateAgentFile, parseAgentFile } = require('../lib/agent-conformance.cjs');
const { EXECUTORS } = require('../lib/executor.cjs');

// A conforming builder definition (pre-parsed): least-priv tools, a model, and an output
// contract equal to the builder reportSchema.
function goodBuilderDef() {
  return {
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    model: 'opus',
    outputContract: [...EXECUTORS.builder.required],
  };
}

// ── conforming case ───────────────────────────────────────────────────────────

test('validateAgentFile accepts a conforming builder definition', () => {
  const r = validateAgentFile(goodBuilderDef(), 'builder');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── failure modes ───────────────────────────────────────────────────────────

test('validateAgentFile REJECTS an agent that declares no tools', () => {
  const r = validateAgentFile({ ...goodBuilderDef(), tools: [] }, 'builder');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /tools/i.test(e)), 'flags the missing tools allowlist');
});

test('validateAgentFile REJECTS an agent that declares no model', () => {
  const def = goodBuilderDef();
  delete def.model;
  const r = validateAgentFile(def, 'builder');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /model/i.test(e)), 'flags the missing model');
});

test('validateAgentFile REJECTS an output contract that does not equal the reportSchema', () => {
  // a field missing from the declared contract
  const missing = validateAgentFile(
    { ...goodBuilderDef(), outputContract: EXECUTORS.builder.required.slice(0, -1) },
    'builder'
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => /output contract/i.test(e)), 'flags a short contract');

  // an EXTRA field the schema does not require (over-declaration is non-conforming too)
  const extra = validateAgentFile(
    { ...goodBuilderDef(), outputContract: [...EXECUTORS.builder.required, 'pushedTwice'] },
    'builder'
  );
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((e) => /output contract/i.test(e)), 'flags an over-declared contract');
});

test('validateAgentFile REJECTS an unknown executor type', () => {
  const r = validateAgentFile(goodBuilderDef(), 'wizard');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown executor type/i.test(e)), 'flags the unknown type');
});

// ── the SHIPPED builder agent conforms (end-to-end, parsed from raw markdown) ──

test('the shipped payload/.claude/agents/builder.md passes validateAgentFile(..., builder)', () => {
  const builderMd = path.join(PKG_ROOT, 'payload', '.claude', 'agents', 'builder.md');
  assert.ok(fs.existsSync(builderMd), 'payload/.claude/agents/builder.md not shipped');
  const raw = fs.readFileSync(builderMd, 'utf8');
  const r = validateAgentFile(raw, 'builder');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

// ── the SHIPPED remaining five conform to their type, with the locked-fleet model ──
// (flow-03). builder is covered above; each of these is a thin wrapper of EXECUTORS[type]:
// it parses, declares a least-privilege tools allowlist + the fleet model, and its output
// contract set-equals that type's reportSchema.
const agentFile = (type) => path.join(PKG_ROOT, 'payload', '.claude', 'agents', `${type}.md`);
const FLEET = [
  { type: 'reviewer', model: 'opus' },
  { type: 'security', model: 'opus' },
  { type: 'qa-walker', model: 'sonnet' },
  { type: 'researcher', model: 'sonnet' },
  { type: 'devops', model: 'sonnet' },
];

for (const { type, model } of FLEET) {
  test(`the shipped payload/.claude/agents/${type}.md passes validateAgentFile(..., '${type}')`, () => {
    const file = agentFile(type);
    assert.ok(fs.existsSync(file), `payload/.claude/agents/${type}.md not shipped`);
    const raw = fs.readFileSync(file, 'utf8');

    const r = validateAgentFile(raw, type);
    assert.equal(r.ok, true, JSON.stringify(r.errors));

    // declares a (non-empty) least-privilege tools allowlist + the locked-fleet model
    const parsed = parseAgentFile(raw);
    assert.ok(parsed.tools.length > 0, `${type} declares no tools`);
    assert.equal(parsed.model, model, `${type} model must be ${model}`);
  });
}

// ── least-privilege: only devops may push (the locked fleet's canPush) ──────────
// Pins the push capability across the whole fleet so granting push to any other executor
// (in EXECUTORS) trips the suite. Seam 1a: an over-privileged fleet fails.
test('least-privilege: only the devops executor declares push capability (canPush)', () => {
  for (const { type } of FLEET) {
    if (type === 'devops') continue;
    assert.equal(EXECUTORS[type].canPush, false, `${type} must NOT declare push capability`);
  }
  assert.equal(EXECUTORS.builder.canPush, false, 'builder must NOT declare push capability');
  assert.equal(EXECUTORS.devops.canPush, true, 'only devops declares push capability');
});

// ── devops promotes via `wrxn ship`, not the retired env-flag dance (gate-03) ─────
// The WRXN_ACTIVE_AGENT / settings.local.json gate was proven a live no-op (2026-06-19 audit F1);
// devops now promotes via one `wrxn ship` (push → PR → auto-merge) with zero env flags.
test('devops promotes via `wrxn ship` (PR + auto-merge), with NO WRXN_ACTIVE_AGENT / settings.local.json dance', () => {
  const body = (type) => fs.readFileSync(agentFile(type), 'utf8');
  const devops = body('devops');
  assert.match(devops, /wrxn ship/, 'devops must promote via the `wrxn ship` command');
  assert.doesNotMatch(devops, /WRXN_ACTIVE_AGENT/, 'the retired env-flag must be gone (audit F1: a live no-op)');
  assert.doesNotMatch(devops, /settings\.local\.json/, 'the settings.local.json dance must be gone');
  for (const { type } of FLEET) {
    if (type === 'devops') continue;
    assert.match(body(type), /never .*push/i, `${type} body must state it never pushes`);
  }
});
