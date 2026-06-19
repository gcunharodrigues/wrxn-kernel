# Code review — flow-redesign (integration/flow-redesign vs main)

Fresh-eyes `/code-review`. Scope: the full branch diff (19 files, +1376/-6), verified against PRD,
ADR 0006, the 7 issues, CONTEXT.md "Build flow" glossary, and the real `lib/executor.cjs` registry.
Suite: 619/619 green. The CLI was run against the real PRD to verify behavior, not just the unit tests.

## Verdict: REQUEST-CHANGES

Two confirmed blocking correctness bugs, both in the `flow status` feature's `blockedBy` handling, both
producing demonstrably wrong output on the very PRD this branch ships (`wrxn flow status flow-redesign`
reports all seven slices "queued"). The fixes are small and localized. The other five deliverables
(pipeline doctrine rewrite, six executor agents, conformance validator, compass + coverage, qa-walk
operator-mode) are approve-quality: faithful to ADR 0006, well-tested at the contract seam, manifest
clean, fleet correctly least-privileged on `Edit` (only builder + devops), models match the fleet.

Count: 2 blocking, 7 non-blocking.

---

## Blocking

- **bin/wrxn.cjs:542-545 — blocking: the "## Blocked by" parser captures the sentinel bullet
  "- None — can start immediately." as a real dependency.** Every issue using the standard to-issues
  "Blocked by: None" convention (4 of the 7 shipped issues: 01/02/05/06) is therefore treated as
  blocked. Confirmed by running `node bin/wrxn.cjs flow status flow-redesign`: all seven slices print
  `queued`, even though flow-01/02/04/05/06 have a detected green commit (`build✓`) and should read
  stalled/in-progress. The headline deliverable is wrong on its own dogfood PRD. **Fix:** when building
  `blockedBy`, skip sentinel bullets (e.g. drop any bullet matching `/^none\b/i`); ideally also resolve
  the listed dep ids and keep only unresolved ones.

- **lib/flow-status.cjs:34,55 — blocking: `isBlocked` is `blockedBy.length > 0`, evaluated before the
  done check, and never tests whether the dependency is resolved** — despite the doc comment at line 28
  ("blocked by an *unresolved* dependency"). `sliceState` does `if (isBlocked) return 'queued'` as its
  FIRST branch (line 34), so a slice that lists any blocker can never reach `done`. Demonstrated: an
  issue with all four gate artifacts present AND a blocker that is itself fully done still returns
  `queued`, masking a completed slice. **Fix:** check all-gates-done before the `isBlocked`
  short-circuit, and treat a dependency as blocking only when unresolved (pass the set of completed
  issue ids in, or remove blocked-state from this pure function and derive it from the dep graph in the
  caller).

---

## Non-blocking

- **lib/flow-status.cjs:30,38 — non-blocking: "stalled" has no time dimension and covers only the
  build→review gap.** Issue 05 AC wants "stalled when a prior gate passed but the next is *long*-missing."
  As built, every freshly-built-not-yet-reviewed slice immediately reads `stalled` (over-fires —
  conflates a normal in-flight slice with a genuinely stuck one, undermining story 27), and a slice
  stuck at review→security or security→qa never reads `stalled` (under-fires). Defensible as a
  pure/no-time v1, but diverges from the AC wording. **Fix:** derive slice age from the green commit's
  timestamp (already reachable in the CLI's git layer) for a "long-missing" threshold, or document the
  simplification explicitly.

- **lib/agent-conformance.cjs:226-247 — non-blocking: `validateAgentFile` enforces tool *presence*
  (`tools.length > 0`, line 233-234), not least-privilege.** `EXECUTORS[type]` carries no tool
  allowlist, so a reviewer/security agent that later added `Edit` (code-editing) or any extra tool would
  still pass conformance. The shipped fleet is correct, but the guard wouldn't catch a regression —
  weaker than PRD stories 21/24 imply ("a reviewer can't edit code"). **Fix:** add a per-type
  forbidden/allowed-tool assertion if least-privilege must be machine-guarded.

- **payload/.claude/agents/{reviewer,security,qa-walker,builder}.md — non-blocking: "Write scoped to my
  one marker" (story 24) and "only devops may push" (story 18) are not mechanically enforced.** Claude
  Code cannot path-scope a `Write` grant, and reviewer/security/qa-walker/builder all hold `Bash` (so
  could invoke `git push`). The real push guarantee is the runtime anti-accidental-push hook
  (`WRXN_ACTIVE_AGENT` in settings.local.json) + `validateReport`'s pushed-gate, not the tool grant —
  which matches kernel design but is worth stating since the PRD frames it as a tools guarantee. No fix
  required; consider a one-line note in the agent bodies that the push gate is the hook.

- **test/flow-status.test.cjs — non-blocking: the test fixtures never exercise where the bugs live.**
  The CLI integration test uses an issue with no "## Blocked by" section + one with a real "- myprd-01"
  blocker, and the pure-fn tests use synthetic `blockedBy: []`/`['flow-01']`. Neither covers (a) the
  "- None …" sentinel that the real issues use, nor (b) a fully-done slice that lists a (resolved)
  blocker — which is why the suite is 619-green while the live command is wrong. **Fix:** add a CLI
  fixture whose issue says "Blocked by: None" and a pure-fn case asserting all-gates-done beats a
  present blockedBy.

- **payload/.claude/constitution.md, payload/.synapse/global — non-blocking: issue 01's AC
  "Constitution/global language references executors + the human qa-walk consistently" is only partly
  met.** The diff rewrites `payload/.synapse/pipeline` only; constitution + global are untouched. They
  do not contradict the new flow (Art. III still says review/security/QA gate integration; no Art. I–III
  conflict — the hard part of the AC holds), but the ADR's "the constitution's HITL-spine / AFK-executor
  language is sharpened, not replaced" was not carried out — neither file names "executor" or "human
  qa-walk." **Fix:** sharpen Art. III / a global rule to name the executors + the two-level qa-walk, or
  record that the constitution stays deliberately general.

- **payload/.synapse/pipeline + .synapse/manifest (RULES_BUDGET_TOKENS=600) — non-blocking: the budget
  margin for always-on doctrine is only 30 tokens.** Measured: GLOBAL 188 + PIPELINE 382 = 570, +ROUTING
  153 = 723. The builder's flag is accurate. Assessment: always-on doctrine IS protected — `applyBudget`
  pops from the end and ROUTING is the last (recall) section, so on a routing-trigger prompt ROUTING
  drops first and GLOBAL+PIPELINE (570 ≤ 600) survive. The one critical trimmed rule (anti-accidental-
  push, ROUTING_RULE_0) is duplicated in GLOBAL_RULE_0 and Constitution Art. I, so it never actually
  disappears; only the seeded worktree/deploy/slice ROUTING rules drop, and only on an over-budget
  trigger prompt, with a visible `[SYNAPSE-RULES-TRIM]` marker. Acceptable. BUT the PIPELINE rewrite
  grew the always-on set to 570/600 — any future addition to GLOBAL or PIPELINE would start trimming
  PIPELINE itself (the lowest-priority always-on). **Fix:** bump RULES_BUDGET_TOKENS (~800) so the
  flow doctrine has headroom and the seeded ROUTING domain isn't routinely trimmed on its own triggers.

- **test/synapse-engine.test.cjs — non-blocking: no test pins the trigger-prompt trim behavior.** The
  new test asserts the no-trigger prompt ('build me a feature') keeps PIPELINE+GLOBAL with no trim, but
  nothing asserts that on a ROUTING-trigger prompt (e.g. "push") ROUTING drops while GLOBAL+PIPELINE
  survive — the exact property that protects always-on doctrine. **Fix:** add a trigger-prompt case
  asserting `[SYNAPSE-RULES-TRIM] routing` while `[PIPELINE]`/`[GLOBAL]` remain.

---

## Verified clean (no findings)

- Conformance validator output-contract parsing: builder == BUILDER_REQUIRED, the other five ==
  GENERIC_REQUIRED; `sameSet` rejects both a short and an over-declared contract; missing tools / missing
  model / unknown type all rejected; the ```output-contract``` non-greedy match correctly stops before
  the trailing ```json example. All six shipped agents parse and pass for their type.
- Six agents: models match the fleet (builder/reviewer/security=opus, qa-walker/researcher/devops=sonnet);
  only builder + devops hold `Edit`; devops body encodes the set→push→unset WRXN_ACTIVE_AGENT dance with
  mandatory unset (even on failure); the other five state "Never git push." `canPush` pinned per type.
- compass coverage: all 27 installed skills route to exactly one bucket (no orphan); a synthetic unrouted
  skill is reported; "create a skill" → write-a-skill only; skill-creator marked legacy. parseBuckets
  handles hyphenated bucket names correctly.
- flow-status "never a false pass": empty/null/undefined/`0`/`''` artifact values all read pending; a
  missing artifact is never a false done. flow-07 (unbuilt) correctly shows `build·`.
- manifest.json: 6 agents + compass added, all managed/project, paths resolve to real payload files, no
  duplicate paths, valid JSON.
- Pipeline doctrine: four phases in order, per-slice review+security "not batched," integration branch +
  single post-accept trunk push, scale-to-novelty retained, executors named — injects always-on within
  budget (synapse test passes).
