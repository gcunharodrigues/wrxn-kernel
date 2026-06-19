# Code review — gate-07 (pipeline-adherence guard hook)

- **Slice:** `gate-07` · build commit `1e1eb74` on `gate-redesign` (range `efd0c25..1e1eb74`)
- **Contracts:** `acceptance/gate-redesign/issues/07-pipeline-adherence-guard.md` · `PRD.md` · ADR `0007` (locked choice 8)
- **Reviewer:** fresh-eyes, read-only on code; verified every claim against the hook source, the test, the two
  reference hooks (`enforce-push-authority.cjs`, `enforce-managed-guard.cjs`), `lib/executor.cjs`,
  `payload/.synapse/{pipeline,manifest}`, `settings.json`, `manifest.json`, `compass/SKILL.md`.

## Verdict: APPROVE — no blocking findings

The hook does exactly what the issue and ADR specify, with the correct deny shape, correct fail-open, the
correct + complete executor allow-list, sound wiring, and a defensible block-biased heuristic. Full suite
**685/685 green** (+24 new tests, none removed → coverage up). Five non-blocking observations below; none gate
merge.

## Blocking findings

None.

## Non-blocking findings

1. **`to-prd` 2nd-alternation over-blocks a pure read** — `enforce-pipeline-adherence.cjs:34`
   `\bPRD\b[\s\S]{0,25}\b(document|doc)\b`. This branch fires with **no creation verb**, so
   `"summarize the PRD document in two sentences"` and `"read the PRD doc and list the open questions"` both
   BLOCK (empirically confirmed). Over-blocking is the *safe* direction and within the AC, but this is the one
   branch that blocks with zero creation intent — the test `does not block "summarize the PRD.md"` only passes
   because it uses `PRD.md`, not `PRD document`. Optional tighten: require a creation verb in this branch too,
   or drop it (the first alternation already catches `"write the PRD doc"`). Friction-only; the orchestrator
   gets a clear actionable reason and rephrases.

2. **Documented false negatives are acceptable-by-design** — `"tickets"`, `"list issues"`, `"turn these into
   tickets"` all ALLOW (confirmed). This matches PRD *Out of Scope* ("the guard targets the *detectable*
   bypass; the rest stays doctrine + `compass`"). Noted for completeness, not a defect — the common phrasings
   (`write/draft a PRD`, `break/split/slice … into issues`, `grill`, `verticality`) are all caught.

3. **Budget recall-margin is comment-asserted, not test-locked** — `payload/.synapse/manifest:33-36`. The
   doctrine-only no-trim case is *empirically proven* (GLOBAL+PIPELINE+RULE_5 inject with no
   `[SYNAPSE-RULES-TRIM]` and ~229-token headroom at the default 900 budget). The "*+ a firing recall domain*"
   margin (824 < 900) is arithmetic only — no test exercises "default budget + recall fires + doctrine
   survives" (the existing no-trim test uses a no-recall prompt, and `ROUTING` is seeded-empty in a fresh
   install so it cannot be driven from a test). A future doctrine-growth could erode the recall headroom
   without a red test. Pre-existing test-shape limitation, not introduced here; optional future lock.

4. **Stale comment in a pre-existing test (out of scope)** — `test/synapse-engine.test.cjs:102` still says
   "*fit the 600-token governor*" (default is now 900). This slice did not touch that file; flagging only so
   it is on record for a later doc sweep.

5. **`verticality → to-issues` reason mapping (intended, arguably better)** — the hook maps a `verticality`
   match to `to-issues`, not `grill`. This is *more* correct than a `grill` mapping: the verticality gate is a
   gate **within** the issues phase (`PIPELINE_RULE_3`), run over the `to-issues` output — both the code
   comment (`enforce-pipeline-adherence.cjs:39`) and the test document the rationale. Noted to preempt
   confusion vs. any loose "grill/verticality→grill" framing.

## AC checklist

| # | Acceptance criterion | Verdict | Evidence |
|---|----------------------|---------|----------|
| 1 | Determine + record whether CC fires `PreToolUse` on `Task`; choose event accordingly | **MET** | Determination recorded in commit body + hook header (`enforce-pipeline-adherence.cjs:11-18`): chose `PreToolUse:Task` (CC matches PreToolUse matchers on tool name; `Task` is a matchable tool), `UserPromptSubmit` fallback ruled unnecessary. Determination is correct for CC. |
| 2 | Hook blocks non-typed `subagent_type` **AND** HITL-keyword prompt; allows typed executors; fails open on parse error; decision-fn unit-tested | **MET** | `decide()` is pure + directly unit-tested; TYPED_EXECUTORS short-circuits before the scan; 6 regression-lock tests (one per executor) + fail-open tests (no args / empty obj / missing type / non-string prompt / malformed stdin). Empirically confirmed. |
| 3 | Block `reason` names the correct main-thread skill | **MET** | `reasonFor()` joins matched skills; tests assert `to-prd` / `to-issues` / `grill`. Verticality→`to-issues` is the accurate mapping (finding 5). |
| 4 | Wired in `settings.json`, added to manifest, synapse doctrine + `compass` cross-reference | **MET** | `settings.json:35-40` `PreToolUse`/`Task` (well-formed sibling group, `$CLAUDE_PROJECT_DIR`); manifest `managed`/`project` entry; `PIPELINE_RULE_5` added; `compass/SKILL.md:61-65` cross-reference. Settings + manifest wiring each have a dedicated test. |
| 5 | Walk: `general-purpose` "write a PRD" blocked → `to-prd`; `builder` build task allowed | **MET** | Tests 1 & 2; reproduced live (`"write a PRD"`→BLOCK+`to-prd`; builder build prompt→allow). |
| 6 | Coverage does not decrease; suite green | **MET** | `npm test` → **685/685**, +24 new, zero removed. |

## Scrutiny-point verdicts

1. **Decision correctness — PASS.** Blocks exactly {non-typed `subagent_type`} ∧ {HITL-keyword match}; allows
   the six executors unconditionally (short-circuit before the scan) and any non-HITL prompt. The six names
   `builder, reviewer, security, qa-walker, researcher, devops` are **correct + complete** — byte-match to
   `lib/executor.cjs` EXECUTORS keys (lines 26/39/52/64/71/78) and to `PIPELINE_RULE_1`.
2. **Deny-emit contract — PASS.** Emits `{ decision: 'block', reason }` and `exit 0` — byte-identical to all
   five `enforce-*.cjs` hooks (push-authority:41, managed-guard:63, tests-on-push:34, review-marker:57). The
   legacy `{decision:'block'}` shape is the kernel-wide convention and is honored by CC for PreToolUse → the
   guard will actually block, not silently no-op.
3. **Fail-open — PASS.** Every failure path returns allow: unparseable stdin → `emit({})`; missing
   prompt/type/non-Task tool → allow; non-string prompt coerced to `''` → allow. Confirmed in code
   (`decide` + `main`) and tests.
4. **AC-3 reason mapping — PASS.** PRD→`to-prd`, issues→`to-issues`, grill→`grill`, verticality→`to-issues`
   (the verticality gate runs over the issues output — accurate; see finding 5).
5. **Heuristic robustness — PASS (block-biased, defensible).** Empirically: literal `grill`/`grilled` fires;
   `PRD` needs a creation verb within ~40 chars (first alt) — except the `PRD … document/doc` branch which
   over-blocks a pure read (finding 1); `tickets`/`list issues` are false negatives (finding 2). The
   block-biased trade-off matches the AC ("blocks when not-typed AND prompt matches HITL keywords") and the
   PRD's explicit "detectable bypass only" scope. No gap rises to a correctness failure: no AC-mandated block
   is missed, and no typed executor is ever blocked.
6. **Budget side-effect — PASS.** `800→900` cleanly migrated (no stale `800` ref anywhere). Margin math sound:
   GLOBAL ~188 + PIPELINE ~483 (now six rules) + ROUTING ~153 = ~824 < 900. No regression — full suite green,
   incl. the default-budget no-trim test; doctrine-only no-trim empirically reproduced with ~229 headroom.
   Raising the ceiling is the **right** fix vs trimming RULE_5: the doctrine is the always-on spine and
   trimming it would re-introduce the exact "soft doctrine insufficient" failure the slice exists to fix.
   (See finding 3 for the comment-only recall-margin caveat.)
7. **Wiring — PASS.** `settings.json` `PreToolUse`/`Task` group is well-formed and uses `$CLAUDE_PROJECT_DIR`;
   manifest entry is `class:managed` / `profile:project` (matches the other hooks); `compass` + `PIPELINE_RULE_5`
   cross-references are present and accurate. Settings-path and manifest-entry each have a locking test.
