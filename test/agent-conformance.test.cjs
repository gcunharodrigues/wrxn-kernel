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
const { validateAgentFile } = require('../lib/agent-conformance.cjs');
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
