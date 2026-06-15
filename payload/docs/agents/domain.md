# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary, the canonical vocabulary for this project.
- **`docs/adr/`** — Architecture Decision Records. Read the ADRs that touch the area you're about to work in.

If either doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The producer skill (`grill-with-docs`) creates them lazily — `CONTEXT.md` when the first term is resolved, an ADR when a hard-to-reverse decision is actually made.

## File structure

A fresh install ships neither file. They appear at the repo root as the project's language and decisions accumulate:

```
/
├── CONTEXT.md        ← domain glossary (created lazily by grill-with-docs)
└── docs/
    └── adr/          ← one file per decision, named NNNN-<slug>.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 — but worth reopening because…_
