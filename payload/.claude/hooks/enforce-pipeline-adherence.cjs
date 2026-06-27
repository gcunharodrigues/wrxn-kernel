#!/usr/bin/env node
'use strict';

// WRXN managed hook — pipeline-adherence guard (gate-07, the meta-fix).
// Blocks the orchestrator from silently skipping the pipeline by delegating a HITL step
// (PRD / break-into-issues / grill / verticality) to a NON-typed agent (esp. general-purpose).
// The 2026-06-19 incident proved soft doctrine is insufficient — the [PIPELINE] rule was injected
// and skipped anyway — so this is the hard speedbump that points the orchestrator back to the
// right main-thread skill.
//
// SLICE #90 adds a second arm: a PreToolUse:Bash guard that catches a MAIN-THREAD skip — a
// pipeline-bypassing shell command (gh issue/pr create, gh pr merge, trunk git push) run directly
// in the main thread — and warns (default) or blocks (env knob) with the same redirect-to-skill
// intent. Caller context (the `agent_id` stdin field) separates a skip from the identical command
// run legitimately inside a typed-executor subagent. (ADR 0009.)
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
// Contract: PreToolUse event JSON on stdin -> decision JSON on stdout (exit 0). main() dispatches on
// tool_name:
//   Task (delegation skip): allow -> {}   block -> { "decision": "block", "reason": "..." }  (legacy)
//   Bash (main-thread skip): allow -> {}   warn/block -> { "hookSpecificOutput": { ... } }    (modern)

const fs = require('fs');
const { execFileSync } = require('child_process');

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

// ── Bash arm (slice #90) — main-thread pipeline-skip detection ─────────────────────────
// The Task arm above catches a DELEGATION skip (a HITL step handed to a non-typed agent).
// This arm catches a MAIN-THREAD skip: the operator/assistant running a pipeline-bypassing
// command directly (no Task spawn to intercept). The discriminator is CALLER CONTEXT, not the
// command text: every legitimate pipeline mechanic (devops -> `wrxn ship`; all AFK executors)
// runs inside a typed-executor SUBAGENT and so carries `agent_id` on the PreToolUse stdin —
// auto-allowed. Only main-thread ops (`agent_id` absent) are candidates. (ADR 0009.)

const SKILL_SPEC = 'to-prd / to-issues'; // the issue-filing pipeline skills
const SKILL_SHIP = 'wrxn ship / the devops executor'; // the promotion pipeline path

function bashMessage(verb, skill) {
  return (
    `Pipeline guard: running \`${verb}\` directly in the main thread bypasses the build pipeline. ` +
    `Use ${skill} instead — the pipeline (and the server-side CI ruleset) is the gate, ` +
    `not a manual main-thread command.`
  );
}

function isTrunk(name) {
  return name === 'main' || name === 'master';
}

// Normalize a `git push` target to a bare branch name before the trunk compare. Handles the refspec
// forms that would otherwise evade the catch: a colon refspec (local:remote) targets the REMOTE side
// (after the last ':'); a leading `+` is the force marker; `refs/heads/` is the fully-qualified prefix.
// So `+main`, `refs/heads/main`, `+refs/heads/main`, `HEAD:main` all normalize to `main`. (security S2.)
function normalizeRef(token) {
  let ref = token.includes(':') ? token.split(':').pop() : token;
  ref = ref.replace(/^\+/, ''); // strip a leading force marker
  ref = ref.replace(/^refs\/heads\//, ''); // strip a fully-qualified branch prefix
  return ref;
}

// Guarded, READ-ONLY shell-out: resolve the current branch for an argless / remote-only `git push`.
// Any failure -> null, and the caller fails open to allow. This is the only side-effecting path; it
// is injected into `decideBash` (default below) so every unit test drives it without spawning git.
function currentBranch() {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Does this `git push` land on the trunk? Only a trunk push is a skip; feature-branch work is normal.
function pushesToTrunk(cmd, resolveBranch) {
  // Bounded ranges (not unbounded `[\s\S]*?`) keep this linear on the hot path. (security S1.)
  const m = cmd.match(/\bgit\b[\s\S]{0,80}\bpush\b([\s\S]*)/);
  const rest = m ? m[1] : '';
  const positionals = rest.split(/\s+/).filter((t) => t && !t.startsWith('-'));
  const refs = positionals.map(normalizeRef); // normalize force / fully-qualified / colon refspecs
  if (refs.some(isTrunk)) return true; // an explicit main/master ref (any refspec form)
  if (positionals.length >= 2) return false; // an explicit non-trunk branch was named
  // no branch named (argless or remote-only) -> resolve the current branch
  let branch = null;
  try {
    branch = resolveBranch();
  } catch {
    branch = null;
  }
  return branch ? isTrunk(branch) : false; // unresolvable -> fail open (allow)
}

// PURE: { command, agentId, level } -> { action: 'allow'|'warn'|'block', skill?, message? }.
// Unit-tested apart from stdin (mirrors the Task arm's `decide()` seam). `resolveBranch` is an
// injected boundary (defaults to a guarded `git rev-parse`) so the argless-push path stays testable.
function decideBash({ command, agentId, level, resolveBranch = currentBranch } = {}) {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return { action: 'allow' }; // missing command -> fail open

  if (agentId) return { action: 'allow' }; // spine: present = subagent = the pipeline -> allow

  // Posture knob (default/unknown -> warn). `off` disables the Bash arm entirely (kill switch);
  // the Task arm is never gated by the knob.
  const raw = typeof level === 'string' ? level.trim().toLowerCase() : '';
  const lvl = raw === 'block' || raw === 'off' ? raw : 'warn';
  if (lvl === 'off') return { action: 'allow' };

  // A catch command's action: `block` only under the block posture, else `warn`.
  const catchAction = (verb, skill) => ({
    action: lvl === 'block' ? 'block' : 'warn',
    skill,
    message: bashMessage(verb, skill),
  });

  // `gh issue create` is LOCKED to warn under every level (incl. block): to-prd/to-issues/triage
  // run it themselves in the main thread, so a block would wedge the redirect skills. (ADR 0009 §4.)
  if (/\bgh\b[\s\S]{0,80}\bissue\b[\s\S]{0,80}\bcreate\b/.test(cmd)) {
    return { action: 'warn', skill: SKILL_SPEC, message: bashMessage('gh issue create', SKILL_SPEC) };
  }

  if (/\bgh\b[\s\S]{0,80}\bpr\b[\s\S]{0,80}\bcreate\b/.test(cmd)) {
    return catchAction('gh pr create', SKILL_SHIP);
  }

  // A PR merges into its base (the trunk); promotion is a `wrxn ship` PR gated by CI, not a manual merge.
  if (/\bgh\b[\s\S]{0,80}\bpr\b[\s\S]{0,80}\bmerge\b/.test(cmd)) {
    return catchAction('gh pr merge', SKILL_SHIP);
  }

  // Only a TRUNK push is a skip — promotion is a `wrxn ship` PR, not a direct push to main/master.
  if (/\bgit\b[\s\S]{0,80}\bpush\b/.test(cmd) && pushesToTrunk(cmd, resolveBranch)) {
    return catchAction('git push', SKILL_SHIP);
  }

  return { action: 'allow' };
}

// Modern PreToolUse output (AC#0-confirmed): a warn lets the tool run while nudging both the
// assistant (additionalContext) and the operator (systemMessage); a block denies with a reason.
function warnOutput(message) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', additionalContext: message },
    systemMessage: message,
  };
}

function blockOutput(message) {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  };
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

  // Bash arm (slice #90): catch a MAIN-THREAD pipeline skip. The discriminator is the snake_case
  // `agent_id` stdin field (present only inside a subagent); the posture comes from process.env.
  if (event.tool_name === 'Bash') {
    const ti = event.tool_input || {};
    const d = decideBash({
      command: ti.command,
      agentId: event.agent_id, // presence = subagent = the pipeline -> allow
      level: process.env.WRXN_PIPELINE_GUARD,
    });
    if (d.action === 'warn') return emit(warnOutput(d.message));
    if (d.action === 'block') return emit(blockOutput(d.message));
    return emit({}); // allow
  }

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

module.exports = { decide, decideBash };
