# auto-memory-03 — auto-handoff: SessionEnd synth → baton → SessionStart hold

**Status:** ready-for-agent
**Type:** AFK
**Parent:** `acceptance/auto-memory/PRD.md`
**User stories:** 1, 2, 3, 4, 8, 16, 17, 18, 19, 20, 28

## What to build

The end-to-end automatic handoff. Ending a session writes the baton with no manual step; the next session resumes on it, even a back-to-back `/clear`.

- **SessionEnd spawn hook:** recursion-guarded (no-op when `WRXN_MEMORY_SYNTH` is set), stashes the SessionEnd payload, writes the pending markers under `.wrxn/continuity/`, spawns the synth detached, returns `{}` immediately.
- **Synth handoff path:** builds a bounded transcript blob from the payload's `transcript_path` (prompts + assistant text + thinking + tool_use + truncated tool_result), runs the engine (`handoff` task) with the faithful handoff prompt (TL;DR / goal / current state / decisions+why / files / next step / open / dead-ends), redacts secrets, writes the baton `.wrxn/continuity/latest.md` atomically, then clears the handoff marker to release session-start. Skips a trivial/empty transcript.
- **SessionStart hold:** before its existing baton read, poll the handoff marker until cleared (synth done) or a crash safety-cap elapses, then inject the baton as today.

## Acceptance criteria

- [ ] On SessionEnd, the baton is written automatically from the session transcript with no manual step (verified end-to-end with a fake invoker).
- [ ] The spawn hook returns `{}` immediately and runs the synth detached (never blocks session close).
- [ ] Recursion guard: with `WRXN_MEMORY_SYNTH=1` set, the spawn hook spawns nothing; unset → it spawns. Unit-tested.
- [ ] SessionStart holds until the handoff marker clears OR the safety-cap age elapses, then injects the baton; the poll decision is unit-tested without wall-clock sleeps.
- [ ] The synth is the SOLE baton writer (continuity doctrine) and clears its markers on every exit (success/fail), so start never hangs beyond the cap.
- [ ] A trivial/empty transcript → the synth writes nothing and clears markers (no model spend).
- [ ] Secrets are redacted from the handoff body.
- [ ] The new spawn hook is registered in the manifest and wired on `SessionEnd` in the payload `settings.json`; existing `session-start` tests stay green.

## Blocked by

- auto-memory-02 (the engine layer the synth calls).
