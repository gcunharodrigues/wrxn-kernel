# Operator Layer (workspace profile)

This file is laid ONLY by a `wrxn init --workspace` install — it is the representative marker of
the **workspace profile**. A `--project` install never receives it.

The workspace profile = the project profile (dev pipeline + intelligence layer + enforcement
boundary) **plus** the operator layer:

- onboarding + the decisions log
- the audit / level-up operating rituals
- the connections registry (the workspace nervous system — `wrxn connect`; see issue 21)

Project installs are the floor; workspace installs are the superset. This is a seeded file —
yours to edit; `wrxn update` never overwrites it.
