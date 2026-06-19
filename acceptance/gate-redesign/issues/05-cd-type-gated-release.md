# 05 — CD: type-gated release-on-merge

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

Continuous delivery with no manual release step. Adapt the existing `.github/workflows/release.yml` to
trigger on push to `main`; a pure type-gate decides whether a merge publishes (conventional commits
`feat`/`fix`/`perf`/breaking → bump + publish; `chore`/`docs`/`refactor`/`test` → no publish). Reuse the
current npm **OIDC tokenless + provenance** publish; add a `concurrency` group so two merges can't
double-publish. Applies to the published repos (kernel here; `recon-wrxn` in slice 06).

## Acceptance criteria

- [ ] `shouldRelease(commits)` is a pure function returning whether — and at what bump level — a merge publishes, by conventional-commit type; unit-tested across types (feat/fix/perf/breaking publish; chore/docs/refactor/test do not).
- [ ] `release.yml` triggers on push to `main`, runs after CI, publishes via OIDC + provenance only when `shouldRelease` is true, and is `concurrency`-locked.
- [ ] The publish path keeps tokenless OIDC + provenance (no long-lived npm token reintroduced).
- [ ] `release.yml` is valid YAML (structural test).
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- 01 — CD runs after, and reuses the infrastructure of, the `wrxn-ci` workflow.
