---
id: todo-02
title: "S2 — complete a task (done <id>)"
status: open
labels: [ready-for-agent]
---

Status: ready-for-agent

## Parent

todo-cli PRD (.scratch/todo-cli/PRD.md)

## What to build

The second demoable slice: mark a captured task complete, reflected in `list`.

- `todo done <id>` → set that task's `done:true` in `.todos.json`, print confirmation.
- An already-done task stays done (idempotent).
- Unknown / non-numeric id → error + non-zero exit.

## Acceptance criteria

- [ ] with a task #1 present, `todo done 1` flips it; `todo list` then shows `[x] #1 <text>`
- [ ] `todo done 1` again is idempotent (stays done, exits 0)
- [ ] `todo done 99` (unknown id) errors to stderr + exits non-zero, changing nothing
- [ ] `todo done abc` (non-numeric) errors to stderr + exits non-zero

## Blocked by

- todo-01 (needs the store + a task to complete)
