# ADR 0006 — Build flow: HITL front-loaded, AFK verified per slice, human qa-walk gate; AFK runs as native executor agents wrapping the dispatch harness; compass routes; flow-status derives

- **Status:** Proposed (2026-06-18) — wrxn flow-redesign grill-with-docs (9 decisions locked); PRD pending.
- **Context:** The unified-dev pipeline ships as five always-on SYNAPSE rules (`payload/.synapse/pipeline`):
  a linear `grill → research → prototype → PRD → issues → verticality → tdd → code-review → security →
  QA-walk → accept`, with review/security/QA effectively **batched after the whole build**. AFK is
  dispatched via the `wrxn dispatch --executor` **harness** (`lib/executor.cjs`) — a proven *pure contract*
  (`buildDispatchSpec` / `validateReport`, type-aware push gate) that explicitly leaves "the live LLM
  execution out of scope." So `.claude/agents/` is **empty**: AFK has no native-subagent face. Routing
  lives **only** in the always-on `[PIPELINE]` injection; there is no operator-invocable map of the ~26
  skills (the upstream `mattpocock/skills` `ask-matt` router was skipped in 0.9.0 as a flow conflict), and
  an operator cannot **see** a flow's progress or whether routing is correct.
- **Decision drivers:** (1) per-slice verification catches defects before they compound across slices and
  honors Art. II — a slice is *independently buildable and walkable*, so it isn't "done" until it has
  passed review + security + qa; (2) a **human gate before trunk** is wanted — agents verify ACs, but only
  the operator can judge the whole artifact's story-level correctness and feel; (3) native subagents are
  the SOTA Claude Code delegation primitive, **but** the harness's report + push-gate contract is proven —
  so wrap it, don't replace it (REUSE/ADAPT > CREATE); (4) routing and visibility must **not drift** — the
  operator's standing worry, and the reason `sync`/`harvest` exist.

## Decision

The build flow is restructured into **four phases**, AFK runs as **six native executor agents wrapping the
existing dispatch contract**, a new **`compass`** skill routes, and **`wrxn flow status`** derives progress.
Nine locked choices:

1. **Four-phase flow.** `HITL front (grill → [research] → [prototype] → PRD → issues → verticality)` →
   `AFK per slice (builder → reviewer → security → agent qa-walk)` → `HUMAN qa-walk (whole artifact)` →
   `correction pass` → `devops push`. All human decisions are front-loaded into one window; all AFK-able
   work then runs unattended.
2. **Review + security run per slice**, inside the slice loop — not batched after the build. Small
   fresh-context diffs review sharper, and defects are caught before they compound.
3. **Two-level QA.** The per-slice **agent qa-walk** walks that slice's **issue ACs**; the final **human
   qa-walk** walks the **whole assembled artifact vs all PRD stories**. The `qa-walk` skill gains an
   **operator-mode** for the human walk.
4. **Corrections stay issue-driven.** Human-walk findings are auto-filed as issues → operator triages
   severity (fix-now vs defer; trivia batched into one issue) → fix-now issues run a **scoped re-run of the
   AFK phase** → operator re-accepts.
5. **Single trunk push, post-accept.** AFK-verified slices accumulate on an **integration branch** (slice
   N+1 builds on slice N); the human walk runs there; `devops` promotes integration → trunk in **one** push
   after accept. Un-human-walked code never reaches trunk.
6. **The front half stays elastic** (`PIPELINE_RULE_2` kept): low-novelty thins to grill → PRD → issues;
   `research` / `prototype` remain optional.
7. **AFK = six native executor agents** (`.claude/agents/`) that **wrap** the existing dispatch contract —
   each reads+follows its phase skill (or the global-skill instructions), is bounded by `buildDispatchSpec`
   (isolation, constraints, the type-aware push gate), and returns a report that `validateReport` accepts.
   `builder` / `reviewer` / `security` = **opus**; `qa-walker` / `researcher` / `devops` = **sonnet**.
   Least-privilege tools (read-only except builder + devops; reviewer/security `Write` scoped to their one
   marker). The mandatory compressed output contract **is** the harness `reportSchema` for that type.
8. **`compass` router skill** — `user-invocable` **and** model-invocable: **static** flow doctrine (the four
   phases, the HITL/AFK split, which agent owns each AFK step) + a **live read** of installed skills at
   invoke time (drift-free, no new CLI). The single "create a skill" route points at `write-a-skill`.
9. **`flow status` derives, it does not store.** `wrxn flow status [prd-id]` is a **pure aggregator** that
   reconstructs each slice's gate progress (build/review/security/qa) by reading the durable artifacts
   (green commit, `review-<id>.md`, security report, walk-findings) — no separate mutable state machine.
   `compass` renders it. `skill-creator` is disambiguated by compass now and **physically retired in a
   separate issue** (audit its 3 scripts, fold `quick_validate` into a lint if useful, + a removal
   migration).

## Consequences

- The pipeline rules (`payload/.synapse/pipeline`) are rewritten from the linear route to the four-phase
  flow; the constitution's HITL-spine / AFK-executor language is sharpened, not broken.
- AFK gains a SOTA native-agent face **without losing** the proven contract: the agents are thin wrappers,
  so `validateReport` + the devops-only push gate still hold by construction.
- Per-slice review/security/qa means **more agent runs** (N× instead of 1×) — accepted because slices are
  small, reviewer/security are read-only, and early-catch is worth the tokens. The cheaper `builder→sonnet`
  variant was offered and declined.
- Operators get an on-demand map (`compass`) that **cannot go stale** (live skill-read) and a progress
  board (`flow status`) that **cannot drift** (derived from artifacts) — directly answering "are our flows
  correct / is the process running right."
- This is a **kernel change**: it propagates only on publish + per-install `npx @gcunharodrigues/wrxn
  update`. WRXN-OS itself updates last.

## Considered and rejected

- **Keep review/security batched at the end** — fewer agent runs and a whole-diff view, but loses
  early-catch and breaks slice independence (a "done" slice that later fails review).
- **Native agents that replace the dispatch harness** — simpler/SOTA on the surface, but discards the
  proven `validateReport` contract and the type-aware push gate, which would have to be rebuilt.
- **Per-slice push to trunk** — would put un-human-walked code on trunk before the new human gate.
- **A mutable flow-state machine** — duplicates truth that already lives in the gate artifacts and would
  drift; derivation is drift-proof.
- **A static skill list inside compass** — drifts as skills change across releases; the live read is barely
  more complex and stays correct by construction.
- **Hard-deleting `skill-creator` blind** — it carries unique scripts (`init`/`package`/`quick_validate`);
  audit before retiring.
- **Folding the router into the always-on SYNAPSE injection** instead of a `compass` skill — not on-demand
  invocable, and the operator explicitly wants to *call* the map.

## Sources

This grill (9 locked decisions, 2026-06-18). `lib/executor.cjs` (the six-type dispatch contract being
wrapped). `payload/.synapse/pipeline` (the five rules being rewritten). Constitution Arts. I–III (push
gate, issue-driven slices, quality-first gates). Upstream `mattpocock/skills` `ask-matt` (router shape,
adapted to wrxn skills + the four-phase flow). The kernel propagate rule (publish + per-install update).
CONTEXT.md (HITL phase / AFK phase / executor / agent qa-walk / human qa-walk / correction pass /
integration branch / compass / flow status glossary).
