---
name: chat-search
description: On-demand retrieval over the Conversational log — grep an exact past moment (timestamp · session · role · snippet) from this project's event log. Operator- and agent-invocable; never an automatic hook.
user-invocable: true
---

# chat-search — on-demand retrieval over the Conversational log

`chat-search` retrieves an **exact past conversational moment** on demand — "what did I say about X", "you decided Y earlier". It greps the **Conversational log** (raw, machine-local scrollback), not the Brain: no embeddings, no recon/serve dependency, no index step (ADR 0008). It is **deliberate-only** — the operator types it or the agent reaches for it mid-reasoning (like `recon_find`). It is **never** wired as a `UserPromptSubmit` (or any automatic) hook — Recall's prose-only auto-surface stays the only per-prompt surface (ADR 0002 boundary).

> Scrollback, not memory. The Conversational log is ephemeral and pruned (~90d). Durable, portable memory remains the committed wiki — use the `memory` skill for that.

## Scope (slice 1 — event-log arm)

This slice reads **one arm** of the Conversational log: the **event log** at `.wrxn/events/*.jsonl` — the per-session, secret-redacted **user prompts** emit-event.cjs appends. The harness-transcript arm (the only source of **assistant** turns and full message content) and the `--session` / `--since` / `--regex` flags are follow-on slices; this slice establishes the engine seam.

## Invocation

### Operator

```
/chat-search baton echo
```

### Engine (what the skill runs)

```bash
node .wrxn/chat-search.cjs <search-term...> [--root <dir>]
```

The engine resolves the install root by walking up to the `wrxn.install.json` receipt, so it runs from anywhere inside an install. Pass `--root <dir>` to override (mainly for tests). It prints the rendered result and exits 0 — a nothing-found result is a normal outcome, never an error exit.

### Agent (self-invocation)

When the operator references an earlier moment ("like we discussed", "the decision from this morning") and you need the **exact** wording rather than a guess, run the engine and ground on what was actually said. Reach for it the same way you reach for `recon_find` — deliberately, when a past moment is needed.

## Output

Hits are **most-recent-first**, one per line:

```
<timestamp> · <session (or "this session")> · <role> · <snippet (±1 line context)>
```

- `role` is `user` for a prompt record.
- The session column collapses to `this session` for hits from the active session.
- No match → an explicit `chat-search: nothing found for "<term>" ...` line (never silence, never a crash).

## Boundaries

- **Pure in-process grep.** No Brain, no embeddings, no recon/serve/daemon, no network (ADR 0008).
- **Read-only.** It never writes a wiki page, never mutates the event log.
- **Never an automatic hook.** Invoked only by the operator or the agent, deliberately (ADR 0002).
- Default scope is **this project's sessions** — every `.jsonl` under `.wrxn/events/`. Cross-project search is out of scope.

## Source

WRXN Kernel issue #83 (slice 1 of PRD #82). Engine: `.wrxn/chat-search.cjs`. Grounded by `docs/adr/0008-chat-search-ondemand-grep-outside-brain.md` and the `CONTEXT.md` terms **Conversational log** / **chat-search**.
