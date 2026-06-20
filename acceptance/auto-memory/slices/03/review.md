# Review — auto-memory-03 (auto-handoff: SessionEnd synth → baton → SessionStart hold)

**Reviewer:** fresh-eyes code review (reviewer executor)
**Commit under review:** `cd3cdda` (sole slice-03 commit on `auto-memory`)
**Issue:** `acceptance/auto-memory/issues/03-auto-handoff-end-to-end.md` (8 ACs)
**PRD:** `acceptance/auto-memory/PRD.md`
**Suite:** `npm test` → **845/845 pass, 0 fail** (builder claimed 820→845, +25 — confirmed)

## Verdict: APPROVE-WITH-FINDINGS

No blocking findings. The slice delivers all 8 ACs; the high-risk cross-slice test narrowing is a
faithful, invariant-preserving change — not a regression mask. Findings below are all non-blocking.

---

## Cross-slice narrowing judgment (the flagged high-risk item): FAITHFUL — not a weakening

Two pre-existing assertions were narrowed from *"SessionEnd never exists again"* to *"the retired
`session-end.cjs` writer is unwired"*:
- `test/harvest-retirement.test.cjs:65` (payload-shape) — was `!('SessionEnd' in settings().hooks)`.
- `test/retire-session-capture-migration.test.cjs:213` (e2e `wrxn update`) — was `!('SessionEnd' in cfg.hooks)`.

Verified against all sources — the narrowing is correct and necessary:

1. **Migration 004's retirement logic is byte-for-byte untouched.** `git show cd3cdda` shows ZERO diff
   to `migrations/004-retire-session-capture.cjs`. `unwireHook(cfg, basename)` (004 line 36) strips a
   hook iff `command.includes(basename)`, with `basename ∈ {session-end.cjs, session-history.cjs}`.
   `'memory-synth-spawn.cjs'` does **not** contain the substring `'session-end.cjs'` → the new synth
   hook survives 004 correctly. The builder's claim holds.
2. **The old assertions would now genuinely fail (a real, intended change, not a flaky one).** On
   `update`, `settings.json` is a **managed** file (not `MCP_PATH`), so `lib/update.cjs:64` `lay()`
   overwrites the install settings with the new payload — which now wires SessionEnd→synth — and 004
   runs *after* (update.cjs:86). 004 cannot strip the synth, so post-update `SessionEnd ∈ cfg.hooks` is
   `true`. The narrowed assertion ("`session-end.cjs` is not among the SessionEnd commands") is the
   *true* invariant 004 guarantees. This is an invariant-preserving narrowing, not a masking weakening.
3. **The strict assertion is retained where it is still correct.** The migration *isolation* case
   `retire-session-capture-migration.test.cjs:130` still asserts `!('SessionEnd' in cfg.hooks)` — valid
   there because `staleInstall` wires SessionEnd **only** to `session-end.cjs`, which 004 strips,
   emptying the group → event deleted. So the strict "004 strips the old writer + drops the empty
   event" contract is still fully proven; only the two contexts where `update` *also lays the new
   payload* were narrowed.
4. **All six 004 isolation cases pass** (a, a2, b idempotent, c clean-noop, d bare-noop, e
   corrupt-untouched) plus the e2e — confirmed in the green 845-suite run.

Conclusion: the narrowing protects the real contract (the retired episodic writer is gone) while
letting this slice legitimately re-occupy the (previously unwired) SessionEnd event. Not blocking.

---

## AC verification (all 8 satisfied)

| AC | Evidence |
|----|----------|
| 1 — baton auto-written from transcript (fake invoker) | `memory-synth-handoff.test.cjs:68` writes + asserts blob + handoff prompt reached the engine |
| 2 — returns `{}` immediately, runs detached | `memory-synth-spawn.test.cjs:65` asserts `{}` + `detached:true` + `stdio:'ignore'` + `unref()`×1 |
| 3 — recursion guard both arms, unit-tested | `memory-synth-spawn.test.cjs:86` (set→0 spawns, no markers) + `:65` (unset→spawns) |
| 4 — SessionStart holds until clear OR cap; no wall sleep | `session-start-hold.test.cjs:36-112` — pure `holdDecision` + injected-clock `holdForHandoff` loop |
| 5 — sole writer + clears markers on every exit | handoff tests `:85` (success), `:98` (null synth), `:116`/`:166` (trivial), `:219` (atomic, no temp leak) |
| 6 — trivial/empty → no write, no model spend | `:116` `calls.length===0` + `reason:'trivial'`; `:132`/`:166` no-transcript path. Call-count guard is load-bearing |
| 7 — secrets redacted from handoff body | `:183` (shapes) + `:202` (redacted before baton write) |
| 8 — manifest registered + SessionEnd wired + session-start green | `memory-synth-wiring.test.cjs` (manifest managed/project, SessionEnd→synth, SessionStart untouched, fresh-install e2e) + 845 green |

### Targeted scrutiny (all PASS)
- **Recursion guard** (`memory-synth-spawn.cjs:49,64`): no-op when `WRXN_MEMORY_SYNTH` set; spawn sets it on the child env. Correct.
- **Non-blocking spawn** (`memory-synth-spawn.cjs:61-66`): `detached:true`, `stdio:'ignore'`, `unref()`, returns `{}`. Correct.
- **Atomic baton** (`memory-synth.cjs:446-452`): temp `.latest.md.<pid>.<ts>.tmp` + `renameSync`. Unique per call. No half-written read possible. Correct.
- **Markers cleared on EVERY path** (`memory-synth.cjs:484-488` `finally`): handoff marker first (releases start), then `.pending`; runs on success/null/trivial/throw. Four tests cover all branches.
- **Hold is pure / injected-clock** (`session-start.cjs:92,114`): `holdDecision` pure; loop takes `now`/`sleep`. Production injects `sleepMs` = `Atomics.wait` (verified blocking, not a busy-spin, on Node 22). Existing session-start tests stay green.
- **Trivial → zero model calls**: blob `[user] hi` = 9 chars < `TRIVIAL_BLOB_MIN`(40) → skip before any invoke; asserted by `calls.length===0`.
- **Manifest + settings consistent**: `manifest.json:76` registers the hook (managed/project); `settings.json` wires SessionEnd to `$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs` (house style). Verified.

---

## Findings (all NON-BLOCKING)

### F1 — Redaction over-scrubs ordinary prose containing `key`/`secret`/`token = …` (non-blocking)
`payload/.wrxn/memory-synth.cjs:409`
`/\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+/gi`
Probed: `"the primary key = the user id field"` → `"the primary [REDACTED] user id field"` — it eats the
token after a benign `key =`/`secret:` in prose. This is **safe** (errs toward scrubbing, never leaks)
but degrades handoff fidelity, which the PRD names as the headline value (story 8). Conservative-by-
design is acceptable for a security control; flag for tuning.
*Fix (optional):* tighten the assignment arm to credential-shaped values only (e.g. require the RHS to
look like a token: `[A-Za-z0-9_\-+/=]{12,}` with no spaces) instead of `\S+`, so ordinary sentences
survive while real `KEY=<token>` assignments are still caught.

### F2 — Two declared baton writers coexist until slice 06; stale "single writer" docs (non-blocking, scope-correct)
`payload/.claude/skills/handoff/SKILL.md:10,14` still call the manual handoff skill "the SINGLE/SOLE
writer of `.wrxn/continuity/latest.md`", and `payload/.wrxn/dream.cjs:34,561` still say
"single-writer = the handoff skill" — but `memory-synth.cjs` now also writes the baton.
This is **scope-correct for slice 03**: the PRD assigns handoff-skill removal + doc reconciliation to
**slice 06** (PRD §Implementation "(6) migration: remove handoff skill…", and §Vertical slicing).
Removing it here would be scope creep. No runtime clobber risk: the skill is `disable-model-invocation`
(fires only on explicit `/handoff`), the synth fires on SessionEnd — different triggers, both whole-file
last-write-wins. `session-start.cjs:60` was correctly updated this slice to name the synth as writer.
*Action:* ensure slice 06 deletes the handoff skill and fixes the two `dream.cjs` comment lines so the
continuity doctrine reads true. Tracked, not fixed here.

### F3 — Transient continuity markers are not gitignored in installs (non-blocking, pre-existing pattern)
`payload/.wrxn/memory-synth.cjs:388-389,449` create `.pending`, `.pending-handoff`, and
`.latest.md.<pid>.<ts>.tmp` under `.wrxn/continuity/`, which ships with only a `.gitkeep` and no
payload `.gitignore`. These are per-session scratch, cleared on synth exit, so accidental-commit risk is
low and short-lived; and the baton `latest.md` itself already lived there pre-slice (this is the install's
ignore concern, not this slice's). Informational only.
*Fix (optional, or defer to install/ignore policy):* have `wrxn init`/the install `.gitignore` cover
`.wrxn/continuity/.pending*` and `.wrxn/continuity/*.tmp`.

### F4 — Degraded `sleepMs` could busy-spin to the cap on an exotic runtime (non-blocking, defensive only)
`payload/.claude/hooks/session-start.cjs:77-83,118-127`: if `SharedArrayBuffer`/`Atomics.wait` is
unavailable, `sleepMs()` no-ops and — with a real `sleep` injected — the hold loop would spin on
`existsSync` until the wall-cap (≤60s) if the synth crashed with the marker still up. Verified
`Atomics.wait` IS available and blocks correctly on the target Node 22, so this never triggers in a
standard runtime; the wall-cap bounds it even if it did. Defensive note, not a real-world hang.

---

## Constraints honored
- No `git push` (reviewer never pushes).
- Sole write = this review marker. No source/test/config touched.
- Stayed inside slice 03; handoff-skill removal correctly left to slice 06.
