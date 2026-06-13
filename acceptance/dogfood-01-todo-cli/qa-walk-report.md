# QA-walk report — todo CLI

Walker: functional QA-walk against the REAL artifact (wrxn-kernel-22 dogfood, pipeline qa-walk stage)
Date: 2026-06-13
Artifact: `node bin/todo.cjs` @ commit 6b9507e
Result: **14 / 14 PASS** (10 issue ACs + 4 edge probes). 1 non-blocking finding filed.

## Method

Derived the walk plan from the PRD user stories + both issues' acceptance criteria, then executed
every promised command — plus edge probes beyond the ACs — against the real CLI in clean temp dirs,
asserting stdout + exit code + on-disk `.todos.json` state. (Not the unit tests — the real artifact.)

## Walk plan & evidence

### todo-01 — capture & view
| Check | Result |
|-------|--------|
| AC1 `add "buy milk"` on empty dir → `added #1` + `.todos.json` created | PASS |
| AC2 `list` → `[ ] #1 buy milk` | PASS |
| AC3 second `add` → id 2; `list` in id order | PASS |
| AC4 `add "   "` → error, non-zero, nothing written | PASS |
| AC5 `list` empty/absent → `no todos`, exit 0 | PASS |
| AC6 malformed `.todos.json` → error, store left intact | PASS |

### todo-02 — complete
| Check | Result |
|-------|--------|
| AC1 `done 1` → flips; `list` shows `[x] #1` | PASS |
| AC2 `done 1` again → idempotent, exit 0 | PASS |
| AC3 `done 99` (unknown) → error, store unchanged | PASS |
| AC4 `done abc` (non-numeric) → error, non-zero | PASS |

### CLI surface + edge probes
| Check | Result |
|-------|--------|
| no command → usage, non-zero | PASS |
| unknown command → usage, non-zero | PASS |
| EDGE `done` with no id → error | PASS |
| EDGE unquoted multiword `add hello world` → captures `hello`, drops `world` | PASS (finding filed) |

## Findings

- **QA-1 (non-blocking):** unquoted multi-word `add hello world` silently captures only `hello`.
  In-contract (PRD specifies quoted text) but surprising; filed as `.scratch/todo-cli/issues/03-finding-multiword-add.md`
  (needs-triage). Matches code-review finding #1.

## Verdict

The artifact does what the PRD + issues promised, demonstrated by running it. Ready for operator accept.
