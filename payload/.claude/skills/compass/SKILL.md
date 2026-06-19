---
name: compass
description: Router over the skills and the build flow — ask "which skill or flow fits: where am I, what's next." Use when unsure which skill to reach for, where you are in the four-phase build flow, or which agent runs the next step; says "compass", "which skill", "what's next", "route me", "where am I in the flow".
user-invocable: true
---

# compass — where am I, which skill next

`compass` is the on-demand map of the wrxn skills **and** the build flow. It answers one question:
*given where I am, which skill or executor comes next?* Two halves: a **static flow doctrine** (below,
the part that rarely changes) and a **live read** of the installed skills at invoke time (the part that
must never go stale). Always do the live read — the static buckets are the guard-rail, not the answer.

## The build flow (static doctrine)

The default route is the **four-phase flow**, then a single push. Scale the front to novelty.

1. **HITL phase** — front-loaded in the main conversation with the operator. Every human decision is
   made here, in one window, before any agent builds:
   `grill → [research] → [prototype] → PRD → issues → verticality gate`.
   Low-novelty work thins to `grill → PRD → issues`; `research` and `prototype` are optional.
2. **AFK phase** — per slice, run unattended by isolated typed executors, accumulating on an
   **integration branch** (slice N+1 builds on slice N):
   `builder → reviewer → security → agent qa-walk`.
   Review and security run **inside the slice loop**, not batched after the build — a slice isn't done
   until it has passed all four gates.
3. **Human qa-walk** — the operator walks the **whole assembled artifact against all PRD stories** (the
   cross-slice / does-it-feel-right gate no per-slice agent can see), via `qa-walk`'s operator-mode.
4. **Correction pass** — human-walk findings are filed as issues, triaged for severity (fix-now vs
   defer; trivia batched), the fix-now issues run a **scoped re-run of the AFK phase**, then the
   operator re-accepts.

**Then, and only then:** `devops` promotes the integration branch to **trunk in one push**. Un-human-walked
code never reaches trunk.

The **HITL / AFK split** is the spine: humans decide up front; agents build and verify unattended.

## Which executor owns each AFK step

The AFK phase runs as six native executor agents (`.claude/agents/`), each reading and following its
phase skill (never a paraphrase), bounded by the dispatch contract (`lib/executor.cjs`):

- **builder** *(opus)* — the build step. Reads **tdd**; builds the slice red → green → refactor.
- **reviewer** *(opus)* — the code-review step. Follows **/code-review** (global skill); writes the one
  review marker the push gate checks.
- **security** *(opus)* — the security-review step. Follows **/security-review** (global skill).
- **qa-walker** *(sonnet)* — the per-slice **agent qa-walk**. Reads **qa-walk**; walks that slice's
  issue ACs against the real artifact.
- **researcher** *(sonnet)* — the optional HITL **research** step. Reads **tech-search**.
- **devops** *(sonnet)* — the integration / push step. **The only executor authorized to push.**

For live per-PRD progress across these gates, run **`wrxn flow status [prd-id]`** — it derives each
slice's build/review/security/qa state from the durable artifacts (green commit, `review-<id>.md`,
security report, walk-findings), so it cannot drift.

## Routing rules

- **Create a skill** → **write-a-skill** only — `skill-creator` is **legacy** (kept for its init /
  package / quick-validate scripts; retired in a later issue). Never route new skill authoring to it.
- **Create an agent / subagent** → **write-an-agent**.
- **Never delegate a HITL step to a generic agent** — `grill`, `to-prd`, `to-issues`, and the verticality
  gate are decided in the **main thread** with the operator, never handed to a `general-purpose` (or any
  non-typed) subagent. Only the six typed executors run unattended. The `enforce-pipeline-adherence` guard
  (PreToolUse:Task) hard-blocks that delegation and names the right main-thread skill — doctrine alone
  proved insufficient (the pipeline was skipped this way on 2026-06-19).
- Anything else → match the request to a bucket below, then to the skill whose `description` fits.

## Live read (do this every invoke — the map can't go stale)

Do **not** route from memory or from the static buckets alone. At invoke time:

1. List `.claude/skills/*/` and read each `SKILL.md` frontmatter `name:` + `description:`.
2. Bucket each by the flow using the categories below (dev-pipeline / knowledge / setup-health / meta /
   cross-session).
3. Surface the skill(s) whose `description` best matches the operator's intent and where they are in the
   flow — including any skill **newer than the static block below**, which is exactly why you read live.

## Buckets (the static map — coverage-guarded)

Every installed skill belongs to exactly one flow bucket. This block is machine-checked by
`lib/compass-coverage.cjs` (`compassCoverage`): if a skill is installed but absent here, coverage fails
— the prompt to add it (or to lean on the live read). The live read is the runtime backstop; this is the
build-time guard.

```buckets
dev-pipeline: grill-me, grill-with-docs, tech-search, prototype, to-prd, to-issues, triage, tdd, qa-walk, diagnose, resolving-merge-conflicts, improve-codebase-architecture
knowledge: dream, harvest, sync, ingest, memory
setup-health: onboard, audit, level-up, setup-matt-pocock-skills, synapse
meta: write-a-skill, write-an-agent, skill-creator, compass
cross-session: handoff
```

- **dev-pipeline** — the four-phase build flow and its engineering activities (grill → research →
  prototype → PRD → issues → verticality → tdd → review → security → qa-walk → diagnose / refactor).
- **knowledge** — the Brain / wiki memory lifecycle: consolidate (dream), curate (harvest), drift (sync),
  distill sources (ingest), the wiki adapter (memory).
- **setup-health** — install setup, configuration, and health: onboard, audit, level-up, the
  issue-tracker/domain block (setup-matt-pocock-skills), the SYNAPSE engine (synapse).
- **meta** — authoring the OS's own extensions: skills (write-a-skill), agents (write-an-agent), the
  legacy skill scaffold (skill-creator), and this router (compass).
- **cross-session** — continuity across sessions: handoff.
