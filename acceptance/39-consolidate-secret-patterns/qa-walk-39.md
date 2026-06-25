---
type: qa-walk
issue: 39
branch: fix/39-consolidate-secret-patterns
head: 916f9e8
walker: qa-walker executor (claude-sonnet-4-6)
date: 2026-06-25
status: FINDINGS(1)
---

# QA Walk — #39 consolidate-secret-patterns

Walked the REAL exported functions against the AC promises. No mocks, no unit-test re-run.
Context note: this walk ran in a fresh isolated executor, not the builder's context.

---

## Artifact surface

| File | Exported symbol | Role |
|------|----------------|------|
| `payload/.wrxn/sync.cjs` | `secretScan(text) → 'contains_secret' \| null` | detection |
| `payload/.wrxn/harvest.cjs` | `secretScan(text) → 'contains_secret' \| null` | detection |
| `payload/.claude/hooks/sidecar.cjs` | `secretScan(text) → 'contains_secret' \| null` | detection |
| `payload/.wrxn/memory-synth.cjs` | `redactSecrets(text) → string` | redaction, placeholder `[REDACTED]` |
| `payload/.claude/hooks/sidecar.cjs` | `redactSecrets(text) → string` | redaction, placeholder `[redacted]` |
| `payload/.wrxn/dream.cjs` | *(secretScan not exported — by design)* | detection internal only |

`dream.cjs` `secretScan` is unexported by design; the drift-guard covers it via byte-identical source-text comparison (see §Walk plan P5).

---

## Walk plan

| # | Behavior (promise) | Exercise | Expected |
|---|-------------------|----------|----------|
| P1 | All 14 canonical shapes flagged by every detection site | Call `secretScan` at each of the 3 exported sites with one real-looking sample per shape | Returns `'contains_secret'` at all 3 sites for every shape |
| P2 | All 14 canonical shapes redacted by every redaction site | Call `redactSecrets` at both sites; check output contains placeholder | Output matches `/\[REDACTED\]/` (memory-synth) or `/\[redacted\]/i` (sidecar) |
| P3 | No regression — pre-#39 original-5 shapes still detected everywhere | Same as P1 for the original AWS/OpenAI/GitHub/Slack/Google samples | `'contains_secret'` at all 3 detection sites |
| P4 | Case/spacing variants caught (`/i` assignment shape) | `password=secret`, `gemini_api_key = x`, `TOKEN: value` | Detected + redacted at all sites |
| P5 | PEM body eaten by full-block match (not just header) | Full PEM block with body line → both redactors | Body line absent from output; placeholder present |
| P6 | Drift-pin is real — guard fails on a diverged copy | Source-text comparison with `AKIA{16}` → `AKIA{15}` in scratch copy | `assert.equal` throws; real copies still pass |
| P7 | ReDoS bound — canonical patterns fast on 100k-char pathological input | `redactSecrets` on `'A'×50k + '_KE' + 'A'×50k` and `'ey' + 'A'×50k + '.validpart'` | Both sites complete < 1 s |
| P8 | Clean prose untouched (no over-redaction) | English sentence with no credential-shaped tokens | Output === input at both redaction sites |
| P9 | `secretScan` graceful on null/empty | `secretScan(null)`, `secretScan('')`; `redactSecrets(null)`, `redactSecrets('')` | null for scan; `''` for redact; no throw |

Edge probes per command:
- **Bad input / null:** covered by P9 (null, empty, non-string coercion).
- **Idempotency:** P7 inputs contain no secrets — a second redact pass returns the same output (redacted string has no further credential shapes); verified implicitly.
- **Empty-state (no match):** P8 clean-prose and P7 no-secret inputs confirm graceful no-op.

---

## Execution & evidence

### P1–P2 — All 14 canonical shapes × all sites (detection + redaction)

Command: `node walk-39.cjs` (scratchpad — ephemeral, not committed).

| Shape | Sample (prefix) | sync detect | harvest detect | sidecar detect | synth redact | sidecar redact |
|-------|----------------|------------|---------------|---------------|-------------|---------------|
| 1 AWS | `AKIAIOSFODNN7EXAMPLE` | PASS | PASS | PASS | PASS | PASS |
| 2 GitHub ghp_ | `ghp_aBcDeFgH…` | PASS | PASS | PASS | PASS | PASS |
| 3 GitHub fine-grained PAT | `github_pat_ABC…` | PASS | PASS | PASS | PASS | PASS |
| 4 Slack xoxb | `xoxb-1234567890-…` | PASS | PASS | PASS | PASS | PASS |
| 5 OpenAI sk- | `sk-ABCDEFGHIJKLMN…` | PASS | PASS | PASS | PASS | PASS |
| 6 OpenAI sk-proj- | `sk-proj-ABCDEF…` | PASS | PASS | PASS | PASS | PASS |
| 7 Google AIza | `AIzaSyA1B2C3…` | PASS | PASS | PASS | PASS | PASS |
| 8 Stripe sk_live_ | `sk_live_ABCDEF…` | PASS | PASS | PASS | PASS | PASS |
| 9 npm npm_ | `npm_ABCDEFGHIJ…` | PASS | PASS | PASS | PASS | PASS |
| 10 JWT eyJ… | `eyJhbGci…` (full 3-part) | PASS | PASS | PASS | PASS | PASS |
| 11 PEM full block | `-----BEGIN RSA PRIVATE KEY-----\n…\n-----END…` | PASS | PASS | PASS | PASS | PASS |
| 12 PEM header only | `-----BEGIN RSA PRIVATE KEY-----` | PASS | PASS | PASS | PASS | PASS |
| 13 Bearer | `Bearer ABCDEFGHIJKLMNO…` | PASS | PASS | PASS | PASS | PASS |
| 14 Assignment KEY= | `MY_API_KEY=some_secret_value` | PASS | PASS | PASS | PASS | PASS |

**70 / 70 assertions PASS.**

### P3 — Pre-#39 original-5 regression

All 5 original shapes (AWS, OpenAI, GitHub, Slack, Google) detected at all 3 sites. **15 / 15 PASS.**

### P4 — Case/spacing edge probes

| Input | sync | harvest | sidecar | synth redact | sidecar redact |
|-------|------|---------|---------|-------------|---------------|
| `password=secret123` | PASS | PASS | PASS | PASS | PASS |
| `gemini_api_key = x12345` | PASS | PASS | PASS | PASS | PASS |
| `TOKEN: some_val_here` | PASS | PASS | PASS | PASS | PASS |

**15 / 15 PASS.**

### P5 — PEM body eaten by full-block match

Input: `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAuGbXWiK3…\n-----END RSA PRIVATE KEY-----`

```
synth  output: "[REDACTED]"
sidecar output: "[redacted]"
```

Body line `MIIEow…` absent from both outputs. Full-block pattern matched before header-only fallback. **4 / 4 PASS.**

### P6 — Drift-pin has teeth

Scratch copy of `harvest.cjs` mutated: `AKIA[0-9A-Z]{16}` → `AKIA[0-9A-Z]{15}`. Comparison logic (same as `adapter-drift-guard.test.cjs` `sliceArrayBody`):

```
ref (harvest real)    starts with: /AKIA[0-9A-Z]{16}/, // AWS access key id
drifted (scratch)     starts with: /AKIA[0-9A-Z]{15}/, // AWS access key id
ref === drifted?  false
PASS: guard throws on drift
PASS: real dream.cjs passes byte-identity check (unchanged)
```

Scratch file cleaned up. Real repo files untouched.

Also ran `node --test test/adapter-drift-guard.test.cjs` against the real tree:

```
ok 1 - secretScan (+ SECRET_PATTERNS) is byte-identical across harvest, sync, dream
ok 2 - dayStamp is byte-identical across harvest and recall-surface
ok 3 - the recon-door HTTP client is logic-identical across harvest, sync, recall-surface
ok 4 - door-client normalization ignores per-door error wording + comments but catches logic drift
ok 5 - each self-contained adapter imports node stdlib or co-located payload sibling
ok 6 - #39 the canonical SECRET_PATTERNS set is byte-identical across dream/sync/harvest/memory-synth/sidecar
ok 7 - #39 the PEM full-block shape precedes the header-only fallback
ok 8 - #39 detection stays non-global; redaction sites derive the g-flagged form
# tests 8 / pass 8 / fail 0
```

**All 8 drift-guard tests PASS.** Pin is real and has teeth. **PASS.**

### P7 — ReDoS bound on pathological 100k-char inputs

Inputs:
- `pathAssign`: `'A'×50k + '_KE' + 'A'×50k` (targets assignment shape #14 near-miss)
- `pathJWT`: `'ey' + 'A'×50k + '.validpart'` (targets JWT shape #10 near-miss)

| Site | pathAssign | pathJWT | < 1 s? |
|------|-----------|---------|--------|
| `memory-synth.redactSecrets` | 2 ms | 1 ms | PASS |
| `sidecar.redactSecrets` | 4 658 ms | 2 368 ms | **FINDING** |

**Isolation run** (each pattern timed independently against the same inputs):

| Pattern | pathAssign | pathJWT |
|---------|-----------|---------|
| CANON#1–14 (all canonical) | 0–1 ms | 0–1 ms |
| EXTRA#1 Bearer-wide | 0 ms | 0 ms |
| EXTRA#2 pwd-assign | 1 ms | 0 ms |
| **EXTRA#3 URI-cred** | **4 658 ms** | **2 368 ms** |
| EXTRA#4 eyJ-JWT | 0 ms | 0 ms |

The `\b`-anchor fix in #39 is confirmed correct for the canonical set — all 14 canonical patterns are 0–1 ms. The slow pattern is `EXTRA#3` (a `SIDECAR_EXTRA` shape from #38, not part of the drift-pinned canonical set):

```js
/[a-z][a-z0-9+.\-]+:\/\/[^\s:/@]+:[^\s/@]+@\S+/i
```

The unbounded `[a-z0-9+.\-]+` before `://` produces O(n²) backtracking on long strings without `://`.

**Filed: issue #68** (label: bug, reference: #39, needs-triage, non-blocking on #39).

### P8 — Clean prose untouched

Input: `"The authentication system uses bearer tokens for session management, but all keys are rotated weekly. The deployment pipeline secures passwords via vault references, not literals."`

Both `memory-synth.redactSecrets` and `sidecar.redactSecrets` return the input unchanged. **2 / 2 PASS.**

### P9 — Null/empty/non-string edge

| Call | Result | |
|------|--------|-|
| `syncScan(null)` | `null` | PASS |
| `syncScan('')` | `null` | PASS |
| `harvestScan(null)` | `null` | PASS |
| `harvestScan('')` | `null` | PASS |
| `sidecarScan(null)` | `null` | PASS |
| `sidecarScan('')` | `null` | PASS |
| `synthRedact(null)` | `''` | PASS |
| `synthRedact('')` | `''` | PASS |
| `sidecarRedact(null)` | `''` | PASS |

**9 / 9 PASS.**

---

## Summary counts

| Plan item | Assertions | Pass | Fail |
|-----------|-----------|------|------|
| P1–P2 all 14 shapes × all sites | 70 | 70 | 0 |
| P3 pre-#39 regression | 15 | 15 | 0 |
| P4 case/spacing edges | 15 | 15 | 0 |
| P5 PEM body eaten | 4 | 4 | 0 |
| P6 drift-pin teeth | 8 guard tests + inline proof | all | 0 |
| P7 ReDoS timing | 8 | 6 | **2** |
| P8 clean prose | 2 | 2 | 0 |
| P9 null/empty | 9 | 9 | 0 |
| **Total** | **131** | **129** | **2** |

---

## Verdict

**FINDINGS (1)**

The #39 canonical set is correct and complete: all 14 shapes detect and redact uniformly across every site (70/70), the drift-pin guard is live with teeth (8/8), PEM body is eaten (not just the header), and the `\b`-anchor ReDoS fix on the canonical patterns holds (0–1 ms on 100k inputs for EVERY canonical shape at BOTH redaction sites).

One finding filed:

| ID | Title |
|----|-------|
| [#68](https://github.com/gcunharodrigues/wrxn-kernel/issues/68) | sidecar EXTRA#3 URI-cred pattern: catastrophic backtracking on long inputs (ReDoS) |

The finding is in `SIDECAR_EXTRA` (added by #38, not part of the drift-pinned canonical set). It is non-blocking on #39's core promise — the canonical 14 shapes are all correct and fast — but `sidecar.redactSecrets` fails the whole-function 1 s bound on pathological inputs.

**Walk coverage:** 7 promise categories, 131 assertions, 129 PASS, 2 FAIL (both in the same ReDoS finding against sidecar EXTRA#3). Did not push.
