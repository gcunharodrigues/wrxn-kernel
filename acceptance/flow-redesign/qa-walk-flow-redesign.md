# QA-Walk Report — flow-redesign

**Date:** 2026-06-18
**Branch:** `integration/flow-redesign`
**Entry point:** `node bin/wrxn.cjs` (kernel root: `/home/guilherme/Documents/_projects/wrxn-kernel`)
**Batch dir:** `.scratch/flow-redesign/`
**Context note:** This walk runs as an isolated qa-walker executor in fresh context (not the builder's context).

---

## Walk plan

Derived from `.scratch/flow-redesign/PRD.md` user stories and `.scratch/flow-redesign/issues/01–07`.
This is an operator-mode whole-artifact walk — all PRD stories and all issue ACs checked.

| # | Behavior (promise) | Command(s) | Expected |
|---|---|---|---|
| P1 | `wrxn flow status <prd>` prints a per-slice gate board | `node bin/wrxn.cjs flow status flow-redesign` | Per-slice rows with build/review/sec/qa gates, state column |
| P2 | No-arg `flow status` exits cleanly with an error | `node bin/wrxn.cjs flow status` | Exit 2, helpful error message, no crash |
| P3 | Non-existent prd slug fails gracefully | `node bin/wrxn.cjs flow status nonexistent-prd` | Exit 2, clear ENOENT-style error, no crash |
| P4 | Repeat-run idempotency for flow status | Run P1 twice | Identical output |
| P5 | Missing artifacts read as not-yet-done (never false pass) | Pure lib: `flowStatus([{id:'flow-01'}], {})` | All gates "pending", state "queued" |
| P6 | All gates present → done state | Pure lib with all artifact fields | All gates "done", state "done" |
| P7 | Build done, review absent → stalled | Pure lib with only `greenCommit` set | state "stalled" |
| P8 | Build+review done → in-progress | Pure lib with greenCommit + reviewMarker | state "in-progress" |
| P9 | compassCoverage passes for all installed skills | `lib/compass-coverage.cjs` against `payload/.claude/skills/` | ok=true, orphans=[] |
| P10 | compassCoverage reports a fake skill as orphan | Add synthetic skill to check | ok=false, orphans=['fake-skill'] |
| P11 | All 6 executor agent definitions exist and pass conformance | `lib/agent-conformance.cjs` for each agent | ok=true for all 6 |
| P12 | validateAgentFile rejects unknown type | `validateAgentFile(def, 'unknown-type')` | ok=false, errors mention unknown type |
| P13 | Only devops declares push capability | EXECUTORS registry canPush fields | All others false, devops true |
| P14 | Only devops encodes the push-gate dance | agent body text check | Other agents state they never push |
| P15 | pipeline domain injects four-phase flow doctrine | synapse engine test + content check | HITL/AFK/human qa-walk/correction pass all present |
| P16 | qa-walk SKILL.md has operator-mode section | Read `payload/.claude/skills/qa-walk/SKILL.md` | Operator-mode section, contrasts with agent walk |
| P17 | compass SKILL.md has frontmatter + static doctrine + live-read instruction | Read `payload/.claude/skills/compass/SKILL.md` | user-invocable + tight description + four-phase doctrine + bucket instruction |
| P18 | "create a skill" routes to write-a-skill only; skill-creator marked legacy | compass SKILL.md content check | write-a-skill named, skill-creator marked legacy |
| P19 | compass registered as managed payload | manifest.json check | entry present |
| P20 | All 6 agents registered as managed payload | manifest.json check | 6 agent entries present |
| P21 | No new mutable flow-state file introduced | git diff main…HEAD | Only code + payload + test files; no flow-state store |

Edge probes (three mandatory per command surface):

| # | Surface | Bad input | Empty state | Repeat-run |
|---|---|---|---|---|
| E1 | `wrxn flow status` | No prd arg (P2) | No issues dir (P3) | Identical output (P4) |
| E2 | `flowStatus` lib | N/A — pure function, no I/O to mis-invoke | Empty issues + artifacts → all queued (P5) | Deterministic (same input → same output; read-only) |
| E3 | `validateAgentFile` | Unknown type → explicit error (P12) | No-tools def → explicit error (tested in suite) | Same input → same output |
| E4 | `compassCoverage` | N/A — pure function | No skills → ok=true (empty list is vacuously routed) | Deterministic |

---

## Execution + evidence

### P1 — flow status prints per-slice board

```
$ node bin/wrxn.cjs flow status flow-redesign
flow-01          build✓ review· sec· qa·  queued
flow-02          build✓ review· sec· qa·  queued
flow-03          build✓ review· sec· qa·  queued
flow-04          build✓ review· sec· qa·  queued
flow-05          build✓ review· sec· qa·  queued
flow-06          build✓ review· sec· qa·  queued
flow-07          build· review· sec· qa·  queued
exit: 0
```

Slices 01–06 show `build✓` (confirmed by git log: commits `[flow-01]`…`[flow-06]` exist on the branch). Slice 07 shows `build·` (expected — issue 07 is explicitly deferred). Review/sec/qa pending (no artifact files present yet — this is the QA walk prior to those gates). **PASS**

### P2 — No-arg errors cleanly

```
$ node bin/wrxn.cjs flow status
wrxn: flow status requires <prd>
exit: 2
```

Clean error, no crash. **PASS**

### P3 — Non-existent prd slug fails gracefully

```
$ node bin/wrxn.cjs flow status nonexistent-prd
wrxn: cannot read issues from /…/wrxn-kernel/.scratch/nonexistent-prd/issues: ENOENT: …
exit: 2
```

Clean ENOENT message, no crash, no false board. **PASS**

### P4 — Repeat-run idempotency

Run P1 twice in sequence → output byte-identical. **PASS**

### P5 — Missing artifacts → not-yet-done

```js
flowStatus([{id:'flow-01',title:''}], {})
// → [{gates:{build:'pending',review:'pending',security:'pending',qa:'pending'}, state:'queued'}]
```

No false gate pass. **PASS**

### P6 — All artifacts present → done state

```js
flowStatus([{id:'flow-01',title:''}], {
  'flow-01': { greenCommit:'abc123', reviewMarker:'review.md', securityReport:'security.md', walkFindings:'walk.md' }
})
// → [{gates:{build:'done',review:'done',security:'done',qa:'done'}, state:'done'}]
```

**PASS**

### P7 — Build done, review absent → stalled

```js
flowStatus([{id:'flow-01',title:''}], {
  'flow-01': { greenCommit:'abc123', reviewMarker:'', securityReport:'', walkFindings:'' }
})
// → state:'stalled'
```

**PASS**

### P8 — Build+review done → in-progress

```js
flowStatus([{id:'flow-01',title:''}], {
  'flow-01': { greenCommit:'abc123', reviewMarker:'review.md', securityReport:'', walkFindings:'' }
})
// → state:'in-progress'
```

**PASS**

### P9 — compassCoverage passes for installed skills

```
$ node -e "…"
// skills: ["audit","compass","diagnose","dream","grill-me","grill-with-docs","handoff","harvest",
//   "improve-codebase-architecture","ingest","level-up","memory","onboard","prototype","qa-walk",
//   "resolving-merge-conflicts","setup-matt-pocock-skills","skill-creator","synapse","sync","tdd",
//   "tech-search","to-issues","to-prd","triage","write-a-skill","write-an-agent"]
// → {ok:true, orphans:[]}
```

Every installed skill is routed. **PASS**

### P10 — compassCoverage reports fake skill as orphan

```
// add 'fake-skill' to the list
// → {ok:false, orphans:['fake-skill']}
```

Drift-guard works. **PASS**

### P11 — All 6 agent definitions pass conformance

```
builder.md:    {ok:true, errors:[]}
devops.md:     {ok:true, errors:[]}
qa-walker.md:  {ok:true, errors:[]}
researcher.md: {ok:true, errors:[]}
reviewer.md:   {ok:true, errors:[]}
security.md:   {ok:true, errors:[]}
```

All 6 conform. **PASS**

### P12 — validateAgentFile rejects unknown type

```
validateAgentFile(def, 'unknown-type')
// → {ok:false, errors:["unknown executor type: unknown-type"]}
```

**PASS**

### P13 — Only devops declares push capability (canPush)

```
EXECUTORS.builder.canPush   = false
EXECUTORS.reviewer.canPush  = false
EXECUTORS.security.canPush  = false
EXECUTORS.qa-walker.canPush = false
EXECUTORS.researcher.canPush= false
EXECUTORS.devops.canPush    = true   ← sole push-capable executor
```

Suite test `least-privilege: only the devops executor declares push capability (canPush)`: ok 12. **PASS**

### P14 — Only devops encodes push-gate dance; others state they never push

devops.md: contains `WRXN_ACTIVE_AGENT`, `settings.local.json`, `set→push→unset` dance.
All others: each body contains "never push" / "Do not push" / "Do NOT run git push" language.
Suite test `only devops encodes the push-gate dance; the others state they never push`: ok 13. **PASS**

### P15 — Pipeline domain injects four-phase flow doctrine

`payload/.synapse/pipeline` content:
```
PIPELINE_RULE_0: …four-phase flow: HITL phase…AFK phase, per slice…human qa-walk…correction pass…single post-accept push to trunk
PIPELINE_RULE_1: …isolated typed executors (builder, reviewer, security, qa-walker, researcher, devops) — devops alone may promote the integration branch to trunk
PIPELINE_RULE_2: Scale the HITL phase to novelty…
PIPELINE_RULE_3: …code review and security review then run per slice inside the AFK phase, not batched after the build…
PIPELINE_RULE_4: …per-slice agent qa-walk…while the human qa-walk verifies the whole artifact…
```

Synapse engine test ok 6 (`the pipeline domain injects the four-phase flow doctrine within the default budget governor`): PASSES. All four phase names, gate order, review/security per slice, integration branch, trunk, novelty all present. **PASS**

### P16 — qa-walk SKILL.md has operator-mode section

`payload/.claude/skills/qa-walk/SKILL.md` contains:
- `### Operator mode — whole-artifact, story-level` (line 53)
- Explicitly contrasts with agent walk (table at lines 43–44)
- Findings auto-filed as tracker issues (line 62)

Suite tests (4/4): ok 1–4. **PASS**

### P17 — compass SKILL.md has frontmatter + static doctrine + live-read instruction

Frontmatter:
```yaml
name: compass
description: Router over the skills and the build flow — ask "which skill or flow fits…"
user-invocable: true
```

Body: four-phase doctrine section ("The build flow"), "Which executor owns each AFK step", "Live read (do this every invoke)", "Buckets" block.

**PARTIAL — FINDING F-01:** `model-invocable: true` is absent from frontmatter. The issue 04 AC requires "(user-invocable + model-invocable, tight description)". `user-invocable` is present; `model-invocable` is not. See finding `08-compass-missing-model-invocable.md`.

### P18 — "create a skill" routes to write-a-skill only; skill-creator marked legacy

```
compass/SKILL.md line 58:
"- **Create a skill** → **write-a-skill** only — `skill-creator` is **legacy** …"
```

Suite test ok 3. **PASS**

### P19 — compass registered as managed payload

```json
{"path":".claude/skills/compass/SKILL.md","class":"managed","profile":"project"}
```

**PASS**

### P20 — All 6 agents registered as managed payload

All 6 entries present in `manifest.json`. **PASS**

### P21 — No new mutable flow-state file introduced

`git diff main…HEAD --name-only` shows only:
- `bin/wrxn.cjs`, `lib/*.cjs`, `manifest.json`, `payload/.claude/agents/*.md`,
  `payload/.claude/skills/compass/SKILL.md`, `payload/.claude/skills/qa-walk/SKILL.md`,
  `payload/.synapse/pipeline`, `test/*.cjs`

No flow-state store. **PASS**

---

## AC-level coverage summary

### Issue 01 — Pipeline doctrine rewrite (6 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| Pipeline rules describe the four phases, per-slice gate order, human qa-walk, correction pass, integration branch, single trunk push | PASS | PIPELINE_RULE_0–4 content; synapse test ok 6 |
| Review + security stated as per-slice, not batched | PASS | PIPELINE_RULE_3 explicit |
| Scale-to-novelty rule retained | PASS | PIPELINE_RULE_2 explicit |
| Rewritten rules inject as always-on doctrine within token-budget governor | PASS | synapse test ok 6 |
| Constitution/global language references executors + human qa-walk consistently with glossary; no contradiction | PASS* | Pipeline domain carries these terms and injects as always-on; constitution/global are consistent (no contradictions). Constitution Art. III says "Code review and security review gate integration; functional QA walks the real artifact." GLOBAL_RULE_0 references `devops` as a dispatch-phase label. Neither file was changed on this branch — see Observation in Verdict. |
| Coverage does not decrease; suite green; types clean | PASS | 619/619 |

### Issue 02 — Builder agent conformance validator (6 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| `validateAgentFile` returns ok for conforming; errors for missing tools / no model / wrong output contract / unknown type | PASS | Agent conformance tests ok 1–5 |
| Builder executor agent exists, wraps contract, least-priv tools, model opus | PASS | `payload/.claude/agents/builder.md` validated |
| Builder passes `validateAgentFile` | PASS | Test ok 6 |
| Unit tests cover conforming + each failure mode | PASS | Tests ok 1–5 |
| Builder registered as managed payload | PASS | Manifest entry confirmed |
| Coverage; suite green | PASS | 619/619 |

### Issue 03 — Remaining executor agents (7 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| 5 agent definitions exist (reviewer, security, qa-walker, researcher, devops) | PASS | All 5 files present |
| Each passes `validateAgentFile` for its type | PASS | Agent conformance tests ok 7–11 |
| Least-priv tools; reviewer/security Write scoped; only devops canPush | PASS | EXECUTORS registry + test ok 12–13 |
| Models: reviewer/security=opus; qa-walker/researcher/devops=sonnet | PASS | Test ok 7–11 assert model |
| All 6 registered as managed payload | PASS | Manifest entries confirmed |
| Tests assert all 6 conform + wrong-type/over-privileged fails | PASS | Tests ok 1–13 |
| Coverage; suite green | PASS | 619/619 |

### Issue 04 — compass router skill + coverage check (6 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| `compass/SKILL.md` exists with frontmatter (user-invocable + model-invocable, tight description), static four-phase doctrine, live-skill-read + bucket instruction | **FINDING F-01** | `user-invocable: true` present; `model-invocable: true` ABSENT. Filed as `08-compass-missing-model-invocable.md`. |
| Doctrine names six executor agents per ADR 0006 and references `wrxn flow status` | PASS | "Which executor owns each AFK step" section names all 6; line 52 references `wrxn flow status [prd-id]` |
| "create a skill" routes to write-a-skill only; skill-creator marked legacy | PASS | Coverage test ok 3 |
| `compassCoverage` returns ok when all routed; errors listing orphan | PASS | P9 + P10 (node -e probes + test ok 1–2) |
| compass registered as managed payload | PASS | Manifest entry confirmed |
| Coverage; suite green | PASS | 619/619 |

### Issue 05 — flow status (6 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| `flowStatus(issues, artifacts)` maps issues + artifacts → correct per-slice board states (done/in-progress/queued/stalled) | PASS | P5–P8 probes; flow-status tests ok 1–10 |
| Missing artifact ⇒ not-yet-done (never false pass) | PASS | P5; falsy-values test ok 8 |
| `wrxn flow status [prd]` prints the board | PASS | P1 |
| Unit tests cover full/partial/empty artifact sets | PASS | flow-status tests ok 1–12 |
| No new mutable flow-state file | PASS | P21 (git diff) |
| Coverage; suite green | PASS | 619/619 |

### Issue 06 — qa-walk operator-mode (5 ACs)

| AC | Result | Evidence |
|----|--------|---------|
| `qa-walk/SKILL.md` has operator-mode section: whole artifact, all PRD stories, story-level, run by operator | PASS | Line 53 heading; P16 |
| Contrasts with agent per-slice AC-level walk | PASS | Table at lines 43–44; test ok 3 |
| Findings still auto-file as tracker issues | PASS | Stated at line 62; test ok 4 |
| No regression to existing agent walk behavior | PASS | Agent-walk spine unchanged |
| Coverage; suite green | PASS | 619/619 |

### Issue 07 — Retire skill-creator

Explicitly marked "Separate from the flow-redesign release — tracked here, shipped on its own. Not required for the flow-redesign acceptance." **N/A for this walk.**

---

## Findings

### F-01 — compass/SKILL.md missing `model-invocable: true` in frontmatter

**Filed:** `.scratch/flow-redesign/08-compass-missing-model-invocable.md`

**Promise:** Issue 04 AC1 — "compass/SKILL.md exists with frontmatter (user-invocable + model-invocable, tight description)".

**Observed:** Frontmatter contains `user-invocable: true` but no `model-invocable` field.

**Impact:** Non-blocking. The functional behavior of compass is unaffected — it is still invocable by both users and models. The `description` field serves as the routing trigger for model invocation. However, the AC explicitly states both flags should be present, and the absence means the declared frontmatter contract doesn't match the PRD/issue promise.

**Repro:**
```bash
head -6 payload/.claude/skills/compass/SKILL.md
```
Output shows no `model-invocable` line.

---

## Verdict

**FINDINGS (1)**

### Coverage summary
- Issues walked: 01, 02, 03, 04, 05, 06 (07 out of scope per its own note)
- Total ACs checked: 36
- PASS: 35
- FINDINGS: 1 (F-01 — compass missing `model-invocable` frontmatter field)
- Commands run: 21 planned probes + 3 mandatory edge probes per command surface
- Suite: 619/619 (full green)

### Findings filed: 1
- `08-compass-missing-model-invocable.md` — compass/SKILL.md missing `model-invocable: true` (non-blocking)

### Observations (not filed as findings)
- **Issue 01 AC5 interpretation:** The global domain and constitution were not changed on this branch. The pipeline domain carries all the executor/human-qa-walk/four-phase-flow terminology and injects as always-on doctrine. Whether the AC required explicit updates to the constitution/global files (vs. just "no contradiction") is ambiguous. The pipeline domain satisfies the functional intent; the static files are consistent and do not contradict the new flow. The builder appears to have treated this as a consistency check rather than a sharpening task. The Seam 2 test verifies all required terms inject in the correct order. If the operator wanted explicit executor/human-qa-walk text in the global domain itself, that would require a targeted sharpening commit.

### Operator verdict
The core artifact is production-ready. F-01 (missing `model-invocable` frontmatter field) is non-blocking — compass works correctly for both user and model invocation, the functional behavior is sound, the coverage check passes, and the routing is unambiguous. The single `devops`-only push gate, the four-phase pipeline doctrine, the per-slice AFK executor fleet, the flow-status board, and the qa-walk operator-mode are all correctly implemented and test-covered at 619/619. Recommended disposition: fix F-01 in a targeted patch commit before devops promotes to trunk.
