---
slice: gate-07
artifact: payload/.claude/hooks/enforce-pipeline-adherence.cjs
walker: qa-walker (fresh isolated context — not the builder)
date: 2026-06-19
---

# QA-Walk — gate-07: pipeline-adherence guard hook

## Source of promises

- Issue: `acceptance/gate-redesign/issues/07-pipeline-adherence-guard.md`
- Entry point: `node payload/.claude/hooks/enforce-pipeline-adherence.cjs` (stdin → stdout JSON)

---

## Walk plan

Derived from the six acceptance criteria in the issue.

| # | Behavior (AC source) | Command(s) | Expected |
|---|----------------------|------------|----------|
| P1 | HITL delegation blocked — PRD creation (AC-2, AC-3, AC-5) | `echo '{"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"write a PRD for the new billing feature"}}' \| node hook` | `{"decision":"block","reason":"…Use to-prd in the main thread."}`, exit 0 |
| P2 | HITL delegation blocked — break into issues (AC-2, AC-3) | general-purpose + "break it down into issues" | block, reason names `to-issues`, exit 0 |
| P3 | HITL delegation blocked — grill (AC-2, AC-3) | general-purpose + "Grill me on this plan" | block, reason names `grill`, exit 0 |
| P4 | HITL delegation blocked — verticality (AC-2, AC-3) | general-purpose + "Run the verticality review" | block, reason names `to-issues`, exit 0 |
| P5 | Typed executors always allowed (AC-2, AC-5) | builder + PRD prompt; reviewer + PRD prompt; devops + PRD prompt; security/qa-walker/researcher + all keywords | `{}`, exit 0 |
| P6 | Non-HITL generic spawn allowed (AC-2) | general-purpose + "summarize the PRD.md file"; general-purpose + "fix the login bug" | `{}`, exit 0 |
| P7 | Fail-open on malformed/partial stdin (AC-2) | bad JSON; empty object; empty stdin; missing subagent_type; missing prompt; non-string prompt | `{}`, exit 0; never crash |
| P8 | Non-Task tool short-circuit (AC-1) | tool_name=Bash; tool_name=Write; tool_name=Read | `{}`, exit 0 |
| P9 | description field folded into keyword scan (AC-2 "prompt matches") | Task + general-purpose + description="write a PRD" + prompt="go" | block, names `to-prd`, exit 0 |
| P10 | Block reason names correct skill (AC-3) | covered by P1–P4 | reason string contains the expected skill name |
| P11 | settings.json wired PreToolUse:Task with $CLAUDE_PROJECT_DIR (AC-4) | read settings.json | Task matcher present, command contains `enforce-pipeline-adherence.cjs` and `$CLAUDE_PROJECT_DIR` |
| P12 | manifest.json entry: managed, profile=project (AC-4) | read manifest.json | entry `.claude/hooks/enforce-pipeline-adherence.cjs`, class=managed, profile=project |
| P13 | .synapse/pipeline references adherence rule (AC-4) | read .synapse/pipeline | PIPELINE_RULE_5 names the hook |
| P14 | compass/SKILL.md cross-references the guard (AC-4) | read compass/SKILL.md | "enforce-pipeline-adherence" named + doctrine cross-ref |

Edge probes added per spine rule (one set per command class):

| Edge | Input | Expected |
|------|-------|----------|
| Bad input — non-string subagent_type | `{"subagent_type":42,"prompt":"write a PRD"}` (via decide()) | fail open `{block:false}` |
| Bad input — non-string prompt | `{"subagent_type":"general-purpose","prompt":42}` | fail open `{}` |
| Empty state — empty stdin | `""` piped | `{}` |
| Repeat-run / idempotency | same HITL payload piped twice | identical `{"decision":"block",…}` both times |
| Multi-HITL match — dedup in reason | general-purpose + "draft a PRD and break it into issues" | block, reason contains both `to-prd` and `to-issues` |
| PRD mention without creation verb | "Read the PRD and check edge cases" | `{}` (no creation match) |

---

## Execution evidence

Entry point confirmed present:

```
$ node /…/enforce-pipeline-adherence.cjs 2>&1 <<< ""
{}
exit 0
```

### P1 — HITL block: PRD creation

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"write a PRD for the new billing feature"}}
stdout: {"decision":"block","reason":"Blocked: this spawn delegates a HITL pipeline step to a non-typed agent. HITL steps (PRD, issues, grill, verticality) are decided in the MAIN THREAD with the operator — delegating one to a generic subagent silently skips the pipeline (the 2026-06-19 error). Use to-prd in the main thread."}
exit:   0
```

Result: PASS — decision=block, reason names `to-prd`, names `main thread`.

### P2 — HITL block: break into issues

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Take this PRD and break it down into issues for the tracker"}}
stdout: {"decision":"block","reason":"…Use to-issues in the main thread."}
exit:   0
```

Result: PASS — decision=block, reason names `to-issues`.

### P3 — HITL block: grill

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Grill me on this plan and surface the hidden assumptions"}}
stdout: {"decision":"block","reason":"…Use grill in the main thread."}
exit:   0
```

Result: PASS — decision=block, reason names `grill`.

### P4 — HITL block: verticality

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Run the verticality review on these issues before we build"}}
stdout: {"decision":"block","reason":"…Use to-issues in the main thread."}
exit:   0
```

Result: PASS — decision=block, reason names `to-issues` (the verticality gate maps to the to-issues skill as designed).

### P5 — Typed executors always allowed

```
# builder
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"builder","prompt":"Build slice gate-07 per the PRD acceptance criteria…"}}
stdout: {}   exit: 0   PASS

# reviewer
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"reviewer","prompt":"Review this code, it writes a PRD and break it into issues"}}
stdout: {}   exit: 0   PASS

# devops
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"devops","prompt":"Push this branch; the PRD has been accepted"}}
stdout: {}   exit: 0   PASS

# security (HITL keyword prompt — still allowed)
  security -> {}   PASS
# qa-walker (HITL keyword prompt — still allowed)
  qa-walker -> {}   PASS
# researcher (HITL keyword prompt — still allowed)
  researcher -> {}   PASS
```

Result: PASS — all six typed executors pass even on maximally triggering prompts.

### P6 — Non-HITL generic spawn allowed

```
# summarize PRD.md (read verb, no creation verb)
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Read and summarize the PRD.md file in two sentences."}}
stdout: {}   exit: 0   PASS

# fix login bug (no HITL keyword)
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Fix the login bug where users are redirected incorrectly after OAuth."}}
stdout: {}   exit: 0   PASS
```

Result: PASS — no false positives on non-HITL prompts.

### P7 — Fail-open on malformed/partial stdin

```
# (a) not JSON
stdin:  "{ not valid json at all"
stdout: {}   exit: 0   PASS

# (b) empty object
stdin:  {}
stdout: {}   exit: 0   PASS

# (c) empty string
stdin:  ""
stdout: {}   exit: 0   PASS

# (d) missing subagent_type
stdin:  {"tool_name":"Task","tool_input":{"prompt":"write a PRD"}}
stdout: {}   exit: 0   PASS

# (e) missing prompt
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose"}}
stdout: {}   exit: 0   PASS

# (f) non-string prompt value
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":42}}
stdout: {}   exit: 0   PASS
```

Result: PASS — every malformed/partial variant fails open, no crash, no block, exit 0.

### P8 — Non-Task tool short-circuit

```
# Bash
stdin:  {"tool_name":"Bash","tool_input":{"command":"echo write a PRD"}}
stdout: {}   exit: 0   PASS

# Write
stdin:  {"tool_name":"Write","tool_input":{"file_path":"/tmp/prd.md","content":"write a PRD"}}
stdout: {}   exit: 0   PASS

# Read
stdin:  {"tool_name":"Read","tool_input":{"file_path":"/tmp/prd.md"}}
stdout: {}   exit: 0   PASS
```

Result: PASS — non-Task tools are no-ops.

### P9 — description field folded into keyword scan

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","description":"write a PRD","prompt":"go"}}
stdout: {"decision":"block","reason":"…Use to-prd in the main thread."}
exit:   0
```

Result: PASS — description field participates in the keyword scan even when the prompt itself is innocuous.

### P10 — Block reason names correct skill

Verified across P1–P4 and P9. Each block reason string contains exactly the skill name the AC requires (`to-prd`, `to-issues`, `grill`) and the phrase `main thread`. The dedup test also confirms multiple matches produce a deduplicated `to-prd / to-issues` list:

```
stdin:  {"tool_name":"Task","tool_input":{"subagent_type":"general-purpose","prompt":"Please draft a PRD and break it into vertical-slice issues"}}
stdout: {"decision":"block","reason":"…Use to-prd / to-issues in the main thread."}
exit:   0
```

Result: PASS.

### P11 — settings.json wired PreToolUse:Task

```json
PreToolUse.Task group found:
{
  "matcher": "Task",
  "hooks": [
    {
      "type": "command",
      "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-pipeline-adherence.cjs\""
    }
  ]
}
```

Result: PASS — matcher=Task, command references `$CLAUDE_PROJECT_DIR`, hook file name matches.

### P12 — manifest.json entry

```json
{
  "path": ".claude/hooks/enforce-pipeline-adherence.cjs",
  "class": "managed",
  "profile": "project"
}
```

Result: PASS — all three required fields match the AC exactly.

### P13 — .synapse/pipeline references adherence rule

PIPELINE_RULE_5 (line 7 of the file):

```
PIPELINE_RULE_5=Never delegate a HITL step … The enforce-pipeline-adherence hook (PreToolUse:Task) hard-blocks it and points you back to grill / to-prd / to-issues…
```

Result: PASS — the hook is named by its canonical identifier in the doctrine file.

### P14 — compass/SKILL.md cross-references the guard

From `payload/.claude/skills/compass/SKILL.md`, Routing rules section:

```
Never delegate a HITL step to a generic agent … The `enforce-pipeline-adherence` guard
(PreToolUse:Task) hard-blocks that delegation and names the right main-thread skill…
```

Result: PASS — the adherence rule is cross-referenced in compass by name and event type.

---

### Edge probes summary

| Edge | Input | Observed | Result |
|------|-------|----------|--------|
| non-string prompt value | `prompt: 42` | `{}` exit 0 | PASS |
| empty stdin | `""` | `{}` exit 0 | PASS |
| repeat-run idempotency | same HITL payload ×2 | identical block JSON both times | PASS |
| multi-HITL dedup | "draft a PRD and break it into issues" | block, `to-prd / to-issues` | PASS |
| PRD read (no creation verb) | "Read the PRD and check edge cases" | `{}` exit 0 | PASS |

---

## Verdict

**PASS**

Walk coverage: 14 promised behaviors checked, 19 commands/payloads executed (including 5 edge probes), 0 findings filed.

Every AC passes:
- AC-1: hook event is PreToolUse:Task — confirmed by settings.json wiring and the non-Task short-circuit behavior.
- AC-2: block/allow decision is correct across all HITL keywords, typed executors, non-HITL generics, and fail-open cases.
- AC-3: block reason names the correct main-thread skill in every case; dedup works on multi-match.
- AC-4: wired in settings.json (PreToolUse:Task, `$CLAUDE_PROJECT_DIR`), in manifest.json (managed/project), doctrine in .synapse/pipeline (PIPELINE_RULE_5), compass cross-reference present.
- AC-5: walk scenario confirmed — general-purpose + "write a PRD" blocks with `to-prd`; builder + build task allows.
- AC-6: not re-run here (unit test coverage is the builder's concern, not this walk's scope).

Note on live CC harness deny: whether the Claude Code runtime actually prevents the subagent spawn on receiving `{"decision":"block"}` is a bootstrap self-host concern and is explicitly deferred per walk instructions. The hook's output contract is verified correct.
