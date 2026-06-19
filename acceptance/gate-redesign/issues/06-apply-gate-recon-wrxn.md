# 06 — Apply the gate to `recon-wrxn`

Status: ready-for-agent

## Parent

`acceptance/gate-redesign/PRD.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`

## What to build

`recon-wrxn` is a published sibling repo, **not** a `wrxn` install — the payload never reaches it, so the
"kernel delivers the flow on update" mechanism doesn't apply. Bring it under the same model with a
documented one-time setup that reuses the protect logic and the CI/release templates (no bespoke
mechanism): the `wrxn-main-gate` ruleset, the `wrxn-ci` workflow, and type-gated release-on-merge.

## Acceptance criteria

- [ ] A runbook in this epic dir documents applying CI + `wrxn-main-gate` ruleset + release-on-merge to `recon-wrxn`, reusing `wrxn protect` and the slice-01/05 workflow templates (no recon-specific logic).
- [ ] `wrxn protect` is repo-agnostic — it applies to `recon-wrxn`'s origin given its slug; covered by a fake-invoker test using a non-kernel slug.
- [ ] Post-application (an operator/devops act): a `recon-wrxn` PR runs the `wrxn-ci` check and can auto-merge, and direct push to `recon-wrxn` `main` is blocked — walk evidence recorded in the runbook.
- [ ] Coverage does not decrease; suite green (`node --test`).

## Blocked by

- 01, 02, 05 — reuses the CI workflow, the protect/ruleset logic, and the release workflow.
