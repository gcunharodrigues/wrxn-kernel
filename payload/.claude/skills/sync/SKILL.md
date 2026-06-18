---
name: sync
description: Report which derived docs have drifted from the source code they describe — query recon's computable drift set over the warm serve door and list each stale page, the source symbol that moved, and the watermark it was last reconciled at. Use when someone says "sync", "check for stale docs", "what docs have drifted", or wants to know if the prose is still reconciled with the code before a handoff or release.
user-invocable: true
---

# sync — drift report

`sync` tells you which **derived prose** has fallen out of step with the **source code** it documents.
A page that declares `derived_from: path#symbol` carries a `synced_to:` watermark — the source version
it was last reconciled against. recon-wrxn computes, purely from its index, the set of docs whose source
symbol has since changed (an AST fingerprint, so reformatting and comment edits do **not** trip drift).
This skill **queries that set and reports it**. It is the third maintenance loop alongside `dream`
(memory) — `sync` keeps derived prose reconciled with source.

> The **report** is read-only — it never edits a doc or advances a watermark. For **prose** drift you can
> then go one step further: `sync` can DRAFT a reconciling edit and, on your explicit confirm, write it in
> place and advance the watermark (the `propose → confirm` loop below). Auto-regen of *mechanical* derived
> files is still a separate, later step.

## Indirection contract (MUST)

> Drive the adapter. NEVER hand-compute drift, re-read a doc's frontmatter, or write any file.

- The drift query goes through **`.wrxn/sync.cjs report`** (the install-local door client + report gate).
- The adapter consumes the `synced_to` watermark **from the recon_drift door response** — recon parsed
  it out of the doc's frontmatter. Do not open wiki files to re-derive it; `sync` is strictly read-only.

## The loop

1. **Run the report** from inside the install (the adapter walks up to `wrxn.install.json` — no `--root`
   needed):

   ```bash
   node .wrxn/sync.cjs report
   ```

2. **Read the JSON** it prints — `{ status, stale[], unwatermarked[], orphaned[] }`:

   - **`status: "synced"`** — both the stale AND orphaned sets are empty. **Say so briefly ("all synced") and
     stop.** Do not manufacture findings. A clean tree is a successful no-op.
   - **`status: "drift"`** — present each `stale[]` entry to the operator: the **doc** page, the **symbol**
     that moved, and **`synced_to` → `current`** (the watermark vs the source's current fingerprint). If
     `orphaned[]` is non-empty, flag those DISTINCTLY — each is a **dangling** doc (`doc` + `synced_to`) whose
     `derived_from:` source symbol was **renamed or deleted**, so its provenance is gone and drift can no
     longer be computed. The reconcile loop below cannot fix an orphan (there is no live source to re-stamp
     against); surface it so the operator can re-anchor or retire the page. If `unwatermarked[]` is non-empty,
     note those separately — docs that declare `derived_from` but were never watermarked.
   - **`status: "unavailable"`** — recon's serve door is not warm (no `recon-wrxn serve` running, or it was
     unreachable). Report "drift unavailable — start `recon-wrxn serve` and retry." Never treat this as
     "all synced": unknown is not clean.

3. **Decide per stale doc.** Hand the stale list to the operator. For a **prose** page, you may reconcile
   it with the `propose → confirm` loop below. Regenerating a *mechanical* derived file is still out of
   scope here.

## Propose → confirm (prose re-stamp, sync-06)

For a stale PROSE doc, reconcile it WITHOUT ever auto-rewriting words: you draft the edit, the operator
confirms, then the watermark advances. The watermark means **"verified fresh"**, never "stamped without
checking". Same split as `dream`: **you (the skill) draft the prose; `.wrxn/sync.cjs` gates and writes.**

1. **Draft + propose (stage).** From a `stale[]` entry, write the reconciling markdown body and stage it
   by-reference — secret-scanned, recorded under `.wrxn/sync/staged.jsonl`, the live doc untouched:

   ```bash
   node .wrxn/sync.cjs propose proposal.json
   ```

   `proposal.json` carries the drift record's own fields (do NOT re-derive them) plus your drafted body:

   ```json
   { "doc": ".wrxn/wiki/concepts/auth-flow.md", "symbol": "src/auth.ts#login",
     "synced_to": "<old watermark from the report>", "current": "<current fingerprint from the report>",
     "body": "# Auth flow\n\n…the reconciled prose…" }
   ```

2. **Present it to the operator and wait.** Show the drafted edit. Nothing is written and the watermark is
   NOT advanced until the operator confirms — staging alone never re-stamps.

3. **Confirm (commit) or decline.** On approval, confirm BY REFERENCE (the doc path). The adapter re-reads
   the staged edit, re-runs the secret-scan + an integrity check (a tampered or altered proposal cannot
   write), edits the doc in place, and advances `synced_to:` to `current`:

   ```bash
   node .wrxn/sync.cjs confirm approved.json
   ```

   where `approved.json` is the operator-approved doc list — `[".wrxn/wiki/concepts/auth-flow.md"]` or
   `{ "approved": [".wrxn/wiki/concepts/auth-flow.md"] }`. **Decline** = confirm an empty approval
   (`{ "approved": [] }`) — the file AND the watermark stay exactly as they were.

## Boundaries

- **Report is read-only.** Prose `propose → confirm` is the ONLY write path, and only on explicit operator
  confirm. Regen of mechanical derived files is a later sync slice.
- **Never auto-rewrite words.** The reconciling edit is staged and presented; the in-place write + watermark
  advance happen only on confirm, re-validated at the write boundary.
- **Declared provenance only.** Only docs carrying a `derived_from:` anchor participate; an undocumented
  file is never "drifted". This is opt-in by provenance, by design.
- **Fail-soft, never alarmist.** If recon is unreachable the answer is "unavailable", not "stale" and not
  "synced". The adapter never throws; neither should your report.

## Source

WRXN Kernel issues sync-04 (report) + sync-06 (prose propose → confirm → re-stamp). Adapter: `.wrxn/sync.cjs`.
Drift signal: recon-wrxn `recon_drift` (sync-03), watermark storage (sync-01) + AST fingerprint (sync-02).
Door discovery mirrors `recall-surface.cjs`; skill+adapter shape (stage → commit-by-reference, secret-scan)
mirrors `dream`. PRD `sync-prd`; ADR 0004.
