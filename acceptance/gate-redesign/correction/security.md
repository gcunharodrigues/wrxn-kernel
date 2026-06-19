# Security review — push-gate-redesign correction pass

- **Scope:** `git diff 8aac4df..HEAD` (5 commits) in `/home/guilherme/Documents/_projects/wrxn-kernel`
- **Reviewer:** security executor (read-only; this report is the only write)
- **Date:** 2026-06-19
- **Suite:** 88/88 green across the 5 touched test files (`ci-checks`, `ship`, `pipeline-adherence`, `refresh-routing-rule-migration`, `gate-doctrine`)

## Verdict: **PASS**

All four correction targets are verified closed by direct runtime probe, not partial read. No
blocking findings. Three accepted residuals are recorded as INFO — none is a regression introduced by
this delta; each is the correct, tightest boundary for the control it lives in.

---

## gate-10 — `.mcp.json` content blind spot (`41cebc0`, `lib/ci-checks.cjs`)

**Posture call: ACTUALLY CLOSED for every kernel-managed server. Residual is correctly bounded.**

`managedIntegrity` no longer blanket-skips `.mcp.json` (`lib/ci-checks.cjs:63` dropped the
`f.path !== MCP_PATH` filter); the entry now routes to `mcpServerFailures` (`lib/ci-checks.cjs:83-84`,
`99-117`), which deep-equals (`util.isDeepStrictEqual`) **the whole server object** for every
KERNEL-MANAGED key present in `payload/.mcp.json`. This is the exact post-condition
`install.cjs mergeMcpServer` (`lib/install.cjs:143`) writes, so a clean install never false-positives.

Probed each mutation against `managedIntegrity` (filtered to `.mcp.json` verdicts):

| Mutation | Result |
|---|---|
| `env` injected (`NODE_OPTIONS=--require /tmp/evil.js`) | **CAUGHT** — `recon-wrxn` drifted |
| `command` swapped (`npx`→`/tmp/evil`) | **CAUGHT** — drifted |
| `--require` injected into `args` | **CAUGHT** — drifted |
| `recon-wrxn` key removed | **CAUGHT** — server "recon-wrxn" is missing |
| `.mcp.json` deleted entirely | **CAUGHT** — managed file missing (`lib/ci-checks.cjs:70-76`; `.mcp.json` is `class:managed, profile:project` → in-profile) |
| corrupt JSON | **CAUGHT, fail-closed** — invalid JSON (`lib/ci-checks.cjs:103-104`; `jsonValidity` also catches) |
| clean recon-wrxn + a legit operator server | **PASS, no false positive** |

Because the comparison is the whole entry via `isDeepStrictEqual`, ANY added/changed/removed field
(including a fresh `env` key) flips the key-set or a value and is caught — so `env`-injection
(`NODE_OPTIONS`/`--require`) is closed, as is command/args swap. JSON.parse yields only own
enumerable properties, so no hidden/non-enumerable key can hide a mutation; key order is irrelevant to
deep-equal, matching the JSON.stringify re-serialization the merge does. recon-wrxn cannot be dropped
silently: removing the key trips "missing", deleting the file trips managed-missing.

- **INFO (accepted residual, not blocking) — `lib/ci-checks.cjs:109-115`:** operator-ADDED server keys
  (absent from the payload, e.g. a fresh `evil-extra`) pass un-judged, and any such server still
  auto-launches on session open. This is the **correct, tightest false-positive-free boundary for a
  managed-INTEGRITY gate**: `.mcp.json` is operator-MERGED, so judging operator keys would false-positive
  on every install that has a legitimate operator MCP server, which would get the gate disabled — a worse
  posture. The residual is a *different* threat class (untrusted operator/PR-supplied MCP content), which
  belongs to a separate "MCP allowlist / new-server review" advisory, not to managed-integrity. An actor
  who can write `.mcp.json` in a repo already holds repo write (and thus many other code-exec vectors), so
  the added server is not uniquely privileged. **No way found to slip a kernel-server mutation past the
  deep-equal.** No fix required; optional future hardening = a separate advisory check that *warns* (does
  not fail) on never-before-seen server keys.

---

## gate-04 — migration 006 mutates a seeded file (`4b933de`, `migrations/006-refresh-routing-rule.cjs`)

**Posture call: SAFE — no injection, no unsafe write/traversal, fail-safe.**

- **No injection:** the replacement (`NEW_ROUTING_RULE_0`, line 31-32) is a frozen 0.11.0 **constant** —
  zero operator/attacker input flows into the written value. `.synapse/routing` is doctrine prose
  consumed as LLM guidance, not executed.
- **No path issue:** write target is `path.join(ctx.target, '.synapse', 'routing')` (line 38). `ctx.target`
  is the install root supplied by `wrxn update` (trusted; `lib/migrate.cjs` passes it). No operator/attacker
  string enters the path → no traversal.
- **Cannot clobber/corrupt operator routing:** the rewrite fires only on a line that BOTH
  `startsWith('ROUTING_RULE_0=')` AND `includes('WRXN_ACTIVE_AGENT')` (line 44). Probe confirmed:
  operator sibling rules, the comment header, and a clean operator `ROUTING_RULE_0=` (no marker) are
  preserved verbatim; trailing newline kept; second run is byte-identical (idempotent — the marker is
  gone after the rewrite).
- **Fail-safe:** the entire `up()` body is wrapped in `try { … } catch {}` (lines 39-54) that swallows
  everything. Probe confirmed a missing routing file and an unreadable routing (dir-in-place) both
  return without throwing. `lib/migrate.cjs:runMigrations` *propagates* a thrown migration to halt
  `wrxn update`, but 006 can never throw → a broken/odd routing can never break `wrxn update`. Matches the
  005 precedent.
- **INFO (narrow, not a security issue) — `migrations/006:44`:** an operator who hand-authored a CUSTOM
  `ROUTING_RULE_0` that itself names `WRXN_ACTIVE_AGENT` would have it overwritten by the constant. This
  is documented and intentional (the marker is the retired mechanism's own identifier); the blast radius
  is one cosmetic doctrine line, not data loss.

---

## gate-03 — `ship` `--` end-of-options guard (`823db31`, `lib/ship.cjs`)

**Posture call: COMPLETE — both bare-positional commands fenced; the dash-leading-branch
argument-injection vector is neutralized.**

Offline proof against a local bare remote:

- WITHOUT `--`: `git push -u origin --delete` → `fatal: --delete doesn't make sense without any refs` —
  git parsed `--delete` as the **delete FLAG** (the injection: would delete a remote ref).
- WITH the fix `git push -u origin -- --delete` (`lib/ship.cjs:38`) → `error: src refspec --delete does
  not match any` — the token is forced to a **refspec** (branch name). Neutralized.
- Control `-- feature-x` reaches refspec resolution cleanly → the `--` does not break the happy path.

`gh pr merge --auto --squash -- <branch>` (`lib/ship.cjs:40`) places the real flags BEFORE the pflag
end-of-options `--`, so `--auto`/`--squash` still parse and a dash-leading branch after `--` is a
positional. `gh pr create` (`lib/ship.cjs:39`) is correctly left unfenced: the branch is the *value* of
`--head`/`--base` (separate argv element), bound positionally by pflag, never a bare positional. No
remaining bare-positional path carries the branch. **No gap.**

---

## gate-07 — adherence-guard null-guard + PRD read-vs-write (`7821ed4`, `enforce-pipeline-adherence.cjs`)

**Posture call: STILL FAILS OPEN on every malformed input; the PRD tighten opened NO real bypass.**

- **Fail-open intact** (`enforce-pipeline-adherence.cjs:97-99`): probed the real `main()` over stdin —
  `null`, `123`, `"str"`, `true`, `[1,2]`, empty, and unparseable `{bad` ALL → exit 0, output `{}`. The
  new `if (!event || typeof event !== 'object')` guard closes the one crash path (`JSON.parse("null")`
  reaching `event.tool_name`); the hook never wedges a session. Fail-open is the correct posture for a
  soft adherence speedbump (threat model = accidental pipeline skip, not an adversary; trivially reworded).
- **Genuine "delegate writing a PRD" still blocked** (branch 1, `:42`): probed — `create`/`write`/`draft`/
  `generate`/`produce`/`prepare the PRD [document]` and even `review and create the PRD document` all →
  **block=true**. Branch 1 (creation verb within 40 of `PRD`) is independent of the new read-verb
  lookbehind, so a read-verb prefix cannot unblock a creation verb. Typed executors (e.g. `builder`)
  remain allowed (they ARE the pipeline, `:75`).
- **Read no longer over-blocked:** `summarize the PRD document` / `read the PRD doc …` → block=false (the
  slice-07 review NB). The variable-length negative lookbehind is valid in Node/V8; quantifiers are all
  bounded → no ReDoS.
- **INFO (pre-existing heuristic limit, not a regression) — `:42`:** a contrived phrasing that uses a
  READ-verb prefix AND omits any creation verb — e.g. `open a new PRD document and fill it in` — slips
  branch 2. This is inherent to a soft, fail-open regex heuristic (omitting the literal "PRD" evades it
  entirely, with or without this change); it is not a new bypass class and not a hard boundary. Common
  creation phrasings stay blocked. No fix required.

---

## Summary table

| Gate | Target | Verdict |
|---|---|---|
| gate-10 | `.mcp.json` deep-equal closes content blind spot | PASS (residual = operator-added servers, correctly bounded, INFO) |
| gate-04 | migration 006 seeded-file refresh | PASS (no injection/traversal, fail-safe) |
| gate-03 | `ship --` end-of-options guard | PASS (complete, proven) |
| gate-07 | adherence null-guard + PRD tighten | PASS (fail-open intact, no real bypass) |
