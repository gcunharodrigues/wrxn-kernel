---
id: gate-redesign-08
title: "Stale wiki concept still teaches the WRXN_ACTIVE_AGENT/settings.local.json dance"
created: 2026-06-19
status: open
labels: [needs-triage, bug]
---

## Parent

`acceptance/gate-redesign/issues/04-retire-pushgates-reconcile-doctrine.md` — AC-5:
"Constitution Art. I + III, `payload/.synapse/*` (pipeline/global rule text), and the wiki concept
`wrxn-git-push-authority-hook.md` describe the PR + CI + auto-merge model with no surviving
contradiction."

## What happened

**Promised:** The wiki concept `wrxn-git-push-authority-hook.md` describes the new PR + CI +
auto-merge promotion model with no surviving reference to the WRXN_ACTIVE_AGENT/settings.local.json
dance.

**Observed:** The file at `<WRXN-OS>/.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md` was not
updated in gate-04. Its content still describes the retired mechanism:

- Frontmatter `description`: "blocks remote git ops unless a deliberate-confirmation flag
  (WRXN_ACTIVE_AGENT=devops) is set in settings.local.json"
- Body section "How to authorize a push" instructs setting WRXN_ACTIVE_AGENT=devops in
  settings.local.json, then removing it after the push
- `derived_from: .claude/hooks/enforce-push-authority.cjs` — the deleted hook

This directly contradicts gate-04's new doctrine (constitution Art. I, GLOBAL_RULE_0,
ROUTING_RULE_0). A developer reading this wiki concept will learn the wrong mechanism.

## Repro steps

```
$ cat <WRXN-OS>/.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md
---
description: How git push works in WRXN-OS — a PreToolUse hook blocks remote git ops unless a
deliberate-confirmation flag (WRXN_ACTIVE_AGENT=devops) is set in settings.local.json.
...
---

## How to authorize a push
1. Add the flag under the `env` key of the machine-local `.claude/settings.local.json`:
   { "env": { "WRXN_ACTIVE_AGENT": "devops" } }
2. Push.
3. Remove it ...
```

The retired hook name `enforce-push-authority.cjs` is also cited (`derived_from` frontmatter key).

## Evidence excerpt

From walk P6b:
- File path: `<WRXN-OS>/.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md`
- Frontmatter description still names the retired env flag + settings.local.json dance
- Section "How to authorize a push" still instructs the WRXN_ACTIVE_AGENT=devops steps
- The hook it's derived from (`enforce-push-authority.cjs`) was deleted in gate-04

## Fix guidance

The file is a seeded wiki concept in the WRXN-OS install — `wrxn update` will NOT overwrite it.
Options:
1. Manually rewrite the file in the WRXN-OS install to describe `wrxn ship` + the server-enforced
   ruleset, replacing or archiving the old hook description.
2. Create a gate-04 migration that updates this seeded file in-place across installs.
3. Rename it to reflect the new model (e.g. `wrxn-git-push-ship.md`) and archive the old one.

## Blocked by

None
