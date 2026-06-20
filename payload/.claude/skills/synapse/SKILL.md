---
name: synapse
description: "Use when someone wants to understand the SYNAPSE context engine, manage its rule domains, tune the token budget or handoff threshold, or troubleshoot why a rule did or didn't inject. Covers the real engine: the three layers (constitution / always-on / keyword-recall), the flat token budget, and the non-blocking handoff directive."
---

# SYNAPSE context engine

## What it is

SYNAPSE is the per-prompt context-injection engine. On every `UserPromptSubmit` it assembles the
install's active rule domains into a single `<synapse-rules>` block and returns it as
`additionalContext`, so each prompt carries the constitution plus the operational rules that apply.

It is one self-contained hook — `.claude/hooks/synapse-engine.cjs` — that ships into an install and
reads only the install's own files (`.claude/constitution.md`, the `.synapse/` domains, and the
`wrxn.install.json` receipt that marks the install root). It imports nothing from the kernel package.
It is **fail-open**: any fault (unparseable input, missing file, assembly error) emits an empty
envelope and injects nothing — the engine never blocks a prompt.

## The three layers

SYNAPSE assembles each prompt from three layers, in this order:

| Layer | Source | Fires |
|-------|--------|-------|
| **L0 — Constitution** | `.claude/constitution.md` | Always. Never trimmed by the budget. |
| **L1 — Always-on domains** | `.synapse/<domain>` where `<DOMAIN>_ALWAYS_ON=true` | Every prompt. (Seeded: `global`, `pipeline`.) |
| **L6 — Keyword-recall domains** | `.synapse/<domain>` with a `<DOMAIN>_RECALL=word,...` list | Only when a trigger word appears in the prompt. (Seeded: `routing`.) |

The constitution is rendered from `constitution.md` (article headings + their bullets) and sits
outside the token budget — it is always kept. Every other active domain contributes a numbered rules
section. See [the layer model](references/layers.md).

## How a domain is defined

Domains are registered in `.synapse/manifest` (flat `KEY=VALUE`) and their rules live in a sibling
file `.synapse/<domain>` (lowercased) as `<DOMAIN>_RULE_<N>=text` lines:

```
# .synapse/manifest
GLOBAL_STATE=active
GLOBAL_ALWAYS_ON=true

# .synapse/global
GLOBAL_RULE_0=git push, PR creation, and release tags are deliberate acts: devops promotes via `wrxn ship` (push the branch → open a PR → arm auto-merge) and a server-enforced ruleset merges only when CI is green — `devops` is a dispatch-phase label, not an authority.
GLOBAL_RULE_1=The unit of work is an issue with explicit acceptance criteria.
```

A domain loads only when `<DOMAIN>_STATE=active`. An always-on domain sets `_ALWAYS_ON=true`; a
keyword domain sets `_RECALL=word1,word2`. See [the manifest format](references/manifest.md) and
[domains & rule files](references/domains.md).

## The token budget

Everything except the constitution is trimmable. A single flat budget (`RULES_BUDGET_TOKENS`,
default 600; override `WRXN_RULES_BUDGET`) caps the trimmable sections; when the assembled rules
exceed it, whole sections are dropped lowest-priority-first and a visible `[SYNAPSE-RULES-TRIM]`
marker records what was dropped. One budget, applied flat. See
[token budget & handoff](references/brackets.md).

## The handoff directive

When real consumed context reaches the handoff threshold (`HANDOFF_PCT`, default 0.40; override
`WRXN_HANDOFF_PCT`) of the model window, SYNAPSE appends a **non-blocking** `[HANDOFF REQUIRED]`
directive: finish the current request, then `/clear` and resume in a fresh session — the continuity
baton writes automatically on session end (the memory synth) and injects on resume, so there is no
manual step. It never refuses work. The math runs on real token usage (resident tokens from the
transcript ÷ the resolved model window), not an assumed window. See
[token budget & handoff](references/brackets.md).

## Output shape

```
<synapse-rules>

[CONSTITUTION] (NON-NEGOTIABLE)
Article I — Agent Authority (NON-NEGOTIABLE)
  git push, PR creation, and release tags are deliberate acts. The deliberate act is a pull request, not a settings flag — devops promotes via `wrxn ship` and a server-enforced ruleset merges only once CI is green; `devops` is a dispatch-phase label, not an authority.
  ...

[GLOBAL]
  1. git push, PR creation, and release tags are deliberate acts: devops promotes via `wrxn ship` ...
  2. The unit of work is an issue with explicit acceptance criteria ...

[RECALL: routing]
  1. git push, PR creation, and release tags promote through `wrxn ship` (push → PR → arm auto-merge) ...

[SYNAPSE-RULES-TRIM] ROUTING dropped over the 600-token rules budget

[HANDOFF REQUIRED]
  Context is at ~42% of the model window (>= the 40% handoff threshold). NON-BLOCKING — do NOT stop work:
  1. Finish the current request.
  2. Tell the operator to /clear and open a fresh session. No manual step: the continuity baton writes automatically when this session ends (the memory synth) and injects on resume.

</synapse-rules>
```

The trim marker appears only when a section was dropped; the handoff directive only at/above the
threshold. When no domains are active the engine injects nothing.

## Configuration

| Knob | Where | Effect |
|------|-------|--------|
| `RULES_BUDGET_TOKENS` | `.synapse/manifest` | Trimmable-rules token ceiling (default 600). |
| `HANDOFF_PCT` | `.synapse/manifest` | Handoff threshold as a window fraction (default 0.40). |
| `CONTEXT_WINDOW` | `.synapse/manifest` | Pin the model window (tokens) for the handoff math. |
| `WRXN_RULES_BUDGET` | env | Overrides `RULES_BUDGET_TOKENS`. |
| `WRXN_HANDOFF_PCT` | env | Overrides `HANDOFF_PCT`. |
| `WRXN_CONTEXT_WINDOW` | env | Forces the model window unconditionally. |

See [invocation & configuration](references/commands.md).

## References

| Guide | Covers |
|-------|--------|
| [The layer model](references/layers.md) | the L0/L1/L6 assembly, ordering, constitution rendering, output format |
| [The manifest format](references/manifest.md) | the `.synapse/manifest` keys and scalars |
| [Domains & rule files](references/domains.md) | the seeded domains, the `RULE_N` format, adding a domain |
| [Token budget & handoff](references/brackets.md) | the flat budget governor + the non-blocking handoff |
| [Invocation & configuration](references/commands.md) | how the hook is wired, the env/manifest knobs, troubleshooting |
| [Templates](assets/README.md) | domain-file and manifest-entry templates |

## Key files

| File | Purpose |
|------|---------|
| `.claude/hooks/synapse-engine.cjs` | The engine (UserPromptSubmit hook). |
| `.claude/constitution.md` | L0 source — the non-negotiable articles. |
| `.synapse/manifest` | Domain registry + budget/handoff scalars. |
| `.synapse/global`, `.synapse/pipeline` | Seeded always-on (L1) domains. |
| `.synapse/routing` | Seeded keyword-recall (L6) domain. |
