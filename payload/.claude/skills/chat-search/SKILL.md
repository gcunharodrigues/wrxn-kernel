---
name: chat-search
description: On-demand retrieval over the Conversational log — grep an exact past moment (timestamp · session · role · snippet) across both arms: the event log AND the harness transcript (user and assistant turns). Operator- and agent-invocable; never an automatic hook.
user-invocable: true
---

# chat-search — on-demand retrieval over the Conversational log

`chat-search` retrieves an **exact past conversational moment** on demand — "what did I say about X", "you decided Y earlier". It greps the **Conversational log** (raw, machine-local scrollback), not the Brain: no embeddings, no recon/serve dependency, no index step (ADR 0008). It is **deliberate-only** — the operator types it or the agent reaches for it mid-reasoning (like `recon_find`). It is **never** wired as a `UserPromptSubmit` (or any automatic) hook — Recall's prose-only auto-surface stays the only per-prompt surface (ADR 0002 boundary).

> Scrollback, not memory. The Conversational log is ephemeral and pruned (~90d). Durable, portable memory remains the committed wiki — use the `memory` skill for that.

## Scope — both arms of the Conversational log

`chat-search` reads **both arms** and merges them into one recency-first result:

- **Event log** — `.wrxn/events/*.jsonl`, the per-session, secret-redacted **user prompts** emit-event.cjs appends.
- **Harness transcript** — `~/.claude/projects/<slug>/*.jsonl`, the only source of **assistant** turns and full user/assistant **message content**. The `<slug>` is the project's absolute path with every non-alphanumeric character replaced by `-` (how the harness names the dir). The transcript arm is **hygiene-cleaned** before matching (see below).

A prompt that appears in **both** arms is de-duplicated — by `(session, timestamp, text)` — so it surfaces once. If the transcript dir is **missing or unreadable**, the search **degrades loudly to events-only** and says so in the output (it never crashes).

The `--session` / `--since` / `--regex` flags are a follow-on slice (#85).

### Transcript hygiene (so a hit is real conversation, not framework noise)

- **Injected context is stripped** before matching: `<wrxn-orientation>`, `<synapse-rules>`, `<recall-surface>`, `<reference-candidate>`, and `<system-reminder>` blocks the hooks inject each turn are removed, so a term that lives **only inside** an injected block is **not** a hit.
- **Secrets are redacted** (the same canonical secret-shape set the memory adapters use): a credential echoed into chat never appears in a snippet.
- Only `text` content is searched — `thinking` / `tool_use` / `tool_result` blocks and unknown line `type`s (`summary`, `system`, …) are dropped.

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

- `role` is `user` (event log or a user transcript turn) or `assistant` (a transcript turn).
- The session column collapses to `this session` for hits from the active session.
- No match → an explicit `chat-search: nothing found for "<term>" ...` line (never silence, never a crash).
- If the transcript arm is unavailable, a trailing `chat-search: transcript arm unavailable — showing event-log results only.` line is appended (loud degrade).

## Boundaries

- **Pure in-process grep.** No Brain, no embeddings, no recon/serve/daemon, no network (ADR 0008). Node stdlib only (`fs` + `os` + `path`).
- **Read-only.** It never writes a wiki page, never mutates the event log or the transcript.
- **Never an automatic hook.** Invoked only by the operator or the agent, deliberately (ADR 0002).
- Default scope is **this project's sessions** — every `.jsonl` under `.wrxn/events/` plus this project's harness transcript under `~/.claude/projects/<slug>/`. The slug is **path-bounded** (it can never escape `~/.claude/projects`). Cross-project search is out of scope.

## Source

WRXN Kernel issues #83 (slice 1 — event-log arm) + #84 (slice 2 — harness-transcript arm + hygiene), under PRD #82. Engine: `.wrxn/chat-search.cjs`. Grounded by `docs/adr/0008-chat-search-ondemand-grep-outside-brain.md` and the `CONTEXT.md` terms **Conversational log** / **chat-search**.
