# 02 — builder executor agent + conformance validator (tracer)

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` · ADR `docs/adr/0006-hitl-front-afk-per-slice-flow.md`

## What to build

Give the AFK dispatch contract (`lib/executor.cjs`) a native-subagent face, as a **thin wrapper** — the
agent file carries no logic the harness doesn't already define. Add a pure `validateAgentFile(agentDef,
type)` that checks an executor agent definition conforms to `EXECUTORS[type]`: it declares least-privilege
tools, a model, and an output contract equal to that type's `reportSchema`. Add the **builder** agent as
the tracer through that validator. End-to-end: the builder agent definition exists, parses, and passes
conformance; the validator rejects a malformed or over-privileged agent.

## Acceptance criteria

- [ ] `validateAgentFile(def, type)` returns ok for a conforming agent and errors for: missing tools, missing model, output contract ≠ that type's `reportSchema`, unknown type.
- [ ] A `builder` executor agent definition exists that wraps the contract: reads+follows the tdd skill, honors the boundary gates (incl. no-push), returns the builder `reportSchema`; declares least-priv tools (Read, Edit, Write, Bash, Grep, Glob, recon impact/find/explain) and model opus.
- [ ] The builder agent passes `validateAgentFile`.
- [ ] Unit tests cover the conforming case + each failure mode (Seam 1a; prior art: the `lib/executor.cjs` tests).
- [ ] The builder agent is registered as managed payload (manifest).
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- None — can start immediately.
