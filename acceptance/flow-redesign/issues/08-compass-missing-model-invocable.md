---
title: "compass/SKILL.md missing model-invocable: true in frontmatter"
labels: [invalid, wontfix]
status: closed-invalid
---

> **Triage 2026-06-18 — CLOSED, invalid (false positive).** Claude Code skills are model-invocable **by
> default**; the only related field is `disable-model-invocation: true`, which turns it OFF. There is no
> `model-invocable: true` field — applying the suggested fix would inject a non-existent key. compass has
> `user-invocable: true` and NO `disable-model-invocation`, so it is correctly **both** user- and
> model-invocable (issue 04 AC1 satisfied). The finding itself notes "functional behavior unaffected."
> No code change. (Verified in the flow-redesign correction pass.)

# 08 — compass/SKILL.md missing `model-invocable: true` in frontmatter

## Parent

`.scratch/flow-redesign/issues/04-compass-router-skill.md` — AC1: "compass/SKILL.md exists with
frontmatter (user-invocable + model-invocable, tight description)"

## Promise vs Observed

**Promise (issue 04 AC1):** `compass/SKILL.md` frontmatter declares both `user-invocable: true` AND
`model-invocable: true` (the skill is explicitly designed as both user-invocable and model-invocable,
per PRD user story 5: "As a lost orchestrator agent, I want to invoke `compass` mid-task").

**Observed:** Frontmatter contains only `user-invocable: true`. The `model-invocable` field is absent.

```yaml
# current payload/.claude/skills/compass/SKILL.md frontmatter
---
name: compass
description: Router over the skills and the build flow — …
user-invocable: true
---
```

## Repro

```bash
head -6 payload/.claude/skills/compass/SKILL.md
```

Expected: `model-invocable: true` appears on a line after `user-invocable: true`.
Actual: line absent.

## Evidence excerpt

```
$ head -6 payload/.claude/skills/compass/SKILL.md
---
name: compass
description: Router over the skills and the build flow — ask "which skill or flow fits: where am I, what's next." Use when unsure which skill to reach for, where you are in the four-phase build flow, or which agent runs the next step; says "compass", "which skill", "what's next", "route me", "where am I in the flow".
user-invocable: true
---
```

`model-invocable: true` does not appear.

## Impact

Non-blocking. The functional behavior of compass is unaffected — both users (via `/compass`) and models
(via the Skill tool) can invoke it. The `description` field already serves as the model-routing trigger.
However, the AC explicitly requires both flags; their absence means the declared frontmatter contract
doesn't match the promise.

## Suggested fix

Add `model-invocable: true` to the frontmatter:

```yaml
---
name: compass
description: Router over the skills and the build flow — …
user-invocable: true
model-invocable: true
---
```

This is a one-line change to `payload/.claude/skills/compass/SKILL.md`.
