'use strict';

// Tests for the pipeline-adherence guard hook (gate-07) — the meta-fix that stops the orchestrator
// silently skipping the pipeline by delegating a HITL step (PRD / issues / grill / verticality) to a
// non-typed agent (esp. general-purpose). Mirrors the kernel seam style: `decide` is a PURE function
// unit-tested directly (prior art test/hooks-boundary.test.cjs); the CLI is exercised black-box
// (stdin -> stdout JSON) like the other enforce-*.cjs hooks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const HOOK = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'enforce-pipeline-adherence.cjs');
const { decide } = require(HOOK);

// Run the hook as a real process (stdin -> stdout JSON), like test/hooks-boundary.test.cjs.
function runHook(input) {
  const out = execFileSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : {};
}

const taskEvent = (subagent_type, prompt) => ({ tool_name: 'Task', tool_input: { subagent_type, prompt } });

// ── decision function: blocks HITL-delegation to a non-typed agent ────────────────────

test('blocks general-purpose spawned to write a PRD, naming to-prd', () => {
  const d = decide({ subagent_type: 'general-purpose', prompt: 'Please write a PRD for the new billing feature.' });
  assert.equal(d.block, true);
  assert.match(d.reason, /to-prd/);
  assert.match(d.reason, /main thread/i);
});

test('allows the builder executor even when its prompt references the PRD', () => {
  const d = decide({
    subagent_type: 'builder',
    prompt: 'Build slice gate-07 per the PRD acceptance criteria; write a failing test first.',
  });
  assert.equal(d.block, false);
});

test('blocks general-purpose spawned to break the work into issues, naming to-issues', () => {
  const d = decide({
    subagent_type: 'general-purpose',
    prompt: 'Take this PRD and break it down into vertical-slice issues for the tracker.',
  });
  assert.equal(d.block, true);
  assert.match(d.reason, /to-issues/);
});

test('blocks general-purpose spawned to grill an idea, naming grill', () => {
  const d = decide({
    subagent_type: 'general-purpose',
    prompt: 'Grill this product idea with me and surface the hidden assumptions.',
  });
  assert.equal(d.block, true);
  assert.match(d.reason, /grill/);
});

test('blocks general-purpose spawned to run the verticality gate, naming a main-thread skill', () => {
  const d = decide({
    subagent_type: 'general-purpose',
    prompt: 'Run the verticality review on these issues before we build.',
  });
  assert.equal(d.block, true);
  assert.match(d.reason, /to-issues/); // the verticality gate is run over the to-issues output
});

// ── allow guards (regression locks) ───────────────────────────────────────────────────

for (const type of ['builder', 'reviewer', 'security', 'qa-walker', 'researcher', 'devops']) {
  test(`allows the typed executor ${type} even on a HITL-keyword prompt`, () => {
    const d = decide({ subagent_type: type, prompt: 'write a PRD and break it into issues, grill, verticality' });
    assert.equal(d.block, false);
  });
}

test('allows a non-HITL generic spawn (no pipeline keyword)', () => {
  const d = decide({
    subagent_type: 'general-purpose',
    prompt: 'Refactor the markdown table parser and fix the off-by-one in the column splitter.',
  });
  assert.equal(d.block, false);
});

test('does not block "summarize the PRD.md" — no creation verb near PRD', () => {
  const d = decide({ subagent_type: 'general-purpose', prompt: 'Read and summarize the PRD.md file in two sentences.' });
  assert.equal(d.block, false);
});

// ── fail open on malformed / partial input ────────────────────────────────────────────

test('fails open on an empty object', () => {
  assert.equal(decide({}).block, false);
});

test('fails open with no arguments', () => {
  assert.equal(decide().block, false);
});

test('fails open when subagent_type is missing (partial event)', () => {
  assert.equal(decide({ prompt: 'write a PRD' }).block, false);
});

test('fails open when prompt is non-string', () => {
  assert.equal(decide({ subagent_type: 'general-purpose', prompt: { not: 'a string' } }).block, false);
});

// ── CLI contract (stdin -> stdout), the shape Claude Code consumes for a PreToolUse deny ──

test('CLI emits a block decision for a HITL-delegation Task spawn', () => {
  const d = runHook(taskEvent('general-purpose', 'write a PRD for the feature'));
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /to-prd/);
});

test('CLI allows a typed-executor Task spawn (empty decision)', () => {
  assert.deepEqual(runHook(taskEvent('builder', 'build the slice per the PRD')), {});
});

test('CLI ignores a non-Task tool (defensive short-circuit)', () => {
  const event = { tool_name: 'Bash', tool_input: { command: 'echo write a PRD' } };
  assert.deepEqual(runHook(event), {});
});

test('CLI fails open on malformed stdin', () => {
  assert.deepEqual(runHook('{ not json'), {});
});

test('CLI folds the description field into the keyword scan', () => {
  const event = { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', description: 'write a PRD', prompt: 'go' } };
  const d = runHook(event);
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /to-prd/);
});

// ── wiring: settings.json (PreToolUse:Task) + manifest (managed/project) ───────────────

test('settings.json wires the guard under a PreToolUse Task matcher', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'settings.json'), 'utf8'));
  const taskGroups = (cfg.hooks.PreToolUse || []).filter((g) => g.matcher === 'Task');
  assert.ok(taskGroups.length > 0, 'expected a PreToolUse group with matcher "Task"');
  const cmds = taskGroups.flatMap((g) => g.hooks.map((h) => h.command));
  const guard = cmds.find((c) => /enforce-pipeline-adherence\.cjs/.test(c));
  assert.ok(guard, 'expected the adherence guard wired under the Task matcher');
  assert.match(guard, /\$CLAUDE_PROJECT_DIR/);
});

test('manifest registers the guard as a managed project hook', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/enforce-pipeline-adherence.cjs');
  assert.ok(entry, 'expected the guard in the manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
});
