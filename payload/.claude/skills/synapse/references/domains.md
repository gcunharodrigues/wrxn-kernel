# SYNAPSE domains & rule files

A domain is a small `KEY=VALUE` file of rules that SYNAPSE injects into prompts. Each domain is
registered in `.synapse/manifest` and its rules live in a sibling file `.synapse/<domain>` (the
lowercased prefix). The engine reads them on every `UserPromptSubmit`.

## The kinds of domain

| Kind | How it fires | Manifest | Seeded example |
|------|--------------|----------|----------------|
| Constitution | always; never trimmed | `CONSTITUTION_STATE=active`, `_ALWAYS_ON=true` | sourced from `.claude/constitution.md` |
| Always-on (L1) | every prompt | `<DOMAIN>_STATE=active`, `_ALWAYS_ON=true` | `global`, `pipeline` |
| Keyword-recall (L6) | when a trigger word is in the prompt | `<DOMAIN>_STATE=active`, `_RECALL=word,...` | `routing` |

The constitution is the one special case: it has no `.synapse/` file — its body is rendered from
`.claude/constitution.md`.

## Rule-file format

Rules are `<DOMAIN>_RULE_<N>=text` lines, where `<DOMAIN>` is the uppercase prefix and `<N>` orders
the rules ascending. Blank lines and `#` comments are ignored.

```
# .synapse/global  (always-on, L1)
GLOBAL_RULE_0=git push, PR creation, and release tags are deliberate acts: devops promotes via `wrxn ship` (push the branch → open a PR → arm auto-merge) and a server-enforced ruleset merges only when CI is green — `devops` is a dispatch-phase label, not an authority.
GLOBAL_RULE_1=The unit of work is an issue with explicit acceptance criteria.
GLOBAL_RULE_2=Before building, apply the decision hierarchy: REUSE > ADAPT > CREATE.
```

At assembly the rules render as a numbered section headed by the domain — `[GLOBAL]` for an
always-on domain, `[RECALL: routing]` for a recall domain.

## The seeded domains

| File | Kind | What it carries |
|------|------|-----------------|
| `.synapse/global` | always-on | WRXN operational invariants (devops promotes via `wrxn ship`, issue-driven work, the decision hierarchy, conventional commits, the server-enforced CI push gate). |
| `.synapse/pipeline` | always-on | The unified-dev build route and how to scale it to the task. |
| `.synapse/routing` | keyword-recall | Representative recall rules (worktrees, deploys, the unit of work). |

`global` and `pipeline` are managed (kernel-owned, overwritten on `wrxn update`). `routing` is seeded
— operator-owned, created once at init and never overwritten on update. Edit `routing` freely; add
your own recall rules there.

## Adding a domain

There is no interactive creator — add a domain by editing two files:

1. Create `.synapse/<name>` with `<NAME>_RULE_0=...` lines.
2. Register it in `.synapse/manifest`:
   - always-on: `<NAME>_STATE=active` and `<NAME>_ALWAYS_ON=true`.
   - keyword-recall: `<NAME>_STATE=active` and `<NAME>_RECALL=word1,word2`.

See [the manifest format](manifest.md) and the [templates](../assets/README.md).

## Source

| File | Purpose |
|------|---------|
| `.synapse/manifest` | Domain registry. |
| `.synapse/<domain>` | The rule files. |
| `.claude/hooks/synapse-engine.cjs` | `domainRules` / `renderRulesSection` read + render them. |
