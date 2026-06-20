# Review — auto-memory-02: synth engine layer (injectable invoker + config + CLI)

- **Slice:** auto-memory-02 — synth engine layer: injectable invoker + config/.env resolve, claude→gemini fallback, manual CLI
- **Branch / commit:** `auto-memory` @ `f20e19d` (on top of slice-01 `624b2e0`)
- **Diff reviewed:** `624b2e0..f20e19d` — `manifest.json` (+10), `payload/.wrxn/memory-synth.cjs` (+462, new), `payload/.wrxn/memory.config.json` (+12, new), `test/memory-synth.test.cjs` (+274, new)
- **Reviewer:** reviewer executor (fresh-eyes)
- **Date:** 2026-06-20

## Verdict: APPROVE-WITH-FINDINGS

0 blocking, 2 non-blocking + 1 carry-forward. The slice delivers all seven acceptance criteria.
The one seam (the injectable engine invoker) is correct: production defaults to the real
`defaultInvoke`, every LLM/network/spawn call sits behind it, and the suite injects a fake — it
**never** issues a real `claude -p`, network, or spawn (the only `defaultInvoke` token in the test
is a comment). The resolver tries primary then fallback and degrades to `null` (never throws) on
missing-key / missing-CLI / invoker-throw. The `claude` and `gemini` specs are faithful to the PRD
and to the proven `aimem-handoff-synth.sh` reference. Manifest registration is doubly-validated
(slice test + the `install.test.cjs` payload↔manifest invariants). Suite independently verified
**818/818 green**; `test/memory-synth.test.cjs` in isolation **16/16**.

## Acceptance-criteria verification (verified against source, not claims)

| AC | Verdict | Evidence |
|----|---------|----------|
| `memory.config.json` seeded: per-task (`handoff`,`dream`) `{primary,fallback}` of `{engine,model}`; defaults claude/`claude-sonnet-4-6` + gemini/`gemini-3.1-flash-lite`; seeded class; in manifest | PASS | Payload config carries both tasks with the exact default tiering (memory.config.json:1-12). Manifest entry `.wrxn/memory.config.json` `class:seeded` `profile:project` (manifest.json:14-18 of diff). Tests: "the seeded payload memory.config.json parses to the default tiering" (memory-synth.test.cjs:763) + "the manifest registers … memory.config.json (seeded …)" (:774). Doubly-pinned by `install.test.cjs:26,:35`. |
| Resolver tries `primary` then `fallback`; both fail → `null`; pure, fake-invoker tested | PASS | `synthesize` loops `[primary, fallback]`, first non-empty wins, else `null` (memory-synth.cjs:395-402). Tests: fallback-in-order (:658), short-circuit-on-primary (:665), both-fail→null (:674,:684). |
| `claude` engine → `claude -p --model <id>`, prompt on stdin, `WRXN_MEMORY_SYNTH=1` in env, bounded timeout, CLI auth (no key) | PASS | `buildClaudeSpec` → `cmd:'claude'`, `args:['-p','--model',model]`, `input=assemblePrompt`, `env:{WRXN_MEMORY_SYNTH:'1'}`, `timeoutMs:120000`, no key (memory-synth.cjs:255-264). Test asserts args, stdin, sentinel, bounded timeout, **and absence of any key** (:608-618). |
| `gemini` engine → POST `…:generateContent` with `x-goog-api-key` from `.env`; missing key fails engine (→ fallback/null), never throws | PASS | `buildGeminiSpec` → generateContent URL + `x-goog-api-key` header (memory-synth.cjs:271-284); `runEngine` returns `null` for gemini when `!apiKey` **without invoking** (:377). Tests: request-shape (:624), keyless-gemini-never-invoked (:674). |
| All LLM/network/spawn behind the injectable invoker; suite never makes a real call | PASS | `spawnSync`/`https.request` exist only inside `invokeClaude`/`invokeGemini`/`defaultInvoke` (memory-synth.cjs:310-358); `synthesize`/`run` default to `defaultInvoke` but every test injects `fakeInvoke`/`noCall`. Grep: zero real-invoker calls in the test (only a comment at :6); all 4 `synthesize` + 4 `run` calls pass `invoke`. |
| Manual CLI: transcript file + task → prints synthesized text (demoable, no hooks) | PASS | `run()` + `require.main` guard (memory-synth.cjs:441-472). Test "run() prints the synthesized handoff …" asserts exit 0, stdout carries the text, and the engine was fed prompt+blob (:714). |
| Tests cover primary→fallback, claude args, gemini shape, missing-key/missing-CLI degradation — all with the fake | PASS | Tests at :658/:665 (selection), :608 (claude args), :624 (gemini shape), :674 (missing key + CLI down → null), :684 (invoker throws → null). |

## Focus-area findings (from the spawn brief)

- **Injectable-invoker seam correct** — yes. `defaultInvoke` is the default for both `synthesize`
  (memory-synth.cjs:395) and `run` (:441); `require.main` wires the real one (:466). It is the sole
  call site of `spawnSync`/`https`. The suite injects a fake everywhere → no real call (verified by
  grep; the lone `defaultInvoke` token in the test is the prior-art comment at :6).
- **Resolver never throws on missing-key / missing-CLI / engine error** — yes. Missing gemini key →
  `runEngine` returns null without invoking (:377); missing CLI → real `invokeClaude` maps ENOENT
  (`error && status==null`) to `{ok:false}` (:318) → null → fallback; invoker throw → `runEngine`
  try/catch → null (:385). `synthesize` has no throw path; `buildGeminiSpec`'s `JSON.stringify` runs
  inside the try. Both-fail → null (:401).
- **`claude` / `gemini` specs correct** — yes. claude: model, stdin, sentinel env, bounded timeout,
  no key (:255). gemini: `…/v1beta/models/<model>:generateContent`, `x-goog-api-key`,
  `system_instruction`=prompt, user content=`TRANSCRIPT:\n<blob>`, temp 0.2, bounded timeout (:271)
  — faithful to the reference call.
- **Config / `.env` parsing sound, no unsafe eval** — yes. `loadConfig` merges parsed over
  `DEFAULTS`, catch→defaults (:111-129); `loadEnv` is a minimal `KEY=value` parser (blank/`#`
  skipped, `export ` tolerated, surrounding quotes stripped, split on first `=` via `indexOf`),
  never throws, no `eval`/`require` of the file (:139-160).
- **CLI behavior** — yes. handoff prints → exit 0; `--task dream` → `PROMPTS.dream` undefined → exit
  2 "unsupported task" (the slice-04 placeholder); missing file → exit 2 Usage; no-engine → exit 1,
  prints nothing (memory-synth.cjs:441-463; tests :731,:744).
- **Manifest class/profile** — yes. `.wrxn/memory-synth.cjs` `managed/project` (always refreshed on
  update); `.wrxn/memory.config.json` `seeded/project` (operator edits survive update). Matches PRD
  US-23 + Implementation Decisions. Validated by the slice test (:774) and the `install.test.cjs`
  completeness invariants (:26,:35) — both green.
- **Tests behavioral, not implementation-coupled** — yes. Orchestration (`synthesize`/`run`) is
  exercised through external behavior with the fake invoker. The pure "contract" surfaces
  (`buildClaudeSpec`/`buildGeminiSpec`/`parseGeminiResponse`/`buildTranscriptBlob`) are tested
  directly, but AC-7 **explicitly mandates** asserting claude arg construction + gemini request
  shape, and this mirrors the established `lib/protect.cjs` precedent (exports + tests
  `buildRulesetSpec`/`parseSlug`). Consistent with the codebase; not over-coupling.
- **REUSE fidelity vs `aimem-handoff-synth.sh`** — faithful. The HANDOFF prompt is verbatim
  (memory-synth.cjs:79-100 == reference SYS :32-53). The transcript-blob builder is a faithful
  python→node port (role fallback `type||role||'?'`; text / `[thinking]`≤600 / `[tool_use NAME]`≤300
  / `[tool_result]`≤200; malformed lines skipped). The gemini request mirrors the reference
  (endpoint, header, system_instruction+user, temp 0.2). The `claude` engine is net-new per the PRD
  (the reference is gemini-only) — not invented, PRD-specified. **One bounded-parameter deviation:
  `maxOutputTokens` 900 (reference) → 1200 (slice).** See NB-1.

## Findings

### Blocking
None.

### Non-blocking

- **NB-1 (REUSE-fidelity nit): `GEMINI_MAX_OUTPUT_TOKENS = 1200` deviates from the reference's
  `maxOutputTokens: 900` with no rationale comment** (memory-synth.cjs:217; reference
  aimem-handoff-synth.sh:80). No behavioral impact for handoff (the prompt caps output at "~400
  words", well under both limits); the bump most plausibly reserves headroom for the dream task
  landing in slice 04. Recommend a one-line comment stating the intent, or revert to 900 to keep the
  port byte-faithful. Not a defect.

- **NB-2 (coverage nit): `loadConfig`'s merge paths are untested.** Only the absent-config default
  (memory-synth.test.cjs:542) and the seeded-file default (:763) are covered. The partial-override
  merge (`if (t.primary)` spread, memory-synth.cjs:121-122) and the broken/unparseable→defaults
  degradation (the `catch` at :125) have no dedicated test. The code is correct by inspection (starts
  from `clone(DEFAULT_TASK)`, spreads only truthy `primary`/`fallback`; catch returns the cloned
  defaults), so this is completeness only — a test writing a partial and a corrupt
  `memory.config.json` and asserting the resolved tiering would lock the operator-edit contract.

### Carry-forward (from slice-01 review, not a finding against this slice)

- Slice-01 NB-1 flagged that a **value-less `--source`** silently disables the dream quote-verify
  gate. This slice does **not** invoke `dream --source` (out of scope), so it is unaffected. The
  auto-dream slice (**auto-memory-04**), which builds the dream argv programmatically, must always
  pass a concrete `--source <path>` so the auto path never emits a bare trailing `--source`. Recorded
  here so it is not lost between slices.

## Suite verification

Independently ran `npm test` (`node --test --require ./test/setup.cjs`):

```
# tests 818
# pass 818
# fail 0
# skipped 0
```

The **818 green** claim is **confirmed**. `node --test --require ./test/setup.cjs
test/memory-synth.test.cjs` in isolation: **16/16** pass. (Slice-01 baseline was 795; +23 = the 12
dream `--source` tests carried from slice-01's range plus this slice's 16 synth tests, net of the
range under review — the suite total is green either way.)

## Conclusion

APPROVE-WITH-FINDINGS. The slice is mergeable. All seven ACs are delivered and behaviorally tested,
the injectable seam keeps every real engine call out of the suite, the resolver fails safe to `null`
on every degraded path, and the engine specs are faithful to the proven reference. The two
non-blocking items (a parameter-fidelity nit and a config-merge coverage gap) do not gate
integration; the slice-01 carry-forward should be honored when slice 04 builds the auto-dream argv.
