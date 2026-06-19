# Code review — gate-04 (retire push-gates + reconcile doctrine)

- **Slice:** `gate-04` — retire client-side push machinery + flip doctrine in lockstep (the coarse-on-purpose slice).
- **Commit reviewed:** `8071950` on `gate-redesign` (`git diff 73675bc..8071950`).
- **Reviewer:** fresh-eyes AFK `reviewer`. **Suite:** `npm test` → **759 pass / 0 fail / 0 skipped**.
- **Contracts:** issue `acceptance/gate-redesign/issues/04-…md`, `PRD.md`, ADR 0007 (choices 5 + 7), carry-forward CF-4 / CF-5.

## Verdict: APPROVE — no blocking findings

The kernel-controllable scope of the slice is fully and coherently delivered: the three client-side push
hooks are gone (disk + manifest + settings), the managed guards are genuinely de-fanged to advisory-only,
the live kernel doctrine (Constitution + `.synapse/*` + compass) is rewritten to PR+CI+auto-merge with a new
durable regression test, and CF-4/CF-5 land clean. The grep-clean holds for payload + doctrine. Three
non-blocking items below (one cross-repo AC component, two builder-declared deferrals) — all correctly
outside this slice's reach or AC scope, but they must be tracked so they are not lost.

## Blocking findings

**None.**

## Non-blocking findings

1. **AC-5 wiki-concept clause is satisfiable only in WRXN-OS, not the kernel — currently untracked.**
   AC-5 names `wrxn-git-push-authority-hook.md`. The kernel payload ships **empty** wiki tiers
   (`payload/.wrxn/wiki/concepts/.gitkeep`); the page does not exist in the kernel repo. It lives in the
   **WRXN-OS install** at `.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md` and still describes the OLD
   model in full (the confirmation-flag "how to authorize a push" steps, `WRXN_ACTIVE_AGENT` in
   `settings.local.json`), with `derived_from: .claude/hooks/enforce-push-authority.cjs` — a **now-deleted
   hook**, so the page is actively misleading. A kernel slice cannot touch a different repo's operator-owned
   wiki prose, so this is correctly out of `gate-04`'s reach — but it is **not** in the carry-forward
   "Bootstrap requirements." **Fix:** add a bootstrap/correction line — when WRXN-OS is updated last (per the
   PRD bootstrap), rewrite or retire that wiki page to the PR+CI+auto-merge model and drop the dead
   `derived_from`. Non-blocking on the kernel slice; must be tracked for the WRXN-OS step.

2. **(flag #7a) Seeded `.synapse/routing` rewrite reaches NEW installs only — no migration advances existing
   installs, unlike its own prior-gen precedent.** `.synapse/routing` is class `seeded` (manifest), so the
   gate-04 `ROUTING_RULE_0` rewrite never overwrites an existing install. The authoritative doctrine still
   reaches existing installs via the **managed** `constitution.md` + **managed** `.synapse/global`
   (`GLOBAL_RULE_0`/`_4`), and routing is the lower-tier L6 keyword echo — so this is a defensible deferral.
   The asymmetry worth noting: `gate-04` *relies on* migration `002` having fixed the **prior** seeded-routing
   staleness, yet introduces a **new** seeded-routing staleness with **no** equivalent migration. Existing
   installs that already ran `002` keep a `ROUTING_RULE_0` echo that still names `WRXN_ACTIVE_AGENT` /
   `settings.local.json` forever. **Fix (correction pass):** a migration mirroring `002`, gated on the stale
   marker (e.g. `includes('WRXN_ACTIVE_AGENT')`), advancing the line to the gate-04 model. Non-blocking.

3. **(flag #7b) Synapse skill docs still teach the OLD `GLOBAL_RULE_0` as an illustrative example.**
   `payload/.claude/skills/synapse/SKILL.md` (L45,77,81,85), `references/domains.md` (L25; L37 table:
   "devops-only push … the green-suite push gate"), `references/layers.md` (L67,71,75) reproduce the old
   "deliberate acts held behind a confirmation flag" wording as teaching snippets. These are **outside AC-5's
   enumerated `payload/.synapse/*` scope**, carry **no** `WRXN_ACTIVE_AGENT`/`settings.local.json` literal (so
   **no AC-4 grep-trip**), and are docs not live rules — acceptable deferral. But the example now **mismatches
   the live `.synapse/global` rule it documents**. **Fix (correction pass):** update the example to mirror the
   new rule (or make it obviously generic). Non-blocking.

4. **(informational) `bin/wrxn.cjs` retains two forward-looking `settings.local.json` references** (L146, L540,
   both for `wrxn protect`: "the hard gate that replaces the settings.local.json env-flag dance") — introduced
   in `gate-02`, not this diff. Same blessed forward-looking category as the `lib/ship.cjs` / `lib/protect.cjs`
   comments; `bin` is CLI code, not payload or doctrine, and the text is retrospective ("replaces"), not a live
   instruction. The slice correctly de-danced the `ship`-specific references it owned. No action required.

## AC checklist (issue-04 + CF-4 + CF-5)

- **AC-1 — 3 hooks deleted + removed from manifest:** ✅ MET. `enforce-push-authority` / `enforce-review-marker`
  / `enforce-tests-on-push` absent on disk; the 3 manifest entries removed (`-15` lines); commit deletes the
  files (`-52/-62/-40`). `wrxn update` will therefore remove them from installs.
- **AC-2 — settings.json no longer references deleted hooks + test asserts absence + remaining wiring intact:**
  ✅ MET. `PreToolUse:Bash` now lists only `enforce-managed-precommit`. New `settings-hook-paths.test.cjs` tests:
  the 3 retired hooks are unwired AND all 10 survivors (session-start, synapse-engine, reference-detect,
  recall-surface, enforce-managed-guard, enforce-managed-precommit, enforce-pipeline-adherence, code-intel-push,
  drift-detect, wiki-lint) remain wired — matches settings.json + disk + manifest exactly.
- **AC-3 — managed guards drop `WRXN_MANAGED_CONFIRM` + never block + advisory + tested at boundary:** ✅ MET.
  Both `enforce-managed-guard.cjs` + `enforce-managed-precommit.cjs` emit only `{}` or
  `hookSpecificOutput.additionalContext`; no `decision:'block'` path; no `WRXN_MANAGED_CONFIRM` read (only a
  retired-note comment, allowed). `hooks-managed.test.cjs` rewritten: "ADVISES (never blocks)" + "advises
  identically with/without the token" (`deepEqual` of both runs) for guard and precommit.
- **AC-4 — no payload/doctrine reference to `WRXN_ACTIVE_AGENT` / settings.local.json dance (grep-clean):**
  ✅ MET. `git grep` shows **zero** hits in `payload/` and the doctrine; remaining hits are forward-looking
  `lib/`+`bin/` comments and absence-asserting tests (`executor`, `gate-doctrine`, `agent-conformance`, `ship`).
- **AC-5 — Constitution Art I+III, `.synapse/*`, wiki concept on the new model, no surviving contradiction:**
  ⚠️ MET for the kernel-controllable scope; one cross-repo component deferred. Constitution Art. I (deliberate
  act = `wrxn ship` PR + auto-merge, "not a settings flag") + Art. III (server-enforced CI is the gate;
  review/security = AFK agents + CI, "not a self-written human-review marker") rewritten. `.synapse/global`
  (`GLOBAL_RULE_0`+`_4`), `.synapse/routing` (`ROUTING_RULE_0`), compass reviewer line corrected.
  `PIPELINE_RULE_5` (slice 07 adherence) preserved intact. New `gate-doctrine.test.cjs` locks all of it. The
  **wiki concept** is the only gap → non-blocking finding #1 (lives in WRXN-OS, not the kernel; track for the
  WRXN-OS update).
- **AC-6 — coverage does not decrease; suite green:** ✅ MET. See scrutiny #8.
- **CF-4 — `buildDispatchSpec('devops')` de-danced + pinning test flipped:** ✅ MET. `lib/executor.cjs` devops
  instructions now promote via `wrxn ship`; `executor.test.cjs` flipped to `doesNotMatch` WRXN_ACTIVE_AGENT /
  settings.local.json / AIOX_ACTIVE_AGENT and `match` `wrxn ship`, asserting `spec.executor==='devops'` +
  push constraints retained.
- **CF-5 — `devops.md` tools → `Read, Bash`:** ✅ MET. Frontmatter `tools: Read, Bash` (Edit/Write removed);
  body promotes via `wrxn ship` only (no settings.local.json edit). Pre-existing `agent-conformance.test.cjs`
  still green.

## Scrutiny-point verdicts

1. **Deletions + wiring — PASS.** 3 hooks gone (disk+manifest+settings). All 10 survivors wired+present+manifested.
   No dangling reference (only hit repo-wide is the absence-asserting `RETIRED_PUSH_HOOKS` array).
2. **Demoted guards never block — PASS.** Code path emits only `{}`/advisory; no block, no token read. Tests assert it.
3. **No surviving contradiction in doctrine — PASS (kernel payload).** Constitution + `.synapse/{global,routing}`
   on the new model; `PIPELINE_RULE_5` survived; compass corrected; `gate-doctrine.test.cjs` guards it. Caveat:
   synapse *skill docs* still show the old rule as an example (non-blocking #3, outside AC-5 scope, no grep-trip).
4. **CF-4 / CF-5 — PASS.** Dispatch spec + pinning test flipped to `wrxn ship`; devops.md tools tightened.
5. **grep-clean — PASS.** Zero payload/doctrine hits; only blessed forward-looking `lib/`+`bin/` comments +
   absence-asserting tests remain (info note #4 on the two `bin/`/`wrxn protect` references from gate-02).
6. **Migration-002 oracle — PASS.** `migrations/` untouched → `002` byte-identical/immutable. The
   seeded-honesty test repoints `HONEST_ROUTING_LINE` to `002`'s OWN frozen constant via
   `realMigrationBody().match(/'(ROUTING_RULE_0=[^']*)'/)` — sound (the frozen string has no inner quote; the
   `HONEST_ROUTING_RULE_0` constant precedes the `startsWith('ROUTING_RULE_0=')` literal, so `.match` captures
   the full line). `002` gates on `includes('devops role')`; the new gate-04 seed lacks that marker → **no
   mis-fire / no clobber** of a fresh install, and the e2e stale-0.2.0→honest-0.2.1 path still proves out.
7. **The two deferred flags — both NON-BLOCKING (see findings #2 + #3).** (a) seeded-routing reaches new installs
   only: defensible (managed constitution+global carry the authoritative doctrine to existing installs) but
   asymmetric vs `002`'s precedent → recommend a marker-gated migration. (b) synapse skill examples: outside
   AC-5's `payload/.synapse/*` scope + no grep-trip → acceptable, but mismatches the live rule → correction pass.
8. **Coverage — PASS.** Top-level `test()` 702→697 (**-5**) = **-11** (`hooks-boundary.test.cjs`, all 11 testing
   the 3 DELETED hooks) **+4** (`gate-doctrine`) **+2** (`settings-hook-paths`). No surviving-code coverage lost;
   the demoted guards KEPT their tests (rewritten to the advisory contract, same count). Suite 759/759 green.
