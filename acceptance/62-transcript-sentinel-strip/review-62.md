# Code review — #62 strip hook-injected framework context from the transcript blob

- **Slice**: wrxn-kernel #62 — `fix(continuity): strip hook-injected framework context from the transcript blob`
- **Branch / commit**: `fix/62-transcript-sentinel-strip` @ `6462b22`
- **Diff reviewed**: `git diff main...HEAD` — 3 files, +131 / -2 (`payload/.wrxn/memory-synth.cjs`, `test/memory-synth.test.cjs`, `test/memory-synth-handoff.test.cjs`)
- **Reviewer**: reviewer executor (fresh context)
- **Date**: 2026-06-24

## Verdict: APPROVE-WITH-FINDINGS

Blocking: **0**  ·  Non-blocking: **3**

The change delivers all four ACs. It is surgical, fail-open, sits on the single shared blob seam, and is
proven by real red→green tests; the full suite is green (1180/1180). The lone correctness caveat
(over-strip on literal in-prose sentinel mentions) is an inherent consequence of AC-1's own
"unclosed → drop to EOF" mandate, is bounded per-part, and never throws / corrupts / leaks — so it is a
known tradeoff, not a blocker.

## AC verification (every claim checked against the real code)

| AC | Verdict | Evidence (verified) |
|----|---------|---------------------|
| **1** strip all 5 sentinels, closed + unclosed, multi-line, truncation→EOF | PASS | `INJECTED_SENTINELS` (`memory-synth.cjs:196`) = all five. Closed: `<tag>[\s\S]*?</tag>` global+lazy (`:210`) — multi-line, multiple blocks. Unclosed: `<tag>[\s\S]*$` (`:211`) → strips to end-of-part. Order closed-then-unclosed is correct; robust across interleaved tag orderings (reasoned through orientation-first, rules-first, nested). Per-part scope never crosses role boundaries. |
| **2** orientation+work omits baton; orientation-only → `trivial` | PASS | Empirically: orientation-only part → all-empty parts → no chunk pushed (`:259-260`) → `blob.trim().length` 0 < `TRIVIAL_BLOB_MIN` 40 (`:588,:753`) → `reason='trivial'`, `wrote=false`, 0 model calls, no baton, marker cleared. Pinned by the new `runHandoff treats an orientation-only session … as trivial` test. |
| **3** heavy sessions unaffected; one shared blob builder (engine-agnostic); fail-open; node stdlib; caps preserved; coverage not decreased | PASS | Single seam: `buildTranscriptBlob` is the ONLY blob builder (grep), feeding handoff (`:752`), dream (in-memory reuse), and manual CLI (`:1001`); both `buildClaudeSpec`/`buildGeminiSpec` consume it via `assemblePrompt`. Fail-open: `try/catch` returns input unchanged (`:207-216`); builder already skips malformed lines. Caps `THINK_MAX`/`TOOL_USE_MAX`/`TOOL_RESULT_MAX` untouched — strip touches only string content + `type:'text'` parts, not thinking/tool_use/tool_result. Stdlib only (`RegExp`/`String`). Coverage: +5 tests, 1180/1180 green. |
| **4** tests a/b/c/d | PASS | (a) orientation-only→trivial (handoff test); (b) orientation+work→work survives, baton spans excluded; (c) unclosed/truncated→stripped, `assert.doesNotThrow`; (d) malformed JSONL still skipped + heavy session `chunks.length===3`. **Red→green proven**: ran the (b) inputs against `git show main:` (pre-change) module — `Shipped kernel 0.15.0`, `wrxn-orientation`, `Layer 2 build loop` all present → the new assertions WOULD fail on `main`. Not tautological. |

### redactSecrets interaction — clean
Strip runs at build time per-part (`:240,:245`); `redactSecrets` runs after, on the assembled blob, before
egress (`:758` handoff, `:895` dream). Composable, no double-issue, no gap: strip only removes text (never
adds), so it cannot create a secret-exposure window; a secret inside a stripped block is removed entirely.
The manual-CLI path (`:1004`) strips but does not redact — that is the pre-existing **O2**, explicitly
out-of-scope for this issue; no NEW gap introduced.

## Findings

### F1 — Over-strip false positive on literal in-prose sentinel mentions — NON-BLOCKING (low–medium)
`payload/.wrxn/memory-synth.cjs:210-211`. A text part that literally contains a sentinel tag (angle
brackets included) loses real content. Empirically verified against the built module:
- Unclosed mid-prose: `"Please fix the bug where the <synapse-rules> block is double-counted, then add a retry…"` → blob keeps only `"[user] Please fix the bug where the"` (everything after the tag dropped to end-of-part).
- Inline-code mention: ``"…it emits `<reference-candidate>` only once. Verified with a test…"`` → blob truncates at the backtick; the rest is lost.
- Closed mention: `"before <recall-surface> keep this </recall-surface> after"` → enclosed `keep this` dropped.

Severity rationale: bounded **per text part** — never crosses role boundaries (test (c) confirms prior-turn
work survives), never throws, never re-introduces the baton, never affects redaction. Worst case is a
slightly less complete handoff summary, which is strictly better than the baton-echo bug being fixed.
Probability is low in general but **elevated for this repo's own meta-sessions** (kernel work discusses
`<wrxn-orientation>`/`<synapse-rules>` by name — the #62 issue body itself is full of them). Crucially,
the unclosed→EOF behavior is **mandated by AC-1** ("a block that opens but never closes → drop to the next
role boundary / EOF"), so this is the specified behavior, not a defect → cannot be blocking.

Optional hardening (cheap, AC-1-compatible, not required for acceptance): anchor the **unclosed** strip to
part-start (`^\s*<tag>`). Every real injection is emitted part-leading (`session-start.cjs:389` makes the
orientation the whole additionalContext; the UserPromptSubmit hooks PREPEND their blocks), and a
truncated-tail orientation is also part-leading — so a part-start anchor still satisfies AC-1's truncation
case while eliminating the mid-prose false positive.

### F2 — Closed-block strip is global/anywhere-in-part by design — NON-BLOCKING (informational)
`memory-synth.cjs:210`. The closed regex removes a `<tag>…</tag>` pair anywhere in the part, so a closed
legitimate mention (F1 third bullet) loses its enclosed text even if F1's unclosed branch were anchored.
Same root cause and same acceptable-tradeoff disposition; noted separately so the optional hardening isn't
mistaken for a complete fix. All real injections are part-leading, so anchoring the closed branch too would
be safe if the false positive is ever observed in practice.

### F3 — Sentinels inside tool_result / thinking are not stripped — NON-BLOCKING (informational)
The strip covers string content + `type:'text'` parts only — exactly where the hooks inject. If a
`tool_result` echoed a transcript containing sentinels (e.g. `cat`-ing a `.jsonl`), those would not be
stripped; but tool_result is capped at 200 chars and is not an injection path, so this is not a defect.
Noted for completeness.

## Style / surgical-scope
Diff is +131/-2 across 3 files; no adjacent code touched. The new helper mirrors the existing
`redactSecrets` scrub discipline and the surrounding comment density — consistent with house style. No
managed-integrity concern (this IS the deliberate kernel change, landing through the PR + CI gate).

## Boundary statement
Read-only review. I did **not** push, did not edit source/tests, and opened no PR. This review marker is
my only write.
