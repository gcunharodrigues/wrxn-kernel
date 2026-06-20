# auto-memory-04 — auto-dream: synth → gated + quote-verified → auto-commit

**Status:** ready-for-agent
**Type:** AFK
**Parent:** `acceptance/auto-memory/PRD.md`
**User stories:** 5, 6, 7, 19, 25

## What to build

The synth's dream path, running automatically after the handoff with no human approval. After writing the baton, the synth builds dream proposals via the engine (`dream` task — the faithful proposal prompt: ≤5 evidence-backed concept/decision/gotcha/rule pages), then runs them through `dream.cjs check --source <blob>`, stages the accepted set, and commits the accepted slugs (the commit re-gates). Auto-approval = exactly the gate's accepted set.

This runs in the background after the baton is written, so it never extends the session-start hold. The manual `dream` skill path (no `--source`, trusted proposer) is unchanged.

## Acceptance criteria

- [ ] On SessionEnd (after the handoff), the synth produces dream proposals and commits only those that pass `dream.cjs check --source <blob>` — verified end-to-end with a fake invoker.
- [ ] A proposal with a fabricated quote (not in the transcript) is rejected (`quote_not_in_source`) and never written.
- [ ] The existing gate is honored end-to-end: confidence floor (0.75), secret-scan, anti-superstition filters, dedup, ≤5/run.
- [ ] Auto-commit writes net-new pages additively (dedup-skip); there is no human approval step.
- [ ] Dream runs after the baton is written and does NOT extend the session-start hold.
- [ ] The manual `dream` skill path (no `--source`) is unchanged.
- [ ] Unit tests (fake invoker): accepted proposal written; fabricated-quote dropped; gate-reject dropped; abstain → nothing written.

## Blocked by

- auto-memory-01 (the `--source` quote-verify gate).
- auto-memory-03 (the synth scaffold: spawn hook, transcript blob, marker lifecycle).
