# Security Report — wrxn-kernel #63 (manual CLI synth path: redact before egress)

- **Slice:** `fix/63-manual-cli-redact-parity` @ `f465a4a` (off `main`)
- **Diff reviewed:** `git diff main...HEAD` — `payload/.wrxn/memory-synth.cjs` (1 source line), `test/memory-synth.test.cjs` (+51)
- **Scope:** close an un-redacted secret-egress hole on the manual CLI synth path (`run()`, `:972`)
- **Reviewer:** security executor (read-only; did NOT push, edit source, or open a PR)

## Verdict: **PASS**

The egress hole is closed. The raw transcript blob on the manual CLI path is now scrubbed by the
same `redactSecrets`/`REDACTIONS` the automatic paths trust, **before** the only sink that egresses it
(`synthesize` → `claude -p` stdin / off-box gemini POST). No new attack surface, fail-open preserved,
no blocking or non-blocking findings. Two informational notes recorded below (both pre-existing,
accepted design — not introduced or worsened by this slice).

- Findings: **0 Critical / 0 High / 0 Medium / 0 Low**
- Notes (informational, no action on this slice): 2

---

## The change

`payload/.wrxn/memory-synth.cjs:972`
```js
-  const blob = readTranscriptBlob(file);
+  const blob = redactSecrets(readTranscriptBlob(file)); // scrub BEFORE the blob egresses … parity with runHandoff:729 / runDream:866 (#63).
```
Pure function-composition: the existing pure `redactSecrets` (`:652`) wraps the existing
`readTranscriptBlob(file)` (`:237`). One line; no new imports, paths, exec, or network.

## Egress trace — is every path closed?

Entry point: `node .wrxn/memory-synth.cjs --task handoff <file>` → `run()` non-`fromSpawn` branch
(`:962-984`). The blob (now redacted at `:972`) flows to exactly **one** egress chain:

```
:975 synthesize({ blob }) → synthesizeDetailed → runEngine
      ├─ claude  → buildClaudeSpec → spec.input = assemblePrompt(prompt, blob)  (":260")
      │            → invoke → invokeClaude → spawnSync('claude',['-p',…],{input}) ── EGRESS (Anthropic, stdin)
      └─ gemini  → buildGeminiSpec → body.contents[0].parts[0].text = `TRANSCRIPT:\n${blob}` (":302")
                   → invoke → invokeGemini → https.request POST                    ── EGRESS (Google, off-box)
```
Both terminal sinks receive the **redacted** blob. There is no third blob sink on this path — verified:

- `out.write(printed)` (`:983`) writes the **model output** (`text`), not the blob, to **local stdout**.
  Since the *input* is now redacted, the model cannot echo a transcript secret; and stdout is the
  operator's own terminal (they already hold the raw transcript they pointed the CLI at). Not an off-box egress.
- `err.write(…)` (`:964`, `:968`, `:977`) emits **static strings** only — no blob, no derivative.
- The manual `run()` path performs **no** `appendSynthLog` / `writeBatonAtomic` / `writeTemp` / file write
  of the blob (those live only in `runHandoff`/`runDream`). Confirmed by reading `:962-984`.
- No un-redacted copy is retained: the raw return of `readTranscriptBlob(file)` is an ephemeral temporary,
  never bound to a variable, never logged/printed; every later use of `blob` (`:975`) is the redacted value.

**"No entry point egresses an un-redacted blob" — verified across the module.** The three (and only three)
blob-bearing egress call sites all redact first:
- `runHandoff` (`:729` → `:730 synthesizeDetailed`, automatic, `--from-spawn`) ✓
- `runDream` (`:866` → `:869 synthesize`, automatic, `--from-spawn`) ✓
- `run()` manual (`:972` → `:975 synthesize`) ✓ **(this fix)**

The `memory-synth-spawn.cjs` SessionEnd hook spawns the synth with `--from-spawn` (`:87`), routing to
`runHandoff`/`runDream` — never the manual branch. A repo-wide search found no external module that
constructs a `claude`/`gemini` spec or calls `synthesize` with a blob; all callers are inside `memory-synth.cjs`.

## Redaction completeness (in-scope parity, not a #39 audit)

The fix reuses the **identical** redactor the sibling automatic paths use: a single `redactSecrets` (`:652`)
over a single `REDACTIONS` set (`:630-644`) in `memory-synth.cjs`. It did **not** introduce a weaker or
second redactor. Byte-parity with `runHandoff:729` / `runDream:866` confirmed (same function, same patterns,
same `[REDACTED]` replacement). The other `SECRET_PATTERNS` sets in `sidecar.cjs` / `dream.cjs` / `sync.cjs`
are different modules and are the explicit subject of **#39** (cross-module consolidation, out of scope here);
they are not on this egress path. When #39 lands, this call site inherits the consolidated set automatically.

## Fail-open preserved

`redactSecrets` (`:652-656`) is pure + total: `String(text || '')` then a `.replace()` loop over compiled
global regexes — it cannot throw. `readTranscriptBlob` (`:237`) already catches read errors and returns `''`.
So the wrap adds no throw and degrades safely. Even in the impossible event of a throw at `:972`, control
aborts **before** the `:975` egress → the manual run fails **closed** (no leak), never open. No regression to
the graceful-degradation posture. Full `test/memory-synth.test.cjs` suite: **35/35 pass** (automatic-path
redaction tests + the two new #63 tests), verified locally.

## No new surface

Pure string work — a function wrap. No new file/path handling, no new spawn/exec, no new network, no new
import. The diff is one source line plus tests. Nothing expands the slice's I/O or trust boundary.

## Notes (informational — pre-existing accepted design, NOT findings against this slice)

1. **Residual risk — pattern-based redaction is best-effort (`REDACTIONS` `:630-644`).** A novel secret
   shape not matching any enumerated pattern (e.g. a bare high-entropy token outside `KEY=value` form, an
   unlisted vendor format) still egresses. This is the **existing design**, identical to the two automatic
   paths, and is the known limitation called out for #39 — **not a regression** introduced by this fix.
   Stated as the standing limitation, as required.

2. **Manual path does not redact the model OUTPUT before local stdout** (unlike `runHandoff:735`, which
   redacts output before the *durable* baton). Acceptable and not a finding: the input is now redacted so the
   model cannot echo a transcript secret into its output, and stdout is the operator's local terminal (not a
   persisted or off-box artifact). Noted for completeness only.

## Confirmation

- Is the egress hole closed? **Yes** — the manual CLI path now redacts the blob before the sole egress
  (`synthesize` → `claude -p` stdin / gemini POST), at parity with the automatic paths; no other sink leaks it.
- Pushed: **false** (security executor never pushes).
