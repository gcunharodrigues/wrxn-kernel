# Review — auto-memory-01: dream gate `--source` quote-verification

- **Slice:** auto-memory-01 — dream gate `--source` quote verification
- **Branch / commit:** `auto-memory` @ `3290e8e`
- **Diff reviewed:** `main..auto-memory` — `payload/.wrxn/dream.cjs` (+76/-11), `test/dream.test.cjs` (+128)
- **Reviewer:** reviewer executor (fresh-eyes)
- **Date:** 2026-06-20

## Verdict: APPROVE-WITH-FINDINGS

0 blocking, 3 non-blocking. The slice correctly and completely delivers all six acceptance
criteria. The load-bearing safety property (a hallucinated quote cannot reach recall) is
implemented at both the `check` and the `commit` write boundary, the legacy (no-`--source`) path is
provably byte-identical to today, and the precedence is accurately documented and matches the code.
Suite independently verified **795/795 green**. The non-blocking items are robustness/coverage
notes, not defects in the delivered contract.

## Acceptance-criteria verification (verified against source, not claims)

| AC | Verdict | Evidence |
|----|---------|----------|
| `check`/`commit` accept `--source`; omit ⇒ exact legacy behavior | PASS | `runCheck` reads `readSource()` and threads to `validateRun`/`validateProposal` (dream.cjs:412,416,418); `runCommit` likewise (dream.cjs:483,494). Omitting ⇒ `readSource()` returns `null` ⇒ `if (source != null && …)` (dream.cjs:286) short-circuits ⇒ no quote-verify. Test "no --source: the legacy path is unchanged" (dream.test.cjs:745) proves a quote in no transcript still passes. |
| With `--source`, every-quote-matches ⇒ accepted (subject to all existing checks) | PASS | `quotesInSource` uses `p.evidence.every(...)` (dream.cjs:257-260); gate then continues to all later checks. Test "every evidence quote substring-matches the source → accepted" (dream.test.cjs:739). |
| Any quote NOT present ⇒ `quote_not_in_source` | PASS | `.every` false ⇒ `!quotesInSource` true ⇒ reject (dream.cjs:286). Tests at dream.test.cjs:721 (check) and :728 (commit, security). |
| Normalized (whitespace-collapsed, case-insensitive); substantive text still required | PASS | `normalizeForMatch` = `.toLowerCase().replace(/\s+/g,' ').trim()` (dream.cjs:253-255). `\s+` covers spaces/tabs/newlines and collapses to a single space (word boundaries preserved, not removed). Test "whitespace-collapsed + case-insensitive (no false reject)" (dream.test.cjs:751) + "scattered words (not contiguous) is rejected" (dream.test.cjs:759). |
| Composes with existing gate; precedence deterministic + documented | PASS | Precedence comment (dream.cjs:268-273) matches code order exactly: routing(276-277) → confidence(278) → evidence(279-282) → quote-verify(286) → rationale(287) → body(288-289) → negative(290-292) → secret(293-294) → identity(297-299) → dedup(300-301). Compose tests: confidence floor (dream.test.cjs:767), negative filters (:773); precedence test quote-verify-before-negative-filter (:782). |
| Tests extend `test/dream.test.cjs`; no real LLM/network | PASS | 12 new tests, all CLI-driven via `execFileSync` asserting verdict/written-files; no network, no LLM, no reach into private helpers. Module export unchanged (`{ stampImportance }`) — new functions tested purely through external CLI behavior. |

## Focus-area findings (from the spawn brief)

- **`--source` rejects `quote_not_in_source` correctly** — yes (dream.cjs:286, `.every` semantics).
- **No-`--source` path byte-identical to legacy** — yes. The only inserted gate line is guarded by
  `source != null`; both `null` (check/commit) and `undefined` (stage never threads source) skip it.
  Existing 58 dream tests unchanged and green.
- **Normalization sound, not over-permissive** — yes. Whitespace collapses to a single space (does
  not delete boundaries: `"abcdef".includes("abc def")` is false); punctuation is deliberately NOT
  stripped (more conservative); case-folded. See non-blocking NB-2 on the inherent presence-only
  property of substring matching.
- **Quote-verify composes at the documented precedence** — yes; comment matches code line-for-line.
- **`commit` re-gates with the source (write-boundary safety)** — yes (dream.cjs:494). The security
  test seeds a hallucinated proposal directly into `staged.jsonl` and proves `commit --source`
  blocks it with `quote_not_in_source` and writes nothing to the recall surface
  (dream.test.cjs:728-737). This holds even if staging integrity is bypassed — the correct
  defense-in-depth.
- **Unreadable-source hard-fail correct** — yes. `readSource` catches the read error and `fail()`s
  (exit 2) rather than returning `null` (dream.cjs:389-393); a given-but-unreadable path can never
  silently disable the gate. Test at dream.test.cjs:811.
- **Tests are real behavioral tests, not implementation-coupled** — yes; all subprocess CLI
  invocations asserting verdict/files. Matches the PRD Testing Decisions discipline.
- **Regression to existing gate** — none. No external callers of `validateProposal`/`validateRun`
  exist outside `dream.cjs`/its test (grep-verified); signature gained an optional 3rd param;
  legacy ordering preserved.

## Findings

### Blocking
None.

### Non-blocking

- **NB-1 (robustness): `--source` with no following value silently falls to the legacy gate-off
  path.** `flag('source')` returns `process.argv[i+1]`, which is `undefined` when `--source` is the
  last token (dream.cjs:80-83); `readSource` then treats `undefined` as "flag absent" and returns
  `null` (dream.cjs:387-388) — i.e. quote-verify is disabled. This is in mild tension with the
  module's own stated principle ("a missing source must NEVER silently disable the gate",
  dream.cjs:383-384). It is **not exploitable in the delivered contract** — `--source <file>` with a
  real path verifies, and a path that resolves to another flag (e.g. `--source --root`) fails closed
  via the unreadable hard-fail. It only matters when a caller emits a bare trailing `--source`. The
  sole safety-critical consumer (the auto-dream synth) is a later slice that builds argv
  programmatically. Recommendation for the synth-integration slice (auto-memory-04): always pass a
  concrete path; optionally harden `readSource` to fail-closed when `--source` is present but its
  value is missing/another-flag. Out of scope to fix here; shared `flag()` behavior is consistent
  with the pre-existing `--root` parsing.

- **NB-2 (design property, within AC scope): substring quote-verify proves presence, not
  substantiveness.** `quotesInSource` (dream.cjs:257-260) accepts any normalized substring match, so
  a trivial/short quote (e.g. `"the"`) or a quote that is a substring of a larger word
  (`"cat"`⊂`"category"`) passes verification. The AC scopes the mechanism to "normalized substring",
  so this is **within the delivered contract**, and the body still faces the full gate (confidence
  floor, negative filters, secret-scan). The PRD's safety model is explicitly layered ("safety rests
  on the gate"), so a real-but-trivial quote on a hallucinated body is only partially mitigated by
  this layer by design. Noted for awareness; no change required for this slice.

- **NB-3 (test coverage nit): the confidence-before-quote-verify ordering is documented but not
  pinned by a dedicated test.** The compose-confidence test (dream.test.cjs:767) uses a *present*
  quote, so it does not distinguish "confidence checked before quote-verify" from "after". The
  quote-verify-before-negative-filter ordering *is* pinned (dream.test.cjs:782). A test with a
  low-confidence proposal whose quote is *absent*, expecting `confidence_below_threshold` (not
  `quote_not_in_source`), would lock the full documented precedence. The code order is correct and
  structurally guaranteed (early return); this is a completeness nit only.

## Suite verification

Independently ran `npm test` (`node --test --require ./test/setup.cjs`):

```
# tests 795
# pass 795
# fail 0
# skipped 0
```

The "795 green" claim is **confirmed**. `node --test test/dream.test.cjs` in isolation: 70/70 pass
(12 new `--source` tests, all green).

## Conclusion

APPROVE-WITH-FINDINGS. The slice is mergeable. All six ACs are delivered and behaviorally tested,
the write-boundary re-gate closes the hallucination path, the legacy path is byte-identical, and the
suite is fully green. The three non-blocking items are robustness/coverage notes that do not gate
integration; NB-1 is worth carrying into the auto-memory-04 (synth) slice so the auto path never
emits a value-less `--source`.
