# Code review — wrxn-kernel #63: redact the manual CLI synth blob before egress

- **Issue:** #63 — manual CLI synth path egresses the transcript blob un-redacted → redact before `synthesize` (parity with the automatic paths).
- **Branch:** `fix/63-manual-cli-redact-parity` · **commit:** `f465a4a` (off `main`)
- **Diff reviewed:** `git diff main...HEAD` — 2 files, `+52 / -1` (source `+1/-1`, tests `+51`).
- **Reviewer disposition:** fresh-eyes, read-only. Every claim verified against the real code + an empirical red→green proof (no source mutated).

## Verdict: APPROVE-WITH-FINDINGS

**Blocking: 0 · Non-blocking: 2 (1 cosmetic test-comment nit, 1 out-of-scope defense-in-depth note).**
Ship it. The fix is correct, minimal (one line), reuses the existing redactor, closes the parity hole exactly, and is genuinely test-proven.

---

## The change

`payload/.wrxn/memory-synth.cjs:972`, the manual `run()` (non-`fromSpawn` `--task <t> <file>`) path:

```diff
- const blob = readTranscriptBlob(file);
+ const blob = redactSecrets(readTranscriptBlob(file)); // scrub BEFORE the blob egresses … parity with runHandoff:729 / runDream:866 (#63).
```

Plus two tests in `test/memory-synth.test.cjs`.

## AC verification (all met)

| AC | Verdict | Evidence |
|----|---------|----------|
| **1** — manual path redacts before `synthesize`; byte-parity with `:729`/`:866`; no entry point egresses un-redacted | PASS | `:972` redacts before `synthesize` at `:975`. Identical function (`redactSecrets`) as `runHandoff:729` and `runDream:866`. Full egress surface is exactly 3 `synthesize`/`synthesizeDetailed` callsites — `:730` (safeBlob), `:869` (safeBlob), `:975` (now redacted). `assemblePrompt`/`buildClaudeSpec`/`buildGeminiSpec` are reachable ONLY via `runEngine ← synthesizeDetailed`, so those 3 are the complete surface. The `fromSpawn` route (`:953`/`:957`) reuses the **already-redacted** `safeBlob` `runHandoff` returns (`:751`) and `runDream` redacts it again (idempotent). No raw blob reaches any engine. |
| **2** — verified at the invoke boundary; secret → `[REDACTED]`, clean → unchanged → identical handoff | PASS | Proven empirically below. Secret transcript → `calls[0].input` carries `[REDACTED]`, not the raw token; clean transcript → blob byte-identical (redaction is a no-op on prose). |
| **3** — reuses `redactSecrets`/`REDACTIONS`, no new pattern; pure/fail-open/stdlib; coverage not decreased | PASS | No new regex — calls existing `redactSecrets` (652-656)/`REDACTIONS` (630-644); inherits #39's future consolidation automatically. `redactSecrets` is pure+total; `readTranscriptBlob` is total (`catch { return '' }`, `:241`) so the wrap adds **no throw surface** — fail-open preserved. Node stdlib only (no new `require`). Test count **33 → 35 (+2)**: coverage up. |
| **4** — tests (a) secret→`[REDACTED]`, (b) clean→byte-identical, (c) automatic-path tests green | PASS | (a) `test/memory-synth.test.cjs:381`, (b) `:411`, both present and sound. (c) `node --test test/memory-synth.test.cjs` → 35/35; full repo `npm test` → **1178/1178**, 0 fail. |

## Placement / no raw-blob stdout leak (explicit check)

The redaction sits before `synthesize` (`:975`) AND before every `out`/`err` write on the path. The only value printed is the **model output** (`printed = stripPreamble(text)`, `:982-983`) — never the raw blob. The `:964`/`:968`/`:977` error writes carry no blob. Confirmed: no raw-blob leak to stdout/stderr.

## Empirical red→green proof (no source mutated)

Ran the pre-fix module (`git show main:…memory-synth.cjs`) and the branch module side-by-side through the actual `run(['--task','handoff', tx, '--root', root], {invoke})` path with an injected `fakeInvoke` capturing `calls[0].input` (= `claude -p` stdin = `assemblePrompt(prompt, blob)`):

- **RED** — pre-fix `run()` egressed the RAW `ghp_…` token to `calls[0].input` (the secret genuinely reached the invoke boundary; nothing redacted).
- **GREEN** — branch `run()` egressed `[REDACTED]`, the raw token gone, ordinary prose (`"wiring the manual synth demo path"`) intact.
- **PARITY** — `manualBlob === redactSecrets(readTranscriptBlob(tx))`, and `redactSecrets(redactSecrets(x)) === redactSecrets(x)` (idempotent — so the `fromSpawn` double-redact is safe).

The planted secret is split (`'ghp' + '_0123…'`) so the test isolates the **egress-timing** fix, not a pattern gap. The primary engine (gemini, per #59 defaults) is skipped for want of a key in the fresh tmp root, so claude (the fallback) is the single recorded call and `calls[0].input` is the assembled prompt — the test correctly asserts on the egress payload, not merely on stdout.

## Findings

### NB-1 (non-blocking, cosmetic) — test comment misassigns the gemini engine role
`test/memory-synth.test.cjs:398` — `// what reaches \`claude -p\` (and would POST off-box to gemini on fallback)`. Under the #59 shipped defaults gemini is the **primary** and claude the **fallback**; claude is reached in this test only because the gemini primary is skipped (no key). The phrase "to gemini on fallback" inverts the roles. The substantive point — the same redacted blob protects both the claude stdin AND the gemini POST body — is correct, and every assertion is correct. Comment-only; no behavior impact.

### NB-2 (non-blocking, out of scope — NOT a vulnerability) — manual path prints model output without an output-side scrub
The manual `run()` path prints the model's output (`text`) to stdout without an output-side `redactSecrets`, unlike `runHandoff:735` which scrubs the durable baton body. This is **not a leak and correctly out of #63's scope**: (a) stdout is the operator's local terminal, not an off-box egress; (b) because the INPUT blob is now redacted, the model never sees the secret and so cannot echo it back — the printed output is transitively secret-free. Recorded only to show the output path was considered; no action for #63.

## Scope / boundaries

Touches only the manual path (`:972`) + its tests — the automatic paths (`:729`/`:866`) are untouched, as the issue requires. No managed-file or manifest change (payload `.cjs` edit; the seeded config/manifest are unaffected). Surgical: every changed line traces to the AC.

---
*Reviewer note: read-only review. I did NOT push, edit source/tests, or open a PR. This marker is the only file written.*
