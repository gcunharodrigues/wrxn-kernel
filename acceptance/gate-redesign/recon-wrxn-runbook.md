# Runbook — bring `recon-wrxn` under the `wrxn-main-gate` (gate-06)

One-time setup an operator/devops follows ONCE to put the `recon-wrxn` sibling under the SAME push-gate
model as every `wrxn` install: a `wrxn-main-gate` branch ruleset, a required `wrxn-ci` check, and
type-gated release-on-merge. It reuses the kernel's own logic and workflow templates — **no recon-specific
gate mechanism**. Parent: `acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`
(decision 4 + Consequences) · issue `issues/06-apply-gate-recon-wrxn.md`.

## Why a runbook, not the kernel payload

`recon-wrxn` is a **published sibling repo, not a `wrxn` install** — `wrxn init`/`update` never run there, so
the managed payload (`payload/.github/workflows/wrxn-ci.yml`, migration `005`'s ruleset apply) never reaches
it. To make "uniform across all repos" (PRD user story 6 + 19) actually uniform, the same three controls are
applied to `recon-wrxn` as a documented one-time bootstrap, reusing:

- `wrxn protect` (`lib/protect.cjs`) — repo-agnostic; the SAME `wrxn-main-gate` spec via `~DEFAULT_BRANCH`.
- the slice-01 CI template `payload/.github/workflows/wrxn-ci.yml` — adapted to recon's real build/test.
- the slice-05 CD template `.github/workflows/release.yml` — adapted to recon's name/version + OIDC.

## `recon-wrxn` facts used (verified 2026-06-19, from the real repo)

| Fact | Value |
| --- | --- |
| package name | `recon-wrxn` |
| version | `6.0.0-wrxn.6` — a **semver prerelease** (`6.0.0-wrxn.N`) → `npm publish` needs an explicit `--tag latest` |
| test command | `npm test` → `vitest run` (a **real** suite, not the `true` stub) |
| build | `npm run build` → `tsc && …` (a **TypeScript** project → build is required before test/publish) |
| default branch | `main` |
| origin slug | `gcunharodrigues/recon-wrxn` (from `https://github.com/gcunharodrigues/recon-wrxn.git`) |
| `wrxn.install.json` | **none** — confirms NOT a `wrxn` install (managed-integrity is vacuous here) |
| `.wrxn/wiki` | **none** (wiki-lint has nothing to lint) |
| `.synapse/manifest` | **none** (see the no-receipt CI note below — this is the important nuance) |
| publish identity | OIDC trusted-publishing is **already** configured (`publishConfig.provenance: true`; existing `release.yml` publishes via OIDC, no `NPM_TOKEN`) |
| existing workflows | `ci.yml` (test matrix 20/22 **+ a legacy `NPM_TOKEN` tag-gated publish job**), `release.yml` (tag-`v*`-triggered OIDC publish), `recon-review.yml` (its own blast-radius PR dogfood — unrelated, keep) |

## Apply order (matters)

A required status check that has never reported on a branch will **block** PRs forever. So land the workflow
files FIRST (while the ruleset is not yet on — direct push or a normal merge still works), open one PR so the
`wrxn-ci` check reports once, THEN apply the ruleset. Same land-then-apply shape as the kernel self-host.

1. Add `wrxn-ci.yml` + replace `release.yml` + remove the legacy publish job (Steps 2–3 below); land them.
2. Open a throwaway PR so the `wrxn-ci` check runs once and is registered as a check on the repo.
3. Apply the `wrxn-main-gate` ruleset (Step 1 command below).
4. Fill the **Walk evidence** checklist.

---

## Step 1 — apply the `wrxn-main-gate` ruleset (reuse `wrxn protect`, repo-agnostic)

`wrxn protect` reads the origin slug from `origin`, builds the repo-agnostic `wrxn-main-gate` spec
(`~DEFAULT_BRANCH`, required check `wrxn-ci`, PR with 0 approvals, branch-up-to-date, **no bypass actor**),
and create-or-updates it idempotently via `gh api` — fail-soft if `gh` is missing / not admin / no remote.
There is **no recon-specific logic**: the exact same command protects the kernel and every install.

Run it from the `recon-wrxn` checkout (requires `gh` installed + authenticated as a repo admin):

```sh
# Option A — the published kernel CLI (no kernel checkout needed):
cd /path/to/recon-wrxn && npx --yes @gcunharodrigues/wrxn protect

# Option B — a local kernel checkout's bin (identical logic):
cd /path/to/recon-wrxn && node /path/to/wrxn-kernel/bin/wrxn.cjs protect
```

Expected: `wrxn protect` prints `wrxn-main-gate created on gcunharodrigues/recon-wrxn` (or `updated …` on a
re-run — idempotent). On no `gh`/no admin it prints a skip and exits 0 (fail-soft) — then fix auth and re-run.

> Repo-agnosticism is proven in `test/protect.test.cjs` with a **non-kernel slug + fake invoker** — see
> "Repo-agnostic protect coverage (AC #2)" at the end. No real `gh` is ever issued from the test suite.

---

## Step 2 — the required `wrxn-ci` check (adapted slice-01 template)

The `wrxn-main-gate` ruleset requires a status check named **`wrxn-ci`**. Provide it with the workflow below
(job name `wrxn-ci` → the check run is named `wrxn-ci`). It is the slice-01 template's shape — PR-triggered,
ONE required check — with recon's real build/test in the project-suite slot.

### Honest no-receipt CI behavior (the load-bearing nuance)

The kernel template's last step runs the kernel-universal checks via `npx @gcunharodrigues/wrxn ci`. On
`recon-wrxn` that aggregate is **the wrong tool, and it does NOT degrade to a clean pass** — verified by
running it read-only against the real repo (`node bin/wrxn.cjs ci --root …/recon-wrxn` → exit 2):

```
✓ managed-integrity — no wrxn.install.json — not a wrxn install, nothing to verify   (vacuous, OK)
✓ wiki-lint        — wiki frontmatter clean                                          (no wiki, OK)
✗ synapse-manifest — .synapse/manifest is absent or unreadable                       (HARD FAIL)
✓ json-validity    — 4 json path(s) checked                                          (OK)
✓ node-check       — 0 .cjs file(s) parsed                                           (no payload .cjs, OK)
wrxn-ci FAIL  (exit 2)
```

`managedIntegrity` is correctly vacuous on a no-receipt repo, but `synapseManifestLint` treats a missing
`.synapse/manifest` as a **failure**, so the whole aggregate fails on any non-install repo. The universal
checks exist to give a **no-suite install** a real gate (a backstop for the `true` stub). `recon-wrxn` is the
opposite case: it HAS a real suite (`vitest`), and it has no kernel-managed surface to verify. So:

- **`recon-wrxn`'s real `wrxn-ci` gate is its OWN suite** — `npm ci && npm run build && npm test`. That is
  strictly stronger than the universal backstop it would otherwise stand in for.
- **Do NOT add the `npx @gcunharodrigues/wrxn ci` step** to recon's `wrxn-ci.yml`: on a non-install repo it has
  nothing managed to verify and would false-fail on the absent synapse manifest. (Carry-forward: the kernel's
  `wrxn ci` does not gracefully degrade on a non-install repo — `synapseManifestLint` hard-fails on a missing
  `.synapse/manifest`. A future kernel enhancement could treat "no `.synapse/manifest` AND no receipt" as
  not-applicable rather than a failure, which would let non-install repos reuse the universal step verbatim.)

A single fixed node version (not a matrix) is used on purpose: a matrix produces `wrxn-ci (20)` / `wrxn-ci (22)`
check names, neither of which matches the required context `wrxn-ci`.

### `recon-wrxn/.github/workflows/wrxn-ci.yml` (ready to drop in)

```yaml
name: wrxn-ci

# The single required status check the `wrxn-main-gate` branch ruleset gates on (ADR 0007, gate-06).
# Adapted from the kernel template payload/.github/workflows/wrxn-ci.yml for the recon-wrxn sibling.
# recon-wrxn is NOT a wrxn install (no wrxn.install.json) → the kernel-universal `wrxn ci` checks have no
# managed set / wiki / synapse to verify and actively fail on the absent .synapse/manifest (verified), so
# they are deliberately NOT invoked here. recon-wrxn's real gate is its OWN vitest suite — far stronger
# than the `true`-stub backstop the universal checks exist for. No recon-specific GATE logic: same
# PR-triggered, single-required-check shape; only the project build/test commands differ.

on:
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  wrxn-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
      - name: install dependencies
        run: npm ci
      - name: build (recon-wrxn is a TypeScript project)
        run: npm run build
      - name: test (the real gate — recon-wrxn's vitest suite)
        run: npm test
```

**What runs, exactly:** on every PR to `main` → `npm ci` → `npm run build` (`tsc`) → `npm test` (`vitest run`).
That single green check named `wrxn-ci` is what the ruleset gates on. No universal `wrxn ci` step.

**Reconcile with the existing `ci.yml`:** recon's current `ci.yml` `test` job (matrix 20/22) is now redundant
with `wrxn-ci`. Keep it only if the 20/22 matrix coverage is wanted (it does NOT satisfy the required check —
its job is named `test`, not `wrxn-ci`). Its `publish` job is removed in Step 3.

---

## Step 3 — type-gated release-on-merge CD (adapted slice-05 template)

Replace recon's **tag-triggered** publish with the epic's **release-on-merge** model: a merge to `main`
publishes (or not) by conventional-commit type, reusing the kernel's CD type-gate via the published CLI
(`npx @gcunharodrigues/wrxn release-check` — gate-05 built this bridge for exactly this external reuse).

### `recon-wrxn` adaptations (vs the kernel `release.yml`)

- **package name/version** are read from recon's own `package.json` at publish time (no hard-coding).
- **`npm run build`** is added before publish (recon is a TS project; the kernel is not).
- **`npm publish … --tag latest`** — recon's version is a **prerelease** (`6.0.0-wrxn.N`); npm 11 refuses to
  publish a prerelease to the default dist-tag without an explicit tag (this matches recon's existing
  `release.yml`). The kernel publishes a non-prerelease, so it omits `--tag`.
- everything else is identical reuse: type-gate via `release-check`, OIDC + provenance, `concurrency` lock,
  `persist-credentials: false` + the isolated env-scoped `x-access-token` tag-push (gate-05 MED-1 hardening).

### `recon-wrxn/.github/workflows/release.yml` (ready to drop in — REPLACES the existing tag-triggered one)

```yaml
name: release

# Continuous delivery — type-gated release-on-merge (ADR 0007, gate-06). Adapted from the kernel template
# .github/workflows/release.yml for recon-wrxn. Replaces recon's tag-`v*`-triggered publish: a merge to
# `main` publishes (or not) by conventional-commit type. Runs AFTER CI by construction — the wrxn-main-gate
# ruleset only lets a change reach `main` once the required `wrxn-ci` check is green.
#
# Type gate (reused from the published kernel CLI — `npx @gcunharodrigues/wrxn release-check`):
#   feat → minor · fix/perf → patch · breaking (type! / BREAKING CHANGE:) → major  → PUBLISH
#   chore/docs/refactor/test/style/ci/build → NO release.
#
# Version model: package.json.version is the source of truth (bump it IN THE PR). On merge: if the type
# gate says release AND that version is not already on npm → build, publish via OIDC + provenance, push the
# v<version> tag. The npm-already-published guard makes re-runs idempotent. recon versions are prereleases
# (6.0.0-wrxn.N) → publish needs an explicit `--tag latest`.

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: write

# Serialize releases so two quick merges can't double-publish. Never cancel an in-flight publish.
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          # Do NOT persist GITHUB_TOKEN into git config — the npm build/test/publish steps run third-party
          # lifecycle code and must not hold an ambient contents:write credential. The tag is pushed by an
          # isolated final step that injects the token narrowly via env (gate-05 MED-1).
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
          cache: npm

      # Decide by conventional-commit type over the merged commit range, using the published kernel CLI.
      # No npm ci needed: release-check uses only node stdlib + git, so a chore/docs merge stops here fast.
      - name: decide release by conventional-commit type
        id: decide
        run: npx --yes @gcunharodrigues/wrxn release-check --range "${{ github.event.before }}..${{ github.sha }}"

      - name: upgrade npm (OIDC trusted publishing needs npm >= 11.5.1)
        if: steps.decide.outputs.release == 'true'
        run: npm install -g npm@latest
      - name: install dependencies
        if: steps.decide.outputs.release == 'true'
        run: npm ci
      - name: build (recon-wrxn is a TypeScript project)
        if: steps.decide.outputs.release == 'true'
        run: npm run build
      - name: test (pre-publish backstop)
        if: steps.decide.outputs.release == 'true'
        run: npm test

      - name: publish to npm (OIDC + provenance) when release-worthy and unpublished
        id: publish
        if: steps.decide.outputs.release == 'true'
        run: |
          VER=$(node -p "require('./package.json').version")
          PKG=$(node -p "require('./package.json').name")
          PUBLISHED=$(npm view "$PKG@$VER" version 2>/dev/null || true)
          if [ -n "$PUBLISHED" ]; then
            echo "$PKG@$VER already published — skipping (idempotent re-run)"
            exit 0
          fi
          echo "publishing $PKG@$VER (bump: ${{ steps.decide.outputs.bump }})"
          # recon versions are prereleases (6.0.0-wrxn.N) → npm 11 requires an explicit dist-tag.
          npm publish --provenance --access public --tag latest
          echo "published=true" >> "$GITHUB_OUTPUT"

      # The ONLY step that holds a write-capable token (gate-05 MED-1). checkout used
      # persist-credentials: false, so no contents:write credential was ambient to the npm steps above;
      # the token is injected narrowly here and used only to push the v<version> tag.
      - name: push the release tag (isolated write step)
        if: steps.publish.outputs.published == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
        run: |
          VER=$(node -p "require('./package.json').version")
          git tag "v$VER"
          git push "https://x-access-token:${GH_TOKEN}@github.com/${REPO}" "v$VER"
```

### Reconcile recon's existing CD (do this when landing Step 3 — avoids a double-publish)

- **Remove the legacy `NPM_TOKEN` publish job** from `recon-wrxn/.github/workflows/ci.yml` (the `publish:` job
  gated on `refs/tags/v*` that runs `npm publish` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`). It is
  superseded by OIDC release-on-merge; leaving it would re-publish on the `v*` tag this workflow pushes AND
  keep a long-lived `NPM_TOKEN` secret the OIDC model removes.
- The **old tag-triggered `release.yml` is replaced** by the file above (its tag `v*` trigger would otherwise
  double-fire on the tag the new CD pushes). If the operator prefers to keep a tag-publish path, it must be
  made idempotent against the `npm view` guard; the recommendation is a clean replace.
- `recon-review.yml` (blast-radius PR comment) is unrelated to the gate — **keep it.**

---

## Walk evidence (operator/devops fills during the bootstrap — NOT walkable in-build)

These assertions require a real `gh`-admin token and live GitHub enforcement on `recon-wrxn`. They are an
**operator/devops act** performed once during the bootstrap self-host — they are NOT walkable from the AFK
build (which never runs a real mutating `gh` against `recon-wrxn`, per the slice boundary). Tick + paste
evidence when applied:

- [ ] **Ruleset applied** — `gh api /repos/gcunharodrigues/recon-wrxn/rulesets` shows a `wrxn-main-gate`
      ruleset, `enforcement: active`, `bypass_actors: []`.
      <!-- evidence: -->
- [ ] **PR runs `wrxn-ci` + auto-merges on green** — a `recon-wrxn` PR shows the required `wrxn-ci` check, and
      with auto-merge enabled (`gh pr merge --auto --squash`) GitHub merges it the instant `wrxn-ci` is green,
      no human click.
      <!-- evidence (PR #): -->
- [ ] **Direct push to `main` is blocked** — `git push origin main` (a direct push, no PR) is rejected by the
      ruleset (`GH006 Protected branch` / "Changes must be made through a pull request").
      <!-- evidence: -->
- [ ] **Release-on-merge works** — a `feat:`/`fix:` merge to `main` (with `package.json.version` bumped in the
      PR) publishes the new `recon-wrxn` version to npm via OIDC and pushes its `v<version>` tag; a
      `chore:`/`docs:` merge does NOT publish.
      <!-- evidence: -->

> Honest limit (same as the epic's PRD): the unit tests verify only what we *send* (the ruleset spec, the
> type-gate decision, the workflow YAML shape). That GitHub actually *enforces* the ruleset, auto-merges on
> green, and CD publishes is verified ONLY here, by the operator, in this walk.

---

## Repo-agnostic protect coverage (AC #2)

AC #2 — "`wrxn protect` is repo-agnostic … covered by a fake-invoker test using a non-kernel slug" — is
**already satisfied** by slice-02's `test/protect.test.cjs` (no new test is added; a duplicate would be
redundant). The definitive test:

- `applyProtection is repo-agnostic: the SAME logic protects recon-wrxn (slug + ~DEFAULT_BRANCH)` —
  drives `applyProtection` with the **non-kernel slug `gcunharodrigues/recon-wrxn`** and a fake `gh` invoker
  (no real `gh api`), asserting the apply targets the recon-wrxn slug and the POSTed body protects
  `~DEFAULT_BRANCH` (recon's default branch, without naming it).

Corroborating coverage in the same file: the `originSlug parses an https remote …` test derives
`gcunharodrigues/recon-wrxn` from `https://github.com/gcunharodrigues/recon-wrxn.git` (a real recon origin URL
in its body), and `buildRulesetSpec: the required-check context is parameterizable` (the spec carries no
hard-coded repo). The
SAME `lib/protect.cjs` the kernel and every install use therefore applies to `recon-wrxn` with zero
recon-specific branch — the runbook's Step 1 is just that logic, invoked against recon's origin.
