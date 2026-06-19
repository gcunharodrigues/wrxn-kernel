# Review — gate-06 (recon-wrxn gate runbook)

- **Slice:** `gate-06` — `acceptance/gate-redesign/recon-wrxn-runbook.md`
- **Build commit:** `3896337` (docs-only — 1 file, +328, no source/test change)
- **Reviewer:** reviewer executor (fresh-eyes), 2026-06-19
- **Verdict: APPROVE.** No blocking findings. 2 minor non-blocking observations.

All claims were fact-checked against the REAL `recon-wrxn` repo, the kernel reuse sources
(`lib/protect.cjs`, `payload/.github/workflows/wrxn-ci.yml`, `.github/workflows/release.yml`,
`test/protect.test.cjs`), the issue, the PRD, and ADR 0007. The load-bearing `wrxn ci` honesty claim
was reproduced read-only.

---

## Blocking findings

None.

---

## Non-blocking observations

1. **Redundant explicit `npm run build` (trivial, harmless).** Both adapted workflows run an explicit
   `npm run build` step, but recon's `package.json` has `"prepare": "npm run build"`, so `npm ci`
   already triggers a build via the prepare lifecycle. The explicit step rebuilds (idempotent `tsc`) —
   defensive and correct, just not strictly necessary. No change required.
2. **No explicit "requires kernel ≥ 0.11.0 published" prerequisite.** Step 1/Step 3 invoke
   `npx --yes @gcunharodrigues/wrxn protect` and `… release-check` — both are gate-epic additions not
   yet on npm `latest` until the epic publishes `0.11.0`. The intended sequence is post-publish (ADR
   Consequences: "propagates only on publish (0.11.0)"; recon is a one-time bootstrap applied after),
   so it is correct as written. A one-line "Prerequisites: `@gcunharodrigues/wrxn ≥ 0.11.0` published
   (ships `protect` + `release-check`)" near the top would stop an operator running it too early from
   silently pulling an older `latest`. Optional doc-polish.

---

## AC checklist (issue 06)

- **AC-1 — runbook documents CI + `wrxn-main-gate` ruleset + release-on-merge, reusing `wrxn protect` +
  slice-01/05 templates, no recon-specific logic: MET.** `recon-wrxn-runbook.md` (328 lines) covers all
  three: Step 1 (ruleset via repo-agnostic `wrxn protect`/`~DEFAULT_BRANCH`), Step 2 (CI adapted from
  `payload/.github/workflows/wrxn-ci.yml`), Step 3 (release-on-merge adapted from
  `.github/workflows/release.yml`). Only project facts differ (build step, `--tag latest`, node 24);
  no bespoke gate mechanism.
- **AC-2 — `wrxn protect` repo-agnostic, fake-invoker test with a non-kernel slug: MET.**
  `test/protect.test.cjs:198` — `applyProtection is repo-agnostic: the SAME logic protects recon-wrxn
  (slug + ~DEFAULT_BRANCH)` drives `applyProtection({ slug: 'gcunharodrigues/recon-wrxn' })` with a
  fake `gh` invoker, asserts `action==='created'`, every gh call targets the recon slug, and the POSTed
  body's `conditions.ref_name.include === ['~DEFAULT_BRANCH']`. Substantive, not a stretch citation.
  The runbook references it (no duplicate). Verified passing.
- **AC-3 — post-application walk evidence (operator/devops act) recorded in the runbook: MET (build
  scope).** The "Walk evidence" section has 4 well-formed checkboxes (ruleset applied / PR runs
  `wrxn-ci` + auto-merges on green / direct push to `main` blocked / release-on-merge) each with a
  concrete verification command + evidence slot, correctly marked NOT walkable in-build (needs a real
  `gh`-admin token + live enforcement). The structural requirement (slots recorded in the runbook) is
  met; the ticking is correctly deferred to the operator bootstrap per the slice boundary + ADR
  test-honesty doctrine.
- **AC-4 — coverage does not decrease; suite green (`node --test`): MET.** Docs-only diff (no code) →
  coverage cannot decrease. `npm test` → 762/762 pass, 0 fail.

---

## Verdicts on the 6 scrutiny points

1. **Accuracy vs the REAL recon-wrxn: PASS.** Every fact in the runbook's table matches the live repo:
   name `recon-wrxn`; version `6.0.0-wrxn.6` (semver prerelease → `--tag latest`, matching recon's own
   `release.yml`); test `npm test` → `vitest run`; build `npm run build` → `tsc && …` (TS project);
   default branch `main`; origin `gcunharodrigues/recon-wrxn` from
   `https://github.com/gcunharodrigues/recon-wrxn.git`; no `wrxn.install.json` / `.wrxn/wiki` /
   `.synapse/manifest`; `publishConfig.provenance: true` + OIDC (no `NPM_TOKEN` in `release.yml`);
   existing workflows `ci.yml` (matrix 20/22 + a legacy `NPM_TOKEN` tag-`v*`-gated publish job),
   `release.yml` (tag-`v*`-triggered OIDC publish, `--tag latest`), `recon-review.yml` (blast-radius).
   No factual error an operator would trip on.
2. **No recon-specific gate logic / genuine reuse: PASS.** Step 1 = the same `wrxn protect`
   (`~DEFAULT_BRANCH`). Step 2 = slice-01 shape (PR-triggered, single required check `wrxn-ci`; matrix
   deliberately avoided so the check name stays `wrxn-ci`). Step 3 carries the slice-05 hardening
   verbatim: `persist-credentials: false` + isolated env-scoped `x-access-token` tag push (MED-1), OIDC
   + provenance, `concurrency` lock. Deltas are project facts only.
3. **No-receipt honesty (the builder's key finding): PASS — reproduced.** Ran
   `node bin/wrxn.cjs ci` against the real recon repo read-only → `✗ synapse-manifest — no manifest`,
   `wrxn-ci FAIL`, exit 2 (managed-integrity + wiki-lint vacuous-OK, as the runbook states). The
   runbook correctly explains `synapseManifestLint` hard-fails on a missing `.synapse/manifest` so the
   aggregate fails on any non-install repo, and that recon's real gate is its own `vitest` suite
   (`npm ci && build && test`) — strictly stronger than the `true`-stub backstop. It explicitly tells
   operators NOT to add the `wrxn ci` step and leaves a precise carry-forward for a future kernel
   "no-manifest AND no-receipt = not-applicable" enhancement. Honest, not hand-waved.
4. **AC-2 repo-agnostic protect test: PASS.** See AC-2 above — `test/protect.test.cjs:198` is a real,
   non-kernel-slug fake-invoker test asserting `~DEFAULT_BRANCH`; the ~line-198 citation is exact.
5. **Operational correctness: PASS.** The apply-order caveat (land workflows → open one PR so `wrxn-ci`
   registers → THEN apply the ruleset, else a never-reported required check blocks PRs forever) is
   correct GitHub behavior and prominent (its own "Apply order (matters)" section near the top).
   Removal guidance is correct and thorough: it identifies BOTH existing tag-`v*` publish paths —
   `ci.yml`'s legacy `NPM_TOKEN` `publish:` job (remove: avoids double-publish on the pushed tag +
   drops a long-lived secret) and the old tag-triggered `release.yml` (replace: would double-fire on
   the tag the new CD pushes). `recon-review.yml` correctly kept.
6. **Walk-evidence slot: PASS.** Present, a real 4-item checklist with commands + evidence slots,
   correctly marked an operator/devops bootstrap act not walkable in-build, and closed with the
   epic-consistent honest-limit note (unit tests verify only what is *sent*; enforcement/auto-merge/CD
   are operator-verified here).
