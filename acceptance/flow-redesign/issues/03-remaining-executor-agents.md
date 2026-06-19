# 03 — The remaining five executor agents

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

Add the other five executor agents — **reviewer, security, qa-walker, researcher, devops** — each a thin
wrapper over its `EXECUTORS` registry entry, validated by `validateAgentFile` (from issue 02). reviewer and
security may write only their one marker file; `devops` is the only agent that declares push capability.
End-to-end: all six executor agents exist, parse, and pass conformance for their types.

## Acceptance criteria

- [ ] Five agent definitions exist (reviewer, security, qa-walker, researcher, devops), each wrapping its registry entry (skill or global-skill instructions, artifact, isolation, boundary gates, `reportSchema`).
- [ ] Each passes `validateAgentFile` for its type.
- [ ] Least-priv tools per the locked fleet; reviewer/security `Write` scoped to their one marker; only `devops` declares push capability (`canPush`).
- [ ] Models per fleet: reviewer/security = opus; qa-walker/researcher/devops = sonnet.
- [ ] All six agents are registered as managed payload (manifest).
- [ ] Tests assert all six conform, and that a wrong-type or over-privileged agent fails (Seam 1a).
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- 02 (the conformance validator + builder tracer).
