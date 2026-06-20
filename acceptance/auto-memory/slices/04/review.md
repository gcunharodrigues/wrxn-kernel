# Review — auto-memory-04 (auto-dream: synth → gated + quote-verified → auto-commit)

**Reviewer:** fresh-eyes code review (reviewer executor)
**Commit under review:** `cd3560c` (sole slice-04 commit on `auto-memory`, atop slice-03 `ef0d354`)
**Issue:** `acceptance/auto-memory/issues/04-auto-dream.md` (7 ACs)
**PRD:** `acceptance/auto-memory/PRD.md`
**Suite:** `node --test` → **864/864 pass, 0 fail** (builder claimed 848→864, +16 — confirmed)

## Verdict: APPROVE-WITH-FINDINGS

**0 blocking findings.** The slice delivers all 7 ACs. The flagged high-risk item — two changed
slice-03 assertions — is faithful supersession, not regression-masking. The load-bearing safety
property (a non-human proposer cannot poison recall) is honored end-to-end through the unchanged
`dream.cjs` gate, driven by reference with `--source` at both `check` and the `commit` write boundary.
All findings below are non-blocking (gitignore hygiene + doc nits).

---

## Slice-03 supersession judgment (the flagged high-risk item): FAITHFUL — not a weakening

Two pre-existing slice-03 assertions were CHANGED (not deleted). Both verified against the code:

1. **`test/memory-synth-handoff.test.cjs:163`** — `assert.equal(calls.length, 1, 'the engine ran once
   for the handoff')` → `assert.ok(calls.length >= 1, ...)` + a NEW `calls[0].input includes 'HANDOFF'`.
   - **Correct & necessary.** Slice-04 wires `runDream` AFTER `runHandoff` in the `--from-spawn` route
     (`memory-synth.cjs:701-706`), so the route now makes a SECOND engine call (dream). The old
     `== 1` would now genuinely fail. The fake's non-JSON text makes dream `parseProposals` → `[]`
     → abstain (writes nothing), so the *handoff* contract this test guards is untouched. The added
     `calls[0]` assertion TIGHTENS the guarantee (handoff still runs first). Not a loosening that
     hides a defect.

2. **`test/memory-synth.test.cjs:248-251`** — the `--task dream` probe (was asserted to exit 2,
   `unsupported task "dream"`) was re-pointed to `--task harvest`.
   - **Correct & necessary.** `dream` is now a wired task: `PROMPTS = { handoff, dream }`
     (`memory-synth.cjs` `DREAM_PROMPT` + the `PROMPTS` line). So `run(['--task','dream', file])` no
     longer hits the unsupported-task branch (`run()` line 710-714) — it would synthesize+print the
     manual demo. The old assertion was made stale by the build, exactly as claimed. The
     unsupported-task GUARD itself is still exercised via a genuinely-unknown task (`harvest`), so
     coverage of that branch is preserved, not dropped.

**`runHandoff` is purely additive (verified line-by-line vs `ef0d354`):** the `try/catch/finally`
body is byte-identical except `safeBlob` is hoisted from a `const` inside the `else` to a function-
scope `let` so it can be returned; redaction happens at the same point with the same value. The
marker lifecycle (`finally` clears `.pending-handoff` then `.pending`, always), the atomic baton
write, and the `wrote`/`reason` semantics are unchanged. The return gains ONLY a `blob` field
(`{ wrote, blob, reason? }`) — none removed. The dedicated regression test
(`memory-synth-dream.test.cjs:300`) pins this. All other slice-03 tests pass unchanged (full suite
864 green).

---

## Acceptance-criteria verification (7/7 met)

- **AC1 — proposals committed only if they pass `check --source`, e2e fake invoker.** MET.
  `runDream` (`memory-synth.cjs:610`) → `synthesize` → `parseProposals` → `check --source` →
  `stage` → `commit --source`. The `--from-spawn` e2e test (`...dream.test.cjs:248`) drives the real
  `run()` core with a task-routed fake invoker and asserts the accepted page reaches the wiki.
- **AC2 — fabricated quote rejected (`quote_not_in_source`), never written.** MET. Test
  `...dream.test.cjs:138`. Enforced by `dream.cjs verifyQuotes` (line 282) at `check` AND re-verified
  at `commit` (`dream.cjs:536`, `source` threaded). `runDream` passes the SAFE blob as `--source`.
- **AC3 — gate honored end-to-end (floor 0.75, secret-scan, anti-superstition, dedup, ≤5).** MET.
  Tests for floor (`:158`), secret-scan (`:181`), dedup-skip (`:315`), ≤5 cap (`:331`). The gate in
  `dream.cjs` (`validateProposal`/`validateRun`) is UNCHANGED and driven by reference — no
  re-implementation in the synth.
- **AC4 — additive (dedup-skip); no human approval step.** MET. `commit` writes via
  `wikiWritePage` (additive; existing page → skipped). The dedup test (`:315`) proves a curated page
  is NOT clobbered. Auto-approval = the `check` accepted set (`approvedFile` from `accepted.map(p =>
  p.slug)`); no operator confirmation anywhere.
- **AC5 — dream runs after the baton; does NOT extend the SessionStart hold.** MET — and
  **structurally airtight**, not merely test-passing. `run()` `--from-spawn` awaits `runHandoff`
  (whose `finally` clears `.pending-handoff`) BEFORE invoking `runDream`. The SessionStart hold reads
  ONLY `.pending-handoff` (`payload/.claude/hooks/session-start.cjs:71`, `HANDOFF_MARKER_REL`), so
  once cleared the hold proceeds regardless of dream work. The ordering test
  (`...dream.test.cjs:277`) asserts the marker is already gone at the dream engine-call boundary.
- **AC6 — manual `dream` skill path (no `--source`) unchanged.** MET. `git show cd3560c --name-only`
  shows the commit touches ONLY `memory-synth.cjs` + 3 test files. `payload/.wrxn/dream.cjs` and
  `payload/.claude/skills/dream/` are NOT in the diff → the null-`source` legacy path is byte-
  identical (`validateProposal` skips quote-verify when `source == null`, `dream.cjs:316`).
- **AC7 — unit tests (fake invoker): accepted written; fabricated dropped; gate-reject dropped;
  abstain → nothing.** MET. All four present (`...dream.test.cjs:119`, `:138`, `:158`/`:181`,
  `:199`/`:211`), plus parseProposals, ≤5, dedup, e2e, AC5-ordering, and a slice-03 regression — 16
  tests as claimed.

---

## Cross-cutting safety checks (scrutiny points)

- **Gate not bypassed (AC1/AC3).** The auto-approval set is built from `check`'s `accepted`
  (`memory-synth.cjs:629`), and `commit` re-gates each slug WITH `--source` at the write boundary
  (`dream.cjs:536`). A proposal `check` rejected is never in `approvedFile`; a force-approved-but-
  failing slug is dropped by the commit re-gate. No path writes a page the gate did not accept.
- **`stage`'s source-less re-gate is NOT a hole.** `runStage` re-runs `validateRun` without `--source`
  (`dream.cjs:469`), but it only ever stages a SUPERSET of what `check --source` accepted, and the
  final WRITE boundary (`commit --source`) re-applies the quote-verify. So nothing the source-gate
  rejected can reach the wiki. Confirmed by the fabricated-quote test passing through the full
  check→stage→commit chain.
- **Stale `staged.jsonl` cannot leak.** `commit` reads all staged slugs but writes only the approved
  list (this run's `check` accepted set), each re-gated. A leftover manual-stage entry is never auto-
  committed unless this run also accepted that exact slug.
- **Secret never re-egresses through dream.** `runDream` redacts the blob (`redactSecrets`) before it
  reaches `synthesize` AND writes the SAME `safeBlob` to the `--source` temp file
  (`memory-synth.cjs:616` + the `sourceFile` write). The gate's secret-scan over authored text is a
  second backstop (AC3 secret test).
- **Temp-file handling.** `writeTemp` names files `.dream.<tag>.<pid>.<ts>.tmp` under
  `.wrxn/continuity/`; the per-call `tag` (src/batch/stage/approved) prevents intra-run name
  collision even within one millisecond. `finally { for (p of temps) rmQuiet(p) }` runs on EVERY
  exit (success, abstain, CLI-null, throw); `rmQuiet` never throws. `.tmp` (not `.md`) keeps recon's
  prose ingestion from recalling them. No leak on the happy or error path. `runDream` never throws
  out of the detached synth (`catch` → `{ written: [], reason }`).

---

## Findings

### F1 (non-blocking) — `.wrxn/continuity/` runtime temp files are not gitignored in installs

`runDream` writes `.dream.*.tmp` files under `.wrxn/continuity/` and cleans them in `finally`. On a
SIGKILL between `writeTemp` and the `finally`, a stale `.dream.*.tmp` would remain UNTRACKED in the
operator's repo. `lib/install.cjs:85-91` gitignores `.recon-wrxn/`, `.wrxn/reinforce.json`, and
`.env` — but nothing under `.wrxn/continuity/`.

- **Pre-existing, inherited — not introduced by this slice.** Slice-03 already drops un-gitignored
  runtime artifacts in the same dir (`.pending`, `.pending-handoff`, the `.latest.md.*.tmp` baton
  temp). Slice-04 adds one more class of the same kind. Per "review what changed, don't expand
  scope," this is flagged as non-blocking and out of slice-04's strict remit.
- **Suggested fix (a later hygiene slice, or fold into the migration slice 06):** add
  `ensureGitignoreLine(target, '.wrxn/continuity/.pending*')` and `'.wrxn/continuity/.dream.*.tmp'`
  (or ignore the runtime dir contents wholesale while keeping `latest.md` tracked) in
  `lib/install.cjs` next to the existing three lines, and a matching line in migration 004/006 so
  existing installs gain it on `wrxn update`.

### F2 (non-blocking, doc nit) — `memory-synth.cjs:50-51` header comment is now stale

The file-top comment still reads "The dream task/prompt + gate wiring land in slice 04; PROMPTS gains
`dream` then." That has now happened. Minor doc drift; update the past-tense or drop the line on the
next touch. No behavioral impact.

### F3 (non-blocking, observation) — auto-dream accepted proposals accumulate in the shared `staged.jsonl`

`runDream`'s `stage` step appends to the same `.wrxn/dream/staged.jsonl` the manual `dream` skill
uses. This is the intended append-only audit trail (non-`.md`, so recon does not recall it), shared
by both paths — not a defect. Noted only so a future "audit-trail growth" question has a written
answer; no action needed for this slice.

---

## Conclusion

Slice-04 is correct, faithful, and well-tested. The high-risk cross-slice test changes are genuine
supersession driven by the new behavior, with the superseded guarantees re-covered (handoff-first
ordering; the unsupported-task branch). The load-bearing control — `--source` quote-verify at both
`check` and the `commit` write boundary, over a redacted blob — is honored end-to-end through an
UNCHANGED gate. No blocking issues; the three findings are gitignore hygiene + doc nits, none in
slice-04's strict remit. **APPROVE-WITH-FINDINGS.**
