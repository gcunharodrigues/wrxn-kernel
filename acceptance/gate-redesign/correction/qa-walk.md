# QA-Walk — gate-redesign correction pass (5 fixes)

**Date:** 2026-06-19
**Walker:** qa-walker executor (fresh context — not the builder)
**Artifact entry point:** `node /home/guilherme/Documents/_projects/wrxn-kernel/bin/wrxn.cjs` + kernel lib modules
**Commits walked:** `41cebc0` (gate-10), `4b933de` (006 migration), `823db31` (ship --), `7821ed4` (adherence hook), `54ada8f` (teaching docs)

---

## Walk plan

| # | Fix | Behavior promised | Commands | Expected |
|---|-----|-------------------|----------|----------|
| 1a | gate-10 | Clean install passes managed-integrity | `wrxn ci --root <fresh-install>` | PASS, exit 0 |
| 1b | gate-10 | Swapped kernel server command caught | modify `.mcp.json` command → `wrxn ci` | FAIL, exit 2, names `.mcp.json` |
| 1c | gate-10 | Injected `env` on kernel server caught | add `env` key → `wrxn ci` | FAIL, exit 2, names `.mcp.json` |
| 1d | gate-10 | Operator-added server key not false-positived | add new server key → `wrxn ci` | PASS, exit 0 |
| 1e | gate-10 | Corrupt `.mcp.json` caught | write bad JSON → `wrxn ci` | FAIL, exit 2 |
| 2a | mig-006 | Stale ROUTING_RULE_0 rewritten, siblings/header/operator lines intact | `migration.up({target})` on stale routing | New rule, siblings preserved, trailing newline |
| 2b | mig-006 | Already-new routing → no-op | `migration.up` on already-refreshed routing | Byte-identical |
| 2c | mig-006 | Operator-customized rule (no marker) → untouched | `migration.up` on custom rule | Byte-identical |
| 2d | mig-006 | Missing `.synapse/routing` → no-op, no throw | `migration.up` on dir with no routing | No throw, no file created |
| 3a | ship -- | Dash-leading branch fenced in push + auto-merge | `buildShipPlan({branch:'--oops',title:'t'})` | push: `-- --oops`; auto-merge: `--auto --squash -- --oops`; pr-create: no bare `--` |
| 3b | ship -- | Normal branch same guard | `buildShipPlan({branch:'feat/x',title:'t'})` | `--` present in push + auto-merge, pr-create via `--head` value |
| 3c | ship -- | Missing branch throws | `buildShipPlan({title:'t'})` | throws "branch is required" |
| 3d | ship -- | Missing title throws | `buildShipPlan({branch:'b'})` | throws "title is required" |
| 4a | adherence | null stdin → fail-open | `echo "null" \| node enforce-pipeline-adherence.cjs` | `{}`, exit 0 |
| 4b | adherence | `{}` → fail-open | `echo '{}' \| node ...` | `{}`, exit 0 |
| 4c | adherence | general-purpose + read verb on PRD → allowed | Task event with "summarize the PRD document" | `{}`, exit 0 |
| 4d | adherence | general-purpose + "write a PRD" → blocked naming to-prd | Task event with "write a PRD for the auth feature" | block decision, names `to-prd` |
| 4e | adherence | general-purpose + "create the PRD document" → blocked | Task event with "create the PRD document" | block decision |
| 4f | adherence | typed executor always bypasses | Task event: builder + "write a PRD" | `{}`, exit 0 |
| 4g | adherence | empty prompt → fail-open | Task event with prompt="" | `{}`, exit 0 |
| 5a | docs | Retired doctrine terms absent from synapse skill | `git grep 'WRXN_ACTIVE_AGENT\|confirmation flag\|...'` in `payload/.claude/skills/synapse/` | No matches |
| 5b | docs | New PR+CI+auto-merge doctrine IS present | `git grep 'wrxn ship\|PR.*auto-merge\|server-enforced'` in synapse SKILL.md | Matches present |

All probes sandboxed: wrxn ci probes run against isolated `/tmp` installs (fresh `init`); migration probes run against `/tmp` dirs; ship plan is pure (no side effects); hook probes run via stdin pipe; docs check is read-only grep.

---

## Evidence

### Fix 1 — gate-10: `.mcp.json` managed-integrity (`41cebc0`)

**1a — Clean install → PASS**
```
$ node wrxn.cjs ci --root /tmp/wrxn-walk-yaki41
wrxn-ci (/tmp/wrxn-walk-yaki41)
  ✓ managed-integrity — 87 managed file(s) checked
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 14 .cjs file(s) parsed
wrxn-ci PASS
exit:0
```
PASS

**1b — Swapped command (`evil-binary`) on `recon-wrxn` → must FAIL**
```
$ node wrxn.cjs ci --root /tmp/wrxn-probeA-NNK9KQ
wrxn-ci (/tmp/wrxn-probeA-NNK9KQ)
  ✗ managed-integrity — 87 managed file(s) checked
      - .mcp.json — kernel-managed MCP server "recon-wrxn" drifted from the kernel-owned source
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 14 .cjs file(s) parsed
wrxn-ci FAIL
exit:2
```
PASS

**1c — Injected `env: {EVIL_VAR: "injected"}` on `recon-wrxn` → must FAIL**
```
$ node wrxn.cjs ci --root /tmp/wrxn-probeB-8igK13
wrxn-ci (/tmp/wrxn-probeB-8igK13)
  ✗ managed-integrity — 87 managed file(s) checked
      - .mcp.json — kernel-managed MCP server "recon-wrxn" drifted from the kernel-owned source
  ✓ ...
wrxn-ci FAIL
exit:2
```
PASS

**1d — Operator-added server `operator-tool` → must still PASS (no false positive)**
```
$ node wrxn.cjs ci --root /tmp/wrxn-probeC-Q8hpsI
wrxn-ci (/tmp/wrxn-probeC-Q8hpsI)
  ✓ managed-integrity — 87 managed file(s) checked
  ✓ wiki-lint — wiki frontmatter clean
  ✓ synapse-manifest — 4 active domain(s) checked
  ✓ json-validity — 4 json path(s) checked
  ✓ node-check — 14 .cjs file(s) parsed
wrxn-ci PASS
exit:0
```
PASS

**1e — Corrupt JSON `{bad json{{{{` → must FAIL**
```
$ node wrxn.cjs ci --root /tmp/wrxn-probeD-XcX9u8
wrxn-ci (/tmp/wrxn-probeD-XcX9u8)
  ✗ managed-integrity — 87 managed file(s) checked
      - .mcp.json — invalid JSON: Expected property name or '}' in JSON at position 1
  ✓ ...
  ✗ json-validity — 4 json path(s) checked
      - .mcp.json — invalid JSON: Expected property name or '}' in JSON at position 1
wrxn-ci FAIL
exit:2
```
PASS

---

### Fix 2 — migration 006: seeded routing refresh (`4b933de`)

**2a — Stale WRXN_ACTIVE_AGENT routing rewritten**
```
migration.up({target: /tmp/wrxn-m006-stale-…})
rule0_is_new:              true
no_WRXN_ACTIVE_AGENT:      true
sibling_ROUTING_RULE_1:    true (preserved)
operator_ROUTING_RULE_4:   true (preserved)
trailing_newline:          true
```
PASS

**2b — Already-new routing → byte-identical (no-op)**
```
byte_identical: true
```
PASS

**2c — Operator-customized ROUTING_RULE_0 (no marker) → untouched**
```
byte_identical: true
```
PASS

**2d — Missing `.synapse/routing` → no throw, no file created**
```
no_throw:              true
no_synapse_dir_created: true
```
PASS

---

### Fix 3 — ship `--` end-of-options guard (`823db31`)

**3a — Dash-leading branch `--oops`**
```
$ node -e "JSON.stringify(require('./lib/ship.cjs').buildShipPlan({branch:'--oops',title:'t'}),null,2)"
push:        git push -u origin -- --oops
pr-create:   gh pr create --base main --head --oops --title t --body ''
auto-merge:  gh pr merge --auto --squash -- --oops
```
- push: `--` before `--oops` ✓
- auto-merge: flags (`--auto --squash`) PRECEDE `--`, branch after ✓
- pr-create: branch is value of `--head` (no bare positional `--`) ✓
PASS

**3b — Normal branch `feat/my-feature`**
```
push_has_dbl_dash_before_branch: true
merge_flags_before_dbl_dash:     true
merge_dbl_dash_before_branch:    true
pr_create_no_bare_positional:    true
```
PASS

**3c — Missing branch → throws**
```
bad_input_missing_branch_throws: true  ("branch is required")
```
PASS

**3d — Missing title → throws**
```
bad_input_missing_title_throws: true  ("title is required")
```
PASS

---

### Fix 4 — adherence hook null-guard + PRD read-vs-write (`7821ed4`)

**4a — `null` stdin → fail-open `{}`**
```
$ echo "null" | node enforce-pipeline-adherence.cjs
{}
exit:0
```
PASS

**4b — `{}` → fail-open `{}`**
```
$ echo '{}' | node enforce-pipeline-adherence.cjs
{}
exit:0
```
PASS

**4c — general-purpose + "summarize the PRD document" → allowed**
```
$ echo '{"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"summarize the PRD document"}}' | node ...
{}
exit:0
```
PASS (read verb: allowed, not blocked)

**4d — general-purpose + "write a PRD for the new auth feature" → blocked**
```
{"decision":"block","reason":"Blocked: this spawn delegates a HITL pipeline step to a non-typed agent. … Use to-prd in the main thread."}
exit:0
```
PASS

**4e — general-purpose + "create the PRD document" → blocked**
```
{"decision":"block","reason":"Blocked: … Use to-prd in the main thread."}
exit:0
```
PASS (creation verb wins over doc pattern, per gate-07 NB)

**4f — typed executor `builder` + "write a PRD" → allowed (bypass)**
```
{}
exit:0
```
PASS

**4g — empty prompt → fail-open**
```
{}
exit:0
```
PASS

---

### Fix 5 — teaching docs update (`54ada8f`)

**5a — Retired doctrine terms absent from `payload/.claude/skills/synapse/`**
```
$ git grep 'WRXN_ACTIVE_AGENT\|confirmation flag\|green-suite push gate\|settings\.local\.json' \
    -- payload/.claude/skills/synapse/
(no output)
exit:1
```
exit 1 = no matches. 7 files scanned. PASS

**5b — New PR+CI+auto-merge doctrine IS present in synapse SKILL.md**
```
$ git grep -c 'wrxn ship\|PR.*auto-merge\|server-enforced' -- payload/.claude/skills/synapse/SKILL.md
payload/.claude/skills/synapse/SKILL.md:4
exit:0
```
4 hits confirmed. PASS

---

## Verdict

**PASS — 0 findings filed.**

| Fix | Behaviors checked | Commands run | Result |
|-----|-------------------|--------------|--------|
| gate-10 `.mcp.json` integrity | 5 | 5 | all PASS |
| migration 006 routing refresh | 4 | 4 | all PASS |
| ship `--` guard | 4 | 4 | all PASS |
| adherence hook | 7 | 7 | all PASS |
| teaching docs | 2 | 2 | all PASS |
| **Total** | **22** | **22** | **22 PASS, 0 FINDINGS** |

Walk coverage: 5 promised fixes, 22 probe commands executed, 0 deviations. Every mutating probe ran in a sandboxed `/tmp` install; the kernel working tree was not modified.

Context note: this walk ran in a fresh executor context that had not seen the implementation before reading the artifacts. The verdict is independent.
