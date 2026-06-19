# 06 — qa-walk operator-mode (human whole-artifact walk)

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

Add an **operator-mode** section to the `qa-walk` skill: the human walks the **whole assembled artifact
against all PRD stories** (story-level), distinct from the agent's per-slice **AC-level** walk. Findings
auto-file as tracker issues, as today. End-to-end: the qa-walk skill documents both modes and when each
applies.

## Acceptance criteria

- [ ] `qa-walk/SKILL.md` has an operator-mode section: whole assembled artifact, all PRD stories, story-level, run by the operator.
- [ ] It contrasts with the agent per-slice AC-level walk so there is no ambiguity which mode applies when.
- [ ] Findings still auto-file as tracker issues.
- [ ] No regression to the existing agent (per-slice) qa-walk behavior.
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- None — can start immediately.
