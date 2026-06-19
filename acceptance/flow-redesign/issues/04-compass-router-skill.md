# 04 — compass router skill + coverage check

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

A new `compass` skill — a user- and model-invocable router over the skills + the build flow. Its body is
**static flow-doctrine** (the four phases, the HITL/AFK split, which executor owns each AFK step) plus an
instruction to **read the installed skills live** at invoke time and bucket them by the flow — so the map
can't go stale. The single "create a skill" route points at `write-a-skill` (skill-creator marked legacy).
Add a pure `compassCoverage(skills, buckets)` that ensures every installed skill is routed (no orphan).
End-to-end: invoking compass yields the live map; the coverage check fails if any skill is unrouted.

## Acceptance criteria

- [ ] `compass/SKILL.md` exists with frontmatter (user-invocable + model-invocable, tight description), the static four-phase doctrine, and the live-skill-read + bucket instruction.
- [ ] The doctrine names the six executor agents per ADR 0006 and references `wrxn flow status` for progress (forward reference is fine; the command ships in issue 05).
- [ ] "create a skill" routes to `write-a-skill` only; `skill-creator` is marked legacy.
- [ ] `compassCoverage` returns ok when every skill maps to a bucket and errors listing any orphan skill (Seam 1c).
- [ ] compass is registered as managed payload (manifest).
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- 01 (the doctrine compass restates must match the rewritten pipeline flow).
