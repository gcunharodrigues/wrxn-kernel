# PRD — Push authority: PR + CI + auto-merge gate, kernel-delivered, with a pipeline-adherence guard

Status: ready-for-agent
ADR: docs/adr/0007-push-gate-pr-ci-automerge.md
Slug: gate-redesign

## Problem Statement

As the wrxn operator I want the agent to land changes on `main` **autonomously** — no GitHub clicks, no
`.claude/settings.local.json` dance — but I need it to be **certain**: a correct, race-safe CI/CD must stand
between the agent and `main`, the same way for every repo. Today the opposite is true. The "deliberate-push"
gate is `WRXN_ACTIVE_AGENT=devops` in `settings.local.json`, read by a Bash-tool hook. A 2026-06-19 security
audit proved it is a **live no-op**: Claude Code injects that env additively into the session and a file
"revert" never unsets it, so once armed the gate stays open for the whole session (verified — a clean file,
yet the flag still live). It also only gates the agent's Bash tool (a terminal, IDE, MCP, or `--no-verify`
walks past it), the "review" gate is a file the agent writes itself, and the "tests" gate is a `true` stub.
So the current flow is **high-friction *and* unenforced** — the worst of both.

## Solution

Replace the env-flag gate with a **PR + CI + auto-merge** model that is **server-enforced** and
**kernel-delivered**, uniform across every repo:

- The agent pushes a branch, opens a PR, and enables **auto-merge**; a GitHub **ruleset** blocks direct push to
  `main` and requires a green **CI** check; GitHub merges the instant CI passes. No clicks, no env flag.
- **CI is the sole hard gate** and is never empty: it runs the project suite (when real) plus kernel-universal
  checks. There is **no human-review requirement** (a solo account can't approve-then-self-merge) — the AFK
  `reviewer`/`security` agents still run *before* the PR; CI is the server-enforced backstop.
- The **kernel delivers the flow**: `wrxn update` lays the CI workflow (managed payload) and **auto-applies the
  ruleset** via `gh api` (idempotent, fail-soft); migration `005` does the first application.
- **CD is type-gated release-on-merge**: `feat`/`fix`/`perf`/breaking publish to npm via the existing OIDC
  pipeline; `chore`/`docs`/`refactor`/`test` don't.
- The three local push-gate hooks are **deleted**, the managed-guard demoted to a non-blocking advisory →
  **zero `settings.local.json` env flags remain**; `devops` promotes via a new **`wrxn ship`**.
- A **pipeline-adherence guard** hook blocks delegating a HITL step to a generic agent — the meta-fix for the
  orchestrator skipping the pipeline (which happened live on 2026-06-19, *with* the doctrine injected).

## User Stories

1. As the operator, I want the agent to merge to `main` itself, so that I never open GitHub to click "merge."
2. As the operator, I want no `settings.local.json` editing in the push path, so that the dance — and its
   silent-disarm defect — is gone entirely.
3. As the operator, I want a server-side ruleset to block direct pushes to `main`, so that no client path
   (terminal, IDE, MCP, API, `--no-verify`) can bypass the gate.
4. As the operator, I want CI to be the single hard gate, so that nothing reaches `main` un-green.
5. As the operator, I want CI to never be an empty `true`, so that even a no-suite repo gets a real check.
6. As the operator, I want the same flow on every repo, so that I reason about one model, not per-repo special
   cases.
7. As the operator, I want the kernel to configure each repo on `update`, so that I don't set up CI or rulesets
   by hand.
8. As the operator, I want ruleset application to be idempotent and fail-soft, so that re-running `update` is
   safe and a remote-less install just skips it.
9. As the operator, I want the ruleset to apply to everyone with no bypass actor, so that the agent (on my
   token) can't quietly bypass it.
10. As the operator, I want merges serialized (require-up-to-date, or a merge queue), so that two changes can't
    race a broken `main`.
11. As the operator, I want a `feat`/`fix` merge to publish to npm automatically, so that releasing needs no
    command.
12. As the operator, I want `chore`/`docs` merges to NOT publish, so that npm isn't spammed with versions.
13. As the operator, I want releases concurrency-locked, so that two merges can't double-publish.
14. As the operator, I want `devops` to promote via one `wrxn ship` command, so that the push path is one
    obvious step.
15. As the operator, I want the three push-gate hooks removed and the managed-guard demoted to a warning, so
    that there is no leftover env-flag machinery.
16. As the operator, I want managed-file integrity enforced in CI, so that protection is server-side and
    stronger than the old disarmable local guard.
17. As the operator, I want the Constitution, synapse rules, and the push-authority wiki page rewritten to the
    new model, so that the doctrine the agent reads matches reality.
18. As the operator, I want a guard that blocks delegating a HITL step (PRD / issues / grill / verticality) to a
    generic agent, so that the orchestrator can't skip the pipeline the way it did on 2026-06-19.
19. As the operator, I want `recon-wrxn` (a published sibling, not an install) brought under the same CI +
    ruleset + CD, so that "uniform" is actually uniform.
20. As a future orchestrator agent, I want the guard's block message to name the right skill, so that I
    self-correct to `to-prd`/`to-issues`/`grill` in the main thread.

## Implementation Decisions

- **`lib/protect.cjs`** — `buildRulesetSpec()` (pure: the `gh api` ruleset payload for `wrxn-main-gate` — block
  direct push to `main`, require the `wrxn-ci` status check, require branch up-to-date, merge queue if
  available, no bypass actor) + `applyProtection({ invoker })` (idempotent create-or-update; fail-soft on no
  `gh`/no admin/no remote). REUSE the `lib/connect.cjs` injectable-invoker shape. CLI: `wrxn protect`.
- **`lib/ship.cjs`** — `buildShipPlan()` (pure: branch name, `gh pr create`, `gh pr merge --auto --squash`) +
  `ship({ invoker })`. CLI: `wrxn ship`. The `devops` agent (`payload/.claude/agents/devops.md`) is rewritten
  to call `wrxn ship` and confirm auto-merge is armed — its `WRXN_ACTIVE_AGENT` dance is removed.
- **`.github/workflows/wrxn-ci.yml`** — a managed payload file laid by init/update; on `pull_request` runs the
  project `WRXN_TEST_CMD` (skipped when `true`/empty) plus the universal checks below.
- **Universal CI checks** — pure node predicates (managed-integrity vs `wrxn.install.json`, wiki-lint,
  synapse-manifest lint, JSON validity, `node --check` syntax) reused by the workflow; managed-integrity is the
  server-side replacement for the demoted local guard.
- **`wrxn update` integration + migration `005`** — `update` calls `applyProtection` idempotently; migration
  `005` (`{ id:'005', version:'0.11.0', up(ctx) }`, defensive/idempotent like `003`) performs the first
  application on existing installs.
- **Hook retirement** — delete `enforce-push-authority.cjs`, `enforce-review-marker.cjs`,
  `enforce-tests-on-push.cjs`; rewire `payload/.claude/settings.json` PreToolUse:Bash to drop them; demote
  `enforce-managed-guard.cjs`/`-precommit.cjs` to advisory (no `WRXN_MANAGED_CONFIRM`, never `block`).
- **CD** — adapt `.github/workflows/release.yml` to trigger on push to `main`, gate the publish by
  conventional-commit type, keep OIDC + provenance, add a `concurrency` group.
- **Pipeline-adherence guard** — `payload/.claude/hooks/enforce-pipeline-adherence.cjs`, `PreToolUse:Task`:
  block when `subagent_type` is not one of the six typed executors AND the prompt matches HITL-step keywords;
  the block `reason` names the correct skill. Fail-open. If CC does not fire PreToolUse on `Task`, fall back to a
  `UserPromptSubmit` doctrine nudge keyed to the same heuristic (the slice's ACs must determine which).
- **Doctrine** — rewrite Constitution Art. I + III, the `payload/.synapse/*` pipeline/global rule text, and the
  wiki concept `wrxn-git-push-authority-hook.md` to the PR+CI+auto-merge model; `compass` cross-references the
  adherence rule.
- **recon-wrxn** — not a `wrxn` install; apply the CI workflow + `wrxn-main-gate` ruleset + release-on-merge as a
  documented one-time setup reusing the same logic.

## Testing Decisions

- Good tests assert **external behavior at the highest seam**, not implementation detail, and reuse existing
  patterns. Primary seam = the **`lib/` module boundary**: unit-test the pure builders (`buildRulesetSpec`,
  `buildShipPlan`, the CD type-gate `shouldRelease`, the CI check predicates) and the apply/run decisions
  (idempotency, fail-soft) with an **injected fake invoker**; real `gh`/git only at the CLI layer. Prior art:
  `test/connect.test.cjs`, `test/executor.test.cjs`.
- **Hooks** tested at the decision-function boundary: the managed-guard returns advisory (never `block`); the
  three push-hooks are absent from `settings.json` wiring; the adherence guard blocks the HITL-delegation case
  and allows typed executors. Prior art: `test/hooks-managed.test.cjs`, `test/hooks-boundary.test.cjs`,
  `test/settings-hook-paths.test.cjs`.
- **Migration `005`** tested via the runner contract. Prior art: `test/serve-http-door-migration.test.cjs`.
- **YAML workflows** validated structurally (valid YAML that invokes the node check scripts) — not executed in
  `node --test`.
- **Coverage does not decrease; suite green (`node --test`).** No TypeScript in the kernel → no typecheck step.

## Out of Scope

- Signed commits / Sigstore-gitsign (audit L4 / identity) — deferred, not blocking.
- A CI security-scan job (`npm audit`/semgrep) for audit F9 — the AFK `security` agent stays the gate.
- Broader "don't skip the pipeline" detection beyond HITL-delegation — the guard targets the *detectable*
  bypass; the rest stays doctrine + `compass`.
- Retiring `skill-creator` (separate, deferred as flow-redesign `07`).
- Merge-queue *if the account plan lacks it* — fall back to require-up-to-date (note which in `gate-02`).

## Further Notes

- **Bootstrap (land-then-apply):** build on a branch → land once via the current direct-push (kernel has no
  ruleset yet) → self-host (apply `wrxn-main-gate` to the kernel) → publish `0.11.0` → `update` all 5 installs,
  **WRXN-OS last**. The build runs in a **fresh restarted session** (this session's gate is disarmed per audit
  F1 and cannot be re-armed without a restart).
- **Honest limit:** unit tests cover what we send + local logic only; GitHub's actual enforcement (ruleset
  blocks, auto-merge on green, CD publishes) is verified in the bootstrap self-host walk.
- This epic was itself designed via the corrected flow (grill → PRD here in the main thread → `to-issues`), and
  the `gate-07` guard exists so that correction holds by construction next time.
