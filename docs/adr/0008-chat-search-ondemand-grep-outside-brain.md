# ADR 0008 — Conversational-log retrieval (`chat-search`) is on-demand grep, outside the Brain

- **Status:** Accepted (2026-06-25) — WRXN-OS grill; PRD pending. Supersedes the hand-filed issue #80.
- **Context:** Operators sometimes need an exact past conversational moment ("you decided X an hour ago",
  "what did I say about Y"). The **Brain** (recon-wrxn's graph) deliberately holds only curated, distilled
  code + prose — **not** raw chat (distill-don't-hoard; ADR 0002 keeps raw chat off the automatic recall
  surface). So the **Conversational log** (`.wrxn/events/*.jsonl` + the harness transcript
  `~/.claude/projects/<slug>/*.jsonl`) has no retrieval path. A session review (2026-06-25) compared two
  options: **(A)** on-demand grep over the raw log vs **(B)** embedding `SessionEvent` nodes for semantic
  recall.
- **Decision drivers:** (1) grep is **live + deterministic** — no index lag, the current session is
  searchable immediately [hard]; (2) the harness transcript — the only source of **assistant** turns — is
  outside the repo and never in the Brain, so semantic indexing cannot reach it regardless; (3) raw chat is
  low signal-density vs curated pages → embedding it risks **recall pollution** + unbounded vector cost;
  (4) distill-don't-hoard + ADR 0002 (no auto-surface of raw chat); (5) the REUSE>ADAPT>CREATE hierarchy
  pulled toward reusing `recon_find`, but recon adds lag + a serve-door dependency for **zero** unique
  value on exact match.

## Decision

`chat-search` retrieves the **Conversational log on-demand via pure grep** over both arms — the event log
(`.wrxn/events/*.jsonl`) and the harness transcript (`~/.claude/projects/<slug>/*.jsonl`). It is:

- **Outside the Brain** — no embeddings, no recon/serve dependency, no index step. The Brain stays
  curated-only; raw chat never enters it. (This is why a reader expecting "reuse the Brain" finds grep.)
- **Invoked two ways, both deliberate** — the operator types it, or the agent reaches for it mid-reasoning
  (like `recon_find`). **Never an automatic per-prompt hook** — ADR 0002's boundary holds; B (passive
  semantic surfacing of raw chat) is explicitly rejected.
- **Read-only + safe** — events are pre-redacted; the transcript arm runs `redactSecrets` and **strips
  injected context** (`<synapse-rules>`, `<recall-surface>`, `<wrxn-orientation>`, system-reminders) so a
  hit is real conversation, not injected noise. Reuses memory-synth's existing sentinel-strip (#62).

## Consequences

- Exact-moment retrieval works **live and cross-session** at zero index/store cost; the Brain is never
  polluted by chatter.
- The transcript dependency is an **undocumented harness format** (polymorphic `message.content`, many line
  `type`s) → the arm must parse defensively and **degrade to events-only** if the transcript dir is absent
  or its shape drifts.
- Raw-chat recall stays **machine-local + ephemeral** (events pruned ~90d); durable, portable memory remains
  the committed wiki — by design. `chat-search` is scrollback, not memory.
- **B is deferred, not refuted** — revisit semantic chat recall only on a *measured* need for fuzzy recall
  the wiki's existing semantic surface does not already serve.

## Sources

This session's A-vs-B review (2026-06-25). ADR 0002 (proactive recall prose-only, gated). `CONTEXT.md`
terms **Conversational log** / **chat-search**. Kernel issues #80 (superseded by this ADR + the PRD) and
#81 (main-thread pipeline-skip guard + the cross-repo tracker gap that forced manual kernel filing).
