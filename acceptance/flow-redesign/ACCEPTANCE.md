# Acceptance — flow-redesign (v0.10.0)

**Accepted:** 2026-06-18, operator (Guilherme). **Branch:** `integration/flow-redesign`. **Suite:** 625/625.

## What shipped

The wrxn build flow redesigned to a four-phase shape with native executor agents, an on-demand router, and
a derived progress board. Locked in ADR 0006 (9 grill decisions) + the CONTEXT.md "Build flow" glossary.

| # | slice | commit |
|---|---|---|
| 01 | pipeline doctrine rewrite → four-phase flow (`payload/.synapse/pipeline`) | `65ee668` |
| 02 | builder agent + `validateAgentFile` conformance (`lib/agent-conformance.cjs`) | `58d8d7c` |
| 03 | the other five executor agents (reviewer/security/qa-walker/researcher/devops) | `46278bf` |
| 04 | `compass` router skill + `lib/compass-coverage.cjs` | `a3af87f` |
| 05 | `wrxn flow status` — `lib/flow-status.cjs` (pure) + CLI | `93a89fd` |
| 06 | qa-walk operator-mode | `0f72551` |
| — | correction pass (2 blocking flow-status fixes + 2 sec-low) | `d8c5e55` |

## Pipeline trail (HITL spine in main convo; executors as isolated subagents)

grill-with-docs (9 decisions) → ADR 0006 + CONTEXT glossary → PRD → 7 issues → **verticality PASS** →
4 builders in parallel worktrees (01/02/05/06) → integrate → 2 builders (03/04) → integrate →
**code-review** (REQUEST-CHANGES, 2 blocking) + **security** (PASS-WITH-FINDINGS, 2 low) + **qa-walk**
(35/36 ACs) → **correction pass** (all blocking + sec-low fixed) → **human qa-walk** (operator, live —
validated the board renders/derives, qa auto-file works, triage→invalid loop) → **ACCEPTED**.

Bootstrap note: built UNDER the prior batched flow (the new per-slice flow + native agents are this
build's output, so they couldn't run it); the next build is the first to USE the new flow. Review/security/
qa markers here are per-PRD; the per-slice flow writes per-id `review-<id>.md`.

## Findings dispositions

- **2 blocking** (flow-status: `None` sentinel parsed as a dep; `blockedBy` masking done — green suite but
  wrong CLI) → FIXED + regression tests added (`d8c5e55`).
- **2 security-low** (path traversal + unescaped RegExp on the `prd` arg) → FIXED.
- **08 compass "missing model-invocable"** (qa auto-filed) → **CLOSED-INVALID** (false positive — skills are
  model-invocable by default; no such field).

## Deferred (not in this release)

- **07 retire-skill-creator** — separate tracked issue (audit the 3 scripts + removal migration).
- Non-blocking polish: `stalled` has no time dimension; `validateAgentFile` is presence-only, not a
  least-privilege upper bound (security hardening); SYNAPSE budget margin tight (bump `RULES_BUDGET_TOKENS`);
  `flow status` should filter closed/finding rows; stale `synapse/references/*.md` say "unified-dev".

## Release

`@gcunharodrigues/wrxn@0.10.0` — merge `integration/flow-redesign` → `main`, tag `v0.10.0`, push (OIDC
publishes tokenless + provenance). Then `npx @gcunharodrigues/wrxn update` per install; this WRXN-OS install
last, in a fresh session.
