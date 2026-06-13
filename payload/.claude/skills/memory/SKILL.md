---
name: memory
description: Install-local memory wiki adapter — query/recall/write-page operations over the 4-tier file wiki (concepts, decisions, gotchas, sessions)
user-invocable: true
---

# Memory Wiki — Adapter Skill

The WRXN memory wiki is a **4-tier, file-based, git-versioned** memory system accessed via the install-local adapter `.wrxn/wiki.cjs`. This skill documents the CLI surface and the indirection rule that lets the backend swap (file → MCP → daemon) without consumer rewrites.

## Indirection Contract (MUST)

> **Consumers of the memory wiki MUST call the `.wrxn/wiki.cjs` adapter. Direct wiki file reads are PROHIBITED.**

Rationale: the wiki backend can evolve (file → MCP → daemon) without rewriting routers, hooks, or skills. Direct file reads would couple consumers to the file backend and force a breaking refactor on every backend swap.

## Wiki layout

| Tier | Path | Purpose |
|---|---|---|
| Semantic | `.wrxn/wiki/concepts/` | Evergreen architecture and operator notes |
| Semantic | `.wrxn/wiki/decisions/` | Decisions / ADRs with rationale |
| Procedural | `.wrxn/wiki/gotchas/` | Failure modes and workarounds |
| Episodic | `.wrxn/wiki/sessions/` | Session-continuity notes |

Tiers are laid empty (a `.gitkeep` per tier) on `wrxn init` and fill as you write pages. Every read path returns cleanly over an empty wiki.

## CLI Surface — 3 subcommands

The adapter resolves the install root by walking up to the `wrxn.install.json` receipt, so it can be run from anywhere inside an install. Pass `--root <dir>` to override (mainly for tests).

### 1. `query`

Substring search across the wiki; ranked snippets with provenance (tier + file path + line number).

```bash
node .wrxn/wiki.cjs query "memory tiers"
node .wrxn/wiki.cjs query "synapse" --tier concepts --limit 5
```

Flags: `--tier <concepts|decisions|gotchas|sessions|all>` (default `all`), `--limit <N>` (default 20).
Output: JSON `{query, tier, total, returned, hits[]}` with `{tier, file, line, snippet}` per hit.

### 2. `recall`

Alias of `query` — same substring engine, page-level recall. Same flags and output shape.

```bash
node .wrxn/wiki.cjs recall "what did we decide about handoff"
```

### 3. `write-page`

Create a new wiki page in a tier. Refuses to overwrite an existing file.

```bash
node .wrxn/wiki.cjs write-page concepts new-fact --description "..." --body "..."
node .wrxn/wiki.cjs write-page gotchas failure-mode-x --description "X fails when..."
```

Positional args: `<tier>` (one of concepts|decisions|gotchas|sessions) and `<slug>` (kebab-case).
Flags: `--description "..."`, `--body "..."`. Output: JSON `{written, tier}`.

## Schema

Each page is a plain markdown file with a small frontmatter block:

```yaml
---
name: <kebab-case slug>
description: <one-line>
tier: <concepts|decisions|gotchas|sessions>
source: wiki-cli-write-page
---
```

## Source

WRXN Kernel issue wrxn-kernel-07 (memory wiki + recon config laydown). Adapter: `.wrxn/wiki.cjs`.
