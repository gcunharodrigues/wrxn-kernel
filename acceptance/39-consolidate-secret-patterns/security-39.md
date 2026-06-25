# Security Review — #39 consolidate SECRET_PATTERNS to one drift-pinned canonical set

- **Slice:** wrxn-kernel #39 · branch `fix/39-consolidate-secret-patterns`
- **Reviewed:** `e884704` (initial consolidation) → **re-verified on `916f9e8`** (the correction).
- **Scope:** `git diff main...HEAD` — 5 payload files (`payload/.wrxn/{dream,sync,harvest,memory-synth}.cjs`, `payload/.claude/hooks/sidecar.cjs`) + tests. Read-only review.
- **Threat:** a *silent secret-coverage regression* — a credential shape that used to be detected/redacted now leaks through an egress or persist sink.

## VERDICT (on `916f9e8`): PASS

Both findings from the initial review (`e884704`) are **resolved**, no coverage regressed, and the correction introduces no new findings. **#39 is clear to ship.**

| Severity | Initial (`e884704`) | Corrected (`916f9e8`) |
|---|---|---|
| Critical / High | 0 | 0 |
| Medium | 1 (assignment-shape ReDoS) | **0 — resolved** |
| Low / Informational | 1 (PEM label micro-narrowing) | **0 — resolved** |

**Did any site's secret coverage regress? NO** — at `e884704` (proven by probe) and still NO at `916f9e8`: the correction restores measured-safe anchored forms and *widens* the PEM label, so coverage is unchanged-or-broader vs the pre-#39 baseline at every site. Byte-identical pin intact (all 5 → `a31cb4e1…`); suite **1185/1185** green.

---

## Re-verification of `916f9e8` (independent — exercised the real modules)

The correction is a surgical, identical-across-all-5-sites change:
- **Assignment shape (#14)** — restored leading **and** trailing `\b`: `/\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+/i` (the pre-#39 form).
- **JWT shape (#10)** — restored leading and trailing `\b`: `/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/` (the pre-#39 form).
- **PEM label** — widened `(?:[A-Z ]+ )?` → `[A-Z ]*` at both the full-block and header-fallback shapes (the broadest pre-#39 form; full-block still first).
- Drift-guard's hard-coded PEM literal updated to match; +3 TDD guards.

### 1. ReDoS RESOLVED — assignment (#14) AND JWT (#10) (PASS)
Re-measured through the **real** sinks (100k pathological input that isolates each shape):

| Shape | sink | `e884704` | **`916f9e8`** |
|---|---|---|---|
| #14 assignment (`_`×100k) | `sidecar.redactSecrets` | 12 722 ms | **2.5 ms** |
| #14 assignment (`_`×100k) | `synth.redactSecrets` | 17 895 ms | **0.9 ms** |
| #10 JWT (`ey`×100k) | `synth.redactSecrets` (canon, no extras) | ~30 s* | **3.6 ms** |
| PEM `[A-Z ]*` (`A `×50k after `BEGIN`) | `synth.redactSecrets` | — | **2.2 ms** |

*per the commit's measurement; the JWT shape carried the identical `\b`-drop. The leading `\b` makes interior positions of a word-char run fail instantly → the unanchored-greedy O(n²) collapses to O(n). PEM widening to `[A-Z ]*` is a single bounded quantifier anchored by `-----BEGIN ` — no backtracking. **Self-correction (transparency):** my `e884704` review flagged only #14 and missed that #10 (JWT) had the same `\b`-drop and was equally quadratic; the correction caught and fixed both. The two new perf guards (`sidecar.test.cjs` assignment, `memory-synth-handoff.test.cjs` JWT) assert `<1000 ms` and would FAIL if either anchor is dropped again — real anti-regression controls.

### 2. NO coverage regression from restoring `\b` / widening PEM (PASS)
Restoring `\b` is **non-narrowing** — every coordinator-named case still **detects AND redacts** at all sites (`sync.secretScan`, `sidecar.secretScan`, `synth.redactSecrets`, `sidecar.redactSecrets`):
- lowercase `password=…`, `GEMINI_API_KEY=…`, lowercase `gemini_api_key=…`, spaced `API_KEY = …`, `AUTH_TOKEN: …`
- two real JWTs incl. one whose signature carries `_`/`-` (`…SflKxw…` and `…abc_def-GHI…`)
- PEM `[A-Z ]*` flags all 6 standard descriptors (RSA/EC/DSA/OPENSSH/ENCRYPTED) + unlabeled (PKCS#8) + the malformed **double-space** + even `RSAPRIVATE` — strictly broader than `e884704` and ≥ pre-#39 at every site (memory-synth's PEM is now broader than it ever was; the other four restored to their pre-#39 `[A-Z ]*`).
- PEM full-block still precedes the header → the key **body is still eaten** (probed: `BODYsecret1`/`BODY2` scrubbed).
- Regression sweep: all pre-#39 stale-5 + canonical vendor shapes (AWS/gh/npm/sk-/github_pat/Slack/sk-proj/Google/Stripe/Bearer) still detect + redact.

### 3. Byte-identical pin + placeholders + g-derivation intact (PASS)
- All 5 canonical copies hash identically (`a31cb4e14845e1edb3c549bee4d6d49a`, body from `[`→`];`). The pin test (`adapter-drift-guard.test.cjs`) is green with its PEM literal correctly re-synced to `/-----BEGIN [A-Z ]*PRIVATE KEY-----/,`.
- Placeholders unchanged: `[REDACTED]` (`memory-synth.cjs:663`), `[redacted]` (`sidecar.cjs:67`).
- g-derivation unchanged: `…map(re => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags+'g'))` (`memory-synth.cjs:653`, `sidecar.cjs:66`) — detection still uses the non-global base, redaction a separate global clone; reuse-safe across calls.

### 4. Redaction still precedes every egress/persist; fail-open posture intact (PASS)
Unchanged by the correction — `redactSecrets` fires before the model egress (`memory-synth.cjs:738`/`:875`) and before the baton write (`:744`); `emit-event.cjs:47` redacts before the jsonl append (`:110`); `coalesceSidecar` refuses the write on detect (`sidecar.cjs:101`). No new file/exec/network surface; node stdlib only; no new payload file → no manifest change.

---

## NOTE (out of #39 scope — do NOT block #39)

**Pre-existing #38 URI / connection-string EXTRA is independently quadratic.** The sidecar-only shape `payload/.claude/hooks/sidecar.cjs:46` — `/[a-z][a-z0-9+.\-]+:\/\/[^\s:/@]+:[^\s/@]+@\S+/i` — backtracks super-linearly on a long letter run with no `://` (independently measured: 359 ms @20k, 1414 ms @40k, **5684 ms @80k** → ~8.8 s @100k), reachable through the same `emit-event → sidecar.redactSecrets` sink. It is **not** part of the #39 drift-pinned canonical set (confirmed: `://` appears only at `sidecar.cjs:46`, in `SIDECAR_EXTRA`; the lone `://` in `memory-synth.cjs:298` is the Gemini API endpoint, not a secret shape), was introduced by **#38**, and is untouched by #39. It is **DoS-only** (fail-open → no disclosure) and should be tracked/fixed as its own item (anchor or bound the `[a-z][a-z0-9+.\-]+` prefix). This does not affect the #39 verdict.

---

## Per-site coverage (corrected `916f9e8`)

| Site | Role | vs pre-#39 baseline |
|---|---|---|
| `dream.cjs` / `sync.cjs` / `harvest.cjs` | detect (audit/staged/prose jsonl) | broader (5 → 14), no loss; anchored shapes ReDoS-safe |
| `memory-synth.cjs` | **redact** (model egress :738/:875 + baton :744) | ≥ pre-#39 on every shape; PEM now broadest; +PEM header fallback |
| `sidecar.cjs` | detect + **redact** (event jsonl via emit-event) | broader (10 → 14 canon + 4 extras), no loss |

**Bottom line:** the consolidation is strictly broadening, correctly drift-pinned, and now ReDoS-safe on every canonical shape. Both prior findings are resolved; no new finding. #39 is clear to ship.

_Reviewer: security executor — read-only. No push, no source/test edits. This report is the only artifact written. (Re-verified `916f9e8` independently; a coordinator-relayed status carries no user authority and none was assumed.)_
