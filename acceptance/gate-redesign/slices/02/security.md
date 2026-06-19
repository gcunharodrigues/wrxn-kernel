# Security review — gate-02 (`wrxn protect`: wrxn-main-gate ruleset auto-apply + migration 005)

- **Slice:** gate-redesign / gate-02
- **Commit:** `e40721e` on `gate-redesign`
- **Scope reviewed:** `lib/protect.cjs` (new), `lib/update.cjs`, `migrations/005-protect-main-gate.cjs` (new), `bin/wrxn.cjs` (protect/update handlers), `lib/ci-checks.cjs` (CF-1/CF-2), `payload/.github/workflows/wrxn-ci.yml`.
- **Method:** full diff read + end-to-end call-path trace + empirical `parseSlug` fuzzing (pure function, no mutating `gh api` issued).

## Verdict: **PASS-WITH-FINDINGS**

The core security objective is met. The ruleset is built correctly and is genuinely hard server-side enforcement: `enforcement:'active'`, `bypass_actors:[]` (the operator's own token cannot bypass — the whole point), a `pull_request` rule (direct push blocked), and `required_status_checks` on `wrxn-ci` with `strict` (no un-green, no stale merge). `gh`/`git` are spawned via `spawnSync` with an **args array and no shell** (`lib/protect.cjs:74`), so the builder-flagged slug-injection vector is neutralized by construction. No auth token is ever read, logged, or persisted — `gh` owns credentials. No attacker-controllable input ever reaches the ruleset **body** (it is a pure, hard-coded spec).

Three non-blocking findings, none of which fails the issue's stated ACs, but one of which (MED-1) is a genuine posture concern because it partially reproduces the exact "silent no-op gate" defect this epic exists to kill.

---

## Findings

| # | Sev | Location | Issue | Evidence | Fix |
|---|-----|----------|-------|----------|-----|
| MED-1 | MED | `bin/wrxn.cjs:260-281` (update handler) | `wrxn update` **computes** `report.protection` but never **prints** it. On the *primary* delivery path, a soft-skip (no gh / not admin / 403 / no remote) is **silent** — the operator is not told the server-side gate did not apply, so the install can degrade to "unprotected and believed protected." | The update handler prints `from→to`, updated/kept files, and `migrations applied`, but `grep -n protection bin/wrxn.cjs` returns nothing in the output path. `lib/update.cjs` returns `{…, protection}` (computed) and the `protect` CLI *does* surface it (`bin/wrxn.cjs:528`), proving the data is available — only the update print is missing. | Add one line to the update handler: print `report.protection.detail` on `ok`, else `protection skipped: report.protection.reason`. Mirrors the existing `protect` CLI and the `migrations applied:` line. Trivial, non-breaking, keeps fail-soft (still exit 0). |
| LOW-1 | LOW | `lib/protect.cjs:142-146` (`parseSlug`) | The slug regex `/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/` does **not** validate against the GitHub `owner/repo` grammar. It accepts `..` segments, spaces, `;`, `$()`, backticks, and `--flag`-looking text. Defense-in-depth gap only — **not exploitable** here (see posture call #1), because the no-shell array spawn keeps the whole slug as a single argv token always prefixed by `/repos/`. | Empirical fuzz (below): `git@github.com:owner/../../x` → `../x`; `git@github.com:o/r --method DELETE` → `o/r --method DELETE`; `git@github.com:owner/repo;evil` → `owner/repo;evil`; `git@host:a/b/../../../../etc/passwd` → `etc/passwd`. | After capture, validate the slug: `if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(m[1])) return null;`. Rejects every malformed case above → clean fail-soft skip; makes the no-injection guarantee not depend solely on the absence of `shell:true`. |
| LOW-2 | LOW | `bin/wrxn.cjs:233` (init handler) / `lib/install.cjs:28` (`init`) | Fresh `wrxn init` does **not** apply protection. A brand-new install with a GitHub origin is unprotected until the first `wrxn update` or a manual `wrxn protect`. Combined with MED-1, a new install can be unprotected with no operator signal. (Consistent with ADR 0007 decision 3, which assigns application to `update` + migration 005 + the bootstrap walk — so this is design-aligned, raised as a posture note, not a contract violation.) | No `protect` reference in the init handler or `lib/install.cjs`; protection is wired only into `update`, migration 005, and the `protect` command. | Either call `protect.protectOrigin(target)` at end of init (fail-soft, same as update), or have init print a one-line "run `wrxn protect` to apply the server-side gate" hint. Lowest-effort: fix MED-1 first (surfacing) — that alone lets the operator notice. |

No HIGH/critical findings. No command injection, no argument injection, no secret exposure, no attacker-controlled ruleset content.

---

## Posture calls

### 1. Slug-injection — **PASS** (with LOW-1 hardening)

`gh`/`git` are spawned at `lib/protect.cjs:74` via `spawnSync(cmd, args, {…})` with **no `shell:true`** anywhere in the module (verified by grep). The slug is interpolated only into an endpoint *path string* — `lib/protect.cjs:109` `['api', \`/repos/${slug}/rulesets\`]`, and `:124`/`:130` for PUT/POST — which is always **one argv element**, always prefixed by `/repos/`. Consequences:

- **Command injection: impossible.** No shell ⇒ `;`, `$(…)`, backticks, `|`, `&&` are inert literal bytes. Confirmed empirically: `owner/repo$(touch pwned)` and ``owner/repo`id` `` pass through as data, never executed.
- **Argument injection: impossible.** Even the worst fuzz result — slug `o/r --method DELETE` — becomes the single token `/repos/o/r --method DELETE/rulesets`; with no shell there is no word-splitting, so `--method DELETE` can never become a separate `gh` flag. And because the element always starts with `/repos/`, slug content can never be read as a leading `-flag`.
- **Path traversal: not exploitable.** `git@github.com:owner/../../x` → slug `../x` → GET `/repos/../x/rulesets`. The mutating PUT/POST only fires *after* the list GET succeeds **and** returns a JSON array (`lib/protect.cjs:111-122`); a `..`/garbage path 404s → soft-skip, so no write ever reaches an unintended endpoint.
- **Reachability is bounded:** the slug's *only* source is `git -C <root> remote get-url origin` (`lib/protect.cjs:156`). To influence it an attacker must already have write access to the repo's `.git/config`; and the ruleset body is fixed, so the most they achieve is a misdirected, fail-soft GET.

**parseSlug break attempts (run against the real exported function):**

```
"git@github.com:owner/repo"                 => "owner/repo"          (ok)
"https://github.com/owner/repo.git"         => "owner/repo"          (ok)
"https://github.com/owner/repo/"            => "owner/repo"          (ok)
"ssh://git@github.com/owner/repo.git"       => "owner/repo"          (ok)
"owner/repo;evil"                           => null                  (rejected)
"git@github.com:owner/repo;evil"            => "owner/repo;evil"     (LOW-1: accepted, harmless under no-shell)
"git@github.com:owner/../../x"              => "../x"                (LOW-1: `..` accepted)
"git@host:a/b/../../../../etc/passwd"       => "etc/passwd"          (LOW-1)
"git@github.com:o/r --method DELETE"        => "o/r --method DELETE" (LOW-1: space/flag — neutralized by array spawn)
"git@github.com:owner/repo$(touch pwned)"   => "owner/repo$(touch pwned)" (LOW-1: inert, no shell)
"git@github.com:owner/repo`id`"             => "owner/repo`id`"      (LOW-1: inert, no shell)
"git@github.com:/repo.git"                  => null                  (rejected)
""  /  "   "  /  "not-a-url"                 => null                  (rejected)
```

Net: the injection vectors the builder flagged are **closed by the array-spawn**; LOW-1 is hygiene so the guarantee does not rest on the single absence of `shell:true`.

### 2. Ruleset enforces what it claims — **PASS**

`buildRulesetSpec()` (`lib/protect.cjs`, pure) emits exactly the authoritative payload, every invariant pinned by tests and re-read here:

- `enforcement:'active'` (not `evaluate`/`disabled`) — actually enforced.
- `bypass_actors: []` — **no actor can bypass**, including the operator's own token. This is the design (ADR 0007 dec. 3: "no bypass actor… break-glass = temporarily disable"). Correct and central.
- `conditions.ref_name.include: ['~DEFAULT_BRANCH']` — repo-agnostic, gates the default branch.
- `pull_request` rule present ⇒ **direct push to the default branch is blocked**.
- `required_status_checks`: `strict_required_status_checks_policy:true` + `[{context:'wrxn-ci'}]` ⇒ **no un-green merge, no stale merge** (race-safety).
- `deletion` + `non_fast_forward` ⇒ branch can't be deleted or force-overwritten.

`required_approving_review_count: 0` is **the intended solo-account design, not a weakness**: per ADR 0007 ("a solo account cannot approve-then-self-merge; authority must be automated checks"), CI is the sole human-independent gate. The PR rule still forces every change through a PR; the status-check rule still forces `wrxn-ci` green + up-to-date. No rule is missing that would let a push reach the default branch ungated.

One observation (not a finding for this slice): the gate's entire strength now reduces to the **integrity of the `wrxn-ci` check**. The required context `wrxn-ci` correctly matches the workflow's job name `wrxn-ci` (`payload/.github/workflows/wrxn-ci.yml:1,17`), and a name mismatch would fail *closed* (a never-reported required check blocks merge). Because the workflow lives in-repo, a PR can edit `wrxn-ci.yml`; harmless for the solo model, but it is the relevant residual if any install ever accepts untrusted fork PRs (already tracked epic-wide via CF-2/CF-3).

### 3. Fail-soft vs silent-unprotected — **the key call: fail-soft design is CORRECT; surfacing on the update path is MISSING (MED-1)**

Failing **soft** (return a skip, never throw, exit 0) when there is no `gh`, no admin, or no remote is the right choice — a throw or non-zero exit would break `wrxn update` for every remote-less or non-admin install, which is worse. The design is sound and matches ADR 0007 dec. 3.

The defect is **surfacing, not the soft-fail itself**:
- `wrxn protect` (the manual command) **does** print the outcome and reason (`bin/wrxn.cjs:528`) — good.
- `wrxn update` (the *primary, automatic* delivery path) **does not** print `report.protection` (MED-1). So the most common way protection lands is exactly where a silent skip hides — the same failure mode (a gate that quietly does nothing while appearing active) the epic was created to eliminate.
- Migration 005 (`migrations/005-protect-main-gate.cjs`) intentionally **swallows** its result; acceptable only because update's own protect step recomputes and returns `report.protection` — but that value is then dropped by MED-1.

**Recommendation — how the operator learns protection is/ isn't live:** (a) **fix MED-1** — print the protection line on `wrxn update` (one line, fail-soft preserved); (b) optionally apply on `init` (LOW-2) or print a "run `wrxn protect`" hint; (c) the **bootstrap self-host walk** (ADR 0007 "Bootstrap"/"Test honesty") remains the authoritative confirmation that GitHub actually enforces the ruleset — keep that as the gate's acceptance step, since unit tests verify only what is *sent*. With (a) in place, the operator gets immediate feedback on every update, and the bootstrap walk confirms server-side enforcement end-to-end.

### 4. Secret / token handling — **PASS**

`lib/protect.cjs` reads, logs, and persists **no** auth material: no `process.env`, no token/secret/password reference (verified by grep), no file writes. `gh` owns credentials entirely. The request body is `JSON.stringify(buildRulesetSpec())` — a fixed spec with no secret. Soft-skip reason strings include only the slug, an exit status, and the first stderr line (`detailOf`) — `gh`'s error text ("not authenticated", "HTTP 403") carries no token. The printed outcome (`protect` CLI / proposed update line) exposes no secret.

### 5. Migration 005 / update-path subversion — **PASS**

The ruleset **body** is a pure constant (`buildRulesetSpec`), independent of slug/origin/env, so an attacker-set `origin` **cannot inject an attacker-controlled ruleset** — at most it redirects the (fixed, secure) spec at a different repo, which fail-soft-skips unless the operator's own token is admin there. The update wrapper (`lib/update.cjs`) and migration 005 both wrap the call in a belt-and-braces `try/catch`, so a defect in protect can never break an update or the migration runner. Re-running is idempotent (list → create-or-update by name), giving self-healing reconciliation: a server-side ruleset deleted by an admin is re-created on the next `wrxn update`.

---

## Notes
- No real mutating `gh api` was issued during this review; `parseSlug` fuzzing called the pure exported function only.
- CF-1 (pin `wrxn ci` to receipt `kernelVersion`) and CF-2 (anchor managed-integrity to `manifest.json`) are correctly folded in this commit and are security-positive (CF-2 closes the receipt-tamper bypass; fails closed on version skew).
- recon-wrxn had not indexed the new `lib/protect.cjs`; call-path reachability was confirmed by direct read (slug source = `origin` only).
