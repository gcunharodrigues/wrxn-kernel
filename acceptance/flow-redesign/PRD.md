# PRD — Build-flow redesign: HITL-front, AFK-per-slice, human qa-walk gate; executor agents; compass router; flow status

Status: ready-for-agent
ADR: docs/adr/0006-hitl-front-afk-per-slice-flow.md
Slug: flow-redesign

## Problem Statement

As the wrxn operator I can't easily tell which skill or flow to use, I can't see how a build is
progressing, and I'm not confident the process runs correctly. The 0.9.0 Matt-sync modified existing
skills but skipped the router that helps choose a workflow (`ask-matt`), so there's no map over the ~26
skills. The current pipeline batches code-review / security / QA-walk after *all* slices are built, so
defects surface late and there is **no human checkpoint before trunk**. AFK work is dispatched by a
node-only harness (`lib/executor.cjs`) with no native-subagent face, so I can't direct AFK skills to
dedicated agents.

## Solution

A four-phase build flow, a fleet of native **executor** agents, an on-demand **compass** router, and a
derived **flow status** board:

- All human decisions happen up front in the **HITL phase**, in one window with me.
- Everything AFK-able runs unattended by typed **executor** agents — per slice `builder → reviewer →
  security → agent qa-walk` — accumulating on an **integration branch**.
- After every slice is AFK-verified, I run a **human qa-walk** of the whole artifact; findings flow back
  as a **correction pass**; then `devops` does a single push to trunk.
- **compass** answers "where am I, which skill/agent next," reading the live skill set so it can't go
  stale.
- **`wrxn flow status`** shows each slice's gate progress, derived from the durable artifacts, so I can
  watch a build run and tell when it's stuck.

## User Stories

1. As an operator, I want to invoke `compass` and get a map of every installed skill bucketed by the build
   flow, so that I know which skill fits my situation.
2. As an operator, I want `compass` to read the live skills directory at invoke time, so that the map can
   never go stale as skills change across releases.
3. As an operator, I want `compass` to show the four-phase flow and which executor owns each AFK step, so
   that I understand the route end-to-end.
4. As an operator, I want `compass` to point "create a skill" at exactly one skill (`write-a-skill`), so
   that routing is unambiguous.
5. As a lost orchestrator agent, I want to invoke `compass` mid-task, so that I can self-route to the right
   next skill instead of guessing.
6. As an operator, I want the build flow to front-load all HITL steps (grill → PRD → issues → verticality)
   into one window, so that I answer everything once and then step away.
7. As an operator, I want the front half to stay elastic (thin for low-novelty, full for net-new), so that
   a small change doesn't pay for research/prototype it doesn't need.
8. As an operator, I want each slice built, reviewed, security-reviewed, and qa-walked by agents before the
   next slice, so that defects are caught before they compound.
9. As an operator, I want code-review and security to run per slice rather than batched at the end, so that
   each "done" slice is genuinely done.
10. As an operator, I want each slice's agent qa-walk to verify that slice's issue ACs, so that a slice is
    proven against what its issue promised.
11. As an operator, I want AFK-verified slices to accumulate on an integration branch (slice N+1 on N), so
    that later slices build on earlier ones without touching trunk.
12. As an operator, I want a final human qa-walk of the whole assembled artifact against all PRD stories,
    so that I judge cross-slice / integration / does-it-feel-right correctness no per-slice agent can see.
13. As an operator, I want `qa-walk` to have an operator-mode for that human walk, so that I follow the
    same disciplined walk the agent does.
14. As an operator, I want human-walk findings auto-filed as issues, so that nothing I notice is lost.
15. As an operator, I want to triage findings by severity (fix-now vs defer, trivia batched), so that
    cosmetic nits don't each cost a full build cycle.
16. As an operator, I want fix-now findings to run a scoped re-run of the AFK phase, so that corrections
    get the same build → review → security → walk rigor.
17. As an operator, I want a single trunk push only after I accept, so that un-human-walked code never
    reaches trunk.
18. As an operator, I want `devops` to remain the only agent that may push, so that the anti-accidental-push
    gate holds.
19. As an operator, I want six native executor agents (builder, reviewer, security, qa-walker, researcher,
    devops), so that I can direct each AFK skill to a dedicated agent.
20. As an operator, I want each executor agent to wrap the existing dispatch contract (read its skill,
    honor the boundary gates, return a validated report), so that the proven guarantees still hold.
21. As an operator, I want each executor agent to carry least-privilege tools, so that a reviewer can't
    edit code and only builder/devops can write.
22. As an operator, I want each executor agent's model matched to its job (opus for build/review/security,
    sonnet for walk/research/push), so that reasoning-heavy jobs get the stronger model.
23. As a builder agent, I want my output contract to equal the harness `reportSchema` for my type, so that
    `validateReport` accepts my report without bespoke glue.
24. As a reviewer/security agent, I want write access scoped to my one marker file, so that I produce my
    artifact without the power to change code.
25. As an operator, I want `wrxn flow status [prd]` to show each slice's gate progress (build / review /
    security / qa), so that I can see how a build is going.
26. As an operator, I want flow status derived from the durable artifacts rather than a separate state
    store, so that the board can't drift from reality.
27. As an operator, I want a stalled slice (built but unreviewed for a long time) to show as stuck, so that
    I can tell whether the process is running correctly.
28. As an operator, I want `compass` to render the flow status, so that "where am I" and "how is it going"
    are answered in one place.
29. As an operator, I want the rewritten pipeline rules to inject as the always-on flow doctrine, so that
    every session follows the new flow by default.
30. As an operator, I want the new vocabulary (HITL phase, AFK phase, executor, agent/human qa-walk,
    correction pass, integration branch, compass, flow status) captured in the glossary, so that the team
    and the agents share one language.
31. As an operator, I want `skill-creator` disambiguated by compass now and retired in a separate tracked
    issue, so that the duplicate "create a skill" route stops confusing routing without losing its scripts
    unaudited.

## Implementation Decisions

(Per ADR 0006. Modules/contracts named; no file paths or code.)

- **Pipeline doctrine.** The always-on pipeline domain (the five injected rules) is rewritten from the
  linear route into the four-phase flow: HITL front → AFK-per-slice → human qa-walk → correction → push.
  The constitution's HITL-spine / AFK-executor language is sharpened to name the per-slice gate order and
  the human qa-walk, not replaced.
- **Executor agents.** Six native subagents are added, one per executor type, each a thin wrapper over the
  existing dispatch contract: it reads and follows its phase skill (or the global-skill instructions for
  reviewer / security / devops), is bounded by the dispatch spec (isolation, boundary constraints, the
  type-aware push gate), and returns the structured report its type requires. The agent's mandatory
  compressed output contract **is** that type's report schema. Tools are least-privilege (read-only except
  builder and devops; reviewer/security may write only their marker). Models: builder/reviewer/security =
  opus; qa-walker/researcher/devops = sonnet.
- **Agent-contract conformance.** A pure validator confirms each executor agent definition conforms to its
  registry entry: declares tools and model, and its declared output contract matches the registry
  `reportSchema` for that type. This is the test seam for the agents (the live LLM run stays out of scope).
- **qa-walk operator-mode.** The qa-walk skill gains a short operator-mode section: the human walks the
  whole assembled artifact against all PRD stories (story-level), distinct from the agent's per-slice
  AC-level walk. Findings are auto-filed as issues, as today.
- **Corrections.** Findings become tracker issues, triaged by severity; fix-now issues re-enter the AFK
  phase (scoped re-run); trivia may batch into one issue. No ad-hoc fixes (Art. II).
- **Integration + push.** Slices stage on an integration branch; the human qa-walk runs there; `devops`
  promotes integration → trunk in a single push after accept. Only `devops` may push.
- **compass router.** A new user- and model-invocable skill: a **static** flow-doctrine body (the four
  phases, the HITL/AFK split, executor ownership) plus an instruction to **read the installed skills live**
  and bucket them by the flow. The single "create a skill" route points at `write-a-skill`.
- **compass coverage.** A pure check confirms every installed skill is routed by compass's buckets (no
  orphan), keeping routing drift-proof.
- **flow status.** A pure aggregator reconstructs a per-PRD board from the durable gate artifacts (green
  commit referencing the issue id, the review marker, the security report, the walk-findings) — no separate
  mutable state. A thin CLI (`wrxn flow status [prd]`) prints it; compass renders the same.
- **Manifest + glossary.** The new agents, the compass skill, and any new state directories are registered
  as managed payload; CONTEXT.md carries the new flow glossary (already written); ADR 0006 records the
  decision.

## Testing Decisions

- **What makes a good test here:** assert *external behavior of the contract*, not internals. The kernel's
  established doctrine is that the **harness/contract is node-tested while the live LLM execution is out of
  scope** — proven by `lib/executor.cjs` and the dogfood acceptance (wrxn-kernel-22). Follow it.
- **Seam 1 — pure-transform lib** (prior art: the `lib/executor.cjs` unit tests). Three contracts tested at
  the function level:
  - agent-contract conformance — each executor agent definition matches its registry type (tools, model,
    output contract == `reportSchema`); a malformed or over-privileged agent fails.
  - flow-status aggregation — given a set of issues and present/absent gate artifacts, the aggregator
    returns the correct per-slice board (done / in-progress / queued / stalled); missing artifacts read as
    not-yet-done, never as a false pass.
  - compass coverage — given the installed skills and compass's flow buckets, every skill is routed; an
    unrouted skill fails the check.
- **Seam 2 — synapse rule injection** (existing seam; reuse the engine's tests). Assert the rewritten
  pipeline rules inject as always-on doctrine and stay within the token budget governor.
- **Modules tested:** the new pure lib(s) for conformance / flow-status / coverage; the synapse engine's
  injection of the rewritten pipeline domain.
- **Coverage does not decrease** (Art. III).

## Out of Scope

- **Live LLM execution of the agents** (a builder actually writing a feature) — validated later by a
  dogfood-walk against a real install, per the harness doctrine, not by unit tests.
- **Physical retirement of `skill-creator`** (script audit + removal migration) — a separate tracked issue;
  this PRD only disambiguates routing via compass.
- **Prose quality** of compass / agent bodies — covered by lint, not unit tests.
- **Applying the change to the WRXN-OS install** — happens later via publish + `npx … update` (propagate
  rule); this PRD builds and releases the kernel.
- **Changing recon-wrxn, the 26 skills' content, or the worktree engine** beyond what the flow needs.

## Further Notes

- This is a **kernel change**: inert in installs until publish + per-install `npx @gcunharodrigues/wrxn
  update`. WRXN-OS updates last.
- Decisions are locked in ADR 0006 (9 grill decisions, 2026-06-18) and the CONTEXT.md "Build flow"
  glossary.
- The build is expected to slice into independently-walkable issues (next step: to-issues), each passing
  the verticality gate before any executor runs.
- Acceptance closes with a dogfood-walk + operator accept, mirroring wrxn-kernel-22.
