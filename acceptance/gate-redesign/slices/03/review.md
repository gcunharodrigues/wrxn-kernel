# Review — gate-03 `wrxn ship` + `devops` rewrite

- **Slice:** gate-03 (`acceptance/gate-redesign/issues/03-ship-devops-rewrite.md`)
- **Build commit:** `0c7f6ab` on `gate-redesign` (vs `dab3613`)
- **Reviewer:** reviewer executor (fresh eyes) · 2026-06-19
- **Verified against:** issue 03, `PRD.md`, ADR `0007`, issue 04 (scope boundary), `lib/connect.cjs` (invoker prior art), `lib/executor.cjs` + `test/executor.test.cjs` (out-of-slice flag), full suite run.

## Verdict: APPROVE-WITH-FINDINGS

0 blocking findings. 3 non-blocking. Suite green **661/661** (`npm test`). All issue-03 ACs met (AC-3 within the PRD's explicitly declared test-honesty deferral).

## Blocking findings

none

## Non-blocking findings

- **N1 (cosmetic — invoker param naming):** `lib/ship.cjs:59` — `ship({ invoker })` names the seam `invoker`, while the prior-art `lib/connect.cjs:125` names it `invoke` (`probeInterface(entry, { invoke })`). Faithful reuse otherwise; does **not** weaken testability. Naming-only drift across the two invoker modules. Fix (optional): pick one name kernel-wide.
- **N2 (forward-looking → gate-04):** the builder's `lib/executor.cjs:83` `buildDispatchSpec('devops')` still emits the `WRXN_ACTIVE_AGENT` / settings.local.json dance, **pinned** by `test/executor.test.cjs:95-101` (which currently *requires* that guidance). This is correctly **out of gate-03 scope** (issue-03 ACs name only `devops.md`). But issue-04 AC line 23 demands "grep-clean **across the repo**" — its narrower lead clause says "payload or doctrine" (package code `lib/executor.cjs` is neither), so the *parenthetical* is what catches it. gate-04 must update **both** `lib/executor.cjs:83` **and flip** `test/executor.test.cjs:95-101`, or the repo-wide grep will not be clean. Surfaced so gate-04 does not miss the test flip. No action for gate-03.
- **N3 (idempotency — honest-limit-adjacent):** `lib/ship.cjs:34` — on a partial re-run (push succeeds, then `gh pr create` is re-invoked when a PR already exists for the branch), `gh pr create` errors and ship halts at `pr-create`. Acceptable for v1 per the PRD "honest limit" / Further-Notes deferral (real PR-open is proven only in the bootstrap self-host walk), but worth a note for that walk. Not a gate-03 blocker.

## AC checklist (issue-03)

| AC | Status | Evidence |
|----|--------|----------|
| 1 — `buildShipPlan()` pure: branch/title → ordered git+gh (branch, push, `gh pr create`, `gh pr merge --auto --squash`); unit-tested | **MET** | `lib/ship.cjs:27-37` returns a side-effect-free array `[push -u origin <branch>, gh pr create --base --head --title --body, gh pr merge <branch> --auto --squash]`. Tested: `test/ship.test.cjs` (ordered commands, base/body defaults, throws on missing branch/title). **Interpretation note:** no literal `git branch`/`checkout -b` step — correct, because devops *stands on* the already-reviewed branch (`--branch` defaults to current branch); a create step would be wrong. The AC's "(branch, …)" = the branch is the pushed subject. Matches PRD impl-decision "buildShipPlan() (pure: branch name, gh pr create, gh pr merge…)" and ADR "branch → push → PR → enable auto-merge". |
| 2 — `ship({ invoker })` runs plan via injected invoker; fake-invoker tested, no real network | **MET** | `lib/ship.cjs:59-69` (`invoker \|\| defaultInvoke`). Tested with a fake invoker: runs every step in order + stop-on-fail (`test/ship.test.cjs`). No network. |
| 3 — `wrxn ship` CLI opens a PR with auto-merge enabled (validated by invocation vs real `gh` at CLI) | **MET (within declared honest-limit)** | CLI wires the real invoker: `bin/wrxn.cjs:489` `ship.ship({ branch,title,base,body })` → `defaultInvoke` (real git+gh). Test proves the CLI's real invoker reaches real `gh` **non-destructively** (`gh --version`, never opens a PR) + ENOENT rejection. The literal "opens a PR" is **deferred to the bootstrap self-host walk** per PRD *Further Notes* / ADR *Test honesty* ("unit tests verify only what we send + local logic"). Judged against ALL sources, the deferral is sanctioned by the parent contract → MET, not a gap. |
| 4 — `devops.md` describes `wrxn ship` path, NO `WRXN_ACTIVE_AGENT` / settings.local.json dance | **MET** | `payload/.claude/agents/devops.md` rewritten (process steps 1-4 → `wrxn ship` + confirm auto-merge). `git grep -n WRXN_ACTIVE_AGENT -- …/devops.md` → exit 1 (no match); same for `settings.local.json`. `test/agent-conformance.test.cjs` flipped to `assert.doesNotMatch` both + `assert.match(/wrxn ship/)`. |
| 5 — Coverage does not decrease; suite green | **MET** | `npm test` → **661/661 pass, 0 fail**. New `test/ship.test.cjs` (+9 tests covering the new `lib/ship.cjs`); conformance flipped, not dropped. Coverage increases. |

## Scrutiny-point verdicts

1. **Command-shape correctness — PASS.** Promote sequence is `git push -u origin <branch>` → `gh pr create --base <base> --head <branch> --title <t> --body <b>` → `gh pr merge <branch> --auto --squash`. `--auto` **enables auto-merge** (arms it; GitHub merges when the server CI gate is green) rather than merging immediately — this is the AC's intent. `--body ''` (provided, even if empty) keeps `gh` non-interactive. `base` defaults to `main` (`DEFAULT_BASE`) — correct trunk. Branch ref is valid (the current/reviewed branch).
2. **Stop-on-first-failure — PASS.** `lib/ship.cjs:63-67`: the loop `return`s on the first `!r.ok`, so a failed `push` can never reach `pr-create`/`auto-merge`. Verified in code **and** test (`ship STOPS at the first failing step` asserts `seen === ['push']`). Load-bearing safety property holds.
3. **Invoker-pattern reuse — PASS.** Faithful mirror of `lib/connect.cjs`: pure builder (`buildShipPlan`) / injected invoker (`ship({ invoker })`, default `defaultInvoke`) / real `spawnSync` only at the CLI layer. No testability weakening. Only divergence is the cosmetic `invoker` vs `invoke` param name (N1).
4. **`devops.md` coherence — PASS.** Dance is grep-gone (point 4 evidence). Rewritten promote path is coherent and complete: step 2 runs `wrxn ship --title …` (with `--dry-run` preview + `--base` note), step 3 confirms auto-merge armed (`gh pr view --json autoMergeRequest`), constraints name `wrxn ship` as the sole promote path, output-contract `pushed:true` re-defined as "branch pushed + PR open + auto-merge armed". No dangling reference to the deleted env-flag mechanism.
5. **Builder's out-of-slice flag — PASS (agree with the build).** Leaving `lib/executor.cjs:83` emitting `WRXN_ACTIVE_AGENT` is **correct** for issue-03 (its ACs name only `devops.md`). It is **gate-04's** responsibility (issue-04 AC line 23: "grep-clean across the repo"). I **agree**. One forward-looking caveat carried to N2: gate-04 must also flip the pinning test `test/executor.test.cjs:95-101`.

## Notes

- `bin/wrxn.cjs` ship block: `execFileSync` is imported (line 7), so the `--branch` default-to-current-branch path works; `--dry-run` is parsed via the generic boolean fallback (`args.flags['dry-run']`), confirmed by the passing CLI dry-run test. Error paths (missing branch/title, builder throw) all exit 2.
- Repo-wide `WRXN_ACTIVE_AGENT` still appears in constitution / synapse / hooks / executor / migration-002 / doctrine + the two ship-side descriptive comments — all **gate-04** scope (or intentional "this replaces X" prose), none a gate-03 defect.
