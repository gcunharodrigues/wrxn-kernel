---
id: todo-01
title: "S1 — capture & view (add + list + JSON store)"
status: open
labels: [ready-for-agent]
---

Status: ready-for-agent

## Parent

todo-cli PRD (.scratch/todo-cli/PRD.md)

## What to build

The first demoable vertical slice: capture a task and view it. Includes the JSON store, because
`add` is not demoable without persistence + `list` to read it back.

- `todo add "<text>"` → append `{ id, text, done:false }` to `.todos.json` (cwd), print `added #<id>`.
- `todo list` → print each task as `[ ] #<id> <text>` (or `[x]` when done), in id order.
- Store: `.todos.json` array; absent file = empty list; malformed JSON = error + non-zero exit.
- id = max(existing ids) + 1 (1 for the first).

## Acceptance criteria

- [ ] `todo add "buy milk"` on an empty dir creates `.todos.json` and prints `added #1`
- [ ] `todo list` then prints `[ ] #1 buy milk`
- [ ] a second `add` gets id 2; `list` shows both in id order
- [ ] `todo add ""` (empty/whitespace) errors to stderr and exits non-zero, writing nothing
- [ ] `todo list` on an empty/absent store prints `no todos` and exits 0
- [ ] a malformed `.todos.json` makes any command error to stderr + exit non-zero (never silently reset)

## Blocked by

(none — the foundational slice)
