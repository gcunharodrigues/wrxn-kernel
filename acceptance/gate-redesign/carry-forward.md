# Carry-forward findings — gate-redesign AFK build

Non-blocking findings raised by a slice's gates that the *owning* slice should fix (cheaper there than a
post-hoc correction pass). Each cites the gate that raised it. Resolve + tick when the owning slice lands.

## For gate-02 (`wrxn protect` + update/receipt wiring — owns the version/receipt logic)

- [ ] **CF-1 — pin `wrxn ci` to the install's kernel version** (reviewer NB1 + security MED-3, slice 01).
  `payload/.github/workflows/wrxn-ci.yml` runs `npx --yes @gcunharodrigues/wrxn ci` → floats to `latest`, so
  `managedIntegrity` byte-compares managed files against the *latest* payload, not the version that laid them →
  version-skew reads as drift with zero tampering. Fails closed (safe) but noisy. Fix: pin the invoked kernel to
  the receipt `kernelVersion` (e.g. `npx --yes @gcunharodrigues/wrxn@$VER ci`, VER read from `wrxn.install.json`).
- [ ] **CF-2 — anchor managed-integrity scope to `manifest.json`, not the receipt** (security MED-1, slice 01).
  `managedIntegrity` derives its managed-file SET from the install's `wrxn.install.json`, which is itself not in
  the manifest and never integrity-checked → editing a managed file + dropping/reclassifying its receipt entry
  passes the check. MED for solo/own-PRs; **HIGH if any install ever takes untrusted fork PRs.** Fix: anchor the
  managed set to the kernel `manifest.json` (source of truth).

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
