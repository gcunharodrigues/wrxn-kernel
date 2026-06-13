# Code review — todo CLI (todo-01 + todo-02)

Reviewer: fresh-eyes pass (wrxn-kernel-22 dogfood, pipeline code-review stage)
Date: 2026-06-13
Commits: 1580344 (S1), 6b9507e (S2)
Verdict: **APPROVE-WITH-FINDINGS** — both slices meet their ACs; suite 11/11 green. 2 non-blocking findings.

## Scope

src/todo.cjs (core), bin/todo.cjs (shell wrapper), test/todo.test.cjs.

## Verified against the PRD behaviour contract

- Store: absent → `[]`; malformed JSON → error + non-zero, store left intact (test confirms bytes
  unchanged); non-array → error. ✓
- id = `max(existing)+1`, defensive against non-numeric ids (`Number(t.id)||0`). ✓
- `add` empty/whitespace → fail BEFORE any load/save, so nothing is written. ✓
- `list` empty → `no todos`; otherwise id-sorted with `[x]`/`[ ]`. ✓
- `done` numeric-validated, not-found → fail BEFORE save (store unchanged), idempotent on done. ✓
- unknown/no command → usage + non-zero. ✓
- run() never throws (try/catch → fail); bin only writes streams + exits. ✓

## Findings (non-blocking)

1. **Unquoted multi-word `add` drops trailing words.** `todo add hello world` → text = "hello"
   (only `args[0]`). The PRD contract specifies quoted text (`add "<text>"`), so this is in-contract,
   but a friendlier CLI would `join(' ')` the remaining args. Backlog, not a blocker.
2. **`save()` is a direct `writeFileSync` (not atomic).** A crash mid-write could truncate
   `.todos.json`. Acceptable for a single-user local todo; an atomic temp+rename would harden it.
   Backlog, not a blocker.

## Decision

APPROVE. Findings are quality backlog items, not correctness/security defects. Proceed to security review.
