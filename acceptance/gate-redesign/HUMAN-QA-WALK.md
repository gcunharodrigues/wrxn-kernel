# Human qa-walk — gate-redesign (whole artifact vs the PRD's 20 user stories)

Date 2026-06-19 · Branch `gate-redesign` (assembled, 762/762 green) · Walked in the main thread (HITL).
Each PRD user story → its delivered mechanism on the branch + evidence. **L** = live-enforcement tail that is
NOT unit-testable and is verified in the bootstrap self-host walk (by design, per PRD "Further Notes").

| # | User story (operator wants…) | Verdict | Evidence |
|---|---|---|---|
| 1 | agent merges to main itself, no GitHub click | DELIVERED **+L** | `wrxn ship` pushes branch → `gh pr create` → `gh pr merge --auto --squash` (`lib/ship.cjs`, walk 03). Live merge-on-green = bootstrap. |
| 2 | no `settings.local.json` editing in the push path | DELIVERED | grep-clean of live payload/doctrine; devops.md de-danced; 3 hooks deleted. |
| 3 | server ruleset blocks direct push to main | DELIVERED **+L** | `buildRulesetSpec` → `pull_request` rule on `~DEFAULT_BRANCH` (blocks direct push) + `non_fast_forward`+`deletion`. Live block = bootstrap. |
| 4 | CI is the single hard gate | DELIVERED | ruleset `required_status_checks` = `wrxn-ci`; `wrxn-ci.yml` PR-triggered. |
| 5 | CI never an empty `true` | DELIVERED | universal checks run even with `WRXN_TEST_CMD=true` (walk 01 never-vacuous). |
| 6 | same flow on every repo | DELIVERED | repo-agnostic `wrxn protect` (`~DEFAULT_BRANCH`) + managed CI payload + recon-wrxn runbook. |
| 7 | kernel configures each repo on `update` | DELIVERED | `update`→`applyProtection` (idempotent) + migration `005` first-apply. |
| 8 | ruleset apply idempotent + fail-soft | DELIVERED | walk 02 (re-run no-op; no-remote→exit 0 + message). |
| 9 | applies to everyone, no bypass actor | DELIVERED | `bypass_actors: []` in the spec. |
| 10 | merges serialized (up-to-date / queue) | DELIVERED | `strict_required_status_checks_policy: true` (require-up-to-date); merge-queue = PRD-documented fallback. |
| 11 | feat/fix merge publishes to npm | DELIVERED **+L** | `shouldRelease` feat→minor/fix→patch + `release.yml` OIDC publish. Live publish = bootstrap. |
| 12 | chore/docs merge does NOT publish | DELIVERED | `shouldRelease(['chore: …'])` → `{release:false}` (walk 05, 21 probes). |
| 13 | releases concurrency-locked | DELIVERED | `concurrency: release-${{ github.ref }}`, `cancel-in-progress:false`. |
| 14 | devops promotes via one `wrxn ship` | DELIVERED | `wrxn ship` CLI + devops.md rewritten to it. |
| 15 | 3 push-hooks removed, managed-guard → warning | DELIVERED | 3 hooks gone from disk+manifest+settings; `enforce-managed-*` advisory-only, never `{decision:"block"}` (walk 04). |
| 16 | managed-file integrity enforced in CI | DELIVERED | `managedIntegrity` (manifest-anchored, CF-2) in `wrxn ci`. |
| 17 | constitution / synapse / wiki rewritten | DELIVERED *(kernel)* / **partial** | constitution Art I+III + synapse global/routing flipped (read + walked). **The WRXN-OS wiki concept is install-state** → reconcile on the WRXN-OS 0.11.0 update (gate-redesign-08, tracked). |
| 18 | guard blocks HITL-delegation to a generic agent | DELIVERED | `general-purpose`+"write a PRD" → `{decision:"block"}`; `builder` → `{}` (allowed). |
| 19 | recon-wrxn under the same CI+ruleset+CD | DELIVERED **+L** | runbook reuses protect + slice-01/05 templates; repo-agnostic protect test. Live apply = bootstrap. |
| 20 | guard's block names the right skill | DELIVERED | block reason names **`to-prd`** (just walked). |

## Verdict

**PASS — 20/20 user stories delivered at the artifact level.** Doctrine reads coherently end-to-end (no surviving
contradiction in the live payload). The only things NOT demonstrated here are deferred **by design** and tracked:

- **4 live-enforcement tails (L: stories 1, 3, 11, 19)** — that GitHub actually blocks direct push, auto-merges on
  green, CD publishes, and recon-wrxn is applied. Not unit-testable; verified in the **bootstrap self-host walk**.
- **Story 17 partial** — the WRXN-OS wiki concept `wrxn-git-push-authority-hook.md` (install-state, not a kernel
  file) still teaches the old dance; reconcile during the WRXN-OS 0.11.0 update (gate-redesign-08).

Recommend **ACCEPT**, then proceed to the bootstrap (the L-tails ARE the bootstrap's acceptance walk).

## Still open

**Correction pass COMPLETE (2026-06-19)** — operator said "fix all"; every actionable item fixed + re-gated
(suite 783/783, reviewer APPROVE / security PASS / qa-walk 22/22 — `correction/` markers):
- issue 10 `.mcp.json` blind spot → `41cebc0` · seeded routing → migration `006` `4b933de` · synapse teaching
  docs → `54ada8f` · CF-6 ship `--` guard → `823db31` · slice-07 null-guard + PRD tighten → `7821ed4`.

Remaining (not kernel-fixable now):
1. **CF-2 workspace residual** — deliberately not fixed (no clean cheap fix; documented, low; the tamper case IS
   covered). See `carry-forward.md`.
2. **Story 17 — WRXN-OS wiki concept** reconcile — bootstrap task (install-state, happens at the WRXN-OS update).
3. **The bootstrap sequence** (land-then-apply) — operator/devops act, fresh session + npm auth (see BUILD-SUMMARY).
