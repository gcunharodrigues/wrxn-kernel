# 03 — `wrxn ship`: the autonomous promote path + `devops` rewrite

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

The one-command promote path that replaces the `WRXN_ACTIVE_AGENT` dance. A ship module builds and runs
the promote sequence — create/push a branch, `gh pr create`, enable auto-merge (`gh pr merge --auto
--squash`) — through an injected invoker (REUSE the `lib/connect.cjs` pattern). `wrxn ship` CLI. The
`devops` executor agent is rewritten so its job is `wrxn ship` then confirm auto-merge is armed; its
set→push→unset settings.local.json dance is removed.

## Acceptance criteria

- [ ] `buildShipPlan()` is pure: given branch/title, returns the ordered git + `gh` commands (branch, push, `gh pr create`, `gh pr merge --auto --squash`); unit-tested.
- [ ] `ship({ invoker })` runs the plan via the injected invoker; tested with a fake invoker (no real network).
- [ ] `wrxn ship` CLI opens a PR with auto-merge enabled (validated by invocation against the real `gh` at the CLI layer).
- [ ] `payload/.claude/agents/devops.md` describes the `wrxn ship` promote path and contains NO `WRXN_ACTIVE_AGENT` / settings.local.json dance.
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- None — can start immediately.
