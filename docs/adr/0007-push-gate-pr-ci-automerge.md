# ADR 0007 — Push authority: PR + CI + auto-merge replaces the settings.local.json env-flag gate

- **Status:** Accepted (2026-06-19) — push-gate-redesign grill (8 forks locked). PRD: `acceptance/gate-redesign/PRD.md`.
- **Context:** Constitution Art. I holds remote git ops behind a "deliberate-push confirmation flag":
  `WRXN_ACTIVE_AGENT=devops` set in machine-local `.claude/settings.local.json`, read by the PreToolUse:Bash
  hook `enforce-push-authority.cjs`. A 2026-06-19 security audit proved this gate is a **live no-op**: Claude
  Code injects `settings.local.json` env **additively** into the session process, and removing a key from the
  file does **not** unset it from the running process — so the documented `edit → push → revert` dance arms the
  flag but never disarms it, degrading to permanent-allow for the rest of the session (audit F1/F2, verified by
  a spawned process still seeing `WRXN_ACTIVE_AGENT=devops` with the file clean). The same audit found the gate
  only constrains the CC Bash tool (a human terminal, IDE, or non-Bash path is ungated — F5), the review-marker
  is a self-attested file (F6), the tests gate is a `true` stub (F4), and `REMOTE_OP` is regex-evadable (F3).
  A client-side hook can **never** be hard enforcement — it gates one tool surface, not the repository.
- **Decision drivers:** (1) the operator wants the **agent** to land `main` autonomously — zero GitHub clicks,
  zero `settings.local.json` friction — but with a **correct, race-safe CI/CD** so "directly up" is still
  *certain*; (2) the only control that survives every bypass (human, MCP, API, `--no-verify`, the disarm bug)
  is **server-side** branch protection; (3) a solo operator cannot both author and human-approve a PR, so the
  authority must be **automated checks**, not a human review click; (4) the kernel is the OS — one flow,
  delivered to every install on `update`, not configured per repo by hand; (5) REUSE > CREATE — the `lib/`
  injectable-invoker pattern (`connect`/`executor`/`worktree`) and the existing OIDC `release.yml` are proven.

## Decision

The deliberate-push **env-flag gate is removed entirely** and replaced by a **PR + CI + auto-merge** model that
is **server-enforced** and **kernel-delivered**. Eight locked choices:

1. **PR + auto-merge; CI is the SOLE hard gate.** The agent pushes a branch → opens a PR → a GitHub ruleset
   blocks direct push to `main` and requires a green CI check → the agent enables auto-merge → GitHub merges the
   instant CI is green. **No human review** (a solo account cannot approve-then-self-merge), **no env flag, no
   `settings.local.json`**. "Deliberate act" becomes *"nothing reaches `main` un-green."*
2. **Uniform across all repos; the kernel is the single source.** `wrxn update` pulls the kernel and configures
   the repo — it lays the CI workflow and applies the ruleset, so every install inherits the same flow.
3. **Delivery.** CI workflow `.github/workflows/wrxn-ci.yml` is a **managed payload file**. The branch ruleset
   `wrxn-main-gate` is **auto-applied idempotently by `wrxn update`** via `gh api` (create-or-update; **fail-soft**
   if no `gh` auth / not admin / no remote); migration `005` performs the first application. The **universal CI
   gate** runs the project `WRXN_TEST_CMD` (when real) **plus** kernel-universal checks (managed-integrity,
   wiki-lint, synapse-manifest lint, JSON validity, `node --check`) — **CI is never `true`**. The ruleset applies
   to **everyone, no bypass actor** (the agent uses the operator's token; break-glass = temporarily disable).
4. **CD = type-gated release-on-merge.** On merge to `main`, conventional commits drive the release:
   `feat`/`fix`/`perf`/breaking → auto-bump + publish to npm; `chore`/`docs`/`refactor`/`test` → no publish.
   Reuse the existing npm **OIDC tokenless + provenance** publish; `concurrency`-locked so two merges can't
   double-publish. Published repos only (`wrxn-kernel`, `recon-wrxn`); non-published "release" = the merge.
5. **Retire the local push-gates.** Delete `enforce-push-authority`, `enforce-review-marker`,
   `enforce-tests-on-push` (superseded by the ruleset + CI). Demote `enforce-managed-guard`/`-precommit` to a
   **non-blocking advisory** (drop `WRXN_MANAGED_CONFIRM`); managed-integrity is enforced in CI instead.
   **Zero env flags remain.** The `devops` executor's job changes from "set→push→unset" to **`wrxn ship`**
   (branch → push → PR → enable auto-merge).
6. **Race-safety.** Ruleset "require branch up to date before merge" + auto-merge serialize merges; add a **merge
   queue** if the account plan supports it, else fall back to require-up-to-date.
7. **Doctrine reconciled.** Constitution Art. I (deliberate act = PR+CI+auto-merge, not a settings flag) and
   Art. III ("green suite" = CI; review/security = the AFK agents + CI, not a human-review marker) are rewritten;
   the `payload/.synapse/*` rule text and the wiki concept `wrxn-git-push-authority-hook.md` follow.
8. **Pipeline-adherence guard (the meta-fix).** A `PreToolUse:Task` hook blocks delegating a **HITL step**
   (PRD / issues / grill / verticality) to a non-typed-executor (esp. `general-purpose`), pointing at the right
   skill — because the `[PIPELINE]` doctrine was *present* when the orchestrator skipped it on 2026-06-19, so
   soft doctrine alone is insufficient. Paired with sharpened doctrine + a `compass` cross-reference. Fail-open.

## Consequences

- **Stronger, not just lower-friction:** protection moves from a disarmable Bash-only hook to a server ruleset +
  CI that no client path can bypass. The audit findings F1–F8 (push-side) and F10 **evaporate** when the three
  push-hooks are deleted.
- **Kernel change:** propagates only on publish (`0.11.0`) + per-install `npx @gcunharodrigues/wrxn update`;
  WRXN-OS updates **last**. `recon-wrxn` is a sibling published repo (not a `wrxn` install), so the payload never
  reaches it — it gets the same CI + ruleset + CD applied as a one-time setup (slice `gate-06`).
- **Bootstrap:** the epic can't land *through* the flow it creates — build on a branch → **land once via the
  current direct-push** (kernel has no ruleset yet) → **self-host** (apply the ruleset to the kernel) → publish
  → propagate. This session is disarmed (F1); the build runs in a **fresh restarted session**.
- **Test honesty:** unit tests verify only what we *send* (specs/commands) + local logic; that GitHub *enforces*
  the ruleset, auto-merges on green, and CD publishes is verified only in the **bootstrap self-host walk**.
- **Security review enforcement (audit F9)** stays the AFK `security` agent stage; an optional CI security job
  (`npm audit`) is out of scope here.

## Considered and rejected

- **Human-merge PR** (require a human approval) — the operator explicitly will not click "merge" for personal
  changes; and a solo account can't approve its own PR. Rejected for the autonomy requirement.
- **Keep direct-push + gold-plate the client speedbump** — a hook can never be hard enforcement (Bash-only,
  disarmable); leaves Art. III unenforceable on `main`.
- **One-shot TTL intent file** instead of the env flag — fixes the lifecycle bug but is still an agent-writable
  self-authorization and still client-side friction; the server ruleset subsumes it.
- **Signed commits / Sigstore-gitsign (L4)** — accountability, not authorization; deferred (not blocking).
- **Doctrine-only reinforcement** for pipeline adherence — proven insufficient live (the rule was injected and
  skipped anyway); the hook is the spine.

## Sources

The push-gate-redesign grill (8 forks, 2026-06-19). The security audit (`.scratch/push-gate-redesign/00-audit.md`,
findings F1–F11; F1/F2 verified live). The gold-standard research (5-layer defense-in-depth; agent-speedbump vs
server hard-enforcement). The five `payload/.claude/hooks/enforce-*.cjs`. `lib/connect.cjs` / `lib/executor.cjs`
(injectable-invoker prior art). `.github/workflows/release.yml` (OIDC publish to adapt). Constitution Arts. I+III.
The kernel propagate rule (publish + per-install update).
