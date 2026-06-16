---
name: ingest
description: Distill a dropped source file (PDF/DOCX/HTML/PPTX/XLSX/TXT) into curated memory-wiki pages — a summary page + N note pages, each linked back to the raw source. Use when an operator drops a file in .wrxn/raw/ (or names one) and says "ingest this", "distill this document", or "turn this source into wiki notes".
user-invocable: true
---

# ingest — read → distill → split into notes

The distillation half of `wrxn ingest <file>`. Turns a raw source into compounding wiki knowledge,
following the Karpathy LLM-wiki pattern (Adler's *How to Read a Book*: read → distill → split into
notes). This is built as the first concrete slice of the Phase-3 `dream` ingest.

The work is **split** (the kernel executor pattern):

- **The harness is deterministic** (`lib/ingest.cjs` → `wrxn ingest`): convert the source to markdown,
  place/keep the raw under `.wrxn/raw/`, write the pages you produce with a `derived_from:` provenance
  stamp, and enforce the **additive-only** guard. You do NOT re-implement any of that.
- **You are the distillation step.** You read the converted markdown and produce the *content* — a
  summary page + N note pages. Your job is the curation quality.

## Scope (PRD decision E)

- **Inspectional + analytical depth**: 1 source → **1 summary page + N note pages**. Divide the source
  into its natural documents (sections / themes), one note page each.
- **Additive-only.** You CREATE new pages. You never edit an existing wiki page and never synthesise
  across sources — that is the `dream` loop, out of scope. The harness refuses to overwrite, so a slug
  that collides with an existing page is silently skipped: choose fresh, source-specific slugs.

## Loop

1. **Convert.** Read the converted markdown — either run `wrxn convert <file>` and read its output, or
   read what the harness converted. Do not parse the binary yourself.
2. **Read for the gist.** One pass for the whole; identify the source's structure and its key claims.
3. **Summary page.** One page capturing what the source IS and its main points — the inspectional read.
4. **Note pages.** One page per distinct theme/section — the analytical read. Each note is
   self-contained and titled by its idea, not "Section 3".
5. **Emit the result** as the structured object below and hand it to the harness.

## Result contract

The harness consumes this exact shape (the CLI accepts it via `--distillation <result.json>`):

```json
{
  "summary": { "slug": "paper-summary", "title": "...", "description": "one line", "body": "markdown" },
  "notes": [
    { "slug": "paper-method",  "title": "...", "description": "one line", "body": "markdown" },
    { "slug": "paper-results", "title": "...", "description": "one line", "body": "markdown" }
  ]
}
```

- `slug` — kebab-case (`[a-z0-9-]`), unique, source-specific (prefix with the source name to avoid
  collisions). The harness rejects a non-kebab slug.
- `summary` is required (`{slug, body}` minimum); `notes` is an array (≥1 in practice).
- `tier` is optional per page (default `concepts`; may be `concepts|decisions|gotchas|sessions`).
- The harness adds the `derived_from: .wrxn/raw/<file>` stamp, `role`, and `source: wrxn-ingest`
  frontmatter — you do not write frontmatter into `body`.

## Run

```bash
# the harness does convert → raw placement → provenance stamp → additive write:
wrxn ingest .wrxn/raw/paper.pdf --distillation result.json
```

Re-running on the same source is safe — existing pages are skipped, never clobbered.

## Source

WRXN Kernel issue multiformat-distill-06 (PRD decisions D + E). Harness: `lib/ingest.cjs`.
Converter: `lib/convert.cjs` (slice 05). Wiki: `.wrxn/wiki/` (see the `memory` skill).
