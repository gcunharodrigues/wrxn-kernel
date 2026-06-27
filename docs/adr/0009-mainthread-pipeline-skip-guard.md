# ADR 0009 — Main-thread pipeline-skip detection via the `agent_id` discriminator

- **Status:** Accepted (2026-06-26) — issue #81 grill-with-docs (7 forks locked). Extends ADR 0007 §8.
- **Context:** ADR 0007 §8 added a `PreToolUse:Task` guard (`enforce-pipeline-adherence.cjs`) that blocks
  **delegation skips** — handing a HITL step (PRD / issues / grill / verticality) to a non-typed agent. It is
  **blind to main-thread skips**: the operator/assistant skipping the pipeline *directly*, with no `Task` spawn
  to intercept. Two live skips this session the Task guard could not see — #80 (`recall-chat` hand-authored via
  `gh issue create`, skipping to-prd/to-issues) and #77 (`wiki-lint` fix built **and** shipped in the main
  thread, skipping the AFK executors + `devops`/`wrxn ship`). The root enabler is a **cross-repo seam**:
  to-prd/to-issues publish to the *current install's* tracker, but kernel features are developed in the sibling
  `wrxn-kernel` repo, so kernel-feature dev from an install session has **no configured pipeline path** → the
  operator goes manual on the kernel tracker → the Task-only guard never fires (#81 itself was filed this way).

## Decision

Extend the **same** guard to a **Bash arm**, keeping the existing Task arm byte-identical (its `decide()` and
tests untouched; `main()` dispatches on `tool_name`). Six locked choices:

1. **Spine = the `agent_id` discriminator.** Claude Code `PreToolUse` hooks fire for **all** tool calls,
   including those *inside* subagents — but the stdin payload carries `agent_id` / `agent_type`, **present only
   inside a subagent, absent in the main thread**. So every legitimate pipeline mechanic runs inside a typed
   executor subagent (`devops` → `wrxn ship`; all AFK executors) and carries `agent_id` → **auto-allowed**; only
   **main-thread** ops (`agent_id` absent) are candidates. The same-command ambiguity (`gh pr create` is both the
   skip *and* what `wrxn ship` runs) dissolves on **caller context**, not the command string. (The inner
   `git push`/`gh` that `wrxn ship` shells out to are subprocesses of the `wrxn` binary — invisible to hooks;
   the hook only ever sees the one `wrxn ship` Bash call.)
2. **Catch set (main-thread only):** `gh issue create`, `gh pr create`, `gh pr merge` (trunk), `git push` (trunk
   only — non-trunk pushes are normal). Read-only `gh` (`*list`/`view`/`checks`/`diff`) always allowed. Trunk =
   `main`/`master`.
3. **Warn-default, configurable to block.** Default **warn** — the active, interruptive middle tier between
   passive SYNAPSE doctrine (proven insufficient: present-and-skipped on 2026-06-19) and a hard block. Knob
   `WRXN_PIPELINE_GUARD` ∈ {`warn` (default), `block`, `off`}, read from `process.env` (set via settings.json
   `env`; shell-state env does **not** survive to the hook subprocess, so per-skill env-marking is impossible —
   see rejected). `off` disables the Bash arm only; the **Task arm is never gated by the knob**.
4. **`gh issue create` is locked to warn** even under `block` — to-prd / to-issues / triage run `gh issue create`
   themselves, in the **main thread** (they are HITL skills, no subagent), so it is `agent_id`-absent and
   *indistinguishable* from an operator skip. A block would wedge the very skills the warning redirects to.
5. **The Edit/Write arm is deliberately excluded** (revises #81 AC#1). A `PreToolUse:Edit` hook receives only
   `file_path` + strings — there is **no session→issue link anywhere**, so AC#1's "source edit with no
   ready-for-agent issue ref" is **uncomputable**; warning on every main-thread source edit is alarm fatigue
   that would discredit the Bash arm; and the Bash **ship-step** arm already catches both documented incidents
   (#77's skip is catchable at the ship, not the upstream edit). Deferred, not denied.
6. **The cross-repo seam is the root enabler, decoupled from #81.** The fix — a to-prd/to-issues `--repo` target
   flag so kernel features spec cleanly from an install session — is its **own feature** (own ADR when built).
   #81 satisfies its AC#4 by the **"document"** half of "close or document"; the `--repo` feature delivers the
   "close." Keeps #81 a tight vertical slice.

## Considered and rejected

- **Per-skill env-marker** (to-issues exports a flag the hook reads to self-allow) — the CC Bash tool does not
  persist shell state across calls ("env vars do not persist; the shell is initialized from the profile"), so a
  skill-set env never reaches the hook subprocess. Dead on arrival.
- **Command-content heuristics** (infer skip vs legit from the issue/PR body) — fragile, evadable, high
  false-rate. The `agent_id` caller-context signal is exact; the content is not.
- **Block everything** (mirror the Task arm's hard block) — wedges to-issues/to-prd/triage, which legitimately
  run `gh issue create` in the main thread (choice 4).
- **The Edit/Write arm** — uncomputable AC + alarm fatigue + redundant with the ship-step catch (choice 5).
- **Fold `--repo` into #81 as a slice** — couples a hook guard to a skill-CLI flag, bloats the slice toward the
  too-coarse verticality fail (choice 6).

## Consequences

- **Empirical gate (AC#0) — RESOLVED 2026-06-26** by a main-thread pre-flight (the builder could not observe
  the main-thread-absent half from inside a subagent). Confirmed against the authoritative Claude Code hooks doc
  + corroborated by the live transcript:
  - **Discriminator = `agent_id`** (snake_case, in `PreToolUse` stdin alongside `tool_name`/`tool_input`):
    *"Present only when the hook fires inside a subagent call. Use this to distinguish subagent hook calls from
    main-thread calls."* `agent_type` carries the subagent name. PreToolUse fires for **all** tool calls,
    subagent included. **Trap caught:** the transcript JSONL tags subagent records in **camelCase**
    (`agentId`/`agentType`/`isSidechain`) — a *different* serialization than the hook stdin; the guard reads the
    **snake_case** stdin field, not the transcript casing.
  - **Warn mechanism** = `{ hookSpecificOutput: { permissionDecision: "allow", additionalContext } , systemMessage }`
    — `additionalContext` feeds the assistant (self-correct), `systemMessage` surfaces to the operator; the tool
    still runs. **Block** = `permissionDecision: "deny"` + `permissionDecisionReason` (modern schema). The Task
    arm keeps its legacy `{ decision: "block" }` form (byte-identical, AC#5); the Bash arm uses the modern form.
    (`"ask"` exists as an override-able middle tier — out of scope.)
- **Bootstrap (snake eats tail):** #81 is itself a kernel feature specced from the WRXN-OS install with no
  `--repo` yet, so its PRD + slices are filed onto the kernel tracker by **one acknowledged manual step**. Once
  the `--repo` feature ships, the seam self-eliminates for all future kernel-from-install work.
- **Fail-open preserved** — any parse error / missing field emits `{}`; the guard never wedges a session.
- **Kernel change** propagates only on publish + per-install `npx @gcunharodrigues/wrxn update`; WRXN-OS updates
  last.

## Sources

Issue #81 (evidence: live skips #80, #77). ADR 0007 §8 (the Task-arm guard this extends).
`payload/.claude/hooks/enforce-pipeline-adherence.cjs` + `payload/.claude/settings.json` (current wiring).
The #81 grill-with-docs (2026-06-26). Claude Code hooks doc — `PreToolUse` behavior with subagents
(`agent_id`/`agent_type` present only in-subagent) + the `hookSpecificOutput.permissionDecision` output schema;
AC#0 confirmed by main-thread pre-flight against the doc + the live session transcript (2026-06-26).
