# SYNAPSE manifest reference

`.synapse/manifest` is the domain registry. The engine (`.claude/hooks/synapse-engine.cjs`) reads it
on every `UserPromptSubmit` to learn which domains exist, when each fires, and the budget/handoff
scalars. It is a flat `KEY=VALUE` file; blank lines and `#` comment lines are ignored.

## Per-domain keys

Each domain has a unique uppercase prefix (e.g. `GLOBAL`, `PIPELINE`, `ROUTING`). The engine reads
exactly three per-domain keys:

| Key | Values | Meaning |
|-----|--------|---------|
| `<DOMAIN>_STATE` | `active` \| anything else | The domain loads only when `active`. |
| `<DOMAIN>_ALWAYS_ON` | `true` \| `false` | `true` ⇒ load on every prompt (an L1 domain). |
| `<DOMAIN>_RECALL` | `word1,word2,...` | Load only when a listed word appears in the prompt (an L6 domain). |

A domain is always-on **or** keyword-recall: set `_ALWAYS_ON=true` for the first, `_RECALL=...` for
the second. The `CONSTITUTION` domain is special — only its `_STATE`/`_ALWAYS_ON` are read; its body
comes from `.claude/constitution.md`, not a domain file.

No other per-domain keys exist. There are no agent/workflow/task triggers, no exclude lists, and no
"non-negotiable" flag in the manifest — the constitution's always-kept status is built into the
engine, not declared here.

## Scalars

The engine also reads these non-domain keys, which tune the budget governor and the handoff directive:

| Key | Default | Meaning |
|-----|---------|---------|
| `RULES_BUDGET_TOKENS` | `600` | Token ceiling on the trimmable sections (the constitution is exempt). |
| `HANDOFF_PCT` | `0.40` | Fraction of the model window at which the non-blocking handoff fires. |
| `CONTEXT_WINDOW` | (unset) | Optional: pin the model window (in tokens) used by the handoff math. |

Each can be overridden per-session by an env var — see [token budget & handoff](brackets.md) and
[invocation & configuration](commands.md).

## The seeded manifest

```
# L0 — Constitution (NON-NEGOTIABLE). Always; never trimmed.
CONSTITUTION_STATE=active
CONSTITUTION_ALWAYS_ON=true

# L1 — Global operational invariants. Always-on.
GLOBAL_STATE=active
GLOBAL_ALWAYS_ON=true

# L1 — Pipeline (the unified-dev build route). Always-on.
PIPELINE_STATE=active
PIPELINE_ALWAYS_ON=true

# L6 — Keyword-recall. Loads .synapse/routing when a trigger word appears.
ROUTING_STATE=active
ROUTING_RECALL=deploy,worktree,push,pull request,release,new project,issue

# Budget governor + handoff threshold.
RULES_BUDGET_TOKENS=600
HANDOFF_PCT=0.40
```

## Domain → file mapping

A domain's rules live in a sibling file named for the lowercased prefix:

| Prefix | File | Layer |
|--------|------|-------|
| `CONSTITUTION` | `.claude/constitution.md` (special) | L0 |
| `GLOBAL` | `.synapse/global` | L1 |
| `PIPELINE` | `.synapse/pipeline` | L1 |
| `ROUTING` | `.synapse/routing` | L6 |

## Troubleshooting

**A domain's rules never appear.**
1. Check `<DOMAIN>_STATE=active`.
2. For an always-on domain, check `<DOMAIN>_ALWAYS_ON=true`.
3. For a recall domain, check the prompt actually contains one of the `<DOMAIN>_RECALL` words.
4. Check the sibling `.synapse/<domain>` file exists and has `<DOMAIN>_RULE_<N>=...` lines.
5. If the rules budget is tight, the section may have been dropped — look for a `[SYNAPSE-RULES-TRIM]`
   marker naming it.

**Format rules.** Keys are `KEY=VALUE` with no spaces around `=`; comments start with `#`; values
hold no newlines.

## Source

| File | Purpose |
|------|---------|
| `.synapse/manifest` | The registry itself. |
| `.claude/hooks/synapse-engine.cjs` | `parseSynapseManifest` / `manifestValue` read this file. |
