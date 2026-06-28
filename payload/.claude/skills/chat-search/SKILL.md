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

A prompt that appears in **both** arms is de-duplicated — by `(session, whitespace-normalized text, timestamp within a tight window)` — so a single turn surfaces once even when its two arms stamp it ms apart or differ by whitespace. If the transcript dir is **missing, unreadable, or wholesale-drifted** (present but every line an unknown type, so it yields no usable turn), the search **degrades loudly to events-only** and says so in the output (it never crashes).

Three optional flags refine a search — `--session` (scope to one session), `--since` (a time floor), and `--regex` (pattern match instead of substring). They compose with each other and with both arms. See **Scoping & match flags** below.

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
node .wrxn/chat-search.cjs <search-term...> [--root <dir>] [--session <id>] [--since <when>] [--regex]
```

The engine resolves the install root by walking up to the `wrxn.install.json` receipt, so it runs from anywhere inside an install. Pass `--root <dir>` to override (mainly for tests). Flags follow the search term(s). It prints the rendered result and exits 0 — a nothing-found result is a normal outcome, never an error exit. **Invalid flag input** (a malformed/catastrophic `--regex`, an unparseable `--since`, an unsafe `--session`) fails **loud**: one clear line on stderr and a non-zero exit — never a stack trace or a hang.

### Agent (self-invocation)

When the operator references an earlier moment ("like we discussed", "the decision from this morning") and you need the **exact** wording rather than a guess, run the engine and ground on what was actually said. Reach for it the same way you reach for `recon_find` — deliberately, when a past moment is needed.

## Scoping & match flags

All three are optional, compose with each other, and apply across **both arms** (so scoping/filtering also covers assistant turns), preserving recency order and cross-arm dedup.

- **`--session <id>`** — scope results to a single session (exact match on the session id). The id is the harness/event session id (letters, digits, `-`, `_`); a malformed id is rejected. Scoping only *narrows* the rows — it does **not** relabel them: the `this session` label tracks the genuinely-live session (`CLAUDE_SESSION_ID`), so scoping to a **past** session shows its real id, not `this session`.
- **`--since <when>`** — keep only hits at or after a timestamp floor. `<when>` is either `today` (from 00:00 **UTC** of the current day — record stamps are UTC) or an ISO-8601 date/datetime (e.g. `2026-06-26` or `2026-06-26T12:00:00Z`). A datetime **without an explicit zone** is read as **UTC** (matching the record stamps), not machine-local time. An undatable hit is excluded.
- **`--regex`** — match the search term as a **regular expression** instead of a case-insensitive substring. Regex mode is **case-sensitive** (the universal regex default; the substring default stays case-insensitive).

```bash
node .wrxn/chat-search.cjs "gate.*decision" --regex --since today
node .wrxn/chat-search.cjs baton echo --session 9dc65f19-65fb-43cb-81fa-0340353f1cc5
```

> **`--regex` safety (ReDoS).** The pattern is user-supplied and runs over whole transcripts, so it is bounded at compile (before any input is matched): it is **length-capped** (≤ 200 chars) and runs through a **nesting-aware static screen** that rejects a quantified group whose body repeats or alternates through **any** nesting depth — both flat shapes (`(a+)+`, `(a|a)+`, `(?:a*)*`) and nested ones a flat check misses (`((a)+)+`, `((\w)+)+$`, `((a+))+`, `(a(b+)c)+`) — plus **backreferences** (`\1`…`\9`). A rejected, malformed, or unparseable value fails loud. The screen is deliberately conservative (it also refuses the rare-but-safe `(foo|bar)+` — drop the outer quantifier), but does not over-reject ordinary grouping: `(foo|bar)`, `(ab)+`, `([a+])+`, `(?:ab)+`, `a{1,5}`, `\d{4}-\d{2}-\d{2}` are all fine. **Residual:** a static screen models structure, not match semantics, so under the no-timeout / `fs`-`os`-`path`-only constraint it refuses the known catastrophic shapes rather than proving a pattern safe; an exotic construct outside those shapes is not modelled.

## Output

Hits are **most-recent-first**, one per line:

```
<timestamp> · <session (or "this session")> · <role> · <snippet (±1 line context)>
```

- `role` is `user` (event log or a user transcript turn) or `assistant` (a transcript turn).
- The session column collapses to `this session` for hits from the genuinely-live session (`CLAUDE_SESSION_ID`), independent of any `--session` scope.
- No match → an explicit `chat-search: nothing found for "<term>" ...` line (never silence, never a crash).
- If the transcript arm is unavailable (missing, unreadable, or wholesale-drifted), a trailing `chat-search: transcript arm unavailable — showing event-log results only.` line is appended (loud degrade).

## Boundaries

- **Pure in-process grep.** No Brain, no embeddings, no recon/serve/daemon, no network (ADR 0008). Node stdlib only (`fs` + `os` + `path`).
- **Read-only.** It never writes a wiki page, never mutates the event log or the transcript.
- **Never an automatic hook.** Invoked only by the operator or the agent, deliberately (ADR 0002).
- Default scope is **this project's sessions** — every `.jsonl` under `.wrxn/events/` plus this project's harness transcript under `~/.claude/projects/<slug>/`. The slug is **path-bounded** (it can never escape `~/.claude/projects`). Cross-project search is out of scope.

## Source

WRXN Kernel issues #83 (slice 1 — event-log arm) + #84 (slice 2 — harness-transcript arm + hygiene) + #85 (slice 3 — scoping + match flags), under PRD #82. Engine: `.wrxn/chat-search.cjs`. Grounded by `docs/adr/0008-chat-search-ondemand-grep-outside-brain.md` and the `CONTEXT.md` terms **Conversational log** / **chat-search**.
