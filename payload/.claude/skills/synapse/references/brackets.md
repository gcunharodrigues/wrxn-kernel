# SYNAPSE token budget & handoff

*(This reference covers the flat token-budget governor and the non-blocking handoff directive — the
two controls SYNAPSE applies after it assembles the layer sections.)*

## The flat token budget

Everything except the constitution is trimmable. SYNAPSE applies ONE flat budget — there are no
per-tier or per-window budgets.

- **Budget:** `RULES_BUDGET_TOKENS` in `.synapse/manifest` (default `600`), overridable per session
  with the `WRXN_RULES_BUDGET` env var.
- **Estimate:** a section's token cost is estimated as `ceil(characters / 4)`.
- **Exempt:** the constitution (L0) sits outside the budget and is always kept.
- **How it trims:** the trimmable sections keep manifest order. While the kept set is over budget,
  whole sections are dropped from the END of that order first — the last-declared domain goes first,
  so earlier-declared domains have higher priority. Sections are dropped whole, never partially.
- **What it records:** if anything was dropped, a line is appended naming the dropped domains:

```
[SYNAPSE-RULES-TRIM] ROUTING dropped over the 600-token rules budget
```

## The handoff directive

When the real consumed context reaches the handoff threshold, SYNAPSE appends a **non-blocking**
`[HANDOFF REQUIRED]` directive. It never refuses work — it orders a clean wrap-up:

```
[HANDOFF REQUIRED]
  Context is at ~42% of the model window (>= the 40% handoff threshold). NON-BLOCKING — do NOT stop work:
  1. Finish the current request.
  2. Run the handoff skill to write the baton (a compact handoff document).
  3. Tell the operator to /clear and open a fresh session, where the baton injects on resume.
```

Like the constitution, the handoff directive is outside the budget — it is never trimmed.

### The threshold

`consumed = resident_tokens / model_window`. The directive fires when `consumed >=` the threshold.
The threshold is resolved as: `WRXN_HANDOFF_PCT` env var > `HANDOFF_PCT` in the manifest > `0.40`.

### Resident tokens

The real tokens currently resident in context: the last assistant turn's
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` read from the session
transcript (output tokens are excluded — they are not resident in the next prompt). If the transcript
is unreadable, the handoff math is skipped silently.

### The model window

The window is resolved by an explicit precedence, so the math is correct on both 200k and 1M sessions
instead of assuming a fixed window:

1. `WRXN_CONTEXT_WINDOW` env var (a positive number wins unconditionally).
2. The live statusline sidecar for the session (tracks a mid-session model switch).
3. `CONTEXT_WINDOW` in `.synapse/manifest`.
4. `~/.claude.json` — a model id tagged `[1m]` ⇒ 1,000,000.
5. Self-correcting net: resident already past 200,000 ⇒ the window must be larger (1,000,000).
6. Fallback: 200,000.

## Why a flat budget

An earlier engine varied the budget by an estimate of how much window remained. This engine does not:
one flat budget keeps assembly cheap and predictable, and the handoff directive — driven by real
token usage — covers the "running low" case directly instead of through tiered injection.

## Source

| File | Purpose |
|------|---------|
| `.claude/hooks/synapse-engine.cjs` | `applyBudget`, `estimateTokens`, `resolveBudget`; `readResidentTokens`, `modelWindow`, `resolveHandoffPct`, `handoffDirective`. |
| `.synapse/manifest` | `RULES_BUDGET_TOKENS`, `HANDOFF_PCT`, `CONTEXT_WINDOW`. |
