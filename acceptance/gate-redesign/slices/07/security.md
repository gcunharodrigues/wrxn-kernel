# Security review — gate-07 pipeline-adherence guard

- **Slice:** `acceptance/gate-redesign/issues/07-pipeline-adherence-guard.md`
- **Build commit:** `1e1eb74` on `gate-redesign`
- **Reviewer:** security executor (read-only; this report is the only write)
- **Verdict: PASS**

A fail-open `PreToolUse:Task` hook that parses the model-authored Task event from stdin and emits a
soft `block` nudge when a non-typed agent is handed a HITL step. It is pure string matching — no shell,
no `eval`, no `child_process`, no filesystem writes, no path inputs, no secret handling. No security
findings. One INFO-level robustness nit (below) that is itself fail-open and therefore security-neutral.

## Threat-lens posture calls

### Fail-open correctness — CORRECT
This guard is intentionally fail-open and that is the right call. It is **not a security control**: the
real authority is the server-side gate-02 ruleset + CI (PRD/ADR 0007 — "CI is the SOLE hard gate"). The
guard targets a process/quality concern (silently skipping the HITL pipeline), not C/I/A. Every new
branch fails open — `decide()` returns `{block:false}` on empty prompt (`:69`), missing type (`:70`),
typed-executor allowlist hit (`:71`), and no-keyword (`:73`); `main()` fails open on parse error
(`:89-90`) and non-`Task` tool (`:94`). The **only** path that blocks is a deliberate HITL-keyword match
on a non-typed agent (`:75`, `:101`). Crucially there is **no branch that fails *closed* on malformed or
adversarial input**, so the guard cannot be weaponized to wedge a session (no DoS-via-block). A
hard-fail variant would be strictly worse — it could brick a session on a parse hiccup, the exact
failure the AC forbids. Fail-open creates no security-relevant bypass here because the guard is not the
boundary the bypass would have to cross.

### ReDoS / input handling — SAFE (empirically verified)
The four keyword regexes (`:38`, `:43`, `:47`, `:51`) carry no catastrophic-backtracking structure: the
alternation groups `(writ\w*|creat\w*|…)` are **not** quantified, and the only wildcards are
**bounded** spans `[\s\S]{0,40}` / `{0,60}` / `{0,25}`. No nested unbounded quantifier over an ambiguous
class, so worst case is linear with a small constant. Verified by feeding adversarial inputs through the
real `decide()`:

```
   3.19 ms  block=false  len=60000   60k creation-verb prefix, no PRD
   3.27 ms  block=false  len=60000   60k issue-verb prefix, no issues
   3.11 ms  block=false  len=290000  verb + near-miss "PR D" repeated
   2.20 ms  block=true   len=455000  verticality flood
```

455k-char crafted prompts evaluate in ~3 ms — no blowup. `fs.readFileSync(0)` (`:87`) reads stdin
unbounded in principle, but the source is the Claude Code Task event the model itself authored (not an
external feed), the read is inside the `try` (`:86-91` → fail open on throw), and there is no shell
interpolation of prompt text anywhere — the prompt is only passed to `RegExp.test()`.

### Information leak — NONE
The block `reason` (`reasonFor`, `:56-63`) is a **static** template plus the deduped join of hardcoded
skill names (`to-prd` / `to-issues` / `grill`, from the `HITL_STEPS[].skill` literals at `:36-53`). It
echoes **no** prompt text, no env, no paths, no secrets — the `${list}` interpolation is provably
constrained to the hardcoded skill set. The reason is returned to the orchestrator model, not an
external user, and carries only self-correction guidance.

### Bypass-scope honesty — HONEST (no overclaim)
The slice claims only what it enforces. PRD "Out of Scope" explicitly scopes this to "the *detectable*
bypass; the rest stays doctrine + compass," and the doctrine text (`PIPELINE_RULE_5`, compass SKILL.md
`:61-65`) says the hook hard-blocks *that delegation* (the `Task` seam) — it does not claim to stop a
main-thread agent doing the HITL step inline, or non-keyword phrasings. The keyword heuristic is
inherently evadable by rephrasing, which is acceptable precisely because this is a nudge, not a control,
and is honestly bounded. No claim of repository-wide or pipeline-wide enforcement.

## Findings

None (security). One non-blocking robustness observation:

- **INFO — `payload/.claude/hooks/enforce-pipeline-adherence.cjs:88,94` — uncaught crash on literal
  `null` stdin; security-neutral (fails open).**
  Evidence: the `try` at `:86-91` guards only `JSON.parse` *throwing*. `JSON.parse("null")` *succeeds*
  and returns `null`, so `event = null` (`:88`) flows past the catch; `event.tool_name` at `:94` then
  throws `TypeError: Cannot read properties of null` — uncaught, process exits 1. Reproduced:
  `printf 'null' | node …enforce-pipeline-adherence.cjs` → exit 1; primitives (`123`, `"str"`, `true`,
  `[]`) are handled gracefully (exit 0, `{}`).
  Impact: **none.** Claude Code emits a structured event object, never literal `null`, so the path is
  practically unreachable; and even when hit, exit 1 is treated as a *non-blocking* PreToolUse error
  (only exit 2 / `{decision:"block"}` blocks), so the Task spawn proceeds — consistent with the
  fail-open design. It cannot cause an erroneous block.
  Fix (optional hardening, not required for PASS): guard the post-parse body, e.g.
  `if (!event || typeof event !== 'object') return emit({});` after `:91`, or wrap `main()`'s body in a
  try → `emit({})`.

## Scope notes (not gate-07 findings)

- `RULES_BUDGET_TOKENS` 800→900 (`payload/.synapse/manifest`) is **benign**. The synapse engine marks
  the Constitution `always:true` (`synapse-engine.cjs:314`) and filters it out *before* `applyBudget`
  (`:347-349`); it is "OUTSIDE the budget and always kept … NEVER trimmed" (`:17,:139`). Raising the
  ceiling can only keep *more* trimmable doctrine (incl. security-relevant GLOBAL rules), never crowd
  out the Constitution. Sole cost is ~100 more always-on context tokens — economy, not security.
- `payload/.synapse/global` `GLOBAL_RULE_0/_4` still describe the *old* `WRXN_ACTIVE_AGENT` env-flag
  gate. That doctrine reconciliation is a *different* slice's job (PRD: rewrite Art. I/III + synapse
  rule text under the push-gate retirement slices), explicitly out of scope for gate-07. Noted, not a
  finding here.
