# Review — slice 01: Universal CI workflow (`gate-01`)

- **Commit:** `a0addfe` on `gate-redesign` (`git diff e6b82b0..a0addfe`)
- **Reviewer:** reviewer executor (fresh-eyes)
- **Suite at review:** `node --test` 652/652 green (+26 new); coverage up, not down.

## Verdict: APPROVE-WITH-FINDINGS

0 blocking, 4 non-blocking. All six issue-01 ACs met; the gate fails **closed**; the two
builder-flagged decisions (`.mcp.json` exemption, version-float) are sound-and-bounded / real-but-deferrable
respectively.

## Blocking findings

None.

## Non-blocking findings

1. **Version-float vs. the version the install was laid with** — `payload/.github/workflows/wrxn-ci.yml:42`
   (`npx --yes @gcunharodrigues/wrxn ci`). `managedIntegrity` byte-compares the install's managed files
   against `pkgRoot/payload/...` where `pkgRoot` is the **latest published** kernel, not the version that
   laid the files. On any skew (install behind/ahead of `latest`) the gate goes red with **zero operator
   tampering** — it conflates "stale install" with "tampered install." It fails **closed** (safe) and no AC
   pins a version, so it is deferrable, but it should be closed in `gate-02`/bootstrap. *Required fix (later
   slice):* pin to the receipt's recorded `kernelVersion` — `npx @gcunharodrigues/wrxn@<version> ci` — so the
   check verifies "matches the version it claims," the correct tamper semantics. Also note the bootstrap
   chicken-and-egg: published `latest` is `0.10.0`, which has **no `ci` subcommand**, so this workflow is
   inert/failing until `0.11.0` publishes — exactly the documented land→self-host→publish→propagate order.

2. **`.mcp.json` integrity blind spot** — `lib/ci-checks.cjs:45` (`f.path !== MCP_PATH`). The exemption is
   **correct and tightly bounded**: `.mcp.json` is provably the *only* merge-managed file (`mergeMcpServer`
   is invoked only for `MCP_PATH`, and only on a brownfield collision), and the receipt records no
   laid-vs-merged flag per file (entries are just `{path, class}`), so a blanket skip is the only
   simple-correct option. Consequence: **semantic** tampering of `.mcp.json` (e.g. repointing the
   `recon-wrxn` server `command` at a malicious binary) is invisible to byte-drift — only `jsonValidity`
   (parses-OK) covers it. Not a regression: the old `enforce-managed-guard.cjs` is an edit-time PreToolUse
   gate that never caught out-of-band edits either. *Future hardening:* a merge-aware sub-check that asserts
   the `recon-wrxn` key matches canonical while allowing other operator servers.

3. **`wikiLint` swallows a per-file read error** — `lib/ci-checks.cjs:96-100`. A wiki page that throws on
   `readFileSync` is `continue`-skipped (fail-open at the page level) rather than recorded as a failure —
   the one predicate that swallows an error instead of surfacing it (managed/json/synapse all fail on an
   unreadable target). The aggregate still fails **closed** on a true crash (see scrutiny #4), and an
   unreadable file in a CI checkout is unlikely, so this is minor. *Optional:* push the read failure into
   `failures` for consistency.

4. **Universal checks no-op on a non-install repo** (observation, `lib/ci-checks.cjs` `runChecks`). In a repo
   that is not a `wrxn` install (no receipt; payload lives under `payload/<path>`, not at root — the kernel
   itself, and `recon-wrxn` in `gate-06`), `managedIntegrity` no-ops to pass and `json`/`node-check` find
   nothing at root, so "never vacuous" rests entirely on that repo having a real `WRXN_TEST_CMD`. True for
   the kernel (`node --test`); carry it into `gate-06` so `recon-wrxn`'s `wrxn-ci` isn't a vacuous pass.
   Not a slice-01 defect — the slice targets installs.

## AC checklist (issue 01)

- **AC1 — `wrxn-ci.yml` is a managed payload file (manifest; lands on init/update):** MET. `manifest.json`
  adds `{path:.github/workflows/wrxn-ci.yml, class:managed, profile:project}`; test
  `wrxn-ci.yml is a managed/project payload file…` asserts the entry and that `init` lays it.
- **AC2 — on `pull_request`, a `wrxn-ci` check aggregating WRXN_TEST_CMD (real-only) + the 5 universal
  checks:** MET. Workflow: `on: pull_request`, job `wrxn-ci`, step 1 runs `WRXN_TEST_CMD` (skips `true`/empty),
  step 2 runs `npx … ci` → `runChecks` = managed-integrity + wiki-lint + synapse-manifest + json-validity +
  node-check.
- **AC3 — universal checks are pure functions, unit-tested, each fails on a planted violation and passes
  clean:** MET. Five pure predicates; clean-pass + planted-fail tests for each, plus a `runChecks` aggregate
  (clean green; single-violation red).
- **AC4 — never vacuous (`WRXN_TEST_CMD=true` still runs/can-fail the universal checks):** MET. Workflow
  always runs `npx … ci` after skipping the `true` stub; test `runChecks fails (never vacuous)…` proves the
  universal checks fail independently of any suite. (Caveat: non-vacuous only for repos that ARE installs —
  finding 4.)
- **AC5 — valid YAML that invokes the node check scripts (structural test):** MET. Structural tests: no hard
  tabs, `name`/`on`/`jobs` anchors, `pull_request`, job `wrxn-ci`, invokes `wrxn ci`, skips the `true` stub.
  No real YAML parser (no `js-yaml` in-kernel) — matches the stated prior art `test/settings-hook-paths.test.cjs`.
- **AC6 — coverage does not decrease; suite green:** MET. 652/652, +26 tests, new file.

## Scrutiny verdicts

1. **`.mcp.json` exempted from managed-integrity — correct & bounded?** YES. Single named-path exemption;
   `.mcp.json` is the only merge-managed file (verified) and the receipt has no laid-vs-merged distinction, so
   a blanket skip is the only simple-correct option. The residual blind spot is inherent to merge semantics,
   not a regression (finding 2).
2. **`npx … ci` floats to latest — right payload version / correctness hole?** REAL gap but **fails closed**
   and unpinned by any AC → legitimately deferrable to `gate-02`/bootstrap (the self-host walk will surface
   it). Recommend the receipt-version pin (finding 1). NOT a slice-01 blocker.
3. **Test-cmd skip in YAML, not `wrxn ci` — faithful or a gap?** FAITHFUL. The `wrxn-ci` *job* aggregates
   test-cmd (step 1) + universal checks (step 2); the test-cmd is inherently a CI-runner concern (reads
   `vars.WRXN_TEST_CMD`, `eval`s operator-controlled shell) and is structurally asserted. Matches PRD +
   testing-decisions. Not a gap.
4. **Predicates fail closed?** YES. Each predicate returns failures or throws; the `bin/wrxn.cjs` entrypoint
   rejection handler (`(err) => … process.exit(1)`) turns any thrown exception into a non-zero exit → CI red.
   Receipt/manifest/json/synapse all fail on unreadable inputs. Only `wikiLint`'s per-file read swallow
   (finding 3) is fail-open, and it does not change the closed-on-crash property. PASS.
