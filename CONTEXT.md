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
