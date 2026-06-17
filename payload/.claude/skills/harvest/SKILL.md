---
name: harvest
description: Curate the knowledge tiers — run a health-check, then through operator-confirmed proposals MERGE near-duplicate pages into one evidence-grounded survivor and FORWARD-LINK or FLAG superseded/orphaned pages. The destructive sibling to dream (additive) and sync (drift). Use when someone says "harvest", "curate the wiki", "merge duplicate pages", "clean up stale knowledge", or at handoff when there is curation debt.
user-invocable: true
---

# harvest — knowledge curation

harvest is the third maintenance loop, sibling to **dream** (consolidation, additive-only) and **sync**
(drift). It does what dream deliberately doesn't: **merge, forward-link, and flag** the four knowledge
tiers (`concepts` / `decisions` / `gotchas` / `_rules`), which silt up over time — near-duplicates pile
beside each other, superseded pages linger next to their replacements, and pages whose source code was
deleted go orphaned. Left alone, Recall surfaces a thicket where one clean page belongs.

You **propose**; the deterministic adapter **gates and writes**. Every destructive act is shown to the
operator and **nothing is merged, annotated, or deleted without confirmation** — and a rejected proposal
is re-checked at the write boundary, so it can never mutate a page. The only sanctioned hard-delete is a
**merge**: an absorbed page is deleted *only* once its content provably lives in the survivor.

## Indirection contract (MUST)

> Drive the adapter. NEVER edit, annotate, or delete a wiki page directly, and NEVER re-implement the gate.

- Health-check, merge (`stage` / `commit`), and decay (`decay propose` / `decay confirm`) all go through
  **`.wrxn/harvest.cjs`** — the report, the safety gate (secret-scan, integrity hash, path-confinement),
  the audit trail, and the writer.
- To DRAFT a survivor you may **read** the absorbed pages — they are plain `.md` at the paths the report
  gives — and confirm recall via **`.wrxn/wiki.cjs query`**. Reading never mutates; the indirection
  contract forbids only direct writes/deletes and re-implementing the gate.
- The skill is the **semantic** filter (you don't draft a junk merge); the adapter is the **mechanical**
  backstop (it rejects what slips through). A proposal the gate rejects is never written.

## The loop

1. **Health-check** — `node .wrxn/harvest.cjs check` writes a durable report; nothing is touched.
2. **Read the report** — one record per finding: `near_dup` clusters, `decay_candidate`s
   (orphaned / superseded), and `malformed` pages.
3. **Per finding, draft a proposal** — a merge survivor for a near-dup cluster; a `stale:` /
   `superseded_by:` annotation for a decay candidate.
4. **Stage** — `stage` (merge) or `decay propose` (annotate): record by-reference, the live page untouched.
5. **Present + confirm** — show the operator the survivor (and the pages it deletes) or the annotation, and
   wait. Nothing is written on staging alone.
6. **Commit** — `commit` (merge) or `decay confirm` (annotate) the operator-approved subset only.

If the report is clean, **say so and stop** — a tree with no debt is a successful no-op. Do not manufacture
findings.

## 1 — Health-check (`check`)

Run from inside the install (the adapter walks up to `wrxn.install.json` — no `--root` needed):

```bash
node .wrxn/harvest.cjs check
```

It scans the 4 tiers and writes a fresh, never-mutated `.wrxn/harvest/<ts>.jsonl`, then prints
`{ report, summary: { nearDupStatus, findings: { near_dup, decay_candidate, malformed } } }`. Read the
report file it names. Each record carries enough to seed a proposal:

- **`near_dup`** — a cluster of pages over the measured semantic-similarity threshold (`members[]` with
  `slug` / `path` / `tier`, the strongest-edge `score`). The merge candidates.
- **`decay_candidate`** — `subtype: "orphaned"` (its `derived_from:` source file is gone, carries
  `missing_source`). The decay candidates. Pages already annotated `stale:`/`superseded_by:` are treated
  as resolved and excluded. A supersession is raised via `decay propose` with a replacement target
  (operator/skill judgment), not auto-detected by `check`.
- **`malformed`** — bad frontmatter (the wiki-lint signal). Report-only here (see §4).

If `nearDupStatus` is `"unavailable"`, the recon serve door was cold — near-dup detection was **skipped**
(the local decay + malformed scans still ran). Tell the operator "near-dup unavailable — start
`recon-wrxn serve` and re-run `check`"; never read silence as "no duplicates".

## 2 — Merge (a `near_dup` cluster → one survivor)

A merge folds N near-duplicate pages into **one net-new survivor** and deletes the absorbed originals.
The survivor is a **fresh** page (a new kebab slug, a path that does not yet exist) — list **every**
near-dup member in `absorbed`, including any whose name you'd like to reuse (the adapter writes the
survivor *before* it deletes, so the survivor path can't already exist). The survivor's provenance lands
as `merged_from: [<absorbed slugs>]` on the surviving page.

### The merge reflection rubric (MUST — run it before you stage)

You are **merging, not authoring**. Read every absorbed page, then self-check the drafted survivor against
each one. Stage only if all four hold:

1. **No dropped facts.** Every distinct fact in *each* absorbed page appears in the survivor. A merge that
   loses knowledge is worse than no merge.
2. **No invented facts.** Every survivor line **traces to a source page** — do not add knowledge, dates,
   versions, paths, or claims that were not in an absorbed page. If it isn't in a source, it doesn't belong
   in the survivor.
3. **Union of evidence preserved.** Every evidence quote, citation, and provenance marker from each
   absorbed page is carried into the survivor — the merge is loss-free on evidence, not just on prose.
4. **No secrets.** Redact any credential that surfaced (the gate also rejects `contains_secret`, but you
   are the first filter).

If any check fails, fix the survivor and re-run the rubric. If the cluster members are **not** actually
duplicates (your judgment overrides the threshold), **abstain** — stage nothing for that cluster.

### Stage the merge (PROPOSE)

Write the proposal to a throwaway temp file and stage it by-reference (the live pages are untouched):

```bash
node .wrxn/harvest.cjs stage /tmp/harvest-merge.json
```

```jsonc
{
  "survivor":    ".wrxn/wiki/concepts/auth-flow.md",   // NEW path under a knowledge tier, .md, kebab slug
  "description": "one-line page description",            // becomes the survivor's frontmatter description
  "body":        "# Auth flow\n\n…the synthesised union…", // the rubric-checked survivor markdown
  "absorbed":    [".wrxn/wiki/concepts/login-flow.md", ".wrxn/wiki/concepts/auth-overview.md"]
}
```

`stage` path-confines the survivor + every absorbed target to a knowledge tier, rejects a body over the
cap, secret-scans, then records the proposal + an integrity hash under `.wrxn/harvest/staged.jsonl`. It
prints `{ staged, survivor, absorbed, stagedFile }` and **writes/deletes nothing**.

### Present, then confirm

Show the operator the **diff**: the absorbed pages (read them at the report's paths) and the one survivor
that replaces them, naming exactly which pages will be **deleted**. Wait for confirmation. If the operator
approves none, you are done — commit nothing.

### Commit the merge (CONFIRM, by reference)

Build a JSON array of the approved **survivor paths** (not a rebuilt proposal) and commit:

```bash
node .wrxn/harvest.cjs commit /tmp/harvest-approved.json   # [".wrxn/wiki/concepts/auth-flow.md"]  (or {"approved":[…]})
```

`commit` looks up each approved survivor's staged merge, **re-runs the gate** (secret-scan → integrity →
path-confine survivor + every absorbed → survivor is new), then **writes the survivor first** (knowledge
preserved) and **only then deletes each absorbed** (survivor-before-delete). It prints `{ merged, skipped }`.
An **empty** approval is the decline — nothing changes.

## 3 — Decay / supersession (a `decay_candidate` → annotate, never delete)

Decay is **non-destructive**: it stamps a single forward-link key into a page's frontmatter (the body is
byte-for-byte preserved) so Recall and the operator know its status. Provenance survives — decay never
deletes (deletion is merge's job alone). Two kinds:

- **`stale: <missing-source-path>`** — an orphaned page whose `derived_from:` source file is gone.
  Mechanical: `decay propose` **auto-derives** these from the same scan `check` ran — no draft needed.
- **`superseded_by: <path>`** — a page replaced by another. A **judgment** (auto-scan can't invent the
  replacement) — you draft it into a proposal file.

### Propose the decay (STAGE)

Auto-scan only (stages a `stale:` annotation for every orphaned page):

```bash
node .wrxn/harvest.cjs decay propose
```

Or pass a draft file to add `superseded_by:` judgments (it overrides the auto stale for the same page):

```bash
node .wrxn/harvest.cjs decay propose /tmp/harvest-decay.json
```

```jsonc
// one object, an array, or { "proposals": [ … ] }; key ∈ {stale, superseded_by}; value is a path
{ "page": ".wrxn/wiki/gotchas/old-auth-bug.md", "key": "superseded_by",
  "value": ".wrxn/wiki/gotchas/new-auth-bug.md", "reason": "replaced by the post-refactor write-up" }
```

`decay propose` gates each candidate — page confined + present, key allowlisted, value sanitised +
secret-scanned, the page **not reinforced** (a page surfaced in Recall within the last 30 days is live
knowledge and is skipped), and **not already annotated** (idempotent) — and records survivors to
`.wrxn/harvest/decay-staged.jsonl`. It prints `{ staged, skipped, stagedFile }`. A `skipped` entry names
its reason (`reinforced`, `already_annotated`, `unsafe_page`, …).

### Present, then confirm

Show the operator each staged annotation — the page, the key, the value, and the reason. Wait.

### Confirm the decay (COMMIT, by reference)

```bash
node .wrxn/harvest.cjs decay confirm /tmp/harvest-decay-approved.json   # ["…/old-auth-bug.md"] (or {"approved":[…]})
```

`decay confirm` re-gates each approved page and stamps the one frontmatter key in place (body preserved,
never deleted). It prints `{ annotated, skipped }`. An empty approval is the decline.

## 4 — Malformed pages (report-only)

`check` also reports pages with bad frontmatter. harvest does **not** auto-fix them — surface the list to
the operator to repair by hand (the wiki-lint Stop hook flags the same signal). Fixing frontmatter is
authoring, outside harvest's gated destructive scope.

## Boundaries

- **Curation only, on the 4 knowledge tiers.** Never the retired `sessions` tier, never `_slots`
  (the focus slot is dream's), never code.
- **Confirm-gated + re-checked.** Every merge and decay is staged, presented, and confirmed by reference;
  the gate re-validates at the write boundary, so a rejected/tampered proposal can never mutate a page.
- **Merge is the only hard-delete.** Decay forward-links / flags; it never deletes. No free-form delete
  path exists — only a staged cluster's absorbed members are ever removed.
- **Restraint.** A clean health-check is a success: say so, stage nothing, commit nothing.
- **Never autonomous.** harvest is deliberate and operator-confirmed — never a background sweep.

## Source

WRXN Kernel issue harvest-06, integrating harvest-02 (`check`), harvest-03 (merge `stage` / `commit`),
and harvest-04 (`decay propose` / `confirm`). Adapter: `.wrxn/harvest.cjs`. Skill + adapter shape and the
propose→confirm-by-reference spine adapted from `dream` (`SKILL.md`, `.wrxn/dream.cjs`) and the `sync`
report→propose→confirm walkthrough. ADR 0005; PRD `harvest-prd`.
