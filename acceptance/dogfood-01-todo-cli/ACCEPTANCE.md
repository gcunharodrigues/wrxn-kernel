# Acceptance record — dogfood-01 (todo CLI)

**Issue:** wrxn-kernel-22 — pipeline dogfood acceptance (the PRD's headline acceptance test).
**Date:** 2026-06-13
**Verdict:** ACCEPTED by the operator (Guilherme) after walking the real CLI.

## What this proves

A small CLI mini-app was built through the ENTIRE WRXN pipeline inside a real `wrxn init` install
(80 payload files: the 13 hooks incl. the session-lifecycle + intelligence-surface set, 17 skills,
the local tracker, the 4 wiki tiers). Every pipeline stage produced its artifact, archived here.

## The pipeline run

| Stage | Artifact (this dir) | Result |
|-------|---------------------|--------|
| grill | (HITL — design locked: todo CLI, cwd `.todos.json`, 2 vertical slices) | done |
| PRD | `PRD.md` | done |
| issues | `issues/01-add-list.md`, `issues/02-done.md` | done |
| verticality review | `verticality-review.md` | **PASS** |
| tdd build | commits `1580344` (S1), `6b9507e` (S2); unit suite 11/11 | done |
| code review | `review-todo-cli.md` | **APPROVE-WITH-FINDINGS** (2 non-blocking) |
| security review | `security-todo-cli.md` | **PASS** (no findings) |
| QA-walk | `qa-walk-report.md` | **14/14** vs the real CLI |
| findings filed | `issues/03-finding-multiword-add.md` | needs-triage (non-blocking) |
| operator accept | this file | **ACCEPTED** |

Executor harness (wrxn-kernel-18/19) was dogfooded mid-run: `wrxn dispatch <issue> --executor builder`
produced the build dispatch spec from the real `todo-01` issue (tdd skill, fresh-context, 6 ACs, the
no-push boundary constraint).

## Acceptance evidence (real CLI)

```
$ todo add "ship the kernel"   → added #1
$ todo add "write the docs"    → added #2
$ todo done 1                  → done #1
$ todo list                    → [x] #1 ship the kernel
                                 [ ] #2 write the docs   (exit 0)
```

## Where the mini-app lives

The built install + mini-app: `/home/guilherme/Documents/_projects/wrxn-dogfood-mini`
(sibling of the kernel repo; its own git, 6-commit pipeline trail). This directory is the durable
acceptance RECORD; the install is the working evidence.

## Non-blocking carry-overs

- `todo-03` — unquoted multi-word `add` drops trailing words (in-contract; UX sharpening). Filed,
  left for the mini-app's own triage. Also code-review finding #1.
- `save()` is non-atomic (code-review finding #2) — crash-durability, not correctness/security.
