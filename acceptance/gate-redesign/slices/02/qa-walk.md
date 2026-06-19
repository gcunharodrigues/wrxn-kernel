# QA-Walk — gate-02: `wrxn protect` + ruleset auto-apply + migration 005

**Artifact:** `lib/protect.cjs` + `bin/wrxn.cjs` (`protect` block) + `migrations/005-protect-main-gate.cjs`
**Commit:** e40721e
**Issue:** `acceptance/gate-redesign/issues/02-protect-ruleset-autoapply.md`
**Walker context:** fresh isolated executor (not the builder's context)
**Date:** 2026-06-19

---

## Walk plan

| # | Behavior (promise) | Command(s) | Expected |
|---|-------------------|------------|----------|
| W-1 | `buildRulesetSpec()` is pure and returns correct shape | `node -e "JSON.stringify(require('lib/protect.cjs').buildRulesetSpec(), null, 2)"` | name `wrxn-main-gate`, `~DEFAULT_BRANCH`, `bypass_actors:[]`, PR `required_approving_review_count:0`, check `wrxn-ci`, `strict_required_status_checks_policy:true` |
| W-2 | `wrxn protect` fail-soft on no-remote | `git init /tmp/noremote && node bin/wrxn.cjs protect --root /tmp/noremote` | exit 0, clear "skipped/no remote" message, no crash |
| W-3 | `wrxn protect` self-describes in USAGE | `node bin/wrxn.cjs --help` | `protect` block appears with description |
| W-4 | `applyProtection` idempotency: existing ruleset → PUT not POST | `applyProtection({ invoker: fakeGh(existingRuleset), slug:'owner/repo' })` | action `updated`, no POST call, ok true |
| W-5 | Migration 005 metadata | read `migrations/005-protect-main-gate.cjs` module exports | id `'005'`, version `'0.11.0'`, up is a function |
| W-6 | Migration 005 end-to-end via runner: runs, records, idempotent on no-remote | drive `update()` from `'0.10.0'` receipt + fake pkg carrying 005 | `migrationsRan:['005']`, `protection.action:'skipped'`, receipt records `'005'`; second run: `migrationsRan:[]` |
| W-7 | `wrxn update` fail-soft on no-remote: protection skipped, update succeeds | `update({ pkgRoot, target: noRemoteGitRepo })` | `report.protection.action === 'skipped'`, no throw, `migrationsRan` is an array |
| W-8 (CF-1) | `wrxn-ci.yml` reads `wrxn.install.json`.kernelVersion to pin wrxn version | grep YAML | VER line reads `require('./wrxn.install.json').kernelVersion` |
| W-9 (CF-2) | `managedIntegrity` byte-compares against manifest; `wrxn ci` PASS on clean install | `node bin/wrxn.cjs ci --root <fresh install>` | exit 0, `✓ managed-integrity — 89 managed file(s) checked` |

Edge probes (per SKILL.md — bad input / empty state / repeat-run, required for every command):

| EP | Command | Expected |
|----|---------|----------|
| EP-1 (bad input) | `protect --unknown-flag` (cwd = WRXN-OS repo with real origin) | exit 0, fail-soft message, no crash |
| EP-2 (empty state / no-remote) | `protect --root /tmp/fresh-git-init` | exit 0, "no origin remote" skip message |
| EP-3 (repeat-run) | `protect --root /tmp/noremote` twice | identical output both runs, exit 0 each |

---

## Execution log

### W-1 — `buildRulesetSpec()` output

```
node -e "console.log(JSON.stringify(require('/…/lib/protect.cjs').buildRulesetSpec(), null, 2))"
```

Output (exit 0):
```json
{
  "name": "wrxn-main-gate",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "wrxn-ci" }]
      }
    }
  ]
}
```

Result: **PASS** — name `wrxn-main-gate`, `~DEFAULT_BRANCH`, `bypass_actors:[]`, `required_approving_review_count:0`, check `wrxn-ci`, `strict_required_status_checks_policy:true`. All AC-1 fields present and correct.

---

### W-2 — `wrxn protect` fail-soft on no-remote

```
git init -q /tmp/wrxn-walk-02-noremote
node bin/wrxn.cjs protect --root /tmp/wrxn-walk-02-noremote
```

Output (exit 0):
```
wrxn protect → skipped: no origin remote — the wrxn-main-gate ruleset is not applied (a remote-less install is unprotected here; protection lands when it gains a GitHub origin)
```

Result: **PASS** — exit 0, clear skip message, no crash.

---

### W-3 — `wrxn protect` in USAGE

```
node bin/wrxn.cjs --help | grep -A6 "protect"
```

Output:
```
  wrxn protect [--root <dir>]    apply the wrxn-main-gate server-side ruleset to this repo's origin —
                                 the hard gate that replaces the settings.local.json env-flag dance:
                                 block direct push to the default branch, require a PR + the wrxn-ci
                                 check, require the branch up to date, no bypass actor. Idempotent
                                 (create-or-update by name) and fail-soft (no gh / not admin / no remote
                                 → a clear message, exit 0). Repo-agnostic: the slug is read from origin,
                                 so the SAME command protects the kernel, any install, and recon-wrxn.
```

Result: **PASS** — command self-describes with flags, behavior, and fail-soft guarantees.

---

### W-4 — `applyProtection` idempotency (injectable invoker)

```js
applyProtection({ invoker: fakeGh([{id:42, name:'wrxn-main-gate'}]), slug:'owner/repo' })
```

Output:
```
action: updated
ok: true
used PUT (not POST): true
no POST issued: true
run-2 action: updated
```

Result: **PASS** — when the ruleset already exists, the function issues a PUT (update), not a POST (create). No duplicate creation. Second call produces identical result.

---

### W-5 — Migration 005 metadata

Observed module exports from `migrations/005-protect-main-gate.cjs`:
- `id: '005'`
- `version: '0.11.0'`
- `up: [Function]`

Result: **PASS** — metadata matches AC-5 exactly.

---

### W-6 — Migration 005 end-to-end via update runner (no-remote fixture)

Script: drove `update()` from a `'0.10.0'` receipt against a fake pkg carrying 005, no origin remote.

Run 1 output:
```
RUN-1 migrationsRan: ["005"]
RUN-1 protection.action: skipped
RUN-1 migrationsApplied: ["005"]
RUN-2 migrationsRan (should NOT include 005): []
```
Exit: 0

Result: **PASS** — 005 ran, was recorded in the receipt, protection soft-skipped (no remote), and was NOT re-run on the second update. Runner contract satisfied (recorded + resumable).

---

### W-7 — `wrxn update` fail-soft on no-remote

```js
init({ pkgRoot, target }); // fresh install
execFileSync('git', ['init', '-q', target]); // real git repo, NO origin
update({ pkgRoot, target });
```

Output:
```
update completed — protection.ok: false
protection.action: skipped
migrationsRan type: true
```
Exit: 0

Result: **PASS** — protection soft-skipped, update did not throw, migrations array surfaced.

---

### W-8 (CF-1) — `wrxn-ci.yml` pins wrxn to receipt version

Key lines from `payload/.github/workflows/wrxn-ci.yml`:
```yaml
run: |
  VER=$(node -p "require('./wrxn.install.json').kernelVersion || ''" 2>/dev/null || true)
  if [ -n "$VER" ]; then
    npx --yes @gcunharodrigues/wrxn@"$VER" ci
  else
    npx --yes @gcunharodrigues/wrxn ci
  fi
```

Result: **PASS** — YAML reads `wrxn.install.json`.kernelVersion and pins `npx` to that exact version. Version-skew false-positive (CF-1) is structurally prevented.

---

### W-9 (CF-2) — `wrxn ci` PASS on clean tmp install

```
node bin/wrxn.cjs ci --root /tmp/wrxn-walk02-ci2-<suffix>
```

Output (exit 0):
```
wrxn-ci (/tmp/wrxn-walk02-ci2-f5Vg8J)
  ✓ managed-integrity — 89 managed file(s) checked
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 17 .cjs file(s) parsed
wrxn-ci PASS
```

Result: **PASS** — 89 managed files byte-compare clean against the manifest-owned payload. `managedIntegrity` is anchored to `manifest.json` (confirmed by reading `lib/ci-checks.cjs` lines 37–80).

---

### Edge probes

**EP-1 (bad input — unknown flag):**
```
node bin/wrxn.cjs protect --unknown-flag
```
(cwd = WRXN-OS with a real GitHub origin; `gh` call attempted, received HTTP 403 — Pro required for rulesets on private repos)

Output (exit 0):
```
wrxn protect → skipped: could not list rulesets on gcunharodrigues/WRXN-OS (exit 1: gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)) — is gh installed, authenticated, and admin on the repo? skipping (exit 0)
```

Result: **PASS** — Unknown flag ignored; fail-soft triggers on the `gh` 403 path; clear message, exit 0, no crash. (The flag-ignore is the CLI's existing parsing behavior; no AC mandates flag-rejection.)

**EP-2 (empty state / no-remote):** covered by W-2. **PASS**

**EP-3 (repeat-run):**
```
node bin/wrxn.cjs protect --root /tmp/wrxn-walk02-repeat   # run 1
node bin/wrxn.cjs protect --root /tmp/wrxn-walk02-repeat   # run 2
```

Run 1 output (exit 0): `wrxn protect → skipped: no origin remote — …`
Run 2 output (exit 0): `wrxn protect → skipped: no origin remote — …` (identical)

Result: **PASS** — idempotent on empty/no-remote state.

---

### UNWALKABLE — real GitHub ruleset creation

The actual `gh api POST /repos/{slug}/rulesets` mutating call to create the GitHub branch ruleset is not walkable: it requires GitHub Pro or a public repo, admin auth, and a real remote. This path is exercised by the unit tests via injectable invoker and is deferred to the bootstrap self-host walk (when the kernel gains GitHub Pro / public repo access). No finding is filed for this; it is explicitly noted as a known deferred walkpoint.

---

## Verdict

**PASS — 0 findings filed.**

| Promise | Status |
|---------|--------|
| W-1: `buildRulesetSpec()` shape (name, branch, bypass_actors, PR 0-approval, wrxn-ci, strict) | PASS |
| W-2: `wrxn protect` fail-soft on no-remote (exit 0 + clear message) | PASS |
| W-3: `wrxn protect` self-describes in USAGE | PASS |
| W-4: `applyProtection` idempotent (PUT not POST on existing ruleset) | PASS |
| W-5: Migration 005 metadata (id, version, up) | PASS |
| W-6: Migration 005 end-to-end via runner (recorded, idempotent, no-remote no-op) | PASS |
| W-7: `wrxn update` fail-soft on no-remote (protection skipped, update succeeds) | PASS |
| W-8 (CF-1): `wrxn-ci.yml` pins wrxn version to `wrxn.install.json`.kernelVersion | PASS |
| W-9 (CF-2): `managedIntegrity` manifest-anchored; `wrxn ci` PASS on clean install | PASS |
| EP-1: bad input (unknown flag) — exit 0, no crash | PASS |
| EP-2: empty state (no-remote) | PASS |
| EP-3: repeat-run (idempotent) | PASS |
| UNWALKABLE: real GitHub ruleset creation (no Pro/admin) | DEFERRED to bootstrap self-host walk |

**Walk coverage:** 9 promised behaviors + 3 edge probes = 12 walkpoints run. 12 PASS, 0 FINDING, 1 UNWALKABLE (deferred, expected). Suite-green AC (AC-6) is not a walk concern per SKILL.md (unit tests are not re-run in a walk).
