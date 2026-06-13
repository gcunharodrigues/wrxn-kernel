# Security review — todo CLI (todo-01 + todo-02)

Reviewer: defensive review (wrxn-kernel-22 dogfood, pipeline security stage)
Date: 2026-06-13
Commits: 1580344 (S1), 6b9507e (S2)
Verdict: **PASS** — no findings.

## Threat surface examined

- **Injection.** User input (`text`, `id`) is never shelled, `eval`'d, or templated. `text` is stored
  via `JSON.stringify` (escapes control chars/quotes); `id` is regex-validated `^\d+$` before use. No
  command/JSON-injection path.
- **Path traversal.** The store path is fixed (`path.join(cwd, '.todos.json')`) — no user-controlled
  path segment, so no `../` escape. No file outside cwd is read or written.
- **Data integrity / loss.** A malformed store errors rather than silently resetting, and write paths
  return BEFORE save on every error branch (empty add, unknown id, non-numeric id), so a failed command
  never mutates the store.
- **Resource / DoS.** Bounded work (single file read + in-memory array). No network, no recursion, no
  unbounded loop.
- **Secrets.** None handled; nothing logged beyond user-supplied task text the operator already owns.

## Notes (not findings)

- `save()` is non-atomic (see code review finding #2) — a crash-durability concern, not a security
  vulnerability. Left as a quality backlog item.

## Decision

PASS. Proceed to QA-walk.
