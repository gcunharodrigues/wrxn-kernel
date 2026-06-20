# PRD — auto-memory: hook-driven automatic handoff + dream consolidation

**Status:** ready-for-agent (HITL design locked in conversation 2026-06-20)
**Build target:** the wrxn kernel payload (`payload/`), shipped to every install via a kernel release.
**Parent decisions:** ADR 0003 (dream gate), kernel-10 (session hooks), migration 004 (retire-session-capture).
**Supersedes:** the manual `handoff` skill and the `_slots/current-focus` slot.

## Problem Statement

Today an operator must *manually* preserve memory between sessions:

- **Handoff is a manual chore.** The `handoff` skill (`disable-model-invocation: true`) only runs when the operator types `/handoff`, and then the *main agent* hand-writes the baton `.wrxn/continuity/latest.md`. Forget to run it and the next session resumes cold — there is no automatic baton (the `session-end`/`session-history` hooks and the dated `sessions` tier were retired in migration 004, so nothing captures the session anymore).
- **Dream is a manual, attended, approval-gated chore.** `dream` reflects on the live session, proposes pages, and **blocks on operator confirmation** for every write ("never autonomous… never a write without confirmation"). Durable learnings are captured only if the operator remembers to run it *and* sits through the approval loop.

Net effect: cross-session continuity and durable knowledge depend on the operator doing manual work at the end of every session. In practice it gets skipped, and memory rots (the live `_slots/current-focus.md` is already stale at kernel `0.7.3`).

The operator has a working **automatic** pattern in another workspace (`aimem-handoff`: a SessionEnd hook that summarizes the transcript with an external LLM and writes a rich handoff with no human in the loop) and wants the kernel to work the same way — for both handoff and dream — without manual steps or approval clicks.

## Solution

Make memory **automatic and hook-driven**, writing to the kernel file-wiki (the store the Brain already recalls), with no manual skill invocation and no per-session approval:

- On **SessionEnd**, a hook spawns a detached background synthesizer. The synth reads the session transcript, generates a **handoff** and writes it to the baton (`.wrxn/continuity/latest.md`), then generates **dream** proposals and commits the ones that pass the gate — all automatically.
- On **SessionStart**, the existing baton reader first **holds** (bounded by a crash safety-cap) until an in-flight synth has finished writing the baton, so even a rapid `/clear` resumes on the fresh handoff.
- Synthesis uses **`claude -p` (headless) with `claude-sonnet-4-6` by default**, falling back to **`gemini-3.1-flash-lite`** if the CLI is unavailable, configurable **per task** (handoff vs dream) and overridable to opus for max fidelity.
- Auto-dream is made **safe without human approval** by hardening the existing gate: each evidence quote must verifiably appear in the session transcript, so a hallucinated "memory" cannot reach permanent recall.

The manual `handoff` skill is removed (the synth is the new baton writer); the `_slots/current-focus` slot is dropped (the auto-handoff baton + recalled dream pages carry "where we are / what's next").

## User Stories

1. As an operator, I want a handoff baton written automatically when a session ends, so that I never lose continuity by forgetting to run `/handoff`.
2. As an operator, I want the next session to resume on the freshest handoff, so that a `/clear` mid-task picks up exactly where I stopped.
3. As an operator, I want session-start to wait until an in-flight synthesis finishes writing the baton, so that a back-to-back `/clear` does not resume on a stale baton.
4. As an operator, I want that wait to be bounded by a safety-cap, so that a crashed synthesizer can never hang the start of my next session forever.
5. As an operator, I want durable learnings consolidated into wiki pages automatically at session end, so that the Brain accumulates knowledge without me running `dream` or approving each page.
6. As an operator, I want auto-dream to never write a page whose evidence quote is not actually in the session, so that a hallucination can't poison permanent recall.
7. As an operator, I want auto-dream to still honor the existing gate (confidence floor, secret-scan, anti-superstition filters, dedup, ≤5/run), so that the safety properties I rely on are preserved minus the manual click.
8. As an operator, I want the handoff to be a faithful, dense summary (TL;DR, goal, current state, decisions+why, files, next step, open items, dead-ends), so that a cold agent can resume without re-deriving context.
9. As an operator, I want synthesis to use `claude -p` with `claude-sonnet-4-6` by default, so that I get strong fidelity at lower cost/latency than opus.
10. As an operator, I want a fallback to `gemini-3.1-flash-lite` when `claude -p` is unavailable, so that handoff/dream still happen on a machine without the Claude CLI logged in.
11. As an operator, I want the model for handoff and for dream configurable independently, so that I can run a fast model for handoff and a higher-fidelity model for dream.
12. As an operator, I want to override the default to opus per task, so that I can buy maximum fidelity when I want it.
13. As an operator, I want model settings in a readable JSON config the update process never clobbers, so that my choices survive `wrxn update`.
14. As an operator, I want the Gemini API key in a gitignored `.env`, so that the fallback works without committing a secret.
15. As an operator, I want `claude -p` to use my existing CLI auth, so that the primary path needs no API key in config.
16. As an operator, I want the SessionEnd hook to return immediately (synthesis runs detached), so that closing a session is never blocked by summarization.
17. As an operator, I want the background synthesis to never recursively trigger itself, so that spawning `claude -p` from a SessionEnd hook can't fork-bomb my machine.
18. As an operator, I want trivial/empty sessions skipped, so that I don't pay model cost to summarize a session with nothing in it.
19. As an operator, I want secrets redacted from the handoff and never written into a dream page, so that a durable artifact never hardens a credential.
20. As an operator, I want the auto-handoff to remain the single writer of the baton, so that the continuity doctrine (no clobber) holds with the writer shifted from skill to synth.
21. As an operator, I want the stale `_slots/current-focus` slot and its `set-focus` op removed, so that I'm not maintaining a redundant, rot-prone page.
22. As an operator updating an existing install, I want the old `handoff` skill removed and the new SessionEnd hook wired automatically, so that `wrxn update` migrates me with no manual edits.
23. As an operator updating an existing install, I want a default `memory.config.json` seeded (and preserved on re-update), so that auto-memory works out of the box and stays mine after I edit it.
24. As an operator, I want the dream gate's new quote-verification to be opt-in via a source argument, so that a human running `dream` manually (trusted proposer) is unaffected while the auto path is verified.
25. As an operator, I want the manual `dream` skill to remain available for deliberate attended consolidation, so that I can still curate memory by hand when I choose.
26. As a kernel maintainer, I want the synth's LLM calls behind an injectable invoker, so that the orchestration is unit-tested with no network, process spawn, or real model.
27. As a kernel maintainer, I want the new managed files registered in the manifest and wired in settings, so that managed-integrity and the hook wiring stay consistent across installs.
28. As an operator on a machine with neither `claude -p` nor a Gemini key, I want synthesis to fail safe (write nothing, clear the pending marker), so that a missing engine degrades gracefully instead of breaking session start.

## Implementation Decisions

- **Scope: kernel payload.** New hooks/scripts ship under `payload/`, registered in `manifest.json` (`class: managed`, `profile: project`) and wired in `payload/.claude/settings.json`. Reaches every install on the next release + `wrxn update`.
- **Backend: the kernel file-wiki (store A).** Handoff → the baton `.wrxn/continuity/latest.md`; dream → the `concepts`/`decisions`/`gotchas`/`_rules` tiers via the existing `dream.cjs` + `wiki.cjs` adapters. No dependency on the ai-memory daemon.
- **Three moving parts, two new files + one extension** (the kernel already owns the baton and its reader):
  - `memory-synth-spawn.cjs` — a new **SessionEnd** hook. Reads the payload (`transcript_path`, `cwd`, `session_id`), stashes it, writes a `.pending` marker under `.wrxn/continuity/`, spawns `memory-synth.cjs` **detached** (`spawn(detached, stdio:'ignore').unref()`), prints `{}`. SessionEnd is currently unwired, so this is the sole SessionEnd hook.
  - `memory-synth.cjs` — the background synthesizer. Builds a bounded transcript blob (prompts + assistant text + thinking + tool_use + truncated tool_result), runs the **handoff** task (writes the baton, then clears the handoff marker to release session-start), then the **dream** task (gate + commit), and always clears `.pending` on exit.
  - `session-start.cjs` — **extended** with a bounded "hold": before its existing baton read, poll the handoff marker until cleared (synth wrote the baton) or a crash safety-cap elapses, then read + inject as today.
- **Transcript source.** Solely the SessionEnd payload's `transcript_path` (the Claude Code transcript JSONL). The retired `.trail`/session-history is not used.
- **Engine selection (per task).** A resolver tries `task.primary` then `task.fallback`:
  - `claude` engine → `claude -p` headless, `--model <id>`, prompt on stdin, bounded timeout, `WRXN_MEMORY_SYNTH=1` in env. Uses the operator's CLI auth (no key).
  - `gemini` engine → HTTPS POST to `…/v1beta/models/<model>:generateContent` with `x-goog-api-key` from `.env` (mirrors the proven `aimem-handoff-synth` call).
  - Both fail → write nothing, clear markers (fail-safe).
- **Default tiering.** handoff + dream default to `claude-sonnet-4-6` (claude engine), fallback `gemini-3.1-flash-lite`; `claude-opus-4-8[1m]` available as a per-task override. Rationale: dream's safety is the gate, not the model tier; sonnet-4.6 is a strong faithful proposer at lower cost/latency than opus, which keeps the session-start hold short.
- **Config + secret split.** `.wrxn/memory.config.json` (seeded, operator-editable, preserved across update) holds per-task `{primary,fallback}` `{engine,model}`. `.env` (gitignored) holds `GEMINI_API_KEY`. **JSON, not YAML**, because kernel payload adapters are node-stdlib-only and node has no built-in YAML parser; JSON matches every other kernel config.
- **Recursion guard.** `WRXN_MEMORY_SYNTH` sentinel. The spawn hook no-ops (prints `{}`) when it sees the var set (it is running inside a synth-spawned `claude -p` session); the synth sets the var on every engine spawn. Prevents the SessionEnd→`claude -p`→SessionEnd fork-bomb.
- **Hold semantics.** A true hold (poll until the marker clears = synth done), bounded by a staleness/age safety-cap so a SIGKILLed synth can't hang start. The hold waits on the **handoff** marker only; dream continues in the background after the baton is written (dream pages are recalled independently; they need not exist at the start instant).
- **Dream-gate hardening (in `dream.cjs`).** `check`/`commit` gain an optional `--source <file>`: when present, each evidence quote must substring-match the normalized source, else reject `quote_not_in_source`. Absent `--source` preserves today's behavior (manual dream by the trusted main agent is unaffected). This is the single mechanical defense that makes a non-human proposer safe.
- **Auto-dream flow.** synth → proposals JSON → `dream.cjs check --source <blob>` → stage accepted → `commit` the accepted slugs (the commit re-gates). Auto-approval = the gate's accepted set; no human step. Honors the existing run cap (≤5), confidence floor (0.75), secret-scan, anti-superstition filters, dedup.
- **Removals.** Delete the `handoff` skill (`payload/.claude/skills/handoff/`); the synth becomes the sole baton writer (continuity doctrine preserved). Remove the `_slots/current-focus` slot and `dream.cjs`'s `set-focus` op + the dream-skill "Refreshing the focus slot" section.
- **Manual `dream` skill stays** for deliberate attended consolidation (no `--source`, trusted proposer). Auto-dream is an additional path through the same gate.
- **Migration** (new, sibling to migration 004's retire-session-capture): on `wrxn update`, remove the `handoff` skill files, wire the new SessionEnd hook into the install `settings.json`, seed `memory.config.json` if absent, remove `_slots/current-focus.md`. Idempotent; never throws on a clean install.
- **Trivial-session skip.** If the transcript blob is below a small threshold (empty/near-empty session), the synth writes nothing and clears markers — no model spend.
- **Release.** Ships as the next kernel minor (`feat`), version set at build time so the migration's version ≤ `package.json.version` (the no-inert-migration invariant).

## Testing Decisions

- **Good test = external behavior, not implementation.** Assert the verdict/written-output/marker-state given inputs; never reach into private helpers.
- **Primary new seam — the injectable engine invoker** (`memory-synth.cjs`). Mirrors the established `protect.cjs` fake-`gh`-invoker and `dream.cjs` injected-`io` patterns: the synth's pure orchestration (blob-build, engine resolve+fallback, handoff-then-dream sequencing, marker lifecycle, trivial-skip) is unit-tested with a **fake invoker** returning canned handoff text / dream-proposal JSON — **no real `claude -p`, no network, no spawn**. Prior art: `test/dream.test.cjs`, the protect fake-invoker tests.
- **Reused seam — the dream gate** (`dream.cjs`). Extend `test/dream.test.cjs`: quote present in `--source` → accepted; quote absent → `quote_not_in_source`; no `--source` → legacy pass (manual path unaffected); quote-verify composes with the existing confidence/secret/negative/dedup checks.
- **Reused seam — session-start hold.** Extend `test/session-start.test.cjs`: pending marker present → holds; cleared → proceeds and injects the baton; marker older than the safety-cap → proceeds anyway. Test the pure poll-decision function, not wall-clock sleeps.
- **Recursion guard.** A unit test: invoking the spawn hook with `WRXN_MEMORY_SYNTH=1` set produces `{}` and spawns nothing; unset → it marks pending and spawns.
- **Migration.** Mirror `test/retire-session-capture-migration.test.cjs`: call `up()` against a fixture install (asserts handoff skill removed, SessionEnd wired, config seeded, focus slot removed) AND e2e through `wrxn update`; idempotent; no-throw on a clean install.
- **Managed-integrity / wiring.** Extend `test/hooks-managed.test.cjs` / `test/settings-hook-paths.test.cjs` so the new managed files + settings wiring stay consistent.
- **No real LLM or network in the suite, ever** (same discipline as protect's tests never issuing real `gh`).

## Out of Scope

- The ai-memory MCP / daemon backend (store B) and the maximo bash scripts — the kernel writes to store A only.
- Promoting dream `_rules` pages into the SYNAPSE always-on set (still a separate deliberate act; the synth never edits `.synapse/`).
- `harvest`/`sync` changes (curation + drift remain manual skills).
- A mid-session "force handoff now" command (the auto path covers session end; can be a later add).
- Embeddings / semantic recall changes — recall remains the existing wiki query path.
- Rolling auto-memory out to non-install sibling repos (e.g. recon-wrxn).

## Further Notes

- **Cost/latency:** sonnet-4.6 per session-end is the default spend; the gemini fallback is the cheap last resort; the trivial-session skip avoids spend on empty sessions. The session-start hold is short because it waits only for the handoff (sonnet), not dream.
- **Continuity doctrine preserved:** exactly one baton writer (now the synth instead of the skill); no competing dated-page writer exists (retired in 004), so the historical clobber risk is structurally gone.
- **Safety rests on the gate, not the model:** the `--source` quote-verify is the load-bearing control that lets a non-human proposer write durable memory without poisoning recall; the model tier only affects proposal quality/yield.
- **Vertical slicing (for `to-issues`):** (1) dream-gate `--source` quote-verify; (2) the engine layer (injectable invoker + config/.env resolve, claude→gemini fallback) with a manual CLI entry; (3) auto-handoff end-to-end (spawn hook + synth-writes-baton + session-start hold + recursion guard); (4) auto-dream (synth → gate+source → commit); (5) `memory.config.json` seed + tiering wiring; (6) migration: remove handoff skill, drop `_slots`, wire SessionEnd. Each is independently buildable and walkable.
