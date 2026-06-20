# Security review — auto-memory-04 (auto-dream)

**Verdict: PASS**
**Slice:** auto-memory-04 — auto-dream: synth → gated + quote-verified → auto-commit
**Diff:** commit `cd3560c` (atop `ef0d354`), branch `auto-memory`, repo `wrxn-kernel`
**Reviewer:** security executor (defensive review)
**Scope reviewed:** `payload/.wrxn/memory-synth.cjs` (the new `runDream`, `parseProposals`, `runDreamCli`, `writeTemp`, and the `--from-spawn` wiring) plus the downstream sinks it drives — `payload/.wrxn/dream.cjs` (`check`/`stage`/`commit` gate) and `payload/.wrxn/wiki.cjs` (`write-page` write sink). Test files in the diff cross-checked for security-relevant assertions.

This slice ships an UNATTENDED writer of durable, future-recalled memory (no human approval). Its safety rests on the slice-01 `--source` quote-verify gate. I traced the real call paths to every command/exec sink and every filesystem write sink before ruling.

---

## Attack-surface trace (effect → cause)

`runDream({root, blob})` → `redactSecrets(blob)` → engine (`synthesize`, behind the injectable invoker) → `parseProposals(modelText)` → write redacted blob + proposals to TEMP files → `dream.cjs check --source <tmp> <tmp>` → `dream.cjs stage <tmp>` → `dream.cjs commit --source <tmp> <tmp>` → (per accepted+re-gated proposal) `wiki.cjs write-page <tier> <slug>` → `path.join(root, '.wrxn/wiki', tier, slug+'.md')`.

The only attacker-influenceable inputs are the **transcript blob** and the **model output** (proposal `slug`/`tier`/`title`/`body`/`evidence`). Both are followed to their sinks below.

---

## Findings

No blocking findings. No new findings of any severity. Notes (informational / accepted-by-design) follow.

### [PASS] Command / argument injection — no shell, argv arrays only
- `memory-synth.cjs:584` `runDreamCli` → `spawnSync('node', [dreamAdapter(), ...args, '--root', root], …)` — argv array, **no `shell:true`**.
- `dream.cjs:134,140,148` (the wiki bridge) → `execFileSync('node', [argv…], …)` — argv array, no shell.
- Confirmed `grep -rn "shell\s*:\s*true" payload/` → **none anywhere in the payload**.
- Model output never becomes a command token: proposals are serialized to a temp JSON file (`writeTemp`) and passed **by file path**; the only model-derived tokens passed on a CLI are the accepted **slugs** (`accepted.map(p => p.slug)`, `memory-synth.cjs:638`), each already constrained to `^[a-z0-9][a-z0-9-]*$` by the gate (see below) — so no metacharacters, no `--`-leading value, reach argv.
- `dream.cjs:121` `guardArgv` is a defense-in-depth backstop: it throws on any `--`-leading value at the `node wiki.cjs` exec boundary (title/slug/body/description).
- **No `git` invocation exists in this path** (`grep git` over the four files → only comments/regex). No git, so no git-arg-injection surface.

### [PASS] Path traversal / arbitrary write — slug→path bounded in depth (3 layers)
The auto-commit derives the wiki file path from MODEL OUTPUT (`tier`, `slug`). It cannot escape `.wrxn/wiki/`:
1. **Gate, check time** — `dream.cjs:330` rejects any slug not matching `/^[a-z0-9][a-z0-9-]*$/` (`invalid_slug`): no `/`, no `.`, no `..`, no absolute path, no leading `-`. `dream.cjs:305` requires `tier ∈ TIERS` (`unsupported_tier`); `:306` requires `kind↔tier` agreement.
2. **Gate, commit re-gate** — `dream.cjs:536` re-runs the FULL `validateProposal` (including the slug/tier checks) at the write boundary on the looked-up staged proposal, so a force-approved slug still cannot bypass slug/tier validation.
3. **Write sink** — `wiki.cjs:133-134` independently re-validates `TIERS.includes(tier)` + the kebab-slug regex before `path.join(root, '.wrxn/wiki', tier, `${slug}.md`)` (`:146-148`). The sink does not trust its caller.
- **Overwrite is path-scoped and unreachable from auto-dream.** `--force` overwrite is permitted ONLY for `_slots/current-focus` (`wiki.cjs:141`). `runDream` only ever calls `check`/`stage`/`commit` and **never passes `--force`**, and `_slots` is absent from `KIND_TIER`/`TIERS` in the gate — so auto-dream is strictly create-only + dedup-skip; it can neither overwrite a curated page nor reach the focus slot. Proven by the dedup-skip test (`memory-synth-dream.test.cjs:315`, curated body preserved).
- **Temp files are safe.** `writeTemp(root, tag, content)` (`:594`) uses a **hardcoded literal** `tag` at every call site (`'src'`,`'batch'`,`'stage'`,`'approved'`) — never model-controlled — plus `process.pid`+`Date.now()` for uniqueness, written inside `.wrxn/continuity/`, and unlinked in a `finally` (`:645-647`). No traversal, no orphan on the happy path or on a thrown fault.

### [PASS] Secret handling — redacted blob egresses; raw secrets never reach the model or the temp file
- `memory-synth.cjs:616` `const safeBlob = redactSecrets(blob)` — the **same slice-03 `redactSecrets`** function (not a fork), applied BEFORE the blob is sent to the engine.
- The temp `--source` file is written with **`safeBlob`** (`:622`), not the raw blob — so the quote-verify hay and the on-disk temp both contain only `[REDACTED]` in place of credentials. Raw secrets never egress and never hit disk via this path.
- Defense-in-depth at the page: the gate independently secret-scans the AUTHORED page text and drops on match (`dream.cjs:238,326`), proven by the AKIA test (`memory-synth-dream.test.cjs:181`). A durable page cannot harden a credential.
- Noted (correct, fail-closed): because the `--source` hay is the REDACTED blob, a proposal whose evidence quote spans a now-`[REDACTED]` secret will fail `quote_not_in_source` and be dropped. That is the safe direction — flagged only per the spec's instruction to note it; it is not a defect.

### [PASS / accepted-by-design] Auto-write poisoning / trust boundary
Auto-dream writes durable memory with no human gate, defended by the quote-verify gate plus the existing controls. The bounding is reasonable:
- **Quote-verify** (`dream.cjs:282`): every evidence quote must be a **substantive** (`≥12` chars AND `≥3` tokens, `:269-276`) **verbatim** span of the (normalized) transcript, else `quote_not_substantive`/`quote_not_in_source`. Re-verified at the commit write boundary (`:536` with `--source`). A purely hallucinated page cannot pass — proven by the fabricated-quote test (`memory-synth-dream.test.cjs:138`).
- Plus: confidence floor `0.75` (`:307`), secret-scan, anti-superstition negative filters (`:198`), title/slug identity + flag-injection guard, dedup-skip, and the **≤5/run cap** (`:349`, proven by the 6→5 test).
- **Residual, inherent-by-design (not a fail):** the gate verifies that an evidence quote is *real*, not that the proposal *body* is benign prose. A hostile transcript containing a genuine ≥3-word span could, in principle, drive a page whose body embeds a subtle directive that a later session ingests on recall. This is the unavoidable trade-off of unattended memory and is explicitly the PRD's accepted posture (safety rests on the quote-verify, not on body adjudication). The ≤5 cap + secret-scan + negative filters + dedup bound the blast radius. **Recorded as an accepted design risk, not a finding** — no additional mechanical defense is in scope for this slice. (Possible future hardening, out of scope: an authored-body directive/imperative heuristic; recall-time provenance labeling of auto-written pages.)

### [PASS] Fail-safe posture — `runDream` never throws; never blocks or hangs session lifecycle
- The entire `runDream` body is wrapped in `try { … } catch (e) { return { written: [], reason: … } }` (`memory-synth.cjs:610-648`) with temp cleanup in `finally` — it **cannot throw out of the detached synth**.
- A `runDreamCli` failure (non-zero exit / unparseable stdout) returns `null` (`:585-590`) and degrades to "no result"; the batch continues, nothing half-writes.
- Ordering guarantees it can never extend the SessionStart hold: in `--from-spawn`, `runDream` runs strictly AFTER `runHandoff` has cleared the `.pending-handoff` marker (`:701-706`); the hold waits only on that marker. Proven by the order test (`memory-synth-dream.test.cjs:277`, marker already cleared when dream runs) and the e2e markers-cleared test (`:248`).
- `wiki.cjs write-page` `process.exit(2)` on an existing page is caught at `dream.cjs:545-551` (recorded `skipped`, batch continues) — no TOCTOU crash.
- Recursion guard intact (not in this diff but the path this slice wires into): the SessionEnd spawn hook no-ops when `WRXN_MEMORY_SYNTH` is set (`memory-synth-spawn.cjs:49`), and the synth child is spawned with that sentinel (`:64`). `runDreamCli`'s `spawnSync('node', …)` inherits the synth process env (it passes no `env`), so the sentinel propagates to the dream child — no fork-bomb risk from the auto-dream sub-invocations.

---

## Write-scope / boundary compliance
- The diff touches only `payload/.wrxn/memory-synth.cjs` + three test files — no managed-file or settings edits in this slice (the spawn-hook/settings wiring is slice-03). No source edited by this review.
- This review wrote exactly one artifact: this marker. No push performed.

## Verdict
**PASS** — no injection (argv arrays, no shell, no git, model output passed by file path), slug→path traversal bounded in depth at the gate (check + commit re-gate) and independently at the `wiki.cjs` write sink with `--force` path-scoped and unreachable from auto-dream, the model + temp `--source` file see only the slice-03 REDACTED blob, and `runDream` is fail-closed (never throws, cleans temps, runs after the hold is released). The unattended-write trust boundary is bounded by the quote-verify gate + ≤5 cap + secret-scan as designed; the residual body-directive risk is an accepted inherent property, recorded, not failed.
