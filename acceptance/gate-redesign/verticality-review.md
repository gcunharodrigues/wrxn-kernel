# Verticality gate — gate-redesign

Date: 2026-06-19 · Gate: HITL phase (grill → PRD → issues → **verticality**). Verdict: **PASS** (7/7).

Each slice checked against the four failure modes (horizontal, not-demoable, too-coarse, dependency-error):

| # | Slice | Vertical (cuts all layers)? | Demoable / walkable? | Right-grained? | Deps correct? | Verdict |
|---|---|---|---|---|---|---|
| 01 | Universal CI workflow | Yes — workflow + pure check predicates + tests | Yes — a PR runs the `wrxn-ci` check | Yes | — | PASS |
| 02 | `wrxn protect` + ruleset + migration 005 | Yes — lib + CLI + update-wiring + migration + tests | Yes — `protect` applies the ruleset; re-run no-op | Yes (mechanism + delivery cohere) | ←01 | PASS |
| 03 | `wrxn ship` + devops rewrite | Yes — lib + CLI + agent doc + tests | Yes — `ship` opens a PR w/ auto-merge | Yes | — | PASS |
| 04 | Retire push-gates + reconcile doctrine | Yes — deletions + settings + guard + doctrine | Yes — fresh session: no flag, managed edit warns | Coarse **on purpose** (code+doctrine must flip in lockstep; splitting forces a contradictory intermediate commit) | ←02 (no protection gap) | PASS |
| 05 | CD type-gated release-on-merge | Yes — pure type-gate + workflow + tests | Yes — `fix:` merge publishes, `chore:` doesn't | Yes | ←01 | PASS |
| 06 | Apply gate to `recon-wrxn` | Yes — runbook + repo-agnostic protect reuse | Yes — recon-wrxn PR runs CI + auto-merges | Yes (one-time setup, reuses 01/02/05) | ←01,02,05 | PASS |
| 07 | Pipeline-adherence guard hook | Yes — hook + tests + doctrine + compass xref | Yes — generic-agent PRD spawn is blocked | Yes | — | PASS |

Notes:
- **04 coarseness is deliberate**, not a too-coarse failure: the Constitution/synapse/wiki doctrine and the hook deletions must land together or an intermediate commit contradicts itself. Considered split 04a (code) / 04b (doctrine) — rejected, they cannot land independently.
- **DAG** has no cycle: 01 → {02, 05}; 02 → {04, 06}; 05 → 06; 03, 07 free. Parallelizable front: 01, 03, 07.
- The real server-side enforcement (ruleset blocks, auto-merge, CD publish) is verified in the **bootstrap self-host walk**, not `node --test` — flagged in each affected slice and the PRD's "Further Notes."

HITL phase COMPLETE → ready for the AFK phase (per the bootstrap sequence: restart → build on a branch in the kernel).
