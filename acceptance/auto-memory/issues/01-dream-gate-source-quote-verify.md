# auto-memory-01 — dream gate: `--source` quote verification

**Status:** ready-for-agent
**Type:** AFK
**Parent:** `acceptance/auto-memory/PRD.md`
**User stories:** 6, 7, 24

## What to build

Harden the dream gate so a non-human proposer cannot write a hallucinated "memory". `dream.cjs` `check` and `commit` gain an optional `--source <file>` argument. When present, every evidence quote on a proposal must verifiably appear in the source text (the session transcript blob), or the proposal is rejected. When absent, behavior is byte-identical to today — the manual `dream` skill (trusted main-agent proposer) is unaffected.

This is the single mechanical control that makes auto-dream (later slices) safe without human approval: safety rests on the gate, not the model tier.

## Acceptance criteria

- [ ] `check` and `commit` accept `--source <file>`; omitting it preserves today's exact behavior (legacy path).
- [ ] With `--source`, a proposal whose every evidence quote substring-matches the normalized source is accepted (subject to all existing checks).
- [ ] With `--source`, a proposal with any evidence quote NOT present in the source is rejected with machine reason `quote_not_in_source`.
- [ ] Quote matching is normalized (whitespace-collapsed, case-insensitive) so transcript formatting doesn't cause false rejects, while still requiring the substantive quote text to be present.
- [ ] `quote_not_in_source` composes with the existing gate (confidence floor, secret-scan, negative filters, dedup, identity); precedence is deterministic and documented.
- [ ] Unit tests extend `test/dream.test.cjs`: quote-present → accept, quote-absent → reject, no-`--source` → legacy pass, and compose-with-existing-checks. No real LLM/network.

## Blocked by

None — can start immediately.
