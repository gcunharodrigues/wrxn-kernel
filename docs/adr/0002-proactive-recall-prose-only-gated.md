# ADR 0002 — Proactive recall is prose-only and relevance-gated; code + 1-hop stay on-demand

- **Status:** Accepted (2026-06-16) — wrxn Phase 2 grill; PRD pending.
- **Context:** Phase 2 upgrades the `recall-surface` UserPromptSubmit hook from substring matching to
  recon's warm hybrid retriever (BM25 ⊕ embeddings / RRF). The hook fires on **every** prompt, and the
  brain is a **unified** graph (≈34k code + ≈4k prose nodes). Two design questions fall out: does
  per-prompt recall surface *code* as well as prose, and how does it stay silent so it does not inject
  noise on every turn. Grounded by the SOTA research at
  `WRXN-OS/docs/research/2026-06-16-sota-per-turn-recall-gating/`.
- **Decision drivers:** (1) injecting weak/irrelevant context **measurably lowers** answer quality
  (Lost-in-the-Middle 30–55pp; context rot across 18/18 frontier models; low-precision chunks reduce
  accuracy) [hard]; (2) across Cursor/Claude Code/Cody/Continue/Aider, **knowledge is auto-injected,
  code is agent-initiated**; (3) RRF scores are rank-based consensus, **not** a relevance magnitude;
  (4) a per-prompt latency + context budget.

## Decision

The automatic per-prompt recall surfaces **prose only** (`type: [Page, Section]` + wiki tiers) and is
**relevance-gated**:

- **Gate on the per-arm signal, never the fused RRF score** — the dense **semantic cosine floor**
  (`SEMANTIC_FLOOR = 0.4`, reused from P1.5) and/or **consensus** (a hit in the top-K of both the BM25
  and the dense arm). If nothing clears, the hook emits **nothing** (abstain).
- **Inject little, high-signal** — top 2–3 hits, slug + one-line snippet, ≤600 chars.
- **Code retrieval stays on the agent's on-demand path** — `recon_find` (now hybrid, returns
  code+prose), `recon_explain`, `recon_impact`, `recon_map`, `recon_rules`, and `wrxn brain query`.
  The brain itself is untouched; only the *hook's query* is scoped to prose.
- **1-hop neighbor expansion is OUT of the hook.** It helps entity lookups (86%) but hurts
  relation/path queries (24%, 2.5× precision loss; PolyG). It is exposed only behind an explicit
  `wrxn brain query --neighbors`. **This revises plan decision 8**, which had placed 1-hop neighbors
  in the recall path.

## Consequences

- Per-prompt recall is high-precision and low-noise; on the ~8% of prompts that deserve no retrieval
  (Adaptive-RAG) it stays silent, which also saves latency.
- Code intelligence is unchanged — it remains the agent's daily-driver MCP tools, exactly where SOTA
  places code retrieval. Nothing in recon is orphaned by the prose scope.
- When the warm serve door is unreachable the hook fails open to **silent** (it does not fall back to
  the old substring engine — serve is warm in-session, and a weak fallback can itself harm).
- Thresholds are starting points; calibrate on the real wiki/prose gold set (the P1.5 corpus).

## Sources

`docs/research/2026-06-16-sota-per-turn-recall-gating/` (Adaptive-RAG, Self-RAG, FLARE; Lost-in-the-
Middle, Chroma context-rot, Anthropic context-engineering; RRF-not-a-gate — Laforge/Azure/MongoDB;
PolyG 1-hop). Plan memory `wrxn-intelligence-rebuild-plan` (decision 8). recon-wrxn ADR 0003
(concurrent serve door).
