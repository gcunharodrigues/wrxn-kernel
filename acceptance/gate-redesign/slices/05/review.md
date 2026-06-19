# Review — gate-05 · CD: type-gated release-on-merge

- **Slice:** gate-05 (continuous delivery, no manual release step) · build commit `2e68595` on `gate-redesign` (parent `c1e2027`)
- **Reviewer:** fresh-eyes code review (read-only on code; this marker is the only write)
- **Suite:** `npm test` → **762/762 pass** (was 725; +37 from this slice), 0 fail, 0 skipped
- **Smoke:** `node bin/wrxn.cjs release-check --range HEAD~1..HEAD` → `{"release":true,"bump":"minor"}` (classifies the gate-05 `feat(cd):` commit itself — correct)
- **Sources verified against:** issue `05-cd-type-gated-release.md`, `PRD.md`, ADR `0007` (locked choice 4), `carry-forward.md` (no gate-05 obligations), `test/migrate.test.cjs` (no-inert invariant), `lib/protect.cjs` + `payload/.github/workflows/wrxn-ci.yml` (the CI gate the comment relies on)

## Verdict: APPROVE — no blocking findings

All five issue-05 ACs met; all six scrutiny points pass. The type-gate truth table is correct (scopes, `!`, `BREAKING CHANGE:` space/hyphen, mixed→max, empty→no — none misclassified), the workflow is concurrency-locked with the OIDC+provenance publish gated on the decision plus a defensive npm-view idempotency guard, the version model is coherent and preserves the no-inert-migration invariant, and the CLI bridge is a clean reuse seam with a correct `$GITHUB_OUTPUT` write and fail-safe git read. Suite green, scope clean. Four non-blocking notes below; none block the slice.

## Blocking findings

**None.** No type misclassification, no double-publish path, no broken migration invariant, no token reintroduction, no coverage regression.

## Non-blocking findings

1. **NB1 — a release-type merge with a forgotten version bump silently no-ops** (`.github/workflows/release.yml:74-78`).
   If a `feat`/`fix` merges but the developer did not bump `package.json.version` (still the already-published value),
   `decide.outputs.release=='true'` runs the publish step, but the npm-view guard finds the version on npm and `exit 0`s
   ("already published — skipping"). Net: the change is on `main`, no npm artifact, no tag, only a log line. This is the
   **documented model** (ADR/PRD: "the developer bumps `package.json.version` IN THE PR") and the guard's behavior is the
   *correct, idempotent-safe* choice (npm forbids republishing a version anyway). The gap — "release decision = true does
   not guarantee a publish" — is non-obvious. A server-side "a release-type PR must bump the version" check belongs in the
   `wrxn-ci` gate (gate-01/02 scope), not here. Informational; out of gate-05 scope.

2. **NB2 — the kernel's OWN repo root has no `wrxn-ci.yml`** (`.github/workflows/` holds only `release.yml`; the CI workflow
   lives at `payload/.github/workflows/wrxn-ci.yml`, a managed file laid into *installs*). The workflow header asserts
   "runs AFTER CI by construction: the `wrxn-main-gate` ruleset only lets a change reach `main` once the required `wrxn-ci`
   check is green." For the kernel *itself* that holds only once the **bootstrap self-host** (a) places a `wrxn-ci`
   workflow at the kernel root and (b) applies the ruleset — both explicitly bootstrap/gate-01/02 concerns, not gate-05.
   The release.yml workflow is structurally correct regardless, and re-runs `npm test` before publish (lines 65-67) as a
   redundant backstop, so a non-CI'd commit could not mis-publish. Flagged so the operator wires the kernel's own CI during
   the self-host walk; the ruleset's required `wrxn-ci` check otherwise never reports on kernel PRs. Cross-slice, non-blocking.

3. **NB3 — a 3+-near-simultaneous-merge burst could skip an intermediate version on npm** (`.github/workflows/release.yml:37-39`).
   With `cancel-in-progress: false`, GitHub keeps at most one in-progress + one pending run per concurrency group; a third
   arrival cancels the *middle* pending run. Each run publishes its own `package.json.version`, so the latest version always
   lands, but a cancelled middle run's distinct bump (e.g. `0.11.1` between `0.11.0` and `0.11.2`) would never publish. This
   is well-mitigated by gate-02's `strict_required_status_checks_policy: true` (require-branch-up-to-date), which serializes
   merges to `main` so they cannot truly stack instantly. The concurrency block fully satisfies AC-2's "two merges can't
   double-publish" (the dangerous direction). Edge-case informational only.

4. **NB4 — a fail-safe git read trades a *missed* release for never a *wrong* one** (`bin/wrxn.cjs:778-784`).
   If `git log <before>..<head>` ever throws (non-repo / unreachable `before`), the try/catch yields `raw=''` → no release.
   This is the correct safe direction (never double/mis-publish on uncertainty), and `fetch-depth: 0` (release.yml:47) plus
   the ruleset's `non_fast_forward` (force-push block, gate-02) keep `before` reachable in practice, so the throw path is
   effectively won't-happen on the kernel. Noted for completeness; correct as written.

## AC checklist (issue-05)

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 `shouldRelease(commits)` pure, returns whether + bump by CC type; unit-tested across types (feat/fix/perf/breaking publish; chore/docs/refactor/test do not) | **MET** | `lib/release.cjs` `shouldRelease` is pure (no I/O); classify: BREAKING footer→major (`:13`), `!`→major (`:18`), feat→minor (`:19`), fix/perf→patch (`:20`), else null; max-bump fold (`:30-36`). Tests cover every type incl. scopes, `!`, BREAKING space+hyphen, mixed, empty, non-array (`test/release.test.cjs:45-122`) |
| AC-2 `release.yml` triggers on push to `main`, runs after CI, publishes via OIDC+provenance only when `shouldRelease` true, concurrency-locked | **MET** | trigger `push: branches:[main]` (`release.yml:28-30`); after-CI via the `wrxn-ci` ruleset gate (check name verified, see SP4); publish `if: steps.decide.outputs.release=='true'` (`:70`) with `id-token: write` (`:33`) + `--provenance` (`:80`); `concurrency` group + `cancel-in-progress:false` (`:37-39`). Structural tests `test/release.test.cjs:212-237` |
| AC-3 Publish path keeps tokenless OIDC + provenance (no long-lived npm token) | **MET** | No `NODE_AUTH_TOKEN`/`NPM_TOKEN`/`secrets.NPM` anywhere in the workflow (asserted `test/release.test.cjs:239-244`); OIDC `id-token: write` + `registry-url` (`release.yml:50-51`) + `--provenance --access public` matching `publishConfig {provenance:true,access:public}` |
| AC-4 `release.yml` is valid YAML (structural test) | **MET** | `test/release.test.cjs:203-210` (no hard tabs; `name:`/`on:`/`jobs:` present) + the trigger/concurrency/permissions/gate assertions `:212-244`; suite green |
| AC-5 Coverage does not decrease; suite green (`node --test`) | **MET** | 762/762 pass; +37 tests added (`test/release.test.cjs` new — pure classifier, real-git CLI invocation, `$GITHUB_OUTPUT`, fail-safe, structural workflow) |

## Scrutiny-point verdicts (1–6)

1. **`shouldRelease` truth table — PASS.** feat→minor, fix/perf→patch, `feat!`/`fix(api)!`/`refactor!`→major, `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer→major, chore/docs/refactor/test/style/ci/build→no release, mixed→highest (`RANK` major>minor>patch), empty/non-array→no. **Scopes handled** (`(\([^)]*\))?` between type and `:`); **`!` handled on any type** (`m[3]==='!'`→major, ahead of the type switch); **BREAKING footer anchored to a line start** (`/^BREAKING[ -]CHANGE:/m`) so prose can't false-positive; non-conventional subjects (`Merge pull request…`)→no release. No type misclassified. (The subject regex is case-insensitive + `toLowerCase()` — marginally more lenient than strict CC, but safe.)

2. **release.yml correctness — PASS.** Triggers on push to `main`; `concurrency: group: release-${{ github.ref }}` with `cancel-in-progress: false`; OIDC `id-token: write` + `--provenance` preserved from the old workflow; publish (and the npm-upgrade/ci/test steps) all gated on `steps.decide.outputs.release=='true'`; the `npm view "$PKG@$VER"` already-published guard short-circuits a re-run (`exit 0`). `fetch-depth: 0` correctly present so `before..sha` is computable. No tag-trigger remnant; the tag push targets `refs/tags`, so it does not re-trigger this `branches:[main]` workflow (no publish loop).

3. **Version model coherence — SOUND.** `package.json.version` stays source-of-truth, **backed by a real invariant** (`test/migrate.test.cjs:125-138` fails the suite if any migration's version > `package.json.version`) — so the placeholder/semantic-release model is genuinely precluded and the workflow correctly does **not** commit a bump back to `main`. The `v<version>` tag is pushed (`release.yml:81-82`); tags are `refs/tags/*`, outside the `wrxn-main-gate` branch ruleset (which targets `~DEFAULT_BRANCH`), so the tag bypasses the gate as claimed. **Cannot double-publish** (concurrency serializes + npm-view guard + npm's own same-version refusal). **Cannot break the migration invariant** (no inert placeholder is ever written). **Can skip a release** only in the documented forgotten-bump case (NB1) and the 3+-burst edge (NB3) — both non-blocking and mitigated.

4. **"Runs after CI" via trigger, not `needs:` — CORRECT.** A cross-*workflow* `needs:` does not exist (`needs:` is intra-workflow; a true cross-workflow dependency would need a `workflow_run` trigger and would *re-run* on the release-tag push, re-introducing coupling). Relying on the server ruleset is the right mechanism, and it is real: `lib/protect.cjs` `DEFAULT_CHECK='wrxn-ci'` with `required_status_checks:[{context:'wrxn-ci'}]` + `strict_required_status_checks_policy:true`, and the payload `wrxn-ci.yml` is `name: wrxn-ci` on `pull_request` — so the comment's "wrxn-ci green + up-to-date" claim is accurate. A redundant `npm test` runs before publish as defense-in-depth. No cross-workflow dependency needed. (Kernel-self-host CI wiring → NB2.)

5. **`permissions: contents: read → write` — JUSTIFIED + MINIMAL.** The elevation exists solely for `git push origin v$VER` (`release.yml:81-82`), pushed with the checkout-configured `GITHUB_TOKEN`. Scope is exactly `id-token: write` (OIDC, unchanged) + `contents: write` (tag push) — no `packages:`, `pull-requests:`, or `actions:` over-grant. Cannot be narrower and still push a tag.

6. **CLI bridge `wrxn release-check` — SOUND.** The kernel's release.yml calls **local** `node bin/wrxn.cjs release-check` (`:55-57`), avoiding a circular self-`npx`; gate-06 (recon-wrxn) reuses the same gate via `npx` per the comment + PRD — a clean seam because the pure classifier (`shouldRelease`) is unit-tested and only the git read sits at the CLI layer. Verified the command runs **without `npm ci`**: all of `bin/wrxn.cjs`'s top-level requires are local-`lib`/node-stdlib (no third-party), and `recon-wrxn` (the sole runtime dep) is not loaded in this path — smoke-confirmed above. The `$GITHUB_OUTPUT` write is correct GitHub `key=value\n` format (`release=…\nbump=…\n`, `bin/wrxn.cjs:788`; asserted `test/release.test.cjs:178-188`). Edge handling is right: zero before-sha → HEAD-only (`:772-774`, test `:170-176`), no range → HEAD (`:776`), non-repo/bad-range → fail-safe no-release (`:778-784`, test `:190-194`).

## Scope check

Diff touches only: `lib/release.cjs` (new, pure type-gate), `bin/wrxn.cjs` (the `release-check` command, `--range` flag, help text), `.github/workflows/release.yml` (rewritten trigger/gate/concurrency/publish), `test/release.test.cjs` (new). No carry-forwards are assigned to gate-05 (`carry-forward.md` lists gate-04 CF-3..CF-6 and gate-06 notes only). Every changed line traces to issue-05. No scope creep; `release.yml` is correctly a repo-root file (not a payload — CD applies to published repos only, confirmed `payload/.github/workflows/` holds only `wrxn-ci.yml`).
