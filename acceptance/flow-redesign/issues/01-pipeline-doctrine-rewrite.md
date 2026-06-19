# 01 — Pipeline doctrine rewrite (four-phase flow)

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

Rewrite the always-on pipeline domain (the injected rules in `payload/.synapse/pipeline`) from the linear
unified-dev route into the **four-phase flow**: HITL front (grill → [research] → [prototype] → PRD →
issues → verticality) → AFK per slice (builder → reviewer → security → agent qa-walk, onto an integration
branch) → human qa-walk (whole artifact) → correction pass → single post-accept trunk push. Sharpen the
constitution/global HITL-spine + AFK-executor language to match, using the CONTEXT.md "Build flow"
glossary. Keep the scale-to-novelty rule. End-to-end: a fresh session injects the new doctrine as
always-on rules.

## Acceptance criteria

- [ ] Pipeline rules describe the four phases in order, naming the per-slice gate order, the human qa-walk gate, the correction pass, the integration branch, and the single post-accept trunk push.
- [ ] Review + security are stated as **per-slice**, not batched after the build.
- [ ] The scale-to-novelty rule is retained.
- [ ] The rewritten rules inject as always-on doctrine within the token-budget governor (Seam 2: synapse engine injection test asserts presence + budget).
- [ ] Constitution/global language references executors + the human qa-walk consistently with the CONTEXT.md glossary; no contradiction with Arts. I–III.
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- None — can start immediately.
