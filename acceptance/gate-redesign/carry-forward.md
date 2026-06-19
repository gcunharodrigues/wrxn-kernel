# Carry-forward findings — gate-redesign AFK build

Non-blocking findings raised by a slice's gates that the *owning* slice should fix (cheaper there than a
post-hoc correction pass). Each cites the gate that raised it. Resolve + tick when the owning slice lands.

## For gate-02 (`wrxn protect` + update/receipt wiring — owns the version/receipt logic)

- [x] **CF-1 — pin `wrxn ci` to the install's kernel version** ✅ folded into gate-02 (`e40721e`). (reviewer NB1 + security MED-3, slice 01).
  `payload/.github/workflows/wrxn-ci.yml` runs `npx --yes @gcunharodrigues/wrxn ci` → floats to `latest`, so
  `managedIntegrity` byte-compares managed files against the *latest* payload, not the version that laid them →
  version-skew reads as drift with zero tampering. Fails closed (safe) but noisy. Fix: pin the invoked kernel to
  the receipt `kernelVersion` (e.g. `npx --yes @gcunharodrigues/wrxn@$VER ci`, VER read from `wrxn.install.json`).
- [x] **CF-2 — anchor managed-integrity scope to `manifest.json`, not the receipt** ✅ folded into gate-02
  (`e40721e`). (security MED-1, slice 01.) `managedIntegrity` now anchors its managed SET to the kernel
  `manifest.json`; the receipt is trusted only for profile, and a present managed file must byte-match regardless
  → dropping/reclassifying or profile-flipping a receipt entry can no longer hide drift.

## Resolved during the build (not deferred)

- **CF-1 + CF-2** — folded into gate-02 (`e40721e`).
- **slice-02 security MED-1** — `wrxn update` silently dropped `report.protection` (the epic's own "silent
  no-op gate" anti-pattern, on the PRIMARY delivery path). **Closed in `4ea456b`**: update now prints
  `protection: …` / `protection skipped: …`; fail-soft preserved (still exit 0).
- **slice-02 security LOW-1** — `parseSlug` too permissive. **Closed in `4ea456b`** (strict `owner/repo` grammar
  rejecting `../x`, spaces, `;`, `$()`, backticks).

## Slice-02 deferred (non-blocking; decide at correction pass / bootstrap)

- **LOW-2** — a fresh `wrxn init` does not apply protection; installs are unprotected until their first
  `wrxn update` (when a remote usually exists). By-design-ish; bootstrap/onboarding docs should note "protection
  lands on first update after a remote exists." Note, don't fix unless cheap.
- **review NB (CF-2 residual)** — for files present ONLY in the workspace profile, the missing-file branch still
  trusts the receipt profile (a present file always byte-matches regardless). Bounded residual, not the MED-1 hole.
- **review NB** — standalone `wrxn protect` returns exit 0 even on hard inability (AC-conformant; `update` safety
  is independent). Optional: non-zero on hard failure for standalone only.

## For gate-04 (doctrine/guard hardening + the repo-wide grep-clean)

- [ ] **CF-3 — `.mcp.json` content blind spot** (reviewer NB2 + security MED-2, slice 01).
  `.mcp.json` is class `managed` but operator-MERGED, so it's exempted from byte-equality and only JSON-parse
  checked → an injected MCP server `command` passes the whole gate and runs on next session open. Fix: replace the
  blanket skip with a merge-aware allow-list (assert the recon-wrxn server key/command shape survives), not a skip.
  (Could also be a filed follow-up — conditional on a fork-PR threat; not a solo-model blocker.)
- [ ] **CF-4 — `lib/executor.cjs` still emits the dance** (reviewer N2, slice 03) — **REQUIRED for gate-04's
  repo-wide grep-clean AC.** `buildDispatchSpec('devops')` (`lib/executor.cjs:~83`) still emits
  `WRXN_ACTIVE_AGENT` guidance, pinned by `test/executor.test.cjs:~95-101`. gate-04 must rewrite that spec to the
  `wrxn ship` model AND flip the pinning test, or `git grep WRXN_ACTIVE_AGENT` won't be clean.
- [ ] **CF-5 — tighten `devops.md` tools** (security LOW-2, slice 03). `payload/.claude/agents/devops.md`
  frontmatter `tools: Read, Edit, Write, Bash` → `Read, Bash`. `Edit`/`Write` existed only for the deleted
  settings.local.json edit and are dead under `wrxn ship`. Least-privilege; trivial.
- [ ] **CF-6 — `ship` end-of-options guard** (security LOW-1, slice 03; *optional* hardening). `buildShipPlan`
  emits `gh pr merge <branch> …` / `git push -u origin <branch>` with a bare positional; a dash-leading branch
  name could be read as a flag. Add a `--` end-of-options separator or validate the branch name. Triple-mitigated
  + attended today; do only if cheap.

## Notes for gate-06 (recon-wrxn) — not a wrxn install

- `recon-wrxn` has **no `wrxn.install.json` receipt** → `managedIntegrity` (and any receipt-scoped check) is
  vacuous there. The runbook + any recon-wrxn CI must not rely on managed-integrity; its universal checks reduce to
  wiki-lint / JSON / `node --check` over whatever payload-shaped files it has, or none. Flagged by review (slice 01
  "universal-checks no-op on non-install repos") + security LOW-3.

## Low / informational (no slice owns; note only)

- `wikiLint` swallows a per-file read error (fail-open on one unreadable page) — does NOT break the closed-on-crash
  property of the gate overall (entrypoint `exit 1` on any thrown predicate). Leave unless cheap.
- **slice-07 null nit** (security INFO): `enforce-pipeline-adherence.cjs:~88,94` — `JSON.parse("null")` returns
  `null` past the parse `try`, then `null.tool_name` throws uncaught (exit 1). Still **fails open** (exit 1 ≠
  block-exit 2) and unreachable in practice (CC never emits literal `null`). Optional 1-liner:
  `if (!event || typeof event !== 'object') return emit({});` after the parse block.
- **slice-07 PRD-doc over-block** (review NB1): the `\bPRD\b…\b(document|doc)\b` branch fires on a read-only
  "summarize the PRD document" delegated to a generic agent — safe-direction false positive (over-block is
  recoverable). Optional tighten; not worth a re-dispatch.
