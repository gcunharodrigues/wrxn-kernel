# Security review — auto-memory-01: dream gate `--source` quote-verification

- **Slice:** `auto-memory-01` — dream gate: `--source` quote verification
- **Repo / branch / commit:** `wrxn-kernel` · `auto-memory` · `624b2e0` (findings-fix on top of `3290e8e`)
- **Diff reviewed:** `git diff main..auto-memory` — `payload/.wrxn/dream.cjs` (+131/-22), `test/dream.test.cjs` (+207). Fix commit alone: `git show 624b2e0`.
- **Reviewer:** security executor · 2026-06-20 (RE-REVIEW after findings fix — supersedes the prior PASS-WITH-FINDINGS)
- **Suite at review:** `node --test` → **802/802 pass, 0 fail** (incl. the 5 new F1 + 1 F2 + 1 NB-3 tests)

## Verdict: PASS

The fix resolves **both** prior findings and introduces **no new surface**. F1 (MED) is closed by a
substantive-quote floor checked before source-presence; F2 (LOW) is closed by reading argv directly so a
value-less `--source` fails closed (exit 2). The change remains **strictly additive** and **fail-closed**:
nothing that previously rejected can now pass, every later gate still composes, and the adapter-drift
guards (`SECRET_PATTERNS` / `secretScan`, `NEGATIVE_FILTERS` / `negativeFilter` / `guardArgv`) are
byte-identical `main` vs `auto-memory`. Two residual items remain as forward-notes for slices 02/04 —
both fail-closed (safe direction) and out of slice-01's threat model; neither is an open finding.

---

## F1 — MEDIUM — RESOLVED

**Was:** the bare normalized-substring match was satisfiable by a trivially-present quote
(`evidence:[{quote:"the"}]`), so a fabricated body carrying any in-transcript word cleared quote-verify —
under-delivering the PRD's load-bearing "a hallucination can't poison recall" claim.

**Fix (`dream.cjs:262-287`, gate at `:316-319`):** a substantive-quote floor now runs as a global
precondition. `isSubstantiveQuote` (`:272-276`) operates on the **normalized** quote (lowercase +
whitespace-collapse + trim, `:262-264`) and requires `norm.length ≥ QUOTE_MIN_CHARS (12)` **AND**
`norm.split(' ').filter(Boolean).length ≥ QUOTE_MIN_TOKENS (3)`. `verifyQuotes` (`:282-287`) checks
substantiveness for **every** quote first (`quote_not_substantive`) **before** any source-presence match
(`quote_not_in_source`) — the ordering the spec requires, pinned by the precedence + NB-3 tests.

**Confirmed by live probe against the real CLI (`node dream.cjs check … --source`):**
- single common word `"the"` (deliberately PRESENT in the source) → `quote_not_substantive` — the exact
  exploit I filed is **closed**; a proposer can no longer pass with a single common word.
- long **single-token** `"authentication"` (14 chars, PRESENT) → `quote_not_substantive` — the token floor
  rejects it (length alone is not enough).
- **padding-bypass attempt** `"the the the the"` (15 chars / 4 tokens — clears the floor) → `quote_not_in_source`.
  This is the key result: padding a trivial quote to clear the char/token floor forces a string that must
  then appear **contiguously** in the source, and **the proposer does not control the source** (it is the
  trusted orchestrator's transcript blob). The two checks compose (substantive **AND** contiguous-in-source);
  you cannot satisfy both by padding. **The floor is not trivially bypassable.**
- terse legit multi-word `"use pino logs"` (13 chars / 3 tokens, present) → `ok:true` (suite-pinned) — a real
  short decision quote is **not** false-rejected.

**Residual (forward-note, NOT an open finding — inherent to substring verification, materially narrowed):**
A genuinely-present, ≥12-char/≥3-token *generic* contiguous phrase (e.g. `"i think that is"`) still passes
quote-verify while the body is fabricated — substring-presence proves the cited span is a **real** part of
the session, not that it **supports** the body's claim; no substring check can establish semantic grounding.
The fix eliminates the easy, non-adversarial failure mode (single words / two-word fragments / sub-12-char
triples) the original finding was about, and the residual is covered defense-in-depth by the negative
filters + secret-scan + `≤5`/run cap + (for the auto path) the stage→human-approve→commit loop in slices
02/04. The fix delivers the spec's stated acceptance bar. Separately, a real but very terse 3-word quote of
≤11 normalized chars (`"ship it now"`) is **false-rejected** `quote_not_substantive` — this is **fail-closed**
(a real memory is dropped, never a fabricated one admitted) and the proposer can re-cite a fuller span; a
recall-completeness cost, not a security weakness. Both are forward-notes for 02/04, not slice-01 blockers.

## F2 — LOW — RESOLVED

**Was:** a value-less trailing `--source` token (`dream check p.json --source`) collapsed to `undefined` via
`flag('source')` and fell through to the no-verify legacy path — a silent gate-off contradicting
`readSource`'s own never-silently-disable invariant.

**Fix (`dream.cjs:422-436`):** `readSource` now reads argv directly (`process.argv.indexOf('--source')`).
Only `i === -1` (flag **truly absent**) returns `null` → legacy. When the flag IS present, a value of
`undefined` (trailing) **or** `''` (empty) **or** one beginning with `--` (next flag) calls `fail(...)`,
and `fail` (`:93-96`) is `process.stderr.write` + `process.exit(2)` — a hard, fail-closed exit.

**Confirmed by live probe (all three forms → exit 2, stderr matches `/--source/`):**
- trailing value-less `… --source` → `exit=2`
- empty value `--source ""` → `exit=2`
- `--`-leading value `--source --root …` → `exit=2`

The `||` short-circuit checks `file === undefined` before `file.startsWith('--')`, so the trailing case never
throws a TypeError. A present `--source` can **no longer** silently disable quote-verify.

---

## No new surface introduced by the fix (verified, not assumed)

- **Data-flow of `source` is unchanged and sink-clean.** Traced every reference (grep over the whole file):
  `source` flows only `readSource → validateRun/runCheck/runCommit → validateProposal → verifyQuotes →
  normalizeForMatch → hay.includes(needle)` — a **boolean** only. The source *content* never reaches
  `execFileSync`, `wikiWritePage`/`wikiForceWritePage`/`wikiQuery` (their args are still
  `tier/slug/title/body/--root` from the proposal, `:542`/`:580`/`:367`/`:378`), `print`, or `appendFileSync`
  (`:440` logs the outcome object, not the source). No new injection, exfiltration, or write sink.
- **Drift-guards byte-identical** (`git show main:` vs `auto-memory:`, `diff` empty): `SECRET_PATTERNS`,
  `secretScan`, `NEGATIVE_FILTERS`, `negativeFilter`, `guardArgv`. The secret-scan posture is intact.
- **New helpers are total + crash-safe.** `normalizeForMatch` coerces `null/undefined` via
  `String(s == null ? '' : s)`; `isSubstantiveQuote` only ever sees a string (the `missing_evidence` gate at
  `:308-311` already rejects any non-string / blank quote before `verifyQuotes` runs); `verifyQuotes` is
  reached only when `source != null` and `p.evidence` is a guaranteed non-empty `{quote:string}[]`.
- **Precedence still composes, never bypasses.** Quote-verify sits AFTER routing + confidence floor +
  evidence-presence and BEFORE rationale/body/negative-filters/secret-scan/identity/dedup (`:296-302`); the
  NB-3 test pins confidence-before-quote-verify, and the compose tests prove a passing quote still faces every
  later gate. With `--source` absent the branch is skipped → byte-identical to the legacy manual-dream path.
- **`readSource`'s `file.startsWith('--')` guard** rejects a source path literally named like a flag — a
  fail-closed conservatism, not a reachable issue (transcript blobs are written to known names by the trusted
  orchestrator).

## INFO — `--source` path is unconstrained (carried from prior review, unchanged, not a slice-01 vuln)

`fs.readFileSync(file, 'utf8')` (`:432`) accepts any path. Not a traversal/exfiltration vuln here: the
`--source` path is chosen by the **trusted caller** (argv), not by the untrusted proposal JSON, and only a
per-quote boolean is derived — the content is never returned/written/logged. **Forward-note (02/04):** if the
auto-dream orchestrator ever derives the `--source` path from untrusted input, constrain it to the install
root.

---

## Conclusion
**PASS.** F1 (MEDIUM) and F2 (LOW) are both **resolved** and verified by live adversarial probe + a green
802/802 suite. The fix is strictly additive and fail-closed; the substantive floor is not bypassable by
padding (the source-presence check the proposer cannot control backstops it) and does not false-reject a
legitimate ≥12-char/≥3-token quote; a value-less `--source` now fails exit 2. No new injection, traversal,
secret-handling, or fail-open seam was introduced; all drift-guards are byte-identical. Two fail-closed
residuals (the inherent substring-verification gap + a terse ≤11-char false-reject) are forward-notes for
slices 02/04, not open findings. Ship-able.
