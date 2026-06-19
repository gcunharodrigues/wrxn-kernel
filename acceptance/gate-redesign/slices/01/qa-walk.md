# QA Walk — gate-01: Universal CI Workflow

Slice: `01-universal-ci-workflow.md`
Commit: `a0addfe`
Entry point: `node /home/guilherme/Documents/_projects/wrxn-kernel/bin/wrxn.cjs ci`
Walk date: 2026-06-19
Context: fresh isolated qa-walker executor (not the builder's context)

---

## Walk plan

Source of promises: `acceptance/gate-redesign/issues/01-universal-ci-workflow.md` (6 ACs)
and PRD user stories 4 ("CI is the single hard gate") and 5 ("CI is never an empty `true`").

| # | Behavior (AC / story) | Commands | Expected |
|---|----------------------|----------|----------|
| P1 | `wrxn ci` exists and self-describes in `--help` (AC-2 + CLI presence) | `node bin/wrxn.cjs --help` | Exit 0; help text includes `wrxn ci [--root <dir>]` description |
| P2 | Clean install passes — all 5 checks report ok, exit 0 (AC-2, AC-3) | `wrxn init --project` in fresh git dir; `wrxn ci --root <dir>` | `wrxn-ci PASS` exit 0; all 5 check lines show `✓` |
| P3a | managed-integrity fails on drifted managed file (AC-3) | Append a line to a managed `.cjs` in probe copy; `wrxn ci --root <copy>` | `✗ managed-integrity` names the offending file; exit 2 |
| P3b | wiki-lint fails on malformed frontmatter (AC-3) | Write a `.md` with no frontmatter to `.wrxn/wiki/concepts/` in probe copy; `wrxn ci` | `✗ wiki-lint` names the page; exit 2 |
| P3c | synapse-manifest lint fails on active domain with missing file (AC-3) | Append `GHOSTDOMAIN_STATE=active` to `.synapse/manifest` in probe copy; `wrxn ci` | `✗ synapse-manifest` names the ghost domain; exit 2 |
| P3d | json-validity fails on corrupt JSON receipt (AC-3) | Overwrite `wrxn.install.json` with `{broken json}` in probe copy; `wrxn ci` | `✗ json-validity` names the file; exit 2 |
| P3e | node-check fails on syntax error in managed `.cjs` (AC-3) | Plant a broken function in `.claude/hooks/drift-detect.cjs` in probe copy; `wrxn ci` | `✗ node-check` names the file; exit 2 |
| P4 | Never-vacuous: WRXN_TEST_CMD=true does NOT bypass universal checks (AC-4) | Set `WRXN_TEST_CMD=true` in env + plant a managed-integrity violation; `wrxn ci` | `wrxn-ci FAIL` exit 2 — universal checks still run and catch the violation |
| P5 | Workflow structural: triggers on PR, job named `wrxn-ci`, invokes `wrxn ci`, skips `WRXN_TEST_CMD=true` (AC-2, AC-5) | Parse + inspect `payload/.github/workflows/wrxn-ci.yml` | `on: pull_request`; job `wrxn-ci`; step runs `npx --yes @gcunharodrigues/wrxn ci`; test-step skips when `true`/empty |
| P6 | Workflow is a managed payload file — lands on `wrxn init` (AC-1) | Inspect manifest.json entry; verify file in install after `wrxn init` | `"class": "managed", "profile": "project"` in manifest; file byte-matches payload |
| E1 | Bad input: unknown command → clean error, non-zero exit | `node bin/wrxn.cjs notacommand` | Exit 2; usage printed; no stack trace |
| E2 | Empty state: `wrxn ci` in non-install dir → no crash | `wrxn ci --root /empty-dir` | No unhandled exception; structured failure (synapse-manifest absent) or graceful pass per check |
| E3 | Repeat-run / idempotency: same output on two consecutive runs | `wrxn ci --root <clean-install>` twice | Identical stdout both times |

---

## Execution and Evidence

### P1 — CLI presence and self-description

```
$ node bin/wrxn.cjs --help | grep -A5 "wrxn ci"
  wrxn ci [--root <dir>]         run the universal CI checks over an install...
```

Exit: 0. Help text includes `wrxn ci` with a description of all 5 checks and the "never vacuous" doctrine.

**PASS**

---

### P2 — Clean install passes (exit 0)

Setup: `git init /tmp/wrxn-qa-walk-<pid>`, then `node bin/wrxn.cjs init --project --root <tmp>`. The workflow file was laid: `laid [managed] .github/workflows/wrxn-ci.yml` (106 files total, 0 unchanged, exit 0).

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-walk-<pid>
wrxn-ci (/tmp/wrxn-qa-walk-<pid>)
  ✓ managed-integrity — 88 managed file(s) checked
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci PASS
exit: 0
```

**PASS**

---

### P3a — managed-integrity fails on drifted managed file

Probe copy of clean install; appended `// DRIFTED` to `.claude/hooks/wiki-lint.cjs`.

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-managed
wrxn-ci (/tmp/wrxn-qa-probe-managed)
  ✗ managed-integrity — 88 managed file(s) checked
      - .claude/hooks/wiki-lint.cjs — drifted from the kernel-owned source
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

Offending file named. Exit 2.

**PASS**

---

### P3b — wiki-lint fails on malformed frontmatter

Probe copy; wrote `no frontmatter here\njust text\n` to `.wrxn/wiki/concepts/bad-page.md`.

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-wiki
wrxn-ci (/tmp/wrxn-qa-probe-wiki)
  ✓ managed-integrity — 88 managed file(s) checked
  ✗ wiki-lint — 1 malformed page(s)
      - concepts/bad-page.md — no frontmatter
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

Offending page named. Exit 2.

**PASS**

---

### P3c — synapse-manifest lint fails on ghost domain

Probe copy; appended `GHOSTDOMAIN_STATE=active\n` to `.synapse/manifest`.

Note: this also triggers managed-integrity (manifest is itself a managed file — correct behavior).

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-synapse
wrxn-ci (/tmp/wrxn-qa-probe-synapse)
  ✗ managed-integrity — 88 managed file(s) checked
      - .synapse/manifest — drifted from the kernel-owned source
  ✓ wiki-lint — wiki frontmatter clean
  ✗ synapse-manifest — 5 active domain(s) checked
      - GHOSTDOMAIN — active in the manifest but .synapse/ghostdomain is missing
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

Ghost domain named in synapse-manifest failure. Exit 2.

**PASS**

---

### P3d — json-validity fails on corrupt JSON receipt

Probe copy; overwrote `wrxn.install.json` with `{broken json}`.

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-json
wrxn-ci (/tmp/wrxn-qa-probe-json)
  ✗ managed-integrity — receipt corrupt
      - wrxn.install.json is unreadable: Expected property name or '}' in JSON...
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✗ json-validity — 4 json path(s) checked
      - wrxn.install.json — invalid JSON: Expected property name or '}' in JSON...
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

Both managed-integrity (receipt unreadable) and json-validity fire. File named in both. Exit 2.

**PASS**

---

### P3e — node-check fails on syntax error in managed .cjs

Probe copy; overwrote `.claude/hooks/drift-detect.cjs` with `function broken( {\n  // SYNTAX ERROR\n}\n`.

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-syntax
wrxn-ci (/tmp/wrxn-qa-probe-syntax)
  ✗ managed-integrity — 88 managed file(s) checked
      - .claude/hooks/drift-detect.cjs — drifted from the kernel-owned source
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✗ node-check — 16 .cjs file(s) parsed
      - .claude/hooks/drift-detect.cjs — /tmp/wrxn-qa-probe-syntax/.claude/hooks/drift-detect.cjs:4
wrxn-ci FAIL
exit: 2
```

Offending file and line named in node-check. Exit 2. (Also triggers managed-integrity — correct.)

**PASS**

---

### P4 — Never-vacuous: WRXN_TEST_CMD=true does not bypass universal checks

Probe copy of clean install with drifted wiki-lint.cjs; `WRXN_TEST_CMD=true` set in shell environment.

```
$ WRXN_TEST_CMD=true node bin/wrxn.cjs ci --root /tmp/wrxn-qa-probe-vacuous
wrxn-ci (/tmp/wrxn-qa-probe-vacuous)
  ✗ managed-integrity — 88 managed file(s) checked
      - .claude/hooks/wiki-lint.cjs — drifted from the kernel-owned source
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 16 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

`wrxn ci` ignores `WRXN_TEST_CMD` entirely (as designed — the workflow skips the test step but the `wrxn ci` step runs unconditionally). Universal checks fire and catch the violation.

**PASS**

---

### P5 — Workflow structural promises

Parsed `payload/.github/workflows/wrxn-ci.yml` with `python3 yaml.safe_load()`:

| Promise | Observed | Result |
|---------|----------|--------|
| `on: pull_request` trigger | `triggers: ['pull_request']` | PASS |
| Job named `wrxn-ci` | `jobs: ['wrxn-ci']` | PASS |
| Invokes `npx --yes @gcunharodrigues/wrxn ci` | `step run: npx --yes @gcunharodrigues/wrxn ci` | PASS |
| Skips WRXN_TEST_CMD when `true`/empty | `if [ -n "$WRXN_TEST_CMD" ] && [ "$WRXN_TEST_CMD" != "true" ]` | PASS |
| YAML is valid | `yaml.safe_load()` succeeded, exit 0 | PASS |

**PASS**

---

### P6 — Workflow is a managed payload file, lands on init

Manifest entry: `{ "path": ".github/workflows/wrxn-ci.yml", "class": "managed", "profile": "project" }`.

Init output: `laid [managed] .github/workflows/wrxn-ci.yml`.

Byte-match: `diff /tmp/wrxn-qa-walk-<pid>/.github/workflows/wrxn-ci.yml payload/.github/workflows/wrxn-ci.yml` → identical.

**PASS**

---

### E1 — Bad input: unknown command

```
$ node bin/wrxn.cjs notacommand
wrxn: unknown command "notacommand"

wrxn — WRXN Kernel installer
...
exit: 2
```

Clean error message, no stack trace, exit 2.

**PASS**

---

### E2 — Empty state: ci in non-install directory

```
$ node bin/wrxn.cjs ci --root /tmp/wrxn-qa-empty-<pid>
wrxn-ci (/tmp/wrxn-qa-empty-<pid>)
  ✓ managed-integrity — no wrxn.install.json — not a wrxn install, nothing to verify
  ✓ wiki-lint — wiki frontmatter clean
  ✗ synapse-manifest — no manifest
      - .synapse/manifest is absent or unreadable
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 0 .cjs file(s) parsed
wrxn-ci FAIL
exit: 2
```

No crash. Structured output per check. `managed-integrity` correctly passes ("not a wrxn install").
`synapse-manifest` fails with a clear message.

Note: there is a minor behavioral inconsistency — `managed-integrity` is designed to pass gracefully when no install receipt is present, but `synapse-manifest` fails when no manifest is present. Both behaviors are individually defensible, but the asymmetry means "run wrxn ci before wrxn init" exits non-zero. This is an edge case (the workflow only lands in installs), but documented here for completeness. Not a filed finding — the ACs do not specify non-install behavior and the check results are structurally correct.

**PASS** (no crash; per-check behavior is as expected given the assertions made in the code)

---

### E3 — Repeat-run / idempotency

Run `wrxn ci --root <clean-install>` twice; compared stdout strings in shell. Output was identical both times.

**PASS**

---

### AC-6 — Suite coverage (not walked)

AC-6 ("coverage does not decrease; suite green") is a unit-test gate, not a functional behavior the artifact exposes to the CLI user. Per QA-walk doctrine, unit test re-runs are not part of a walk. Evidence from the commit message ("26 new tests; suite 652/652 green") and the existence of `test/ci-checks.test.cjs` (268 lines) is noted but not re-executed. AC-6 is marked UNWALKABLE (unit test suite gate — deferred to the builder's TDD gate).

**UNWALKABLE — see note above**

---

## Verdict

**PASS**

Walk coverage: 6 ACs (5 fully walked, 1 unwalkable-by-doctrine), all PRD stories relevant to this slice (stories 4 and 5), 13 planned commands executed, 3 edge probes executed.

| Behavior | Result |
|----------|--------|
| P1 — CLI exists and self-describes | PASS |
| P2 — Clean install exits 0, all checks ✓ | PASS |
| P3a — managed-integrity fails on drift | PASS |
| P3b — wiki-lint fails on bad frontmatter | PASS |
| P3c — synapse-manifest fails on ghost domain | PASS |
| P3d — json-validity fails on corrupt JSON | PASS |
| P3e — node-check fails on syntax error | PASS |
| P4 — Never-vacuous: WRXN_TEST_CMD=true ignored | PASS |
| P5 — YAML structural: PR trigger, job name, wrxn ci step | PASS |
| P6 — Managed payload, lands on init, byte-match | PASS |
| E1 — Bad input: clean error, exit 2 | PASS |
| E2 — Empty state: no crash, structured output | PASS |
| E3 — Repeat-run: identical output | PASS |
| AC-6 — Suite green (unit test re-run) | UNWALKABLE |

**0 findings filed.** Every promised behavior delivered at the CLI layer.

Deferred to the bootstrap self-host walk (per PRD "Honest limit"): GitHub ruleset enforcement, auto-merge triggering on green CI, and CD publish-on-merge are server-side behaviors that require a live GitHub environment and are not walkable here.
