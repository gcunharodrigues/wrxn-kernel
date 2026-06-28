# wrxn kernel — Context

The kernel is the installable wrxn OS: the CLI (`wrxn …`), the managed hooks, the SYNAPSE context
engine, and the skills/pipeline. Its intelligence layer reads a **Brain** built by recon-wrxn.

## Language

**Brain**:
The unified code-and-prose knowledge graph (recon-wrxn's index) plus the hybrid retrieval over it.
One graph, code and prose nodes side by side. `wrxn brain query` and proactive recall both read it.
_Avoid_: index, database, memory store, vector DB.

**Recall** (proactive recall):
The automatic, per-prompt surfacing of relevant **knowledge** into context, performed by the
`recall-surface` hook with no agent decision. Prose-only and relevance-gated; stays silent when
nothing clears the gate.
_Avoid_: search, retrieval (those name the on-demand act, below).

**On-demand retrieval**:
The agent's deliberate query of the Brain — `recon_find` / `recon_explain` / `recon_impact` /
`recon_map` / `recon_rules` over MCP, or `wrxn brain query`. Covers **code and prose**. This is where
code intelligence lives; Recall never surfaces code.
_Avoid_: recall (recall is automatic and prose-only).

**Conversational log**:
The raw, ephemeral, machine-local record of a session — the user-prompt events (`.wrxn/events/*.jsonl`)
and the harness transcript (`~/.claude/projects/<slug>/*.jsonl`, the only source of **assistant** turns).
**Not the Brain** (uncurated, undistilled), **not recalled** (never auto-surfaced), pruned (~90d). Durable
memory is the wiki; the conversational log is scrollback. Read on-demand by **chat-search**, never indexed.
_Avoid_: Brain, memory, history (those name the curated/durable tiers, not this raw log).

**chat-search**:
The deliberate, on-demand retrieval of an exact past moment from the **Conversational log**, invoked two
ways — the operator types it, or the agent reaches for it mid-reasoning (like `recon_find`). **Never an
automatic per-prompt hook** (ADR 0002 keeps raw chat off the auto-surface). Keyword/exact, read-only, no
embeddings. Sibling to **On-demand retrieval** (which queries the **Brain**); chat-search queries the
conversational log instead.
_Avoid_: recall (recall is automatic, prose-only, Brain-sourced).

**Abstain**:
The Recall gate's silent outcome — when no candidate clears the semantic floor / consensus, the hook
injects nothing. Silence is the default, not a failure.
_Avoid_: empty result, no-op (those read as error, not a deliberate gate).

**SYNAPSE**:
The per-prompt context engine that injects the constitution (L0), always-on rules (L1), and
keyword-recall domains (L6). Distinct from Recall: SYNAPSE injects *rules*, Recall injects *knowledge*.
_Avoid_: conflating SYNAPSE rule-injection with Brain knowledge-recall.

**dream**:
The consolidation skill — run deliberately in a session, it reflects on the live conversation,
distills durable knowledge, and (after the operator confirms) writes net-new pages into the wiki's
semantic tiers. Consolidation, not capture; a skill, not a daemon.
_Avoid_: daemon, background job, summarizer (it is a deliberate, operator-confirmed skill).

**Consolidation**:
dream's act — turning one session's experience into durable decisions/gotchas/rules/concepts in the
wiki, each candidate gated by validation.
_Avoid_: summarization.

**Proposal**:
A validated candidate page dream stages for operator confirmation before any write. It carries a
target tier, a one-line rationale, a confidence, and **evidence** — a verbatim quote from the session
that grounds it. Nothing is written without confirmation (writes are additive + dedup-skip).
_Avoid_: draft, suggestion (a proposal is evidence-backed, gated, and auditable).

**Validation gate**:
The deterministic keep-or-discard check dream runs on every proposal — confidence floor, mandatory
evidence, dedup against existing pages, restraint (no durable insight ⇒ write nothing), and the
anti-superstition negative filters. The skill *proposes*; the gate *judges*. "Bad memory is worse
than no memory."
_Avoid_: filter, lint (lint is the later harvest health-check, not the write gate).

**harvest**:
The curation / close-out loop, sibling to **dream** (additive) and **sync** (drift): at handoff
(debt-gated) or on demand, it health-checks the knowledge tiers and, through operator-confirmed proposals,
**merges** near-duplicates into one survivor, **forward-links** superseded pages, and **flags** orphans.
Merge-then-delete is its only sanctioned knowledge deletion.
_Avoid_: prune, garbage-collect, cleanup (harvest is gated + evidence-grounded, not a sweep).

**Health-check**:
harvest's auto, non-destructive detection pass — writes a durable report of near-dups, decay-candidates,
and malformed pages to `.wrxn/harvest/<ts>.jsonl`; the input to curation. The "lint" the Validation-gate
term names.
_Avoid_: the Validation gate (that is dream's *write* gate; the health-check only *reports*).

**Decay**:
A page's **down-weighting in Recall** by recency × importance — never a deletion; reinforced pages stay
fresh. Distinct from **drift** (sync: a doc out of step with its source).
_Avoid_: delete, expire.

**Reinforcement**:
What resets a page's recency — it is access-tracked (Recall surfaces the page), stamped coalesced into
`.wrxn/reinforce.json` (at most one write per page per day). Reinforcement is *use*, not authoring.
_Avoid_: edit, modify (a write is dream/harvest; reinforcement is mere access).

**_rules** (tier):
Durable always/never project conventions, written by dream as **recalled knowledge** (surfaced by
Recall, like concepts/gotchas). Distinct from **SYNAPSE** rules: SYNAPSE injects a small curated set
every prompt; `_rules` pages are many and situational. Promoting a `_rules` page into SYNAPSE is a
separate deliberate act, never dream.
_Avoid_: conflating `_rules` knowledge with SYNAPSE rule-injection.

**Focus slot** (`_slots/current-focus.md`):
The durable, pinned page describing the project's standing focus — recall-surfaced, and the one path
dream may UPDATE (the lone exception to additive + dedup-skip). Disjoint from the **continuity baton**:
the baton (`.wrxn/continuity/latest.md`) is single-writer (the handoff skill), ephemeral cross-session
resume; the focus slot is durable standing context. Keeping their paths and writers disjoint preserves
the continuity doctrine.
_Avoid_: merging the focus slot with the handoff baton.

## Build flow

**HITL phase**:
The front half of the build flow, run in the main conversation with the operator: grill → (research) →
(prototype) → PRD → issues → verticality gate. Everything needing a human decision is resolved here, in
one window, before any agent builds.
_Avoid_: front half, planning (too vague).

**AFK phase**:
The build half, run by isolated typed **executors** with no human in the loop: per slice, builder →
reviewer → security → agent qa-walk. Gated entirely by the dispatch contract.
_Avoid_: back half, automation.

**Executor**:
A typed, isolated subagent that runs one AFK phase by reading and following its phase skill, bounded by
the dispatch spec, returning a validated report. The six: builder, reviewer, security, qa-walker,
researcher, devops — **devops alone may push**.
_Avoid_: worker, runner, bot.

**Agent qa-walk**:
The per-slice functional walk an isolated qa-walker runs against **one slice's issue ACs**, the last gate
of that slice's AFK phase. AC-level.
_Avoid_: conflating with the human qa-walk.

**Human qa-walk**:
The operator's functional walk of the **whole assembled artifact against all PRD stories**, after every
slice is AFK-verified — the cross-slice / integration / does-it-feel-right gate no per-slice agent can
see. Runs via qa-walk's operator-mode.
_Avoid_: acceptance (the sign-off *after* this walk), conflating with the agent qa-walk.

**Correction pass**:
The post-human-walk fix loop: findings are filed as issues, triaged for severity (fix-now vs defer,
trivia batched), the fix-now issues run a scoped re-run of the AFK phase, then the operator re-accepts.
_Avoid_: rework, hotfix.

**Integration branch**:
The staging branch where AFK-verified slices accumulate (slice N+1 builds on slice N) and the human
qa-walk runs; devops promotes it to trunk in a single push after accept. Keeps un-human-walked code off
trunk.
_Avoid_: feature branch, trunk.

**compass**:
The router skill — a user- and model-invocable map of the skills and the build flow that answers "where
am I, which skill/agent next." Static flow doctrine + a live read of installed skills (drift-free by
construction).
_Avoid_: index, menu, help.

**Flow status**:
The derived per-PRD gate board (`wrxn flow status`) — reconstructs each slice's progress
(build/review/security/qa) from the durable gate **artifacts**, not a separate state store. compass
renders it for "is the process running correctly."
_Avoid_: dashboard, state machine (there is no separate state — the artifacts are the truth).

**Pipeline-adherence guard**:
The client-side speedbump that catches a build-flow skip and points back at the right skill, in two
forms: a **delegation skip** — a HITL step handed to a non-typed agent, caught when a subagent is spawned
(ADR 0007 §8) — and a **main-thread skip** — pipeline-bypassing ops run *directly* by the operator with no
subagent to intercept, caught at the act (ADR 0009). It distinguishes a skip from a legitimate pipeline
mechanic by **caller context** (a typed executor running the same command is allowed), not by the command
text. A speedbump, not enforcement — the server CI ruleset is the only hard gate (ADR 0007).
_Avoid_: gate (the CI ruleset is the gate; this is an advisory speedbump), linter, the SYNAPSE doctrine
rule (passive text; the guard is an active interrupt — the distinction is the whole point).

**Release**:
A deliberate `chore(release)` PR that bumps `package.json.version` (cut by `wrxn release`); the CD publishes
it to npm on merge (`decidePublish`: type-release OR version-not-on-npm). Distinct from a **feat-merge**,
which lands on `main` but does **not** publish — feats accumulate unreleased until a Release (ADR 0010).
_Avoid_: deploy, ship (`wrxn ship` is the push/PR/arm mechanic a Release reuses, not the Release itself).
