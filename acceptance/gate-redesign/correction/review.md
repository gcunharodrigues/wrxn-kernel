# Review — push-gate-redesign correction pass (5 commits, `8aac4df..HEAD`)

Reviewer: fresh-eyes executor · Date: 2026-06-19 · Repo: `wrxn-kernel`
Delta reviewed: `41cebc0`, `4b933de`, `54ada8f`, `823db31`, `7821ed4`
Suite: **783/783 green** (re-run locally). Working tree clean. Test declarations 732 → 753 (+21, coverage up; no test removed net or weakened).

## Verdict: APPROVE — ship. 0 blocking, 2 non-blocking (informational, no action required).

Every fix delivers its contract; each was verified against ALL sources (issue text, the merge post-condition it claims, the seeded template, and empirical execution), not a partial read.

---

## Per-fix met / not-met

- **`41cebc0` [gate-10] harden `.mcp.json` managed-integrity — MET.** All 4 ACs satisfied. `managedIntegrity` now includes `.mcp.json` in the managed set and routes it to `mcpServerFailures`, which deep-equals every payload-keyed (kernel-managed) server entry and leaves operator-added keys alone. Tampered command, removed kernel server, and corrupt JSON all fail closed; operator-added server(s) pass with no false positive (2 tests). Policy is the exact post-condition of `install.cjs mergeMcpServer`.
- **`4b933de` [gate-04] migration 006 routing refresh — MET.** Marker-gated, idempotent, operator-safe, missing/unreadable-safe, runs after 005, mirrors 002. Frozen constant === current seeded template (transcription guard + independent check). E2E through `wrxn update` verified (seed preserved → migration refreshes → records 006, resumable).
- **`54ada8f` [gate-04] synapse teaching docs — MET.** grep-clean of all four stale markers across `payload/.claude/skills/synapse/` (empty). Teaching structure preserved; new `gate-doctrine.test.cjs` block is a durable regression guard. Managed → propagates on update.
- **`823db31` [gate-03] ship `--` end-of-options guard — MET.** Empirically parses and pushes (`git push -u <remote> -- branch` → exit 0). `gh pr merge` keeps its flags before `--`; `gh pr create` correctly untouched (branch is a flag VALUE, not a bare positional). Existing tests updated to the new arg order (correct expectation change, not weakened) + a new dash-leading-branch test with a structural invariant.
- **`7821ed4` [gate-07] null-guard + PRD read-vs-write tighten — MET.** Null-guard placed after parse / before field access → `JSON.parse("null")` and bare scalars fail open. PRD regex: read-verb negative lookbehind removes the "summarize the PRD document" false positive; branch-1 creation verb still blocks "write a PRD" / "create the PRD document". Empirically 9/9 boundary cases pass.

---

## Verdicts on the 6 scrutiny points

1. **gate-10 policy correctness — PASS.** Deep-equals the right set (keys present in `payload/.mcp.json` = recon-wrxn), passes operator-added keys, fails tampered/removed/corrupt, no false positive. The "deep-equal whole entry" is sound: `mergeMcpServer` writes `operator.mcpServers['recon-wrxn'] = payload.mcpServers['recon-wrxn']` (exact copy, incl. any future env block), and BOTH `init` (install.cjs:69) and `update` (update.cjs MCP branch) call the same merge, so the install entry stays in lockstep with the node_modules payload the CI reads — CF-1 version-pinning in `args` is kept synced by update, so no version-drift false positive. Present-but-whole-file-missing is handled by the in-profile missing-file branch.

2. **migration 006 safety — PASS.** The `startsWith('ROUTING_RULE_0=') && includes('WRXN_ACTIVE_AGENT')` guard genuinely scopes the rewrite to rule 0; the marker is absent from the new rule (verified) → idempotent / already-new = no-op; operator-edited or marker-absent rule 0 = untouched; a marker mention in a SIBLING rule = untouched (test); missing/unreadable = no-op, no-throw, no file created (tests). Header, sibling rules, and operator-added lines preserved verbatim; trailing newline kept. Loads in id order right after 005.

3. **teaching docs — PASS.** `git grep` of `WRXN_ACTIVE_AGENT | confirmation flag | green-suite push gate | settings.local.json` over the synapse skill dir is empty. The illustrative `[CONSTITUTION]/[GLOBAL]/[RECALL]` and `.synapse/global` examples were rewritten in place to `wrxn ship` + server-enforced CI — no lesson broken, layer/budget structure intact.

4. **ship `--` guard — PASS.** `--` sits before the bare positional branch in `git push` and `gh pr merge`; the real flags (`-u`/`origin`, `--auto`/`--squash`) stay before `--`. `gh pr create` is correctly left alone (branch rides `--head`/`--base` as a value). Empirical push to a local bare remote succeeded. Tests updated, not weakened.

5. **null-guard + PRD tighten — PASS.** `JSON.parse("null")` (and number/string/boolean) now fail open to `{}` before reaching `event.tool_name`. The tighten only RELAXES branch 2 for a nearby read verb; branch 1 (creation verb) is byte-identical to before, so the real block cannot regress while the false positive is removed. "summarize, then write the PRD document" still blocks (creation wins).

6. **no regression — PASS.** 783/783; +21 test declarations (coverage up); tree clean; only the 5 fixes' files touched; migrations correctly ship as a package dir, not a manifest entry (consistent with 002/003).

---

## Non-blocking (informational — optional, no action required)

- **N1 [gate-03, gh pr create]:** the branch rides `--head <branch>` as a separate-token VALUE. The comment correctly reasons it needs no `--`. For belt-and-braces against a dash-leading branch, the `=`-joined `--head=<branch>` form would remove even the theoretical "flag needs an argument" parse-error edge — but branch names here are controlled (`track/<id>`) and a parse error is fail-safe (no option-injection), so this is truly optional, not a defect.
- **N2 [gate-10]:** `mcpServerFailures` re-parses the install `.mcp.json` independently of the separate `jsonValidity` check, so a corrupt `.mcp.json` produces two failure lines (one per check). Harmless defense-in-depth — the source comment already notes it. Not worth collapsing.
