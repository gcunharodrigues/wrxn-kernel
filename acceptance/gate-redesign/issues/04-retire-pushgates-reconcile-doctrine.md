# 04 — Retire the push-gates + kill the dance + reconcile doctrine

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

Remove the superseded client-side push machinery and flip the doctrine to match — **in one slice**, so
there is no intermediate commit where the Constitution says "set the flag" while the hook is already gone.
Delete the three push-gate hooks (the ruleset + CI replace them), rewire settings, demote the managed-file
guard to a non-blocking advisory (its teeth move to CI managed-integrity in slice 01), and rewrite the
Constitution / synapse rules / wiki concept to the PR + CI + auto-merge model. After this, zero
`settings.local.json` env flags remain anywhere in the kernel.

## Acceptance criteria

- [ ] `payload/.claude/hooks/{enforce-push-authority,enforce-review-marker,enforce-tests-on-push}.cjs` are deleted and removed from the manifest (so `update` removes them from installs).
- [ ] `payload/.claude/settings.json` PreToolUse:Bash no longer references the deleted hooks; a `settings-hook-paths`-style test asserts their absence and that the remaining wiring is intact.
- [ ] `enforce-managed-guard.cjs` (+ `enforce-managed-precommit.cjs`) no longer read `WRXN_MANAGED_CONFIRM` and never emit `{decision:"block"}` — they emit a non-blocking advisory; tested at the decision-function boundary (prior art `test/hooks-managed.test.cjs`).
- [ ] No kernel payload or doctrine references `WRXN_ACTIVE_AGENT` or the settings.local.json push dance (grep-clean across the repo).
- [ ] Constitution Art. I + III, `payload/.synapse/*` (pipeline/global rule text), and the wiki concept `wrxn-git-push-authority-hook.md` describe the PR + CI + auto-merge model with no surviving contradiction.
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- 02 — the server ruleset must exist before the local gates are removed (no protection gap).
