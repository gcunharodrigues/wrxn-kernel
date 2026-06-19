---
id: gate-redesign-09
title: "Full-suite EPIPE flake on update-protect stub-gh test (pre-existing from gate-02)"
created: 2026-06-19
status: open
labels: [needs-triage, bug]
---

## Parent

`acceptance/gate-redesign/issues/04-retire-pushgates-reconcile-doctrine.md` — AC-6:
"Coverage does not decrease; suite green (`node --test`)."

## What happened

**Promised:** `node --test` exits green (all tests pass).

**Observed:** `node --test` reports 758/759 pass, 1 fail:

```
not ok 711 - CLI: wrxn update surfaces protection APPLIED when origin is a github repo (MED-1; exit 0)
  error: 'an applied gate is not reported as skipped'
  actual: '...protection skipped: could not create the wrxn-main-gate ruleset on fake-owner/fake-repo
           (no exit (command not found?): EPIPE)...'
```

The test creates a stub `gh` shell script in a temp dir, prepends the dir to PATH, then runs
`wrxn update`. Under full parallel-suite load, the stub process gets EPIPE (its stdout pipe closes
before it can write its response), making `lib/protect.cjs` treat `gh` as unavailable and soft-skip.

The test passes in isolation (`node --test test/update-protect.test.cjs` → 5/5).

**Pre-existence:** At gate-05 HEAD (the commit immediately before gate-04), the suite had 3 failures.
Gate-04 reduced it to 1. The failing test was introduced in gate-02 and has been intermittently
flaking in the full-suite parallel run since then. Gate-04 is not the origin.

## Repro steps

```
$ cd <kernel-repo>
$ node --test 2>&1 | grep 'not ok'
not ok 711 - CLI: wrxn update surfaces protection APPLIED when origin is a github repo (MED-1; exit 0)

$ node --test test/update-protect.test.cjs 2>&1 | tail -5
# tests 5
# pass 5
# fail 0
```

## Evidence excerpt

From walk P8:
- Full suite: `# pass 758`, `# fail 1` (test 711)
- Isolation run of `test/update-protect.test.cjs`: 5/5 pass
- Confirmed pre-existing: gate-05 HEAD had 3 full-suite failures; gate-04 improved to 1
- Error in full suite: EPIPE on the stub `gh` pipe, causing protection to soft-skip

## Fix guidance

The failure is a test-isolation / concurrency issue, not a behavior regression. Options:
1. Make the stub more resilient to EPIPE (handle `SIGPIPE`/ignore write errors in the stub script).
2. Run the apply-path test serially (`{ concurrency: 1 }`) to avoid pipe contention.
3. Use a TCP stub or an in-process mock instead of a shell-script stub on PATH.

The underlying behavior (protection IS applied when a real `gh` is on PATH and responds) is correct
as confirmed by the isolated test run.

## Blocked by

None
