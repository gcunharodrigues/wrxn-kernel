# SYNAPSE — the layer model

SYNAPSE assembles every prompt from three layers and returns them as one `<synapse-rules>` block.
The engine is `.claude/hooks/synapse-engine.cjs` (a `UserPromptSubmit` hook). It is self-contained
(imports nothing from the kernel package), reads only the install's own files, and is fail-open: any
fault emits an empty envelope and injects nothing.

## The layers

```
L0 Constitution  →  L1 Always-on domains  →  L6 Keyword-recall domains
```

Sections are emitted in manifest order, with the constitution always first.

### L0 — Constitution (never trimmed)

- **Source:** `.claude/constitution.md`.
- **Fires:** always, while `CONSTITUTION_STATE=active` in `.synapse/manifest`.
- **Rendering:** `renderConstitution` keeps each `##` article heading and its `-` bullets and drops
  the prose preamble; a wrapped bullet's continuation line is folded back into its bullet. The
  section is emitted as `[CONSTITUTION] (NON-NEGOTIABLE)` followed by the rendered articles.
- **Budget:** outside the token budget — the constitution is always kept, never trimmed.

### L1 — Always-on domains

- **Source:** `.synapse/<domain>` for any domain whose manifest entry sets `<DOMAIN>_ALWAYS_ON=true`.
- **Fires:** on every prompt, while `<DOMAIN>_STATE=active`.
- **Seeded domains:** `global` (operational invariants) and `pipeline` (the unified-dev build route).
- **Rendering:** the domain's `<DOMAIN>_RULE_<N>=text` lines, ordered by `N`, emitted as a numbered
  section headed `[<DOMAIN>]`.

### L6 — Keyword-recall domains

- **Source:** `.synapse/<domain>` for any domain whose manifest entry carries
  `<DOMAIN>_RECALL=word1,word2,...`.
- **Fires:** only when one of the recall words appears (case-insensitively) in the prompt, while
  `<DOMAIN>_STATE=active`.
- **Seeded domain:** `routing` (recall words `deploy,worktree,push,pull request,release,new project,issue`).
- **Rendering:** the domain's numbered rules, emitted under `[RECALL: <domain>]`.

## Assembly flow

1. Read `.synapse/manifest`; parse each domain's `STATE`, `ALWAYS_ON`, and `RECALL`.
2. If `CONSTITUTION_STATE=active`, render `constitution.md` as the always-kept L0 section.
3. For every other active domain in manifest order: an always-on domain loads unconditionally; a
   recall domain loads only if a trigger word is in the prompt. Render its rules.
4. Split the sections into the always-kept constitution and the trimmable rest; apply the flat token
   budget (see [token budget & handoff](brackets.md)).
5. Append the `[SYNAPSE-RULES-TRIM]` marker if anything was dropped, then the `[HANDOFF REQUIRED]`
   directive if consumed context is at/above the threshold.
6. Wrap everything in `<synapse-rules> … </synapse-rules>` and return it as `additionalContext`.

## Ordering & trimming priority

Sections keep manifest declaration order (constitution first). When the trimmable rules exceed the
budget, whole sections are dropped from the END of that order first — the last-declared domain is the
first to go, and the constitution is never dropped. See [token budget & handoff](brackets.md).

## Output format

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
  2. Run the handoff skill to write the baton (a compact handoff document).
  3. Tell the operator to /clear and open a fresh session, where the baton injects on resume.

</synapse-rules>
```

The trim marker appears only when a section was dropped; the handoff directive only at/above the
threshold. When no domains are active the engine injects nothing.

## Contract

| Aspect | Behavior |
|--------|----------|
| Event | `UserPromptSubmit` (event JSON on stdin) |
| Inject | `{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<synapse-rules>…" } }` |
| No-op | `{}` (inject nothing) |
| Install root | nearest ancestor holding `wrxn.install.json` (walked up from `CLAUDE_PROJECT_DIR` or cwd) |
| Failure mode | fail-open — any fault emits `{}` and never blocks the prompt |

## Source

| File | Purpose |
|------|---------|
| `.claude/hooks/synapse-engine.cjs` | The whole engine: parse → build sections → budget → handoff → assemble. |
| `.claude/constitution.md` | L0 source (the non-negotiable articles). |
| `.synapse/manifest` | Domain registry + budget/handoff scalars. |
| `.synapse/global`, `.synapse/pipeline`, `.synapse/routing` | The seeded domains. |
