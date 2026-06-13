# QA-Walk Report — <artifact name>

- **Artifact:** <entry point, e.g. `node tools/skills.cjs`>
- **Batch dir:** `.scratch/<batch-slug>/`
- **Walked:** <YYYY-MM-DD>
- **Walker context:** <fresh isolated subagent | builder's context (caveat)>

## Promises (from PRD + issues)

<!-- Enumerate every promised behavior. Cite its source (user story / issue AC). -->

- P1 — <behavior> [<source: user story / AC-N of issue NN>]
- P2 — …

## Walk plan

<!-- Written BEFORE execution. Every promise → command(s) + expected. Every command → 3 edge probes.
     Mark each command read-only or mutating (mutating → ALL probes sandboxed, per SKILL.md guardrails).
     If a probe class is N/A for a command (e.g. `list` takes no args → bad input N/A), record the row
     as `N/A — <reason>` instead of silently omitting it. An off-artifact "promise" is UNWALKABLE. -->

### P1 — <behavior>

| # | Command | Expected | Probe type |
|---|---------|----------|------------|
| 1.1 | `<command>` | <observable result> | happy path |
| 1.2 | `<command — bad input>` | <clean error + non-zero exit> | bad input |
| 1.3 | `<command — empty state>` | <graceful empty result> | empty state |
| 1.4 | `<command — run twice>` | <identical output / safe no-op> | repeat-run |

### P2 — …

## Execution evidence

<!-- One block per plan item. Record command, exit code, output excerpt, verdict. -->

### 1.1 <behavior> — happy path

```
$ <command>
exit: <code>
<relevant output excerpt>
```

**Verdict:** PASS | FINDING — <one line: matched expected / how it deviated>

### 1.2 …

## Verdict

- **Result:** PASS | FINDINGS (N)
- **Coverage:** <X> promised behaviors checked · <Y> commands run · <Z> edge probes run
- **Findings filed:**
  - `<batch>-NN` — <title>
  - …
- **Caveats:** <e.g. ran in builder's context | write-probes done in temp dir | none>
