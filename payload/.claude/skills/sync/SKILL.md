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

> This slice is **report only**. It never edits a doc, regenerates a file, or advances a watermark.
> Auto-regen of mechanical files and propose→confirm for prose are separate, later steps.

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

2. **Read the JSON** it prints — `{ status, stale[], unwatermarked[] }`:

   - **`status: "synced"`** — the stale set is empty. **Say so briefly ("all synced") and stop.** Do not
     manufacture findings. A clean tree is a successful no-op.
   - **`status: "drift"`** — present each `stale[]` entry to the operator: the **doc** page, the **symbol**
     that moved, and **`synced_to` → `current`** (the watermark vs the source's current fingerprint). If
     `unwatermarked[]` is non-empty, note those separately — docs that declare `derived_from` but were
     never watermarked (so drift can't yet be computed for them).
   - **`status: "unavailable"`** — recon's serve door is not warm (no `recon-wrxn serve` running, or it was
     unreachable). Report "drift unavailable — start `recon-wrxn serve` and retry." Never treat this as
     "all synced": unknown is not clean.

3. **Stop at the report.** Fixing the drift (regenerating a mechanical file, or proposing a reconciling
   prose edit for the operator to confirm) is out of scope here. Hand the stale list to the operator as
   the actionable output.

## Boundaries

- **Report only.** No writes, no regen, no re-stamp — those are later sync slices.
- **Declared provenance only.** Only docs carrying a `derived_from:` anchor participate; an undocumented
  file is never "drifted". This is opt-in by provenance, by design.
- **Fail-soft, never alarmist.** If recon is unreachable the answer is "unavailable", not "stale" and not
  "synced". The adapter never throws; neither should your report.

## Source

WRXN Kernel issue sync-04. Adapter: `.wrxn/sync.cjs`. Drift signal: recon-wrxn `recon_drift` (sync-03),
watermark storage (sync-01) + AST fingerprint (sync-02). Door discovery mirrors `recall-surface.cjs`;
skill+adapter shape mirrors `dream`. PRD `sync-prd`; ADR 0004.
