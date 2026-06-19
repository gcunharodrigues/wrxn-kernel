# Review — gate-02 · `wrxn protect` ruleset auto-apply + migration 005

- **Slice:** gate-02 (server-side hard gate) · build commit `e40721e` on `gate-redesign` (parent `a4f30fe`)
- **Reviewer:** fresh-eyes code review (read-only on code; this marker is the only write)
- **Suite:** `npm test` → **721/721 pass** (+36 over the slice), 0 fail, 0 skipped
- **Sources verified against:** issue `02-protect-ruleset-autoapply.md`, `PRD.md`, ADR `0007`, `carry-forward.md` (CF-1/CF-2), the authoritative ruleset contract quoted in `test/protect.test.cjs`

## Verdict: APPROVE — no blocking findings

All six issue-02 ACs met, both owned carry-forwards (CF-1, CF-2) folded and verified, suite green, scope clean (every changed line traces to the slice). Four non-blocking notes below; none block the slice.

## Blocking findings

**None.** No contract violation, no payload-fidelity gap, no fail-soft/idempotency defect, no coverage regression.

## Non-blocking findings

1. **NB1 — standalone `wrxn protect` exits 0 on a *hard* inability, not only the no-remote no-op** (`bin/wrxn.cjs:526`).
   The CLI always `return 0`, so `not admin` / `gh unauthenticated` print "skipped" yet exit success — a script like
   `wrxn protect && …` reads a failed explicit request as done. **Ruling on the builder's flagged question:** this is
   *AC-conformant* (AC-2 literally specifies `no gh / not admin / no remote → exit 0`), so it is **not** a defect. But
   the fail-soft *rationale* ("never break `wrxn update`") is already fully satisfied by `update`'s own try/catch
   (`lib/update.cjs:92-100`) + `applyProtection`'s never-throw — verified: the `update` CLI exits 2 only on a *thrown*
   error (`bin/wrxn.cjs` update block), and a soft-skip never throws. So `update` safety does **not** depend on the
   standalone exit code. **Recommendation (optional):** distinguish the *non-applicable* no-remote no-op (exit 0) from
   an *explicit-request hard failure* (not-admin/unauth → exit non-zero) for the standalone CLI, leaving `update` soft.
   Strictly better scriptability at zero risk to `update`. Non-blocking.

2. **NB2 — CF-2 residual: the receipt `profile` is still trusted for the *missing-file* check** (`lib/ci-checks.cjs:62-71`).
   CF-2 correctly closes the *present-file* hole (a present managed file is byte-checked regardless of profile). But the
   profile (read from the unprotected receipt) still gates the *missing-file* check, so flipping `workspace→project` can
   suppress detection of a **deleted** workspace-only managed file on a workspace install. Bounded & fails safe: all
   security-critical managed files (constitution, hooks, synapse) are `profile: project` (`inProfile('project', *) =
   true`), so they are *always* checked for both drift and deletion; the residual touches only workspace-only skills/docs,
   and present-file drift — the more dangerous case — is always caught. The code comment is honest about this scope
   ("can only EXCLUDE a missing-file check — it can never suppress a present, drifted file"). Note for the fork-PR threat
   model; not blocking.

3. **NB3 — redundant double-application on the single `0.10.0→0.11.0` update** (`lib/update.cjs:88-100` + `migrations/005`).
   On the one update that crosses 0.11.0, migration 005 applies protection (real invokers) *and* `update`'s own protect
   step applies it again. Both are idempotent (005 creates → update PUTs in place), so it is harmless — one extra `gh`
   round-trip on that single update only. Informational.

4. **NB4 — ruleset matched by name; GitHub permits duplicate-named rulesets** (`lib/protect.cjs:119`).
   `applyProtection` finds the existing ruleset by `name === 'wrxn-main-gate'`. The module is the sole writer and always
   finds-before-create, so it can never create a duplicate itself; a *manually* pre-created duplicate would be
   reconciled non-deterministically (`find` returns the first). Won't-happen-in-practice. Informational only.

## AC checklist (issue-02)

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 `buildRulesetSpec()` pure, returns the payload, unit-tested for shape | **MET** | `lib/protect.cjs:36-65` (fresh independent object each call, no side effects); shape pinned `test/protect.test.cjs:54-103`; purity/no-shared-mutation `:90-98` |
| AC-2 `applyProtection({invoker})` idempotent + fail-soft, proven with a fake invoker | **MET** | `lib/protect.cjs:101-135` (list→PUT-if-present/POST-if-absent; every failure→`softSkip`, never throws); idempotent re-run `test/protect.test.cjs:146-154`; fail-soft no-remote/no-gh/not-admin/unparseable `:156-196` |
| AC-3 `wrxn protect` CLI applies to origin + prints the outcome | **MET** | `bin/wrxn.cjs:519-528`; no-remote skip prints + exits 0 `test/protect.test.cjs:292-300` |
| AC-4 `wrxn update` invokes `applyProtection` idempotently; already-protected update = no-op | **MET** | `lib/update.cjs:88-100` (try/catch, injectable invokers, returns `protection`); created/idempotent-PUT/no-duplicate-POST `test/update-protect.test.cjs:51-77` |
| AC-5 Migration 005 `{id:'005',version:'0.11.0',up}` defensive/idempotent like 003, runner contract, no-remote no-op | **MET** | `migrations/005-protect-main-gate.cjs` (try/catch swallow, delegates to idempotent `protectOrigin`); metadata + delegation + no-remote-no-op + e2e recorded/resumable `test/protect-main-gate-migration.test.cjs:50-100` |
| AC-6 Coverage does not decrease; suite green (`node --test`) | **MET** | 721/721 pass; +36 tests added by the slice (protect 30, update-protect 3, migration 3, ci-checks CF-1/CF-2) |

### Carry-forwards owned by gate-02

| CF | Status | Evidence |
|----|--------|----------|
| CF-1 — pin `wrxn ci` to the receipt `kernelVersion`, `latest` fallback for receipt-less repos | **MET** | `payload/.github/workflows/wrxn-ci.yml:46-54` (`VER=$(node -p require('./wrxn.install.json').kernelVersion…)`; pins `@gcunharodrigues/wrxn@"$VER"`, else `latest`); valid YAML (no tabs, structural anchors pass); asserted `test/ci-checks.test.cjs:285-292` |
| CF-2 — anchor the managed SET to `manifest.json`, trust the receipt only for profile, byte-match present files regardless of profile | **MET** | `lib/ci-checks.cjs:49-78` (set from `manifest.files`; `profile` only excludes a *missing* check; present file always byte-compared); drop-receipt-entry can't hide drift `test/ci-checks.test.cjs:74-87`; flip-profile can't hide a present drifted file `:89-103`; slice-01 clean/drift/delete/mcp/no-receipt tests still green `:34-72` |

## Scrutiny-point verdicts (1–8)

1. **Ruleset payload fidelity — PASS.** Every authoritative field matches: name `wrxn-main-gate`, `target:'branch'`,
   `enforcement:'active'`, `bypass_actors:[]`, `conditions.ref_name.include:['~DEFAULT_BRANCH']`, `pull_request` with
   `required_approving_review_count:0`, `required_status_checks` context `wrxn-ci` + `strict_required_status_checks_policy:true`
   (`lib/protect.cjs:36-65`). Additions — `deletion`, `non_fast_forward`, and the four explicit-`false` PR params — only
   *strengthen/fully-specify* (block main deletion + force-push; pin GitHub defaults for deterministic idempotent PUTs)
   and **do not weaken or alter** the gated enforcement; `non_fast_forward` blocks force-push, not normal PR merge.
   Tested `:84-88`.

2. **Idempotency — PASS.** list → `find(name==='wrxn-main-gate')` → PUT existing id / POST if absent; re-run sends the
   identical body via PUT-in-place → genuine no-op. Verified `test/protect.test.cjs:146-154`, `test/update-protect.test.cjs:65-77`.

3. **Fail-soft — PASS (with NB1 ruling).** Every failure path returns `softSkip` (`lib/protect.cjs:104,110,116,126,131`);
   no-remote skips *without* calling gh (`:104-106`, test `:156-164`); never throws. `update` + migration both add a
   belt-and-braces try/catch. The standalone-CLI hard-failure exit code is AC-conformant at exit 0 → see **NB1** (optional
   improvement, not a blocker).

4. **`update` integration — PASS.** `protectOrigin` called once, after lay+migrations, in try/catch; returns `protection`
   in the report; remote-less update soft-skips and still succeeds; no throw, no double-apply within a single `update`
   call (`lib/update.cjs:88-100`; tests `test/update-protect.test.cjs:38-77`). (Cross-update redundancy with 005 → NB3,
   harmless.)

5. **Migration 005 — PASS.** Metadata `{id:'005',version:'0.11.0',up}`; defensive/idempotent mirroring 003; no-remote =
   pure no-op (real git → null slug → soft-skip, writes nothing — `test:68-76`); runner contract honored (`up(ctx)` uses
   `ctx.target`; recorded + resumable — `test:80-100`). The `require('../lib/protect.cjs')` sibling import **resolves in
   the published layout**: `package.json` `files` ships both `lib` and `migrations`; the runner `require`s the migration
   by absolute path so `../lib` resolves to the package root; the test's `fakePkg` copies `lib/` to faithfully simulate,
   and the e2e test exercises that path green. **Sound.**

6. **CF-1 folded — PASS.** Reads `wrxn.install.json` `kernelVersion`, pins `npx …@"$VER" ci`, falls back to `latest`
   for receipt-less repos (e.g. recon-wrxn). Valid YAML (literal block scalar, consistent indentation, no tabs), correct
   shell logic (`2>/dev/null || true` degrades a missing/corrupt receipt to `latest`; corrupt receipt independently
   caught by the `json-validity` universal check). `payload/.github/workflows/wrxn-ci.yml:46-54`.

7. **CF-2 folded — PASS (residual NB2).** Managed set anchored to `manifest.json` (source of truth); receipt trusted
   only for `profile`; a present managed file is byte-matched **regardless** of profile → closes MED-1 (drop/reclassify
   a receipt entry can no longer hide drift, and a flipped profile cannot hide a present drifted file). Slice-01 tests
   stay green. Residual (profile still gates the *missing*-file check for workspace-only files) → **NB2**, bounded and
   fail-safe.

8. **package.json `0.10.0→0.11.0` — PASS, genuinely required, not scope creep.** The migration runner gates pending on
   `compareVersions(toVersion, m.version) >= 0` (`lib/migrate.cjs:57-59`); with the package left at 0.10.0, migration
   005 (`version:'0.11.0'`) would **never fire** → inert, violating the no-inert-migration invariant. The bump is the
   activation condition. Value is correct and consistent (ADR/PRD/migration/update all name 0.11.0) and a minor bump is
   right for an additive feature with no breaking CLI change.

## Scope check

Diff touches only: `lib/protect.cjs` (new), `bin/wrxn.cjs` (protect command + help), `lib/update.cjs` (protect wiring),
`migrations/005` (new), `package.json` (bump), `lib/ci-checks.cjs` (CF-2), `payload/.github/workflows/wrxn-ci.yml` (CF-1),
+4 test files. CF-1/CF-2 are exactly the two carry-forwards `carry-forward.md` assigns to gate-02; CF-3..CF-6 (gate-04)
untouched. No scope creep.
