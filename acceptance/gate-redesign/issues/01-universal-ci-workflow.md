# 01 — Universal CI workflow (the sole hard gate)

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

A kernel-shipped CI workflow that becomes the single required status check (`wrxn-ci`) the branch
ruleset gates on. On every pull request it runs the project's real test command **plus** kernel-universal
checks, so CI is never a vacuous pass even on a repo with no suite. The universal checks are pure node
predicates the workflow invokes and unit tests exercise: managed-file integrity (files classed `managed`
in `wrxn.install.json` are not drifted), wiki-lint, synapse-manifest lint, JSON validity, and
`node --check` syntax over the payload `.cjs`. Ships as a managed payload file so `wrxn init`/`update`
lays it into every install.

## Acceptance criteria

- [ ] `.github/workflows/wrxn-ci.yml` is a managed payload file (in the manifest; lands in an install on init/update).
- [ ] On `pull_request` the workflow runs a check named `wrxn-ci` that aggregates: the project `WRXN_TEST_CMD` (run only when it is a real command — skipped for `true`/empty), managed-integrity, wiki-lint, synapse-manifest lint, JSON validity, `node --check`.
- [ ] The universal checks are pure functions with unit tests (prior art `test/hooks-managed.test.cjs`): each fails on a planted violation and passes on a clean tree.
- [ ] CI is never vacuous: a repo with `WRXN_TEST_CMD=true` still runs (and can fail on) the universal checks.
- [ ] `wrxn-ci.yml` is valid YAML and invokes the node check scripts (structural test, prior art `test/settings-hook-paths.test.cjs`).
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- None — can start immediately.
