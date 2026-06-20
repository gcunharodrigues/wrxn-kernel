# auto-memory-05 — migration: remove handoff skill, drop `_slots`, wire SessionEnd

**Status:** ready-for-agent
**Type:** AFK
**Parent:** `acceptance/auto-memory/PRD.md`
**User stories:** 21, 22, 23

## What to build

Transition the payload and every existing install onto auto-memory, and remove what it supersedes.

- **Payload removals:** delete the `handoff` skill (the synth is now the baton writer); remove `_slots/current-focus` support — the `dream.cjs` `set-focus` op and the `dream` skill's "Refreshing the focus slot" section — and drop the `_slots` references.
- **Migration (sibling to migration 004):** on `wrxn update`, remove the install's `handoff` skill files, wire the new `SessionEnd` spawn hook into the install `settings.json`, seed `memory.config.json` if absent, and remove `_slots/current-focus.md`. Idempotent; never throws on a clean install.
- **Release:** bump `package.json` so the migration's version ≤ the package version (no-inert-migration invariant); ships as the next `feat` minor.

## Acceptance criteria

- [ ] Payload no longer ships the `handoff` skill; manifest updated; the synth is the documented sole baton writer.
- [ ] `dream.cjs` `set-focus` op removed; the dream skill's focus-slot section removed; no remaining `_slots` references in the payload.
- [ ] The migration removes the `handoff` skill from an existing install, wires `SessionEnd` → the spawn hook, seeds `memory.config.json` if absent, and removes `_slots/current-focus.md`.
- [ ] The migration is idempotent and never throws on a clean install; it runs via `wrxn update`.
- [ ] `package.json` version bumped so the migration's version ≤ the package version; ships as a `feat` minor.
- [ ] Tests mirror `test/retire-session-capture-migration.test.cjs` (isolation `up()` + e2e through `wrxn update`); managed-integrity / settings-wiring tests updated.

## Blocked by

- auto-memory-01, auto-memory-02, auto-memory-03, auto-memory-04 (the final payload shape — hooks, config, dream-gate changes — must exist before the migration wires installs onto it).
