# Code review — wrxn-kernel #39: consolidate `SECRET_PATTERNS` to one drift-pinned canonical set

- **Slice / issue:** #39 — consolidate the drifted `SECRET_PATTERNS` copies into one canonical, drift-pinned 14-shape set.
- **Branch / commit reviewed:** `fix/39-consolidate-secret-patterns` @ `e884704` (vs `main`).
- **Reviewer:** fresh-context reviewer executor. **Read-only — did not push, edit source/tests, or open a PR.**
- **Verdict: APPROVE-WITH-FINDINGS** — 0 blocking, 3 non-blocking (1 informational regression-edge + 2 observations).
- **Full suite:** `1182/1182` green. The 4 touched test files: `100/100` green.

---

## Coverage-regression conclusion: **NO real-world regression** (one malformed-input edge only)

Verified empirically by reconstructing each site's BEFORE and AFTER pattern arrays and asserting AFTER ⊇ BEFORE
over a token battery (script run against the real regexes, not the report's word).

| Site | BEFORE | AFTER | Net |
|---|---|---|---|
| `dream` / `sync` / `harvest` (detection `.test`) | stale 5 shapes | canonical 14 | **+9 shapes** (`github_pat`, `xox`, `sk-proj`, `AIza`, `sk_live/test`, JWT, Bearer, `KEY=val`, PEM full-block) + PEM header fallback; `gh`/`npm` `{36}`→`{20,}` (broader). **0 real regression.** |
| `memory-synth` (`REDACTIONS`, derived `g`) | rich 13 (with `\b`) | canonical 14 | **+1 shape** (PEM header fallback); `\b` dropped → strictly broader (assertion removal = superset). **0 regression.** |
| `sidecar` (`SECRET_PATTERNS` = CANON + EXTRA) | 10 shapes | 14 canon + 4 kept extras = 18 | **+5 vendor shapes**; all 4 prior extras (case-insensitive Bearer, password=, URI-creds, `eyJ` JWT) **kept** in `SIDECAR_EXTRA`. **0 real regression.** |

Spot-verified non-obvious cases: exact-36-char `gh`/`npm` tokens still match under `{20,}`; all 6 standard PEM
descriptors (`PRIVATE`/`RSA`/`EC`/`OPENSSH`/`ENCRYPTED`/`DSA`) still match; lowercase `password=hunter2` still
matches (the `/i` is preserved). The `\b` drop in memory-synth never drops a prior match (removing a zero-width
assertion only broadens, and the redacted span is unchanged) — fail-safe for a redactor.

---

## Findings

### F1 — [NON-BLOCKING · informational · LOW] Malformed double-space PEM header narrows at 4 sites
`dream.cjs:435`, `sync.cjs:278`, `harvest.cjs:667`, `sidecar.cjs:34`
The header fallback `/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/` does **not** match a header with **≥2 spaces**
between `BEGIN` and `PRIVATE` (e.g. `-----BEGIN␣␣PRIVATE KEY-----`), whereas the prior dream/sync/harvest form
`[A-Z ]*` and sidecar's prior form did. **Empirically confirmed** (BEFORE matches, AFTER misses).
Why this is non-blocking:
- Not a valid PEM format — real headers use single spaces; all 6 standard descriptors still match.
- This *converges* the 4 sites onto the exact header regex the issue's canonical list (#12) specifies and that the
  reference copy (`memory-synth`) already shipped pre-#39 — i.e. it is the intended canonical form, not an accident.
- The full-block shape still catches real multi-line keys; dream/sync/harvest are the lower-sensitivity
  audit/staged-jsonl sinks.
- It is on the record only because it technically contradicts AC1's absolute "no existing match weakens" for this
  one malformed input. Optional hardening (`(?:[A-Z ]+ )*`) is **not recommended** — it would re-pin all 5 and
  diverge from the issue's canonical text for zero real-world gain.

### F2 — [NON-BLOCKING · observation] "byte-identical" AND "broader extras" are both literally true (different arrays)
`sidecar.cjs:22` (`SECRET_PATTERNS_CANON`), `:40` (`SIDECAR_EXTRA`), `:49` (`SECRET_PATTERNS = [...CANON, ...EXTRA]`)
The drift-pin asserts **`SECRET_PATTERNS_CANON`** byte-identical across all 5 files. Sidecar's *effective* set is a
documented **superset** (`CANON + EXTRA`), not equal to canon. So the commit message's two claims refer to two
different arrays and do not conflict. Verified the guard pins the core (not the composed set) and that mutating a
`SIDECAR_EXTRA` shape leaves the pinned slice unchanged. Worth stating explicitly so a future reader doesn't misread.

### F3 — [NON-BLOCKING · observation · pre-existing, out of #39 scope] grep binary-detection on the adapters
The adapters carry valid multibyte UTF-8 in comments (`—`, `…`, `─`), pre-existing, which makes some tools treat
them as "binary" under the C locale (cosmetic; node/tests read them fine). Not introduced by #39; the canonical
block's `…` ellipses are intentionally byte-identical across copies (which is what the pin enforces). No action.

---

## Verified-good (the scrutiny checklist)

- **Pin has real teeth (the headline check).** `adapter-drift-guard.test.cjs:203-215` reads **5 separate files**
  and compares each to dream's `ref`. Proven read-only via in-memory mutation: a one-shape divergence in sync
  (`npm_…{20,}`→`{30,}`) makes `got !== ref` → `assert.equal` throws. It is **not** a value-vs-itself compare.
  `sliceArrayBody` extracts the bracket body (const NAME excluded), so sidecar's `SECRET_PATTERNS_CANON` is pinned
  against dream's `SECRET_PATTERNS` correctly; mutating a `SIDECAR_EXTRA` shape does **not** change the pinned slice
  (extras correctly excluded from the pin).
- **No new cross-layer import.** `sidecar.cjs` requires only `fs`+`path` (stdlib); builder chose *replicate* over
  importing `.wrxn/`. `emit-event.cjs` reuses `redactSecrets` from the same-layer `./sidecar.cjs` (pre-existing).
  The AC4 stdlib-only guard for `.wrxn/` adapters + recall stays green.
- **PEM ordering full-block → header.** Byte-identical pin + dedicated test (`:217-223`, `full < headerOnly`).
  Redaction applies in array order, so the full block (index 10) is consumed before the header (index 11) — no
  headerless-body leak. `dream.cjs:434-435`, mirrored at every site.
- **`/i` on the assignment shape preserved.** Canonical shape carries `/i`; the derive-`g` map keeps each shape's
  own flags and only adds `g` (`memory-synth.cjs:653`, `sidecar.cjs:66`) → `'ig'`. Lowercase `password=` matches.
- **Detection non-global / redaction derives `g`.** Detection (`secretScan` in dream/sync/harvest/sidecar) uses
  `.test()` over the no-`g` canonical base (stateless). Redaction maps to fresh `RegExp` objects with `g` added —
  base detection regexes untouched, no shared-`lastIndex` bug. Test `:225-240` asserts both derive sites + the
  sidecar composition.
- **harvest.cjs inclusion justified (not scope creep).** The pre-existing AC1 drift-guard binds
  `secretScan + SECRET_PATTERNS` byte-identical across harvest/sync/dream; consolidating sync/dream without harvest
  would break that test / re-introduce drift. Required scope, as the commit message explains.
- **Tests are genuine red→green, coverage not decreased.** New sync/sidecar tests assert shapes the stale 5-set
  never matched (`sk-proj`/`xoxb`/`AIza`/`sk_live`/`github_pat`/JWT — confirmed un-matched by the old set); the
  memory-synth test asserts a lone PEM header (no END) is now redacted (full-block-only previously missed it).
- **Manifest unaffected.** No new payload file (all 9 changed paths are `M`, builder replicated) → no manifest entry
  required (AC2/AC4).

## Summary
Faithful, well-engineered consolidation onto the issue's canonical 14-shape set. The drift-guard has real teeth and
correctly pins the shared core while permitting sidecar's documented superset. No real-world coverage regression;
the single narrowing is a malformed (non-PEM) double-space header that converges to the contract-specified form.
Full suite green. **APPROVE-WITH-FINDINGS** (0 blocking).
