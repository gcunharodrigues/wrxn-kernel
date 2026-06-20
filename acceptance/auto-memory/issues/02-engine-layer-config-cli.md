# auto-memory-02 — synth engine layer: injectable invoker + config + manual CLI

**Status:** ready-for-agent
**Type:** AFK
**Parent:** `acceptance/auto-memory/PRD.md`
**User stories:** 9, 10, 11, 12, 13, 14, 15, 26, 28

## What to build

The reusable synthesis core both later tasks (handoff, dream) call. Given a task name (`handoff` | `dream`), a prompt, and a transcript blob, it resolves the engine from a per-task config, invokes it, and returns the text — with every LLM/network/spawn call behind an **injectable invoker** (default real; tests inject a fake), so the orchestration is unit-tested with no real model.

Ships a seeded, operator-editable `memory.config.json` (JSON, not YAML — payload adapters are node-stdlib-only) and reads `GEMINI_API_KEY` from `.env`. A manual CLI entry runs it against a transcript file and prints the synthesized text, so the slice is demoable without any hooks.

## Acceptance criteria

- [ ] `memory.config.json` seeded with per-task (`handoff`, `dream`) `{primary, fallback}` of `{engine, model}`; defaults: primary `claude`/`claude-sonnet-4-6`, fallback `gemini`/`gemini-3.1-flash-lite`. Seeded class (preserved across `wrxn update`); registered in the manifest.
- [ ] Engine resolver tries `primary` then `fallback`; both fail → returns null (caller writes nothing). Resolution is a pure function unit-tested with a fake invoker.
- [ ] `claude` engine invokes `claude -p --model <id>` with the prompt on stdin, `WRXN_MEMORY_SYNTH=1` in env, and a bounded timeout; uses the operator's CLI auth (no key in config).
- [ ] `gemini` engine POSTs to the `…:generateContent` endpoint with `x-goog-api-key` from `.env`; a missing key fails that engine (→ fallback / null), never throws.
- [ ] All LLM/network/spawn calls are behind the injectable invoker; the test suite never makes a real call.
- [ ] Manual CLI: given a transcript file + task, prints the synthesized text (demoable without hooks).
- [ ] Unit tests cover primary→fallback selection, `claude` arg construction, `gemini` request shape, and missing-key / missing-CLI graceful degradation — all with the fake invoker.

## Blocked by

None — can start immediately.
