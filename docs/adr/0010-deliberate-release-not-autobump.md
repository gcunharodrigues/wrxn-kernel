# ADR 0010 — Release cadence: a deliberate `wrxn release` PR, not auto-bump-on-merge

- **Status:** Accepted (2026-06-27) — PRD #101 (`grill-with-docs`). **Supersedes ADR 0007 pt 4.**
- **Context:** ADR 0007 pt 4 promised "on merge to `main`, `feat`/`fix`/`perf`/breaking → **auto-bump +
  publish**." The implemented CD (`release.yml`, gate-05) deliberately does **not** auto-bump, for two
  reasons its own header records: (1) `test/migrate.test.cjs` enforces every migration's version ≤
  `package.json.version`, so the version cannot be a moving placeholder a merge rewrites; (2) a bump
  committed back to `main` would re-hit the `wrxn-main-gate` ruleset (a PR-to-bump chicken/egg). The real
  model is **"the developer bumps `package.json` in the PR."** Net drift: a plain `feat` merge with an
  unbumped version → CD probes npm, sees the version already published → **silently skips** (run exits
  success, nothing published), so every release needed a manual 4-step `chore(release)` dance (evidence:
  release run 28286221240, merge of #91; 0.20.0 was hand-cut twice this session).

## Decision

**Bless the deliberate-release model; do not chase auto-bump-on-merge.** For a solo, low-frequency-release
kernel, batching feats into one deliberate release is good — and auto-bump-commit-back re-introduces exactly
the chicken/egg the impl avoided and fights ADR 0007's own ruleset. Instead, kill the *friction* and the
*silent skip*, and reconcile the docs:

1. **A Release is a deliberate `chore(release)` PR** that bumps `package.json` (+ lockfile), cut by the new
   **`wrxn release [minor|patch|major]`** one-command helper — compute the bump (auto from conventional
   commits since the last tag via `release-check`, or an explicit level) → `npm version <bump>
   --no-git-tag-version` → commit `chore(release): <pkg> X.Y.Z` on `chore/release-X.Y.Z` → **delegate**
   push → PR (base `main`) → arm auto-merge to the existing **`wrxn ship`** path. It does **not** publish or
   tag — CD owns that.
2. **CD publishes on merge** via `decidePublish` (`typeRelease || version-not-on-npm`, ADR 0007 / #43): the
   `chore(release)` merge lands a version not yet on npm → CD publishes it. `package.json.version` stays the
   single source of truth (preserving the `migrate.test.cjs` floor); there is **no commit-back to `main`**.
3. **Feats accumulate unreleased** between Releases — a `feat` merge lands on `main` but does not publish.
4. **The silent skip becomes visible** — CI warns when releasable commits sit on `main` with the version
   unbumped, pointing at `wrxn release` (Slice B).

The helper is **repo-agnostic** (operates on the cwd `package.json` + git), so both published repos —
`wrxn-kernel` and `recon-wrxn` — release with the same command.

## Considered and rejected

- **Auto-bump-commit-back-to-`main`** (the literal ADR 0007 pt 4 promise) — re-introduces the PR-to-bump
  chicken/egg against the `wrxn-main-gate` ruleset, and a placeholder version breaks the `migrate.test.cjs`
  version-floor invariant. This is the precise pair the impl deliberately avoided.
- **release-please / changesets** — release-automation machinery beyond a solo, low-frequency kernel; the
  `wrxn release` helper + `decidePublish` already cover the need with no new dependency.

## Consequences

- ADR 0007 pt 4's "auto-bump + publish" wording is superseded by this ADR; pt 4 carries a one-line pointer.
- The `bump` output of `release-check` stops being vestigial — `wrxn release` consumes it for the auto path.
- Kernel change: propagates only on publish + per-install `npx @gcunharodrigues/wrxn update`.

## Sources

PRD #101 (`grill-with-docs`, 2026-06-27); #93 (doc-vs-impl drift). ADR 0007 pt 4 + `release.yml` (gate-05).
`lib/release.cjs` (`release-check` / `decidePublish`, #43). `lib/ship.cjs` (the reused push/PR/arm path).
