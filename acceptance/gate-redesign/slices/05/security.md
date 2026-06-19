# Security review — slice gate-05 (CD: type-gated release-on-merge → auto-publish to npm)

- **Slice:** `acceptance/gate-redesign/issues/05-cd-type-gated-release.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`
- **Commit reviewed:** `2e68595` on `gate-redesign` — `.github/workflows/release.yml` (trigger + permissions + publish rewrite), `lib/release.cjs` *new* (pure type-gate), `bin/wrxn.cjs` `release-check` cmd *new*, `test/release.test.cjs` *new*. Prior workflow: `c1e2027:.github/workflows/release.yml`.
- **Reviewer:** security executor (read-only)
- **Date:** 2026-06-19

## Verdict: PASS-WITH-FINDINGS

0 critical · 0 high · **1 medium** · 2 low · 3 informational, under the documented threat model (solo
operator; this workflow runs **only on already-merged `main` code**; publish authority is GitHub-Actions OIDC
against a npm trusted-publisher config). This is a supply-chain-sensitive auto-publish surface and it is built
with the right posture: **tokenless OIDC + provenance preserved** (no long-lived npm secret — pinned by a
negative test), a **safe `push:`-to-`main` trigger** that fork-author code can never reach, a **fail-closed
type-gate** (uncertainty → no publish), and **triple-layered double-publish prevention**. The single MED is a
least-privilege scoping recommendation on the headline `contents: write` elevation — justified, but ambient to
the dependency-executing steps; the LOWs are defense-in-depth. Nothing blocks the build. Tests 37/37 green;
the gate's only runtime consumer is `release.yml` → `bin/wrxn.cjs release-check` → the pure classifier
(grep-confirmed single call path; no unsafe fan-out).

## Posture calls (the lenses the spec asked for)

| Lens | Call | Basis |
| --- | --- | --- |
| **`contents: read → write` elevation** (justified? minimally scoped?) | **PASS-WITH-FINDING (MED-1)** | **Justified** — the *only* new write is `git push origin "v$VER"` (`release.yml:82`) and GitHub has **no narrower permission than `contents` for tag pushes** (it covers code/tags/branches/releases as one scope). But it is declared at **workflow level** (`:32-34`), so it is ambient to the `npm install -g` / `npm ci` / `npm test` steps (`:59-67`) that execute third-party code while an OIDC-capable, now-`contents:write` `GITHUB_TOKEN` is in scope and persisted into git config by checkout. Recommend job-level scoping + isolating the write. See MED-1. |
| **Tokenless OIDC + provenance preserved** (no long-lived npm token) | **PASS** | `permissions.id-token: write` retained (`:33`); `npm publish --provenance --access public` (`:80`). **No** `NPM_TOKEN` / `NODE_AUTH_TOKEN` / `secrets.NPM*` anywhere in the workflow or repo — verified by read **and** a dedicated negative test (`test/release.test.cjs:239-244`) **and** a repo-wide grep (empty). The only credential is the ephemeral, audience-scoped OIDC id-token minted at publish. Strongest available npm-publish posture. |
| **Trigger safety** (no fork-PR / untrusted code reaches publish) | **PASS** | Trigger is `push: branches: [main]` **only** (`:28-30`) — post-merge, already-trusted code. It is **not** `pull_request` / `pull_request_target` / `workflow_run`, so fork-author code **never** reaches the OIDC publish or the `GITHUB_TOKEN`. The tag push (`:82`) does **not** re-trigger the workflow (the old `tags: ['v*']` trigger was removed) — no publish loop; and GitHub suppresses workflow recursion from `GITHUB_TOKEN`-pushed refs anyway. Pinned by `test/release.test.cjs:212-217`. |
| **Commit-message → release injection / ReDoS / force-suppress** | **PASS** | **No ReDoS:** both regexes are linear, anchored, single-char-class — `/^BREAKING[ -]CHANGE:/m` (`lib/release.cjs:19`) scans each line start O(n); the type regex `/^([a-z]+)(\([^)]*\))?(!)?:/i` runs on the **first line only** (`:21-22`), no nested/overlapping quantifiers. **No output injection:** the `$GITHUB_OUTPUT` values are a **fixed vocabulary** (`release`=bool, `bump`∈{major,minor,patch,''}) derived from the classifier, never raw commit text (`bin/wrxn.cjs:788`) — a crafted message cannot smuggle a newline or extra output key. Force/suppress = INFO-2. |
| **Double-publish / integrity** | **PASS** | Three independent layers: (1) `concurrency: group: release-${{ github.ref }}` + `cancel-in-progress: false` (`:36-39`) serializes all `main` runs and never aborts an in-flight publish; (2) the `npm view "$PKG@$VER"` unpublished-guard skips an already-published version (`:74-78`); (3) npm's own server-side **version immutability** hard-rejects any duplicate. Provenance (`:80`) is retained so consumers can verify the build. Pinned by `test/release.test.cjs:219-224`. |

## Findings

### MED-1 — `contents: write` is workflow-scoped, ambient to the third-party-code steps in the same job
- **`.github/workflows/release.yml:32-34`** (`permissions:` block at workflow scope) granting `contents: write`, in force across **all** steps of the single `release` job — including `npm install -g npm@latest` (`:61`), `npm ci` (`:64`), `npm test` (`:67`), which execute arbitrary dependency code (postinstall scripts, transitive deps).
- **Issue:** the elevation itself is *necessary and minimal in kind* (the tag push at `:82` needs `contents: write`; GitHub offers no tags-only scope). The problem is **reachability**: `actions/checkout@v4` persists the `GITHUB_TOKEN` into git config by default, so from the moment of checkout an OIDC-capable token that can now **write repo contents** (push branches/tags, create releases) is available to every subsequent step. A supply-chain-compromised dev/transitive dependency running during `npm ci`/`npm test` could use it to push to the repo — a **new capability this slice introduces** (the prior workflow at `c1e2027` was `contents: read`, so the same compromised step could previously only read). Pushing to `main` itself is blocked by the gate-02 ruleset *once applied*, but other refs/tags/releases are not. The exposure of `id-token: write` to those steps is pre-existing (the prior workflow had it too); the `contents: write` reachability is the delta.
- **Severity:** **MEDIUM** — real blast-radius increase on a supply-chain-sensitive auto-publish workflow, but **not** independently exploitable: it requires an already-compromised dependency in our own lockfile, the workflow runs only on trusted post-merge code, and the operator is solo. Non-blocking; this is least-privilege hardening, not an open hole.
- **Fix (tightest first):** (a) move the `permissions` block to **job level** under `release:` so a future-added job cannot silently inherit `contents: write` (minimum, low-cost); (b) stronger — **split jobs**: a `decide`/`test` job at `contents: read` and a minimal `publish` job (`id-token: write` + `contents: write`) that runs only `npm publish` + the tag push and installs nothing untrusted; or (c) set `actions/checkout` `persist-credentials: false` and provide the push credential explicitly only at the tag step, removing the ambient git-push credential from the install/test steps. The in-job `npm test` (`:67`) is already labelled a "pre-publish backstop" and is redundant with CI, supporting option (b).

### LOW-1 — release-time context interpolated inline into a `run:` shell (template-injection class)
- **`.github/workflows/release.yml:57`** — `run: node bin/wrxn.cjs release-check --range "${{ github.event.before }}..${{ github.sha }}"`.
- **Issue:** `${{ … }}` values are substituted into the shell command string **before** the shell runs — the canonical GitHub Actions script-injection sink. Here both values are GitHub-set 40-char **hex SHAs** (`github.sha`, `github.event.before`), not attacker-controllable free text (unlike `head_commit.message`, PR titles, or branch names), so practical injection risk is **negligible**.
- **Severity:** **LOW** / defense-in-depth — flagged because the pattern is the one to avoid categorically.
- **Fix:** pass the values via `env:` and reference shell vars — `env: { BEFORE: ${{ github.event.before }}, SHA: ${{ github.sha }} }` then `--range "$BEFORE..$SHA"` — so no expression is ever spliced into the command line.

### LOW-2 — `--range` rides as a trailing positional into `git log` with no `--` end-of-options guard
- **`bin/wrxn.cjs:772-776`** — the `range` flows as the last argv element of `['-C', root, 'log', '--format=%B%x00', range]` (and the `headRef` branch).
- **Issue:** this is **shell-free** — `execFileSync('git', logArgs, …)` (`:780`) spawns git directly (no `shell`), so shell metacharacters in `range` are inert. The residual is **git argument-injection**: a `range` beginning with `-` could be parsed by `git log` as an *option* rather than a revision (e.g. `--output=…`, `--all`). In the deployed path this is **unreachable** — the workflow supplies hex SHAs (`release.yml:57`) and the zero-sha sentinel is regex-checked (`:772`); only an untrusted *direct* `wrxn release-check --range <evil>` caller could reach it, and the failure mode is git misbehaviour, not code execution. Worst case still **fails closed** (the try/catch at `:778-784` → `raw=''` → no release).
- **Severity:** **LOW** / defense-in-depth.
- **Fix:** insert an end-of-options separator (`'log', '--format=%B%x00', '--', range]` won't work since `--` then means paths — instead place the revision and validate it): validate `range`/`before`/`head` against `^[0-9A-Fa-f]{4,40}$` (or a safe-ref pattern) before building `logArgs`, rejecting a leading `-`.

## Informational (not findings)

- **INFO-1 — the `npm view` idempotency guard fails *open* on transient error.** `PUBLISHED=$(npm view "$PKG@$VER" version 2>/dev/null || true)` (`release.yml:74`): a network/registry hiccup yields an empty `PUBLISHED` → the guard treats the version as unpublished and proceeds to `npm publish`. This is **safe** because npm enforces version immutability server-side (a duplicate publish is hard-rejected) and `concurrency` serializes same-ref runs — so it can never cause an **overwrite**; worst case is one wasted, rejected publish attempt. Acceptable; npm is the real integrity backstop.
- **INFO-2 — a commit *body* `BREAKING CHANGE:` can flip `release=true` from a non-`feat` subject, but the version guard neutralizes it.** `classify()` matches the breaking footer against the full message (`lib/release.cjs:19`), so a `docs: …` PR whose body contains a `BREAKING CHANGE:` line classifies as `major`. However the publish is *also* gated on `package.json.version` being unpublished (`:74-78`); a docs PR does not bump the version, so `npm view` finds it published and the publish step **no-ops**. The type-gate decides whether to *attempt*; the version guard decides whether a publish *happens* — the combination makes the false-positive harmless. In the solo trust model, forcing or suppressing a release via commit text is the author's own action (noise), not an attacker primitive.
- **INFO-3 — tag-push-after-publish has no self-heal.** `npm publish` (`:80`) precedes `git tag`/`git push` (`:81-82`); if the tag push fails after a successful publish, the idempotent re-run short-circuits at the `npm view` guard (`:75-78`) and never retries the tag, leaving a published-but-untagged state. This is an availability/bookkeeping gap, **not** a security issue (the tag is a marker; provenance derives from OIDC, not the git tag).

## What is solid (verified, not assumed)

- **No long-lived npm secret anywhere.** Read of `release.yml` + repo-wide grep for `NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM|//registry…authToken` returned **empty**; a dedicated test pins their absence (`test/release.test.cjs:239-244`). Publish authenticates via the ephemeral OIDC id-token only.
- **Untrusted code cannot reach the publish.** The sole trigger is `push: branches: [main]` (`release.yml:28-30`) — post-merge trusted code; no `pull_request_target`/`workflow_run`. Fork PRs never run this workflow, never see `GITHUB_TOKEN` or OIDC. The tag push does not re-trigger it (tag trigger removed).
- **Fail-closed type-gate.** Non-repo / bad range / empty log → `raw=''` (try/catch, `bin/wrxn.cjs:778-784`) → `parseLog('')`=`[]` → `shouldRelease([])`=`{release:false}` → no publish. Uncertainty resolves to **not publishing** (pinned: `test/release.test.cjs:190-194`). A non-array input is also coerced to no-release (`lib/release.cjs:34`).
- **No ReDoS, no output injection.** Linear anchored regexes; type-classification confined to the first line; `$GITHUB_OUTPUT` carries only fixed-vocabulary classifier values (`bin/wrxn.cjs:788`), never raw commit text — no newline/key smuggling into step outputs.
- **Double-publish triple-guarded.** `concurrency` group keyed on `github.ref` with `cancel-in-progress: false` (`release.yml:36-39`) + the `npm view` unpublished guard (`:74-78`) + npm server-side immutability. Provenance (`--provenance`, `:80`) retained for consumer verification.
- **Single, validated call path.** The gate's only runtime consumer is `release.yml` → `node bin/wrxn.cjs release-check` → `release.shouldRelease(release.parseLog(raw))` (`bin/wrxn.cjs:785`); the pure classifier does no I/O. gate-06 (recon-wrxn) reuse is documented as `npx`, not an in-repo call. Grep-confirmed; nothing reaches the classifier through an unguarded path.

## Cross-slice dependency (security-relevant assumption, not a gate-05 defect)

The workflow's "runs **after CI** by construction" guarantee (`release.yml:5-7`) holds **only** once the
`wrxn-main-gate` ruleset (gate-02) is applied to the kernel repo and requires the `wrxn-ci` check (gate-01).
Per ADR 0007's bootstrap note the kernel "has no ruleset yet" and self-hosts it after this epic lands, so the
first release(s) ride a direct push to `main` under operator control. `push: branches: [main]` fires on *any*
push to `main`; whoever can push directly to `main` (bypassing the server ruleset) is already a repo
admin/owner who could publish regardless — so this widens no privilege beyond the existing trust boundary. The
gate-05 code chose the correct (safe) trigger; the CI-precedence property is owned by gate-01 + gate-02.
