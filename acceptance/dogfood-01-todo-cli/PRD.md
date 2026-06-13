# PRD: `todo` — a tiny CLI todo list

Status: ready-for-agent
Source: wrxn-kernel-22 pipeline dogfood (grilled 2026-06-13)

## Problem

You need to jot and track small tasks from the terminal without leaving it, opening an app, or
touching a network service. CLI-First (constitution): the whole capability must work from the shell.

## Goal

A single `todo` CLI that adds tasks, lists them, and marks them done, persisting to a plain JSON
file in the current directory. Small, inspectable, fully exercisable from the command line.

## Users & stories

- As an operator, I run `todo add "<text>"` to capture a task and see it confirmed.
- As an operator, I run `todo list` to see all my tasks with their done-state.
- As an operator, I run `todo done <id>` to mark a task complete and see it reflected in `list`.

## Scope (this dogfood)

Two vertical slices, each independently demoable end-to-end:

- **S1 — capture & view** (`add` + `list`): `todo add "<text>"` appends a task and prints `added #N`;
  `todo list` prints each task as `[ ] #id text` / `[x] #id text`. This slice includes the JSON store
  (load/save `.todos.json` in cwd) because `add` is not demoable without persistence + `list`.
- **S2 — complete** (`done <id>`): `todo done <id>` flips a task's done-state; `list` then shows `[x]`.

## Behaviour contract

- **Store**: `.todos.json` in the current directory; an array of `{ id, text, done }`. Absent file →
  treated as an empty list. Malformed JSON → error to stderr + non-zero exit (never silently reset).
- **id**: `max(existing ids) + 1` (1 for the first task).
- `add` with empty/whitespace text → error + non-zero exit.
- `list` on an empty list → prints `no todos`.
- `done <id>` with an unknown/non-numeric id → error + non-zero exit; an already-done task stays done
  (idempotent).
- No command / unknown command → usage to stderr + non-zero exit.
- Exit `0` on success, non-zero on any error.

## Acceptance

- Every behaviour-contract line is demonstrated by running the real `todo` CLI (not just unit tests).
- `add` → `list` → `done` → `list` round-trips against a real `.todos.json`.
- Error paths (empty add, unknown id, unknown command, malformed store) each exit non-zero with a
  message.

## Non-goals

- No `rm`/edit/priority/due-date/tags (deliberately out of scope for the dogfood).
- No global/home store, no `--store` override, no config file.
- No colour/TTY formatting; plain text only.
