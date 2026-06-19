# 07 — Pipeline-adherence guard hook

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

The meta-fix: a hook that stops the orchestrator from skipping the pipeline by delegating a HITL step to a
generic agent — the exact error seen on 2026-06-19, made *with* the `[PIPELINE]` doctrine already injected
(so soft doctrine alone is insufficient). A guard on the agent-spawn tool blocks delegating a HITL step
(PRD / "break into issues" / grill / verticality) to a non-typed-executor (especially `general-purpose`),
with a block reason that names the correct skill. Pair it with sharpened doctrine + a `compass`
cross-reference. Fail-open so it can never wedge a session.

## Acceptance criteria

- [ ] Determine — and record in the issue/commit — whether Claude Code fires `PreToolUse` on the `Task` tool; choose the hook event accordingly (`PreToolUse:Task`, else a `UserPromptSubmit` fallback nudge keyed to the same heuristic).
- [ ] `payload/.claude/hooks/enforce-pipeline-adherence.cjs` blocks when a spawn's `subagent_type` is not one of the six typed executors AND the prompt matches HITL-step keywords; allows the typed executors; fails open on parse error. Decision-function unit-tested (prior art `test/hooks-boundary.test.cjs`).
- [ ] The block `reason` names the correct main-thread skill (e.g. "use `to-prd` / `to-issues` / grill in the main thread, don't delegate").
- [ ] The hook is wired in `payload/.claude/settings.json`, added to the manifest, and the synapse doctrine + `compass` cross-reference the adherence rule.
- [ ] Walk: spawning `general-purpose` for "write a PRD" is blocked with a pointer to `to-prd`; spawning `builder` for a build task is allowed.
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- None — can start immediately.
