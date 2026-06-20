# Code review — auto-memory-05 (migration 007 + handoff/`_slots` removals)

**Verdict: APPROVE-WITH-FINDINGS** — 1 BLOCKING (operative synapse handoff directive names a
now-deleted skill, contradicts AC1) + 3 non-blocking. Fold the blocking text fix into this slice/epic
before release; the rest are follow-ups.

**Slice:** `acceptance/auto-memory/issues/05-migration-removals.md` (6 ACs)
**PRD:** `acceptance/auto-memory/PRD.md`
**Diff reviewed:** commit `b82343a` atop slice-04 `cd3560c`, branch `auto-memory`
**Repo:** `/home/guilherme/Documents/_projects/wrxn-kernel`
**Reference mirrored:** `migrations/004-retire-session-capture.cjs` + `test/retire-session-capture-migration.test.cjs`
**Suite:** ran `npm test` → **871/871 pass, 0 fail** (matches the +7 claim, 864→871)
**Pushed:** false (reviewer never pushes)

---

## AC verification (every claim checked against the sources)

| AC | Verdict | Evidence |
|----|---------|----------|
| **AC1** payload drops `handoff` skill; manifest updated; synth = documented sole baton writer | **PARTIAL → see BLOCKING F1** | `payload/.claude/skills/handoff/SKILL.md` deleted; `manifest.json` entry removed; `memory-synth.cjs:472` is the atomic single baton writer and no other payload path writes `latest.md`. **But** the *documented* baton writer at the operative runtime surface (`synapse-engine.cjs:290`) still names the deleted handoff skill — AC1's "documented sole baton writer" is not fully met. |
| **AC2** `set-focus` removed; dream-skill focus section removed; no remaining `_slots` references in the payload | **MET (see judgment)** | `runSetFocus`, `wikiForceWritePage`, `FOCUS_TIER/SLUG`, the `--force`/`OVERWRITABLE_*` path, and the "Refreshing the focus slot" section are all gone. Surviving `_slots` mentions are load-bearing/correct — judgment below. |
| **AC3** migration removes handoff skill, wires SessionEnd, seeds config-if-absent, removes `_slots/current-focus.md` | **MET** | `007.up()` steps 1–4 do exactly this; verified line-by-line vs 004's pattern. |
| **AC4** migration idempotent; never throws on a clean install; runs via `wrxn update` | **MET** | Every step existence-guarded + best-effort; corrupt settings left untouched; idempotent wiring scan; e2e through `update()` records `007` + resumable. Tests (b)(c)(d)(e) + e2e all green. |
| **AC5** version bumped so migration version ≤ package version (no-inert invariant); `feat` minor | **MET** | `package.json` 0.11.0→0.12.0; migration `version:'0.12.0'` == package `0.12.0`; all 7 migrations ≤ 0.12.0; commit is `feat(memory):`. |
| **AC6** tests mirror the 004 test (isolation `up()` + e2e); managed-integrity / wiring tests updated | **MET** | `test/auto-memory-migration.test.cjs` mirrors 004 faithfully (metadata, per-step isolation, idempotency, clean/bare/corrupt no-throw, idempotent-wiring, e2e + receipt + resumable). dream/wiki/skills-payload reconciliations are faithful supersessions (below). |

---

## SCRUTINY POINTS (as briefed)

### 1. Migration 007 correctness + safety — SOUND
- Mirrors 004's defensiveness exactly: every step existence-guarded, `force:true` rm of an absent
  path is a no-op, a missing/clean/bare target is a no-op, a **corrupt `settings.json` is parsed in a
  try/catch and left byte-for-byte untouched** while the settings-independent steps still run
  (test (e) proves it).
- **No-inert invariant holds:** migration `version 0.12.0` ≤ `package.json 0.12.0` (equal). ✓
- **Idempotent SessionEnd wiring vs `lib/update.cjs` managed-overwrite — verified safe.**
  `lib/update.cjs:86` runs migrations **after** the managed file overwrite (`settings.json` is plain
  `managed`, always overwritten with the payload version, which already wires SessionEnd). `007`'s
  `wireSessionEndSpawn` then scans the whole config for `memory-synth-spawn.cjs` and **no-ops if
  already wired** → no double-wire. The e2e test asserts exactly-once after `update()` (`:293`) and
  the idempotent-wiring isolation test asserts exactly-once (`:213`). No clobber of a user-edited
  settings: the migration only *adds-if-absent*, never rewrites existing hooks.

### 2. Removal completeness vs orphan-safety — VERIFIED INDEPENDENTLY
- `recon_impact wikiForceWritePage` (upstream) → **1 direct caller: `runSetFocus`**, nothing else.
  Both are removed in this commit, so removing the `--force`/`_slots` write path orphans nothing.
- Repo-wide grep confirms **no production or migration code** depends on the `--force` wiki path
  (the only surviving `--force` hits are `worktree.cjs`/`bin` prune, unrelated).
- **`_slots` correctly RETAINED as an inert tier:** `TIERS` still lists `_slots` (`wiki.cjs:29`), so
  an existing install's `_slots/` dir keeps querying; migration step 4 removes only the
  `current-focus.md` *page*, leaving the tier dir + `.gitkeep` (test `:171` proves the gitkeep
  survives). Manifest still classifies `.wrxn/wiki/_slots/.gitkeep` as state.

### 3. AC2 "no remaining `_slots` references" — JUDGMENT: SATISFIED
A literal "zero `_slots` string occurrences" reading is **self-contradictory** with the deliberate
decision to retain `_slots` as a valid query tier: the `TIERS` array *must* list it for an existing
install's `_slots/` dir to keep working. So AC2 necessarily means "no remaining `_slots/current-focus`
*slot* support / no `set-focus`" — and under that reading the build is clean. The surviving payload
mentions are all correct/load-bearing, not stale plumbing:
- `wiki.cjs:29` `TIERS` entry + `:7,:19,:27-28` doc — the **live retained tier** (required by the
  retain decision).
- `dream.cjs:37-38` NOTE — accurately states `_slots` is **not** a knowledge-gate tier (a surviving
  invariant; a proposal targeting it is `unsupported_tier`, still tested at `dream.test.cjs:529`).
- `wiki-lint.cjs:18`, `harvest/SKILL.md:196` — exclusion notes documenting `_slots` is **out** of the
  human-prose/curation gates (an invariant that survives the focus-slot retirement).

None of these is a stale focus-slot reference. **AC2 met.**

### 4. Deviation #2 (synapse handoff directive) — SEVERITY: BLOCKING-for-epic → see F1
See finding F1. This is the one finding that should be folded now.

### 5. Test reconciliations — FAITHFUL SUPERSESSION, no regression masking
- **`dream.test.cjs`**: the entire set-focus suite (create/update-in-place, audit, the
  lone-updatable invariant, continuity-doctrine disjointness, secret-scan, negative-filter) is
  replaced by one test asserting `set-focus` is no longer a subcommand (falls through to usage,
  **exit 2**, usage banner no longer advertises it, **no slot written**). The deleted tests asserted
  behavior that no longer exists — correct deletion, not masking. The `unsupported_tier` invariant
  for `_slots` is retained.
- **`wiki.test.cjs`**: the `--force` overwrite tests are *inverted* to assert the create-only
  invariant now holds for `_slots` too (`--force` → "already exists" refused, original preserved,
  second write did not land). The `_slots` tier remains a valid query tier (`:184`). The
  path-scoped `dream-qa-07` guard is correctly removed (the whole `--force` path is gone).
- **`skills-payload.test.cjs`**: `handoff` removed from `PIPELINE_SKILLS` **and** a new positive
  regression guard added (handoff absent from payload + manifest + fresh install). A strengthening.

---

## Findings

### F1 — BLOCKING — operative synapse handoff directive instructs the live session to run a deleted skill (contradicts AC1)
**Files (operative — fix now):**
- `payload/.claude/hooks/synapse-engine.cjs:290` — `'  2. Run the handoff skill to write the baton (a compact handoff document).'`
- `payload/.claude/skills/synapse/SKILL.md:65` and `:92`
- `payload/.claude/skills/synapse/references/brackets.md:33`
- `payload/.claude/skills/synapse/references/layers.md:82`

**Why this is blocking (not just stale prose):**
`synapse-engine.cjs:290` is a **UserPromptSubmit hook** that injects the `[HANDOFF REQUIRED]`
directive into the live agent context on **every prompt** once context crosses the handoff threshold
(default 40%). It is an **operative runtime instruction**, not a comment. After this release every
install that crosses the threshold will be told, mid-session, to *"Run the handoff skill to write the
baton"* — a skill this same commit deletes (payload + manifest) and migration 007 removes from every
existing install. The instruction is therefore both (a) **impossible to follow** (target removed) and
(b) **conceptually inverted by the epic's own thesis** — auto-memory's whole point (PRD §Solution) is
that the SessionEnd synth writes the baton **automatically**, making the manual skill obsolete. AC1 of
*this* issue requires "the synth is the **documented** sole baton writer"; the most operator-visible
"documentation" of who writes the baton is exactly this runtime directive, and it still names the
deleted skill. Shipping it leaves the release internally inconsistent at its most visible surface.
(No security/crash risk — it degrades to guidance the agent can't act on — which is why the slice-05
security review correctly scored it LOW from the *security* lens. From the PRD-contract lens it is a
genuine AC1 gap.)

**Concrete fix:** point the directive at the automatic SessionEnd synth instead of a manual skill,
e.g. replace step 2 with a statement that the baton is written **automatically on session end** by the
memory synth — so the directive reduces to: finish the request → `/clear` → resume on the
auto-written baton (optionally note dream consolidates automatically too). Apply the same edit to the
three doc mirrors (`SKILL.md:65,92`, `brackets.md:33`, `layers.md:82`) and update the SKILL "## Output
shape" example block (`SKILL.md:89-93`) so the documented sample matches the new directive.

### F2 — non-blocking — stale `handoff`-skill mentions in comments/taxonomy (defer)
**Files:** `payload/.claude/hooks/session-start.cjs:7` (code comment "single writer = the handoff
skill"), `payload/.claude/skills/compass/SKILL.md:90,101` (routing taxonomy lists `handoff`),
`payload/.claude/skills/memory/SKILL.md:49` (an example `recall` query string mentioning "handoff").
**Why non-blocking:** these are inert prose with no runtime or operator-facing directive effect — a
stale comment, a router category label, and an example string. They do not contradict an AC the way
F1 does. Recommend a follow-up doc sweep (update `session-start.cjs:7` to "single writer = the
memory synth"; decide whether the compass `cross-session` category should now read "auto-handoff /
continuity synth").

### F3 — non-blocking (nit) — migration step-2 comment slightly overstates the realistic case
**File:** `migrations/007-auto-memory-transition.cjs` step 2 comment (`the migration only backfills a
hand-edited one`).
**Observation:** `settings.json` is plain `managed`, so `wrxn update` **always** overwrites it with
the payload version (which already wires SessionEnd) — it is never "left alone". The only real case
the migration's settings step exercises is a **bare/absent** settings.json (left absent) or a
**corrupt** one (left untouched). The step is therefore correct belt-and-suspenders defense, but the
comment's "a hand-edited settings the managed overwrite left alone" describes a case the managed
overwrite never actually produces. Code is correct (test (a)/(e) cover the real cases); only the
comment is slightly aspirational. Optional one-line comment tweak.

### F4 — non-blocking (nit) — `dream.cjs:35-36` flags-doc still lists `--source` for `commit` after the focus removal
**File:** `payload/.wrxn/dream.cjs` header flags block.
**Observation:** the header doc is otherwise correctly updated to "Three subcommands"; just confirm
the `--source (check|commit only)` line and the surrounding NOTE read cleanly post-removal (they do —
`--source` is unrelated to set-focus). No change required unless a doc pass is already open; noted for
completeness, not a defect.

---

## Summary
The migration is the high-risk surface and it is **correct, defensive, idempotent, and faithfully
mirrors 004** — verified line-by-line and against the real `wrxn update` ordering (managed-overwrite
then migrate → no double-wire). Removals are **orphan-safe** (recon_impact confirmed `runSetFocus` was
the sole `wikiForceWritePage` caller) and `_slots` is correctly retained as an inert tier. Tests are
faithful supersessions, suite 871/871 green, no-inert invariant holds. The **one blocking issue** is
deviation #2: the operative synapse `[HANDOFF REQUIRED]` directive (`synapse-engine.cjs:290` + 3 doc
mirrors) still tells the live session to run the deleted handoff skill, which contradicts AC1's
"synth is the documented sole baton writer" and inverts the epic's thesis — a ~6-line text fix the
builder already enumerated. Fold it now; F2/F3/F4 are follow-ups.
