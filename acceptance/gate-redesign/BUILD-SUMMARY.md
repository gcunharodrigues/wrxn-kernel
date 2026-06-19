# gate-redesign — AFK build summary (ready for human qa-walk)

**Status: AFK phase COMPLETE.** 7/7 slices built test-first and gated per-slice (builder → reviewer → security →
qa-walker). Branch `gate-redesign` (19 commits on `702f92b`). Full suite **762/762 green** (baseline was 626).
**Zero blocking findings across all 21 gate runs.** All MED findings fixed in-build; conditional/LOW findings
filed or deferred (see `carry-forward.md`).

## What the epic does

Replaces the `WRXN_ACTIVE_AGENT`-in-`settings.local.json` push gate (a 2026-06-19-audit-proven live no-op) with a
**server-enforced PR + CI + auto-merge** model, kernel-delivered, uniform across every repo. The agent pushes a
branch → opens a PR → a GitHub `wrxn-main-gate` ruleset blocks direct-push-to-main + requires a green `wrxn-ci`
check → auto-merge lands it on green. No clicks, no env flag.

## Slice scoreboard

| # | Slice | Delivered | Gates | Key commit |
|---|---|---|---|---|
| 01 | Universal CI (`wrxn-ci`) | `lib/ci-checks.cjs` (5 pure predicates) + `wrxn ci` CLI + managed `wrxn-ci.yml` | APPROVE-WF / PASS-WF / walk 13/13 | `a0addfe` |
| 03 | `wrxn ship` + devops | `lib/ship.cjs` + `wrxn ship` CLI + devops.md de-danced | APPROVE-WF / PASS-WF / walk 11 | `0c7f6ab` |
| 07 | Adherence guard | `enforce-pipeline-adherence.cjs` (PreToolUse:Task) + doctrine + compass | APPROVE / PASS / walk 14 | `1e1eb74` |
| 02 | `wrxn protect` + ruleset + migration 005 | `lib/protect.cjs` (`buildRulesetSpec`/`applyProtection`) + migration 005 + update wiring; **CF-1+CF-2 folded** | APPROVE / PASS-WF / walk 12 | `e40721e` (+`4ea456b`) |
| 05 | CD type-gated release | `lib/release.cjs` (`shouldRelease`) + `wrxn release-check` + `release.yml` push-to-main | APPROVE / PASS-WF / walk 21 | `2e68595` (+`6ad5745`) |
| 04 | Retire gates + flip doctrine | delete 3 push hooks; demote managed guards → advisory; constitution+synapse+compass flipped; **CF-4+CF-5** | APPROVE / PASS-WF / walk 15/17 | `8071950` (+`d1d55ed`,`d25aeac`) |
| 06 | recon-wrxn runbook | `recon-wrxn-runbook.md` (reuses protect + slice-01/05 templates) | APPROVE / PASS-WF / walk 16 | `3896337` (+`aa03be2`) |

(WF = with non-blocking findings.) Per-slice gate markers: `acceptance/gate-redesign/slices/<NN>/{review,security,qa-walk}.md`.

## Findings handled in-build (fixed-now, not deferred)

- **slice-02 MED-1** — `wrxn update` silently dropped the protection outcome (the epic's OWN "silent no-op"
  anti-pattern, on the primary delivery path) → fixed `4ea456b`.
- **slice-05 MED-1** — `release.yml` ran npm dependency steps with an ambient `contents:write` token → scoped off
  via `persist-credentials:false` + isolated tag push `6ad5745`.
- **slice-04 gate-redesign-09** — a real-code EPIPE bug in `lib/protect.cjs` (a successful `gh` apply discarded
  on a stdin-write race; also a CI flake) → fixed `d1d55ed`, 5/5 parallel-runs green.
- **slice-04 SEC-LOW-1** — 6 agent specs cited the retired `WRXN_MANAGED_CONFIRM` → `d25aeac`.
- Plus CF-1/CF-2 (gate-02), CF-4/CF-5 (gate-04), slice-03 + slice-06 LOW runbook additions.

## Open items (operator decides at correction-pass / accept)

- **`issues/10-harden-mcp-json-managed-integrity.md`** (SEC-MED, CONDITIONAL) — `.mcp.json` content blind spot;
  gate-04 widened it. Clean fix needs design (operator-extensible file). Solo-model low-risk. **Filed, not fixed.**
- Non-blocking deferrals + the **bootstrap sequence** are in `carry-forward.md` (synapse teaching-docs refresh,
  seeded-routing reach, WRXN-OS wiki-concept reconcile, etc.).

## NOT done by design (the slice boundary)

Live GitHub enforcement — ruleset actually blocks direct push, auto-merges on green, CD publishes — is **not
unit-testable**; every gate verified only what we *send* (specs / commands / YAML shape). It is verified in the
**bootstrap self-host walk** (operator act). The **whole-artifact human qa-walk** (vs the PRD's 20 user stories)
and the single post-accept trunk push are likewise the operator's next acts.

## Next (operator)

1. **Human qa-walk** — walk the assembled branch against the PRD's 20 user stories.
2. **Accept** → **correction pass** for any findings (fix-now re-runs the AFK phase).
3. **Bootstrap** (land-then-apply, see `carry-forward.md` → "Bootstrap requirements"): land `gate-redesign` on
   kernel `main` via the current direct-push (no ruleset there yet) → copy `wrxn-ci.yml` to the kernel root +
   `wrxn protect` the kernel (self-host) → publish `0.11.0` (OIDC) → `npx @gcunharodrigues/wrxn update` all 5
   installs (**WRXN-OS last**) → apply the **recon-wrxn runbook** as a separate one-time setup.
