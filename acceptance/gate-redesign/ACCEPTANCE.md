# ACCEPTANCE — gate-redesign

**ACCEPTED by the operator on 2026-06-19.** The push-gate redesign epic (PR + CI + auto-merge replaces the
`settings.local.json` env-flag gate — a 2026-06-19-audit-proven live no-op) is accepted on branch `gate-redesign`
(27 commits on `702f92b`, HEAD `713a6f4`, suite **783/783 green**, not yet pushed).

## What was accepted

The full assembled artifact — 7 vertical slices + the correction pass — delivering the server-enforced
PR + CI + auto-merge model, kernel-delivered and uniform across repos. **20/20 PRD user stories delivered**
(`HUMAN-QA-WALK.md`).

## Pipeline trail (every phase, per the constitution)

- **HITL** — grill (8 forks) → PRD (`PRD.md`) → issues (`issues/01..07`) → verticality gate PASS 7/7
  (`verticality-review.md`) → ADR `docs/adr/0007`.
- **AFK** — 7 slices, each `builder → reviewer → security → qa-walker` (markers under `slices/<NN>/`). Zero
  blocking findings; every MED fixed in-build (slice-02 silent-protection, slice-05 supply-chain perms, slice-04
  real-code EPIPE bug, slice-04 SEC-LOW).
- **Human qa-walk** — whole artifact vs the 20 PRD stories → PASS (`HUMAN-QA-WALK.md`).
- **Correction pass** ("fix all") — issue 10 `.mcp.json` (`41cebc0`), seeded routing migration `006` (`4b933de`),
  synapse teaching docs (`54ada8f`), CF-6 + slice-07 nits (`823db31`, `7821ed4`); re-gated review APPROVE /
  security PASS / qa-walk 22/22 (markers under `correction/`).

## Deferred (NOT blocking accept; tracked)

- **CF-2 workspace residual** — deliberately not fixed (no clean cheap fix; documented low; tamper case covered).
- **WRXN-OS wiki concept reconcile** (story 17 tail) — install-state; happens at the WRXN-OS 0.11.0 update.
- **Live GitHub enforcement** (stories 1/3/11/19 tails) — not unit-testable; verified in the bootstrap self-host walk.

## Next — bootstrap (land-then-apply; operator/devops act, fresh session + npm auth)

Per `BUILD-SUMMARY.md` "Next" + `carry-forward.md` "Bootstrap requirements":
land `gate-redesign` → kernel `main` (direct-push, no ruleset there yet) → copy `payload/.github/workflows/wrxn-ci.yml`
to the kernel **ROOT** + `wrxn protect` the kernel (self-host) → publish **0.11.0** (OIDC) →
`npx @gcunharodrigues/wrxn update` all 5 installs (**WRXN-OS last**) → apply the **recon-wrxn runbook** separately.
