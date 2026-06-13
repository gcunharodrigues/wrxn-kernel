---
name: onboard
description: Use on Day 1 of a wrxn workspace install, or when someone says "set me up", "onboard me", "fill in my AIOS". Runs the intake interview AND scaffolds the Day-1 operator file set. Idempotent — re-run any time after editing aios-intake.md.
---

## What this skill does

A combined wizard over `aios-intake.md` (the canonical intake): conduct the interview if the file
isn't filled, then scaffold the Day-1 operator file set under `context/`.

## Execution

### Step 1 — Read the intake

Read `aios-intake.md`. Check which Q1-Q7 sections have content vs. `[Your answer here]` placeholders.
- All filled → skip Step 2, go to Step 3.
- Some filled → ask which to fill now vs. scaffold from what's there.
- None filled → run Step 2 conversationally.

### Step 2 — The interview (7 questions, one at a time)

Write each answer into `aios-intake.md` as you go, so the user can resume if interrupted. Q1 identity
+ offer + ICP; Q2 raw voice samples (MUST be pasted, never typed mid-conversation); Q3 90-day
priorities (push for a number/deadline); Q4 revenue + where tracked; Q5 comms channels; Q6 docs/notes;
Q7 the task that eats the week + where work is tracked.

### Step 3 — Scaffold the Day-1 file set

The scaffold is DETERMINISTIC and CLI-First — run it (do not hand-write the files):

```
wrxn onboard --root .
```

It reads the filled `aios-intake.md` and writes the `context/` set (about-me, about-business,
priorities) + seeds `connections.md`. Idempotent: re-running overwrites the generated `context/`
files from the current intake (your hand-edited seeds — decisions/log.md, connections.md — are never
clobbered; they are seeded class).

### Step 4 — The wow

Close with: *"Try this — ask me: what should I focus on this week?"* That plants the Default-Shift
mindset. There's no `/today` skill — the prompt itself is the wow.
