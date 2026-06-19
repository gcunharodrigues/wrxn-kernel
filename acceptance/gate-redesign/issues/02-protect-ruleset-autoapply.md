# 02 — `wrxn protect`: ruleset auto-apply + migration 005

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

The server-side hard gate and its delivery. A protect module builds and applies the `wrxn-main-gate`
GitHub ruleset on a repo's origin — block direct push to `main`, require the `wrxn-ci` status check,
require branch up-to-date (merge queue if the plan supports it), **no bypass actor** — through an injected
command invoker (REUSE the `lib/connect.cjs` pattern). Application is idempotent (create-or-update by
name) and fail-soft (no `gh` auth / not admin / no remote → clear message, exit 0). `wrxn update` calls it
idempotently; migration `005` performs the first application on existing installs.

## Acceptance criteria

- [ ] `buildRulesetSpec()` is pure and returns the ruleset payload (block direct push to `main`, required check `wrxn-ci`, require-up-to-date, no bypass actor); unit-tested for shape.
- [ ] `applyProtection({ invoker })` is idempotent (re-run = no-op) and fail-soft (no gh / not admin / no remote → exit 0 with a message), proven with a fake invoker (prior art `test/connect.test.cjs`).
- [ ] `wrxn protect` CLI applies the ruleset to the repo's origin and prints the outcome.
- [ ] `wrxn update` invokes `applyProtection` idempotently; an `update` on an already-protected repo is a no-op.
- [ ] Migration `005` (`{ id:'005', version:'0.11.0', up(ctx) }`, defensive/idempotent like `migrations/003`) applies protection; tested via the runner contract (prior art `test/serve-http-door-migration.test.cjs`); a no-remote install is a no-op.
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- 01 — the ruleset's required status-check name is `wrxn-ci`.
