---
name: write-an-agent
description: Create a state-of-the-art interactive Claude Code subagent (.claude/agents/<name>.md) through a guided interview — pin its single job, routing trigger, least-privilege tools (you approve the grant), model, and a mandatory compressed output contract, then scaffold and validate the subagent file. Use when someone wants to create, add, or scaffold a subagent, build a custom agent, or says "write an agent", "create an agent", or "new subagent".
---

# Writing an Agent

Scaffold an **interactive subagent** — a `.claude/agents/<name>.md` file spawned via the Agent/Task
tool — through a short interview that gets the few SOTA levers right. Your job here is not to fill a
template; it is to **interrogate the job until the subagent is sharp, cheap, and safe**, then write a
validated file.

**Scope:** interactive helpers (locators, reviewers, runners you call in-session). **Not** AFK
pipeline executors — those live in the kernel's dispatch-executor registry (`wrxn dispatch`). If the
user wants a workflow *they* follow inline, write a skill instead (`write-a-skill`).

## Why a subagent (the levers that make it good)

A subagent is a **separate context** with its own tools, model, and system prompt. The caller sees
**only its final message**. That one fact drives every lever:

| Lever | Why |
|---|---|
| **Single responsibility** | One narrow job → sharp prompt → correct routing. An "and" means two subagents. |
| **`description` = #1 routing lever** | The main thread matches this text to delegate. Vague → mis-routed. Use "use PROACTIVELY" + trigger phrases. |
| **Least-privilege `tools`** | Omitting `tools` inherits ALL tools. Smaller surface = safer + cheaper. |
| **Compressed output contract** | The caller eats only the final message. A terse fixed shape is the highest-value, most-skipped lever. |
| **Stateless** | No memory but the spawn prompt + this file. Put everything it needs on the page. |
| **Model match** | Mechanical → haiku; reasoning → sonnet; hard → opus. |

## File format (verified — code.claude.com/docs sub-agents)

```
---
name: <kebab-case, equals the filename>
description: >
  <what it does> + WHEN. Include "use PROACTIVELY" + trigger phrases.
tools: Read, Grep, Glob          # explicit allowlist ALWAYS — omitting inherits ALL tools
model: haiku                      # haiku | sonnet | opus | inherit
skills: tdd                       # OPTIONAL — preloads that skill's content at startup
---
<system prompt — SOTA body order below>
```

Real fields: `name`, `description`, `tools`, `model`, `skills` (advanced: `disallowedTools`,
`permissionMode`). Don't invent others.

## Interview — run in this order

1. **Job** — the ONE responsibility. If it needs an "and", STOP and propose two subagents.
2. **Trigger** — when should the main thread delegate? → becomes `description`:
   `<what it does>. Use PROACTIVELY when <the exact situations/phrases that route to it>.`
3. **Propose frontmatter → ONE consolidated approval.** Infer from the job, then show `tools` +
   `model` + `skills` together as a single preview; the operator approves or edits before you continue:
   - **tools** — the minimal allowlist. Locator/reviewer → `Read, Grep, Glob`; + run things → `+Bash`;
     mutates files → `+Edit, Write`; research → `WebFetch, WebSearch`; integration →
     `mcp__<server>__<tool>` (named, never `*`). **Never omit** (= inherit-all). **Never grant a push
     path** (no devops). Flag `Bash` as broad (reaches `git` + the network).
   - **model** — mechanical → `haiku`, reasoning → `sonnet`, hard → `opus`, match the caller → `inherit`.
   - **skills** — propose only if the job maps to a skill **installed here** (`.claude/skills/<name>/`
     exists; a dangling preload = a broken subagent). Don't auto-add `caveman` — compression ships via
     the body instruction, which is portable.
4. **Output contract (mandatory)** — pin exactly what returns + how terse: a fixed return shape (e.g.
   `path:line — finding`, one per line; or small JSON) **and** a compression instruction (lead with the
   answer, drop prose, backtick exact paths/symbols). Don't finish the subagent without it.
5. **Generate → validate → write** (below).

## Body structure (SOTA order — every subagent)

1. **Role** — one line: who it is + the single job.
2. **Process** — the numbered steps it follows.
3. **Constraints** — hard NOs: what it refuses (scope creep; edits if read-only; ever pushing).
4. **Output contract** — the fixed return shape + **one concrete example**. State plainly: *your final
   message IS the return value — return the result, not a conversational reply.* Compress.
5. **Stateless reminder** — it gets only its spawn prompt + this file; no main-thread memory, no
   inherited CLAUDE.md persona. Keep the page self-sufficient.

## Validate (loose by design)

- [ ] `---` fences open/close; `name` present, kebab-case, equals the filename.
- [ ] `description` says **what** + **when** (the routing trigger; uses "use PROACTIVELY").
- [ ] `tools` is an explicit allowlist of **real** tools; present, never omitted; no push path.
- [ ] `model` ∈ `haiku | sonnet | opus | inherit`.
- [ ] `skills` (if present) names a skill that exists under `.claude/skills/`.
- [ ] Body has Role + Process + Constraints + Output contract (with an example).
- Don't hard-gate `tools` against a frozen list — new MCP tools are valid.

## Write + load

- Write `.claude/agents/<name>.md` at the install root. **Brownfield-safe**: if it exists, STOP —
  offer to edit or rename, never overwrite.
- **Loading:** a file written to disk is **not live this session**. Tell the operator to **restart
  Claude Code, or create/refresh it via the `/agents` interface** (which loads immediately). Then it is
  invokable by the Agent/Task tool, a workflow, or FleetView.

See **[EXAMPLES.md](EXAMPLES.md)** for a complete worked subagent.
