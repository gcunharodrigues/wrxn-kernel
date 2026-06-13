# Verticality review — todo-cli slices

Reviewer: fresh-context audit (wrxn-kernel-22 dogfood, pipeline verticality gate)
Date: 2026-06-13
Verdict: **PASS** — both slices are vertical, demoable, right-sized, dependencies correct.

## Method

Each slice audited against the four verticality violations: horizontal (a layer, not a feature),
not-demoable (can't be shown working end-to-end), too-coarse (bundles multiple features), and
dependency-error (wrong/missing prerequisite).

## todo-01 — capture & view (add + list + store)

| Check | Verdict | Note |
|-------|---------|------|
| Horizontal? | NO | Spans store→command→output for ONE user-visible capability (capture & view), not a single layer. |
| Demoable? | YES | `todo add "x"` then `todo list` shows it — a complete user-visible round-trip. |
| Too coarse? | NO | `add`+`list`+store is the minimal demoable unit; `add` alone is not demoable (nothing reads it back), so bundling `list` + the store is correct tracer-bullet sizing, not coarseness. |
| Dependency-error? | NO | Foundational slice, no prerequisite. |

## todo-02 — complete (done)

| Check | Verdict | Note |
|-------|---------|------|
| Horizontal? | NO | A discrete user capability (mark complete) end-to-end. |
| Demoable? | YES | `todo done 1` then `todo list` shows `[x]`. |
| Too coarse? | NO | Single small command. |
| Dependency-error? | NO | Correctly declares `blocked by todo-01` (needs the store + a task to complete). |

## Outcome

Both slices keep their `ready-for-agent` label. Build order: todo-01 → todo-02.
