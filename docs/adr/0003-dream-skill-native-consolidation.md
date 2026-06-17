# ADR 0003 — `dream` is skill-native consolidation: live-session reflection, additive, propose-then-confirm

- **Status:** Accepted (2026-06-16) — wrxn Phase 3 grill-with-docs; PRD pending.
- **Context:** Phase 3 adds **memory consolidation** — turning session experience into durable wiki
  knowledge (the rebuild plan's `dream`, decisions 5/6/7). The design is modelled on Karpathy's
  LLM-wiki and a full inspection of `akitaonrails/ai-memory` (a mature Rust implementation: markdown =
  source of truth, SQLite = derived index, a background **auto-improve** loop that reviews completed
  sessions and proposes durable pages behind a hard validation gate). wrxn already has the pieces
  ai-memory builds: a file wiki (`concepts/decisions/gotchas/sessions`), the recon **Brain** (hybrid
  retrieval that already exceeds ai-memory's), session-end breadcrumb **Capture**, and the
  relevance-gated **Recall** surface (ADR 0002).
- **Decision drivers:** (1) wrxn's **session pages are thin turn-trail breadcrumbs** (prompt
  first-lines) and already auto-decay (cap 50) — they are not a consolidation *source*; (2) the recall
  surface was **poisoned by stale pages** (7 bad pages fed to sessions — the bug that triggered this
  whole rebuild), so writing to it carries real risk; (3) plan decision 5 locks **"dream is a SKILL,
  no daemon"**; (4) ai-memory's most valuable, most portable artifact is its **deterministic
  validation gate** ("bad memory is worse than no memory"), not its observation store or scheduler.

## Decision

`dream` is a **user-invocable kernel skill** that consolidates the **current session** (it reflects on
the live conversation already in its context — no new capture layer, no transcript re-reading, no
background scheduler). Five locked choices:

- **Source = live session context.** Current-session scope. Backlog/cross-session mining is out (the
  existing breadcrumb sessions hold nothing minable anyway).
- **Write model = additive + dedup-skip.** dream only *creates* net-new pages; if a page with the same
  path or normalized title exists, it skips (never touches the curated page). Merging/refreshing is
  deferred to **harvest** (Phase 5) — `ai-memory` itself defers merge. The lone update-exception is
  `_slots/current-focus.md`.
- **Autonomy = propose-then-confirm.** dream stages validated **proposals** (with an audit trail) and
  the operator approves the batch before any write. This **refines plan decision 9** ("auto-additive"):
  because dream writes to the poisoning-prone recall surface, even additive writes are confirmed until
  the gate earns trust ("trust is earned with history, not enthusiasm"). Auto-apply is a later opt-in.
- **Validation gate = a pure, node-testable function** the skill calls (the LLM *proposes*; the
  function *judges*). Ported from ai-memory's `auto_improve` and adapted to a skill: a **restraint
  preflight** (no durable insight ⇒ write nothing — "return only the episodic page"); per-proposal
  **confidence ≥ 0.75**, **mandatory evidence = a verbatim quote from this session** (+ optional
  `file:line`/commit), a rationale, an H1 body, a size cap, **dedup vs existing path + title**,
  kind↔tier agreement, and **≤ 5 proposals/run**. Plus the **anti-superstition negative filters**
  (reject "tool X is broken" — it hardens into a permanent false refusal — transient env failures,
  smoke tests, one-off task narratives, and **never memorialize wrxn itself**).
- **Trigger = on-demand + a handoff-time nudge.** Primary path is explicit invocation; the handoff
  flow nudges "consolidate before you hand off." No background run (it is a skill).

**Two new tiers, with boundaries that protect existing systems:**

- **`_rules`** — durable always/never project conventions, written as **recalled knowledge** (distinct
  from SYNAPSE's small curated always-injected set). Promotion of a `_rules` page into SYNAPSE is a
  separate deliberate act, never dream.
- **`_slots/current-focus.md`** — the durable pinned project focus, **disjoint** from the continuity
  baton (`.wrxn/continuity/latest.md`, single-writer = the handoff skill). The baton is ephemeral
  cross-session resume; the slot is durable standing context. Disjoint paths + writers preserve the
  continuity doctrine (the structural fix for the 2026-06-12 clobber).

**Decay stays out of scope.** Sessions already rotate (cap 50); semantic pages are permanent
(ai-memory: only episodic decays). Stale-flagging, dedup, and merge are **harvest** (Phase 5) plus the
existing wiki-lint hook.

## Consequences

- Ships the highest-value ai-memory artifact — the validation-gate discipline — **safely** on the
  recall surface, reusing wrxn's wiki + Brain + Recall with **no daemon, server, or store**.
- Propose-then-confirm + an audit trail means **no clobber, no poisoning**; trust is earned before any
  move to auto-apply.
- **Limits accepted:** current-session scope only; additive-only means small-page proliferation until
  harvest adds merge/dedup/decay; the two new tiers (`_rules`, `_slots`) require adapter, manifest,
  recall-allowlist, and validation-allowlist changes.
- The validation gate as a pure function is the **TDD seam** (mirrors Phase 2's `decideRecall`): the
  deterministic judge is unit-tested; the skill orchestrates propose → validate → present → confirm →
  write.

## Considered and rejected

- **Full ai-memory port** (persist per-event observations + a background review scheduler) — too heavy
  and violates "skill, no daemon"; the thin existing sessions give nothing to mine.
- **Transcript-read consolidation** — rich but huge (token cost), ephemeral/purgeable, fragile access
  from a kernel skill, and outside the wiki.
- **Merge-capable writes** — deferred to harvest; reintroduces the clobber/poisoning risk ai-memory
  itself deferred.
- **Auto-apply (literal decision 9)** — deferred until the gate earns trust on the recall surface.

## Sources

`akitaonrails/ai-memory` (full inspection 2026-06-16: `auto_improve.rs` validation gate + system
prompt, `batch_consolidate_system.md`, `docs/auto-improvement-loop.md` negative filters, the
tier/`kind` model, the decay formula). The Karpathy LLM-wiki gist (concept `karpathy-llm-wiki-pattern`).
Plan memory `wrxn-intelligence-rebuild-plan` (decisions 5/6/7/9). Kernel ADR 0002 (Recall), CONTEXT.md
(Brain/Recall/SYNAPSE/dream glossary).
