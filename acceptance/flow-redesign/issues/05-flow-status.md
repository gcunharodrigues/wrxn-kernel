# 05 — flow status (derived progress board)

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

`wrxn flow status [prd]` — a pure aggregator `flowStatus(issues, artifacts)` that reconstructs each slice's
gate progress (build / review / security / qa) from the durable artifacts (green commit referencing the
issue id, the review marker, the security report, the walk-findings), plus a thin CLI that prints the
board. **No separate mutable state store** — the artifacts are the truth. End-to-end: running the command
on a PRD's issue set prints the board; a slice missing an artifact reads as not-yet-done, never as a false
pass.

## Acceptance criteria

- [ ] `flowStatus(issues, artifacts)` maps issues + present/absent artifacts → per-slice board states (done / in-progress / queued; stalled when a prior gate passed but the next is long-missing).
- [ ] A missing artifact ⇒ not-yet-done (never a false pass).
- [ ] `wrxn flow status [prd]` prints the board (thin I/O around the pure function).
- [ ] Unit tests cover full / partial / empty artifact sets (Seam 1b; prior art: the `lib/executor.cjs` tests).
- [ ] No new mutable flow-state file is introduced (derive-only).
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- None — can start immediately.
