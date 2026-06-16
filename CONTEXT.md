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
