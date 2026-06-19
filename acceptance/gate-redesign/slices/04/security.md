# Security review — gate-04 (retire push-gates + demote managed-guard + reconcile doctrine)

- **Slice:** `acceptance/gate-redesign/issues/04-retire-pushgates-reconcile-doctrine.md`
- **Commit:** `8071950` on `gate-redesign` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`
- **Reviewer:** security executor (defensive) · **Date:** 2026-06-19

## Verdict: PASS-WITH-FINDINGS

The central question — *is the protection posture still sound after removing the local gates?* — is
**yes, and net stronger at the code level**. The deleted client-side gates were a proven live no-op
(audit F1–F8); their server-side replacement (the `wrxn-main-gate` ruleset + the `wrxn-ci`
managed-integrity check) genuinely exists in the tree, is correctly ordered ahead of this slice, is
unbypassable once applied, and introduces no new client-writable authority. The change is clean of
injection and self-authorization. Two scoped residuals and one operational precondition (below) keep
this from a clean PASS; none is an AC failure or a blocker under the solo-operator threat model.

---

## Posture calls (the four required axes)

### 1. Transition safety / no protection gap — SOUND (with an operational precondition)
- **Ordering verified, no commit-window gap.** gate-02 ruleset (`e40721e`) and gate-01 CI (`a0addfe`)
  are both **ancestors** of gate-04 (`8071950`) — confirmed via `git merge-base --is-ancestor`. At the
  commit that deletes the local gates, the server teeth already exist in-tree. Issue-04 "Blocked by 02"
  held.
- **The replacement teeth are real, not hollow:**
  - `lib/protect.cjs:36-65` `buildRulesetSpec` — `enforcement:'active'`, **`bypass_actors:[]`** (the
    agent on the operator's token cannot quietly bypass), require a PR, block `deletion`/`non_fast_forward`,
    and require the `wrxn-ci` check with `strict_required_status_checks_policy:true` (race-safety).
  - `lib/ci-checks.cjs:37-81` `managedIntegrity` — byte-compares every managed file against the
    canonical kernel payload, with the managed SET anchored to `manifest.json` (CF-2), and a present
    file must byte-match **regardless of the receipt-claimed profile** (line 73-78) — so a
    dropped/reclassified/profile-flipped receipt entry can no longer hide drift.
  - `payload/.github/workflows/wrxn-ci.yml:10-14,41-54` — runs on `pull_request`, `permissions:
    contents: read` (least privilege), runs the universal checks **always** (even with no project
    suite), and pins the kernel to the receipt `kernelVersion` (CF-1) so version skew isn't read as
    drift.
- **Net:** removing zero-enforcement local machinery loses no real protection; the server gate is the
  control that survives every bypass (terminal, IDE, MCP, API, `--no-verify`, the disarm bug). ADR
  0007's "stronger, not just lower-friction" claim holds **at the code level**.
- **Operational precondition (INFO, not a gate-04 code defect):** live enforcement exists only once
  `applyProtection` has actually run against each repo's GitHub origin with an admin token. It is
  **fail-soft** (`lib/protect.cjs:101-135`: no `gh` / not admin / no remote / any non-zero → skip, exit
  0). So a repo can transiently sit with the local gates gone **and** the ruleset not-yet-applied. This
  is owned by gate-02's apply path + the documented bootstrap (land → self-host apply → publish →
  propagate, **WRXN-OS last**), the skip outcome is surfaced on `update` (gate-02 MED-1, `4ea456b`), and
  the PRD "honest limit" + carry-forward "Bootstrap requirements" name it. Flagged so the final
  human-accept verifies the kernel-self-host apply actually succeeded before relying on the posture.

### 2. Advisory-guard residual — SOUND for the managed set, with one real hole (`.mcp.json`)
- For the general managed set, "advisory locally + CI managed-integrity server-side" is a genuine
  net-stronger replacement: the advisory only nudges, the byte-exact manifest-anchored CI check is the
  teeth. Good.
- **The one scenario where a managed-file tamper slips through unwarned AND unchecked is `.mcp.json`**
  — see Finding SEC-MED-1.

### 3. Doctrine integrity — ACCURATE and SAFE-DIRECTIONAL (one stale token)
- Constitution Art. I + III, `.synapse/global` (GLOBAL_RULE_0/_4), `.synapse/routing` (ROUTING_RULE_0),
  and `compass` are correctly rewritten to the PR + CI + auto-merge model. No rewritten rule instructs
  an agent to do anything that bypasses the ruleset; `payload/.claude/agents/devops.md:35-37` explicitly
  says *"do not attempt to bypass it"* and *"never push directly to the trunk."* `gate-doctrine.test.cjs`
  is a durable regression guard for the grep-clean.
- `migrations/002-seeded-honesty.cjs:28` retains the **old** ROUTING_RULE_0 string — verified
  **intentional and correctly handled**: 002 is a frozen historical transform to the 0.2.1 baseline, and
  `test/seeded-honesty-migration.test.cjs` was updated to assert against the frozen migration constant
  (not the evolving template). Not a finding.
- One stale doctrine reference survives — see Finding SEC-LOW-1.

### 4. No new env-flag self-authorization — CONFIRMED CLEAN
- The slice **removes** client authority and adds none. Deleted `enforce-push-authority.cjs` removed the
  `WRXN_ACTIVE_AGENT` read; the demoted guards no longer read `WRXN_MANAGED_CONFIRM`
  (`enforce-managed-guard.cjs:62`, `enforce-managed-precommit.cjs:68` — comment only). `lib/ship.cjs`
  has **no `process.env` at all** (no env-gated authority). The ruleset's `bypass_actors:[]` means
  authority is server-side and not client-writable. Repo-wide `WRXN_ACTIVE_AGENT` grep is clean of live
  payload/bin/doctrine (only the ADR history, the ship.cjs explanatory comment, the frozen migration-002
  constant, and absence-asserting tests remain — all legitimate).

### Changed-hook code — INJECTION-CLEAN
- Both demoted hooks use node stdlib only (`fs`/`path`; precommit reads staged files via
  `execFileSync('git', ['diff','--cached','--name-only'])` — args array, **no shell, no eval**). The
  emitted `additionalContext` is model-context **text**, never executed; the interpolated values (`rel`,
  `hits.join`) are filesystem paths constrained to the known managed set (`managedPaths(root).includes`
  / `managed.has`), so even prompt-injection-via-filename is bounded to kernel file paths. The guard
  keeps its path-traversal check (`enforce-managed-guard.cjs:58`, `rel.startsWith('..')` → silent).
  Both fail open on bad/empty stdin (exit 0). No crash is load-bearing (they never block).

---

## Findings

### SEC-MED-1 — `.mcp.json` content tamper now slips both layers (open carry-forward CF-3)
- **Severity:** MEDIUM (HIGH if any install ever accepts untrusted fork PRs — slice-01's own rating).
- **Where:** `lib/ci-checks.cjs:57` (`f.path !== MCP_PATH` exemption) + `lib/ci-checks.cjs:33-36`
  (rationale) · `payload/.claude/hooks/enforce-managed-guard.cjs:62-68` (demotion) ·
  `acceptance/gate-redesign/carry-forward.md:44-48` (CF-3, still `[ ]`).
- **Issue/exploit:** `.mcp.json` is class `managed` but operator-MERGED, so `managedIntegrity` **exempts
  it from the byte-equality check** and it is only JSON-parse validated (`jsonValidity`). An injected MCP
  server `command` in `.mcp.json` is well-formed JSON → it **passes the entire server-side CI gate**, and
  MCP servers auto-launch on session open → arbitrary command execution. Before this slice, the local
  managed-guard at least *blocked* an `.mcp.json` edit via the CC Edit/Write surface; gate-04 demotes
  that to an advisory, so the content is now **advisory-only locally and skipped server-side** — the one
  managed file with no real integrity teeth on either layer.
- **Scope/evidence:** Pre-existing from slice-01's `managedIntegrity` design (gate-04 does **not** touch
  `lib/ci-checks.cjs` — `git show 8071950 --stat` is empty for it); triaged as slice-01 security MED-2;
  explicitly assigned to gate-04 as **carry-forward CF-3, which remains unchecked**. gate-04 is the slice
  that removes the local counterpart, so it materially widens the exposure of this known gap. Requires
  write access to the branch/`.mcp.json`; under the solo-operator model the live vector is a malicious
  fork PR or supply-chain tamper.
- **Fix (CF-3, as written):** replace the blanket `MCP_PATH` skip with a **merge-aware allow-list** —
  assert the kernel-owned recon-wrxn server key/`command` shape is intact and no extra
  `command`/`args`-bearing server was injected — instead of skipping the file wholesale. Alternatively,
  file as a tracked follow-up and have the operator consciously accept the residual for the solo model.

### SEC-LOW-1 — doctrine still cites the retired "managed-confirm token" in all 6 agent specs
- **Severity:** LOW (safe-directional — does not induce an unsafe action).
- **Where:** `payload/.claude/agents/{builder,devops,qa-walker,researcher,reviewer,security}.md` — the
  Constraints line *"Do not edit managed (kernel-owned) files without the managed-confirm token."*
  (e.g. `devops.md:38`).
- **Issue:** gate-04 **retired** `WRXN_MANAGED_CONFIRM` (the guards no longer read it), but the reconcile
  pass left these six specs telling agents to gate managed-file edits behind a token that is now inert.
  This is a doctrine-vs-reality contradiction the slice's intent ("doctrine matches reality; zero env
  flags remain") aimed to remove. Impact is low and over-cautious-directional: worst case an agent tries
  to set a no-op token; the advisory still fires and CI is the real teeth.
- **Evidence:** `git grep -i managed-confirm 8071950 -- payload/.claude/agents` → 6 hits; the guards'
  own comments (`enforce-managed-guard.cjs:62`) state the token is retired.
- **Fix:** reword to match the new advisory text, e.g. *"edit managed (kernel-owned) files only as a
  deliberate kernel change that lands through the PR + CI gate."* (Not an issue-04 AC — that AC scoped
  the grep-clean to `WRXN_ACTIVE_AGENT`/`settings.local.json` — so optional, but a cheap doctrine-hygiene
  cleanup the operator may fold here or file.)

---

## Checks performed
- Full diff of `8071950` (20 files); ancestor proof gate-02/gate-01 → gate-04; repo-wide
  `WRXN_ACTIVE_AGENT` / `WRXN_MANAGED_CONFIRM` greps across the gate-04 tree (clean of live
  payload/bin/doctrine); read of the server teeth (`lib/protect.cjs`, `lib/ci-checks.cjs`,
  `payload/.github/workflows/wrxn-ci.yml`); both demoted hooks read in full (no shell/eval); full
  PreToolUse wiring (`Edit|Write`→managed-guard, `Bash`→managed-precommit, `Task`→pipeline-adherence
  intact; the 3 push-gate hooks unwired); `lib/ship.cjs` env-auth check; ADR 0007 + PRD + issue-04 +
  carry-forward cross-read.
- Not run: the test suite / coverage (QA lane). Live GitHub ruleset enforcement is verifiable only in the
  bootstrap self-host walk (PRD honest limit) — outside this slice's diff.
