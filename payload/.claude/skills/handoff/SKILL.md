---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Save it to the install's continuity slot: `.wrxn/continuity/latest.md` (resolve the install root by walking up to the `wrxn.install.json` receipt; create the `.wrxn/continuity/` directory if absent). This slot is the deliberate, intent-carrying baton — the NEXT session's `session-start` hook injects its contents as the resume surface, taking precedence over the automatic episodic session page.

CONTINUITY DOCTRINE: this skill is the SINGLE writer of `.wrxn/continuity/latest.md`. The automatic `session-end` hook writes ONLY dated session pages under `.wrxn/wiki/sessions/` and NEVER touches the baton — so a deliberate handoff is never clobbered by the automatic episodic record. Overwrite the previous baton (the latest deliberate handoff is the live one).

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
