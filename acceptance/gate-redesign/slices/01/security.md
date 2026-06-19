# Security review — slice gate-01 (universal `wrxn-ci` gate)

- **Slice:** `acceptance/gate-redesign/issues/01-universal-ci-workflow.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`
- **Commit reviewed:** `a0addfe` on `gate-redesign` (`bin/wrxn.cjs`, `lib/ci-checks.cjs`, `manifest.json`, `payload/.github/workflows/wrxn-ci.yml`, `test/ci-checks.test.cjs`)
- **Reviewer:** security executor (read-only)
- **Date:** 2026-06-19

## Verdict: PASS-WITH-FINDINGS

0 critical · 0 high · **3 medium** · **3 low**, under the documented threat model (solo operator; AFK
`reviewer`/`security` agents run *before* the PR; the agent pushes on the operator's token). The slice is a
real net security improvement over the removed `settings.local.json` env-flag gate: it fails **closed** on
every input-corruption case that matters, its child-process use is shell-free, and its workflow secret /
permission posture is exemplary. The findings are defense-in-depth hardening of a control that the ADR bills
as "server-side and stronger than the old disarmable guard" — three of them narrow that gap. None blocks the
build. The conditional escalations below apply **only** if a `wrxn` install ever accepts untrusted fork PRs.

## Posture calls (the five lenses)

| Lens | Call | Basis |
| --- | --- | --- |
| Command / argument injection | **PASS** | `execFileSync(process.execPath, ['--check', file])` — no shell, args-array; node-manifest paths are validated against `..`/absolute by `loadManifest`. The only `eval` is over an **owner-set** repo variable in a secret-less, read-only job (not PR-author-controllable). |
| Path traversal | **PASS-WITH-FINDINGS** | Kernel-manifest-derived paths are confined; receipt- and synapse-content-derived paths are unvalidated but reach only a **no-content existence/byte oracle** (LOW-1). |
| Fail-closed | **PASS** | Corrupt receipt, malformed wiki, empty/missing synapse manifest, invalid JSON, syntax error, and any *thrown* predicate (→ `main()` reject → `exit 1`) all **FAIL** CI. Minor fail-open edges don't touch the core predicates (LOW-2/3). |
| Workflow secrets / permissions | **PASS (exemplary)** | `on: pull_request` (not `pull_request_target`), `permissions: contents: read`, **zero** secrets referenced. Fork PRs get a read-only, secret-less token. |
| `.mcp.json` carve-out | **PASS-WITH-FINDINGS** | Exemption is correctly **scoped** (literal `.mcp.json` only — cannot exempt any other managed file), but leaves the file's spawn-command content with **zero** CI integrity (MED-2). |

## Findings

### MED-1 — managed-integrity trusts an unprotected receipt to define its own audit scope
- **`lib/ci-checks.cjs:45`** (`receipt.files.filter((f) => f.class === 'managed' && f.path !== MCP_PATH)`), reading `wrxn.install.json` via `readReceipt` (`lib/ci-checks.cjs:20-22`, a raw `JSON.parse` — **no** path validation, unlike `loadManifest`).
- **Issue:** the set of files to verify *and their `class`* comes from `wrxn.install.json`, which is **generated state, not a payload file** (`lib/install.cjs:167` `writeReceipt`: "the receipt is generated state, not a payload file"). It is **absent from `manifest.json`** (grep of the manifest returns only `.synapse/*` and `.mcp.json`), so it is never byte-checked. The check that ADR 0007 §5 / PRD US-16 sells as the "server-side, stronger" replacement for the disarmable local guard therefore has a **new disarm**.
- **Exploit:** edit a managed file maliciously (e.g. `.claude/constitution.md`) **and** in the same PR either drop its entry from `receipt.files[]` or flip its `class` from `"managed"` to `"state"`. It falls out of the `managed` filter → unchecked → `managed-integrity` returns `ok`. The planted-drift test (`test/ci-checks.test.cjs:41`) only covers the *un-edited-receipt* case.
- **Severity:** MEDIUM for the solo-operator model — the receipt edit and the file edit are both visible in the PR diff and the AFK reviewer/security stages run pre-PR (compensating control). **HIGH** for any install that accepts untrusted fork PRs (a fork can ship the pair and merge green).
- **Fix:** derive the authoritative managed set from the **kernel `manifest.json`** (already validated by `loadManifest`, delivered by the package), filtered by the install profile read from the receipt. Treat a kernel-managed file that the receipt omits or reclassifies as a **failure**, not a silent skip.

### MED-2 — `.mcp.json` carve-out leaves the highest-value managed file with no content integrity
- **`lib/ci-checks.cjs:45`** (`&& f.path !== MCP_PATH`); `.mcp.json` is class `managed/project` (`manifest.json:466-470`).
- **Issue:** the exemption is correctly **scoped** — it matches the literal `.mcp.json` only and so **cannot** be abused to exempt any *other* managed file (those still byte-compare; `test/ci-checks.test.cjs:41-55` confirms drift/delete are caught). But `.mcp.json` defines MCP **server launch commands** that Claude Code spawns with the operator's privileges on open, and `jsonValidity` checks only that it *parses*, not its content.
- **Exploit:** a PR that injects `"evil": {"command":"node","args":["x.js"]}` into `.mcp.json` passes the **entire** `wrxn-ci` gate (managed-integrity exempts it; json-validity accepts valid JSON). On merge it executes the next time the repo is opened — a local code-execution vector that survives CI.
- **Severity:** MEDIUM. Necessary tradeoff (the file is legitimately operator-*merged*, so byte-equality is wrong), but it is the one managed file with zero content gate.
- **Fix:** replace the blanket skip with **merge-aware** integrity — assert the recon-wrxn server block matches the kernel-canonical entry and flag any server `command` not present in the payload baseline, rather than exempting the file entirely.

### MED-3 — the gate logic itself is unpinned: `npx --yes @gcunharodrigues/wrxn ci`
- **`payload/.github/workflows/wrxn-ci.yml:42`.**
- **Issue:** the workflow fetches the CI gate fresh from npm at `latest` on every PR run. Both the predicate logic *and* the canonical managed sources it compares against come from whatever version resolves. A compromised or mis-tagged publish (npm account compromise, bad `latest`) silently changes the backstop — including the power to return a **false PASS** — with no change to the repo under review.
- **Severity:** MEDIUM (not HIGH): blast radius is capped by `permissions: contents: read` + `on: pull_request` + no secrets, so a hostile package in this job cannot write `main` or exfil secrets; the risk is a **subverted gate**, not RCE-with-secrets.
- **Fix:** pin to the version already recorded in the install — `npx --yes @gcunharodrigues/wrxn@<receipt.kernelVersion> ci` (the receipt records `kernelVersion`, `lib/install.cjs:167`) — or invoke the install's own vendored `wrxn` instead of re-downloading at gate time.

### LOW-1 — unvalidated traversal in receipt/synapse-derived paths (no-content oracle)
- **`lib/ci-checks.cjs:48-49`** (managedIntegrity: `path.join(root, f.path)` / `path.join(pkgRoot,'payload',f.path)` with unvalidated `f.path`) and **`:140`** (synapseManifestLint: `path.join(root,'.synapse', name.toLowerCase())`, where `name` is regex-captured from manifest content at `:129`).
- **Issue:** a crafted `..` segment escapes the install root. Impact is bounded to an **existence / byte-equality oracle** — failure strings print only the attacker-supplied path, never file *content* — on an ephemeral, secret-less runner, hence LOW. The synapse vector is doubly mitigated: `.synapse/manifest` is itself class `managed` (`manifest.json:461-465`), so injecting a traversal domain is also managed drift. Contrast the safe path: `jsonValidity`/`nodeCheck` derive from the kernel manifest, which `loadManifest` rejects `..`/absolute on.
- **Fix:** normalize and confine receipt/synapse paths under `root` (reject `..`) before any fs call, mirroring the manifest validator.

### LOW-2 — an unreadable-but-present wiki page is silently skipped (local fail-open)
- **`lib/ci-checks.cjs:96-100`** — a `.md` page that exists but throws on read is `continue`-skipped, inconsistent with the fail-closed handling of a corrupt receipt/manifest. Low impact (the runner reads its own fresh checkout), but a locked/tampered page would evade wiki-lint.
- **Fix:** treat a read error on a present page as a lint failure.

### LOW-3 — missing receipt / missing kernel manifest make checks vacuous
- **`lib/ci-checks.cjs:35-37`** (no receipt → managed-integrity passes "nothing to verify") and **`:161-163,199-205`** (if `loadManifest` throws, `jsonPaths` drops the manifest set and `cjsPaths`→`[]`, shrinking those checks to near-no-op).
- **Issue:** the no-receipt branch is correct **by design** for a genuine non-install (e.g. the kernel root's own CI has no receipt), but it also means deleting `wrxn.install.json` disables managed-integrity wholesale; the manifest-load branch is safe **only** because `pkgRoot` is the trusted package.
- **Fix (optional):** when other install markers are present (`.synapse/manifest`, `.claude/`) but the receipt is absent, fail rather than pass; surface a kernel-manifest load failure as an error rather than an empty check set.

## What is solid (verified, not assumed)
- **No shell anywhere in the check path.** Only `execFileSync(process.execPath, ['--check', file], {stdio:'pipe'})` (`lib/ci-checks.cjs:190`) — node binary by absolute `process.execPath`, filename as a distinct argv element (and always an absolute `path.join(root, …)`, so it can't be read as a `node` flag). No `exec`/`execSync`/`shell:true` on any file-, wiki-, or manifest-derived input.
- **Fail-closed on the cases that matter.** Corrupt receipt → fail (`:39-43`); malformed wiki → fail; empty/absent synapse manifest → fail (`:118-135`); invalid JSON → fail; syntax error → fail. Any *thrown* predicate propagates through `runChecks` (no internal swallow) to `main().then(…, err => process.exit(1))` (`bin/wrxn.cjs:663-665`) → non-zero → CI fails. The "never vacuous" guarantee is real and tested (`test/ci-checks.test.cjs:192-199`, `211-217`).
- **Workflow secret/permission posture is exemplary.** `on: pull_request` (fork PRs run in fork context with a read-only token and **no** repo secrets — the correct trigger; not `pull_request_target`), `permissions: contents: read`, no `secrets.*` referenced. The `eval "$WRXN_TEST_CMD"` (`wrxn-ci.yml:37`) reads `${{ vars.WRXN_TEST_CMD }}` — a **repo-owner-set** variable, not PR-author input — in a secret-less, write-less job; not attacker-exploitable (informational: prefer `bash -c -- "$WRXN_TEST_CMD"` over `eval` as a style hardening).
- **Carve-out cannot widen.** The `.mcp.json` exemption is a literal-path equality, not a prefix/glob, so it provably cannot be turned into a wildcard that exempts other managed files.
