#!/usr/bin/env node
'use strict';

// WRXN managed hook — pipeline-adherence guard (gate-07, the meta-fix).
// Blocks the orchestrator from silently skipping the pipeline by delegating a HITL step
// (PRD / break-into-issues / grill / verticality) to a NON-typed agent (esp. general-purpose).
// The 2026-06-19 incident proved soft doctrine is insufficient — the [PIPELINE] rule was injected
// and skipped anyway — so this is the hard speedbump that points the orchestrator back to the
// right main-thread skill.
//
// AC-1 — HOOK EVENT DETERMINATION: PreToolUse:Task.
//   Claude Code matches PreToolUse matchers against the TOOL NAME, and `Task` (the subagent-spawn
//   tool) is a matchable tool name, so a `PreToolUse` entry with matcher `Task` fires BEFORE a
//   subagent is spawned — the seam we need. This mirrors the existing PreToolUse:Bash wiring in
//   payload/.claude/settings.json (same event, different matcher). The fallback (a UserPromptSubmit
//   doctrine nudge keyed to the same heuristic) is unnecessary because the Task matcher fires. The
//   decision is event-independent: `decide()` is a pure function unit-tested apart from stdin.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any parse error / missing field emits {} — the hook NEVER wedges a session.
//
// Contract: PreToolUse event JSON on stdin -> decision JSON on stdout (exit 0).
//   allow -> {}        block -> { "decision": "block", "reason": "..." }

const fs = require('fs');

// The six typed executors (mirrors lib/executor.cjs EXECUTORS keys — hardcoded here because the hook
// is self-contained and cannot import the kernel lib). These ARE the pipeline; they are always allowed
// (a builder's prompt may legitimately reference "the PRD"), so they never trip the guard.
const TYPED_EXECUTORS = new Set(['builder', 'reviewer', 'security', 'qa-walker', 'researcher', 'devops']);

// The HITL step the orchestrator must keep in the main thread, and the skill that owns it.
// `re` matches the delegation prompt; on a match for a non-typed agent the spawn is blocked.
const HITL_STEPS = [
  {
    skill: 'to-prd',
    // Block delegating PRD CREATION. Two ways to match:
    //   1. a creation verb within range BEFORE "PRD" (write/create/draft a PRD …), OR
    //   2. a "PRD document/doc" mention — but NOT when a READ verb (summarize/read/review/list/
    //      explain/open/show) sits just before it, which is a safe read, not a creation (gate-07 NB).
    // A creation verb still wins via branch 1, so "create the PRD document" stays blocked.
    re: /\b(writ\w*|creat\w*|draft\w*|author\w*|produc\w*|generat\w*|prepar\w*|build\w*|put together)\b[\s\S]{0,40}\bPRD\b|(?<!\b(?:summar\w*|read\w*|review\w*|list\w*|explain\w*|open\w*|show\w*)\b[\s\S]{0,40})\bPRD\b[\s\S]{0,25}\b(document|doc)\b/i,
  },
  {
    skill: 'to-issues',
    // a decompose verb within range of "issue(s)", or the bare "into issues" / "issue breakdown"
    re: /\b(break|split|carve|decompos\w*|slic\w*|turn|convert|chop)\b[\s\S]{0,60}\bissues?\b|\binto\s+issues?\b|\bissue\s+breakdown\b/i,
  },
  {
    skill: 'grill',
    re: /\bgrill(?:ing|ed|s)?\b/i,
  },
  {
    skill: 'to-issues', // the verticality gate is run in the main thread over the to-issues output
    re: /\bverticalit\w*\b|\bverticality\s+(gate|review)\b/i,
  },
];

function reasonFor(skills) {
  const list = [...new Set(skills)].join(' / ');
  return (
    `Blocked: this spawn delegates a HITL pipeline step to a non-typed agent. ` +
    `HITL steps (PRD, issues, grill, verticality) are decided in the MAIN THREAD with the operator — ` +
    `delegating one to a generic subagent silently skips the pipeline (the 2026-06-19 error). ` +
    `Use ${list} in the main thread.`
  );
}

// PURE: { subagent_type, prompt } -> { block, reason? }. Unit-tested directly (no stdin).
function decide({ subagent_type, prompt } = {}) {
  const type = typeof subagent_type === 'string' ? subagent_type.trim() : '';
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text) return { block: false }; // missing prompt -> fail open
  if (!type) return { block: false }; // no agent type -> partial event -> fail open
  if (TYPED_EXECUTORS.has(type)) return { block: false }; // a typed executor IS the pipeline

  const skills = HITL_STEPS.filter((s) => s.re.test(text)).map((s) => s.skill);
  if (skills.length === 0) return { block: false };

  return { block: true, reason: reasonFor(skills) };
}

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    return emit({}); // unparseable -> fail open
  }

  // JSON.parse("null") (and bare scalars) parse WITHOUT throwing, so a null/non-object event would
  // reach event.tool_name and throw uncaught past the try. Guard it -> fail open. (gate-07 INFO)
  if (!event || typeof event !== 'object') return emit({});

  // Only gate the Task (subagent-spawn) tool; anything else -> allow.
  if (event.tool_name && event.tool_name !== 'Task') return emit({});

  const ti = event.tool_input || {};
  const prompt = [ti.prompt, ti.description].filter((s) => typeof s === 'string').join('\n');
  const d = decide({ subagent_type: ti.subagent_type, prompt });
  if (!d.block) return emit({});

  return emit({ decision: 'block', reason: d.reason });
}

if (require.main === module) {
  main();
}

module.exports = { decide };
