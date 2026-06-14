# Publishing wrxn (wrxn-kernel-23)

Pre-flight done 2026-06-13. The package is **publish-ready**. Publish + tag are operator/@devops acts
(outward-facing, irreversible-ish) — this doc is the checklist + the exact commands.

## Readiness (verified)

- [x] **Name** — unscoped `wrxn` is 404 (untaken) BUT npm's publish-time similarity filter REJECTS it
      (too similar to `when`/`cron`/`rx`, E403). **Published scoped as `@gcunharodrigues/wrxn`** (operator
      decision, 2026-06-14). The `bin` command stays `wrxn`; install/run use the scoped name.
- [x] **Tarball clean** — `npm pack --dry-run`: 100 files, 120 kB. Top level: `bin lib manifest.json
      migrations payload package.json README.md`. The `files` allowlist excludes `test/`, `.scratch/`,
      `acceptance/` (0 leaked).
- [x] **Cold install simulated** — packed the tarball, installed it in a clean temp env, then:
      `npx @gcunharodrigues/wrxn --version`; `npx @gcunharodrigues/wrxn init --project --root <tmp>` → 80 files laid, receipt
      present. (AC-1 intent, minus the live registry.)
- [x] **Tests green** — 147/147 (`npm test`).
- [x] **Dogfood record archived** — `acceptance/dogfood-01-todo-cli/` (wrxn-kernel-22, ACCEPTED).
- [x] `private: false`, `bin.wrxn`, `engines.node >=20` set.

## Decisions

1. **Version — DECIDED: `0.1.0`** (operator, 2026-06-13). `package.json` bumped 0.0.1 → 0.1.0 to
   signal the first minor release.
2. **License — DECIDED: `MIT`** (operator, 2026-06-13). Open source. `LICENSE` file added
   (© 2026 Guilherme Cunha Rodrigues); `package.json` `license: "MIT"`.

## Publish (operator / @devops — when the two decisions above are settled)

```
# from the kernel repo root, on a clean main with the build pushed:
npm test                                   # confirm green
npm publish --access public                # @devops act — goes LIVE on npm
# then tag the release in the repo (Constitution Art. II — tags are devops-only):
AIOX_ACTIVE_AGENT=devops git tag -a v0.1.0 -m "wrxn v0.1.0 — first public release"
AIOX_ACTIVE_AGENT=devops git push origin v0.1.0
```

## Post-publish acceptance (AC-1, against the LIVE registry)

```
cd $(mktemp -d) && npx @gcunharodrigues/wrxn@latest init --project && cat wrxn.install.json
```

Then 23 can be closed and 24/25/26 (workspace-conversion, migrate mail-agent, migrate wrxn-site)
unblock.
