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
const { decide, decideBash } = require(HOOK);

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

// gate-07 review NB: a READ verb near "PRD document" is a safe-direction false positive — don't block it.
test('does not block a READ delegation: "summarize the PRD document" (review NB false positive)', () => {
  const d = decide({ subagent_type: 'general-purpose', prompt: 'Summarize the PRD document for me in two bullets.' });
  assert.equal(d.block, false);
});

test('STILL blocks "write a PRD" delegated to a generic agent (the real block survives the tighten)', () => {
  const d = decide({ subagent_type: 'general-purpose', prompt: 'Write a PRD for the onboarding flow.' });
  assert.equal(d.block, true);
  assert.match(d.reason, /to-prd/);
});

test('STILL blocks "create the PRD document" — a creation verb wins over the read carve-out', () => {
  const d = decide({ subagent_type: 'general-purpose', prompt: 'Create the PRD document for the billing epic.' });
  assert.equal(d.block, true);
  assert.match(d.reason, /to-prd/);
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

test('CLI fails open on a bare JSON null (JSON.parse("null") must not throw past the parse) [gate-07 INFO]', () => {
  assert.deepEqual(runHook('null'), {});
});

test('CLI folds the description field into the keyword scan', () => {
  const event = { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', description: 'write a PRD', prompt: 'go' } };
  const d = runHook(event);
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /to-prd/);
});

// ════════════════════════════════════════════════════════════════════════════════════
// Bash arm (slice #90) — main-thread pipeline-skip detection via the pure `decideBash`.
// agentId ABSENT = main thread (candidate); PRESENT = subagent (the pipeline) -> allow.
// ════════════════════════════════════════════════════════════════════════════════════

test('decideBash warns on a main-thread `gh pr create`, naming wrxn ship', () => {
  const d = decideBash({ command: 'gh pr create --title "x" --body "y"' });
  assert.equal(d.action, 'warn');
  assert.match(d.message, /wrxn ship/);
});

test('decideBash allows any catch command inside a subagent (agentId present = the pipeline)', () => {
  // a typed executor / `wrxn ship` IS the pipeline — caller context, not command text.
  assert.equal(decideBash({ command: 'gh pr create --title x', agentId: 'agent_abc' }).action, 'allow');
});

test('decideBash escalates `gh pr create` to block under WRXN_PIPELINE_GUARD=block', () => {
  const d = decideBash({ command: 'gh pr create --title x', level: 'block' });
  assert.equal(d.action, 'block');
  assert.match(d.message, /wrxn ship/);
});

test('decideBash warns on a main-thread `gh issue create`, naming to-prd / to-issues', () => {
  const d = decideBash({ command: 'gh issue create --title "x" --body "y"' });
  assert.equal(d.action, 'warn');
  assert.match(d.message, /to-prd/);
  assert.match(d.message, /to-issues/);
});

test('decideBash keeps `gh issue create` a WARN even under block (the redirect skills self-trigger it)', () => {
  // to-prd / to-issues / triage run `gh issue create` themselves in the main thread (agent_id absent),
  // so a block would wedge the very skills the warning points to. Locked to warn under every level.
  assert.equal(decideBash({ command: 'gh issue create --title x', level: 'block' }).action, 'warn');
});

test('decideBash warns on a main-thread `gh pr merge` (trunk), naming wrxn ship', () => {
  const d = decideBash({ command: 'gh pr merge 42 --squash' });
  assert.equal(d.action, 'warn');
  assert.match(d.message, /wrxn ship/);
});

test('decideBash blocks `gh pr merge` under block (the CI ruleset gates the trunk, not a manual merge)', () => {
  assert.equal(decideBash({ command: 'gh pr merge 42 --squash', level: 'block' }).action, 'block');
});

// Read-only gh must pass silently — inspecting state is never a pipeline skip.
for (const ro of ['gh issue list', 'gh pr view 42', 'gh pr checks', 'gh pr diff 42', 'gh status', 'gh run list']) {
  test(`decideBash allows read-only gh: \`${ro}\``, () => {
    assert.equal(decideBash({ command: ro }).action, 'allow');
  });
}

// git push — only a TRUNK push is a skip; ordinary feature-branch work passes silently. The argless /
// remote-only push resolves the CURRENT branch via an injected boundary (real default = git rev-parse).
test('decideBash warns on a main-thread trunk `git push origin main`, naming wrxn ship', () => {
  const d = decideBash({ command: 'git push origin main' });
  assert.equal(d.action, 'warn');
  assert.match(d.message, /wrxn ship/);
});

test('decideBash blocks a trunk `git push origin master` under block', () => {
  assert.equal(decideBash({ command: 'git push origin master', level: 'block' }).action, 'block');
});

test('decideBash allows a non-trunk `git push -u origin feature/x`', () => {
  assert.equal(decideBash({ command: 'git push -u origin feature/x' }).action, 'allow');
});

test('decideBash catches a colon-refspec trunk push `git push origin HEAD:main`', () => {
  assert.equal(decideBash({ command: 'git push origin HEAD:main' }).action, 'warn');
});

test('decideBash resolves an argless `git push` to the current branch — trunk -> warn', () => {
  assert.equal(decideBash({ command: 'git push', resolveBranch: () => 'main' }).action, 'warn');
});

test('decideBash resolves an argless `git push` to the current branch — non-trunk -> allow', () => {
  assert.equal(decideBash({ command: 'git push', resolveBranch: () => 'feat/x' }).action, 'allow');
});

test('decideBash resolves a remote-only `git push origin` to the current branch', () => {
  assert.equal(decideBash({ command: 'git push origin', resolveBranch: () => 'master' }).action, 'warn');
});

test('decideBash fails open (allow) when the current branch cannot be resolved', () => {
  assert.equal(decideBash({ command: 'git push', resolveBranch: () => null }).action, 'allow');
});

// Posture knob `off` disables the Bash arm entirely (kill switch) — even a catch command passes.
test('decideBash off kill-switch allows a catch command (`gh pr create`)', () => {
  assert.equal(decideBash({ command: 'gh pr create --title x', level: 'off' }).action, 'allow');
});

test('decideBash off kill-switch allows a trunk push', () => {
  assert.equal(decideBash({ command: 'git push origin main', level: 'off' }).action, 'allow');
});

// fail-open + edge regression locks — the guard never wedges, and unknown postures degrade to warn.
test('decideBash fails open (allow) on a non-string command', () => {
  assert.equal(decideBash({ command: { not: 'a string' } }).action, 'allow');
});

test('decideBash fails open (allow) on a blank command', () => {
  assert.equal(decideBash({ command: '   ' }).action, 'allow');
});

test('decideBash fails open (allow) with no arguments', () => {
  assert.equal(decideBash().action, 'allow');
});

test('decideBash treats an unknown WRXN_PIPELINE_GUARD value as the warn default', () => {
  assert.equal(decideBash({ command: 'gh pr create --title x', level: 'BOGUS' }).action, 'warn');
});

test('decideBash allows an ordinary non-catch main-thread command (git status)', () => {
  assert.equal(decideBash({ command: 'git status' }).action, 'allow');
});

// ── CLI contract for the Bash arm: stdin PreToolUse:Bash -> modern hookSpecificOutput schema ──
// `main()` dispatches on event.tool_name; the discriminator is the snake_case `agent_id` stdin field
// (present only inside a subagent). The posture knob arrives via the WRXN_PIPELINE_GUARD env var.

function runHookBash(input, env) {
  const out = execFileSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
  });
  return out.trim() ? JSON.parse(out) : {};
}

const bashEvent = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });

test('CLI warns (non-blocking allow) on a main-thread Bash `gh pr create`', () => {
  const d = runHookBash(bashEvent('gh pr create --title x'), { WRXN_PIPELINE_GUARD: '' });
  assert.equal(d.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(d.hookSpecificOutput.permissionDecision, 'allow'); // tool still runs
  assert.match(d.hookSpecificOutput.additionalContext, /wrxn ship/);
  assert.match(d.systemMessage, /wrxn ship/);
});

test('CLI denies a main-thread Bash `gh pr create` under WRXN_PIPELINE_GUARD=block', () => {
  const d = runHookBash(bashEvent('gh pr create --title x'), { WRXN_PIPELINE_GUARD: 'block' });
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /wrxn ship/);
});

test('CLI allows (empty) a Bash call inside a subagent — agent_id present, even under block', () => {
  const d = runHookBash(bashEvent('gh pr create --title x', { agent_id: 'agent_123' }), { WRXN_PIPELINE_GUARD: 'block' });
  assert.deepEqual(d, {});
});

test('CLI allows (empty) read-only gh in the main thread', () => {
  assert.deepEqual(runHookBash(bashEvent('gh pr view 42'), { WRXN_PIPELINE_GUARD: '' }), {});
});

test('CLI Bash arm fails open (empty) on malformed stdin', () => {
  assert.deepEqual(runHookBash('{ not json'), {});
});

// Spine beats posture: inside a subagent (agentId present) EVERY catch command is allowed, even under block.
for (const cmd of ['gh issue create --title x', 'gh pr create --title x', 'gh pr merge 42', 'git push origin main']) {
  test(`decideBash allows \`${cmd}\` inside a subagent (agentId present) even under block`, () => {
    assert.equal(decideBash({ command: cmd, agentId: 'agent_x', level: 'block' }).action, 'allow');
  });
}

test('regression (AC#5): the Task-arm decide() + CLI output are unchanged by the Bash arm', () => {
  // HITL delegation to a generic agent still blocks, naming the main-thread skill...
  const blocked = decide({ subagent_type: 'general-purpose', prompt: 'write a PRD for billing' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /to-prd/);
  // ...and a typed executor still passes.
  assert.equal(decide({ subagent_type: 'builder', prompt: 'build the slice per the PRD' }).block, false);
  // the Task arm keeps its LEGACY { decision: 'block', reason } shape — no hookSpecificOutput leakage.
  const prompt = 'write a PRD for the feature';
  const expected = decide({ subagent_type: 'general-purpose', prompt });
  assert.deepEqual(runHook(taskEvent('general-purpose', prompt)), { decision: 'block', reason: expected.reason });
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

test('settings.json wires the guard under a PreToolUse Bash matcher too (slice #90)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'settings.json'), 'utf8'));
  const bashGroups = (cfg.hooks.PreToolUse || []).filter((g) => g.matcher === 'Bash');
  assert.ok(bashGroups.length > 0, 'expected a PreToolUse group with matcher "Bash"');
  const cmds = bashGroups.flatMap((g) => g.hooks.map((h) => h.command));
  const guard = cmds.find((c) => /enforce-pipeline-adherence\.cjs/.test(c));
  assert.ok(guard, 'expected the adherence guard wired under the Bash matcher');
  assert.match(guard, /\$CLAUDE_PROJECT_DIR/);
  assert.ok(cmds.some((c) => /enforce-managed-precommit\.cjs/.test(c)), 'managed-precommit must remain on Bash');
});

test('settings.json keeps the Task matcher entry intact (no-regression, AC#5)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'settings.json'), 'utf8'));
  const taskGroups = (cfg.hooks.PreToolUse || []).filter((g) => g.matcher === 'Task');
  const cmds = taskGroups.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.some((c) => /enforce-pipeline-adherence\.cjs/.test(c)), 'Task matcher must still wire the guard');
});

test('manifest registers the guard as a managed project hook', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/enforce-pipeline-adherence.cjs');
  assert.ok(entry, 'expected the guard in the manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
});
