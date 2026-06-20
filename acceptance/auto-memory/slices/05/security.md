# Security review — auto-memory-05 (migration 007 + handoff/`_slots` removals)

**Verdict: PASS-WITH-FINDINGS** (2 findings, both LOW/informational — no security defect; no blocking issue)
**Slice:** `acceptance/auto-memory/issues/05-migration-removals.md`
**Diff reviewed:** commit `b82343a` atop `cd3560c`, branch `auto-memory`
**Repo:** `/home/guilherme/Documents/_projects/wrxn-kernel`
**Reviewer:** security executor — defensive review (injection / traversal / authz-secret / fail-open vs fail-closed)
**Pushed:** false (security never pushes)

---

## Scope

A destructive migration (`migrations/007-auto-memory-transition.cjs`) that mutates an existing
install on `wrxn update`: deletes the `handoff` skill dir, idempotently wires a `SessionEnd` hook
into the install `settings.json`, seeds `memory.config.json`, removes `_slots/current-focus.md`, and
backfills `.gitignore`. Plus payload removals: the `dream.cjs` `set-focus` op + `wikiForceWritePage`,
and the `wiki.cjs` `--force`/`_slots` overwrite path.

Call paths traced: `lib/update.cjs:86 → lib/migrate.cjs runMigrations() → 007.up({target})`;
`recon_find` over the removed force symbols; payload-wide grep for residual `--force`/`_slots`/handoff
references; the new `test/auto-memory-migration.test.cjs` (13/13 green) executed.

---

## Checklist results

### 1. Destructive-migration safety — PASS
- **`target` is trusted, not attacker-controlled.** `runMigrations(pkgRoot, target, ctx)`
  (`lib/migrate.cjs:52,67`) forwards `target` (the install root holding the receipt, the operator's
  own dir) straight to `up()`. Every filesystem op in `up()` is `path.join(target, <fixed kernel
  constant segments>)` — no path segment derives from untrusted runtime/user input, so there is **no
  path-traversal vector** (`007.cjs:94,99,115,117,130`).
- **Every delete is existence-guarded / best-effort.** handoff dir `rmSync(..., {recursive, force})`
  (`:94`), `_slots/current-focus.md` `rmSync(..., {force})` (`:130`) — `force:true` makes an absent
  target a no-op; an absent settings/config is guarded by `fs.existsSync` (`:100,116`).
- **Delete bounding is exact.** The handoff delete targets exactly
  `<target>/.claude/skills/handoff` (3 fixed segments), never a parent — confirmed the payload dir
  held only `SKILL.md` (single-file removal; no orphan siblings). The slot delete targets exactly
  `.wrxn/wiki/_slots/current-focus.md` (the slot PAGE only); the `_slots` tier dir + gitkeep are
  deliberately retained inert.
- **Symlink posture is acceptable.** `rmSync` on a path that *is* a symlink removes the link, not its
  target (Node does not recurse *through* a symlinked dir). All path segments are kernel-fixed under
  the operator's own install root, so even an interior operator-placed symlink is not a privilege-
  boundary crossing (no traversal *out* driven by attacker data).
- **Never throws → no half-transition.** Each step swallows its own failure (try/catch around the
  JSON parse `:104`; the seed read `:122`; the gitignore read `:52`) and `rmSync force` cannot throw
  on a missing file. The runner records `007` in the receipt only after `up()` returns (`migrate.cjs
  :73`), so a (defensively impossible) throw would leave it resumable, not half-applied. The test
  proves clean/bare/corrupt installs all complete without throwing and the e2e `wrxn update`
  transition records `007`.

### 2. settings.json edit integrity — PASS (fail-closed on corruption)
- **Corrupt/hand-edited settings.json is never clobbered.** Parse failure sets `cfg = null` (`:105`)
  and the write is gated on `cfg && typeof cfg === 'object' && wireSessionEndSpawn(cfg)` (`:107`) —
  an unparseable file is left byte-for-byte untouched while the other steps still run. Test (e)
  asserts this explicitly.
- **No malformed / injected command.** The wired command is a **fixed payload-relative constant**
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs"` (`SPAWN_HOOK_COMMAND`, `:62`) —
  not derived from any untrusted input — and it byte-matches the payload `settings.json:13`
  (parity verified). `$CLAUDE_PROJECT_DIR` is the standard kernel hook-path convention.
- **No duplicate / clobber of existing user hooks.** `wireSessionEndSpawn` (`:67-84`) does a whole-
  config scan and **no-ops if any event already references** `memory-synth-spawn.cjs` (idempotent vs
  the managed overwrite and re-runs), then *appends* a new group to the `SessionEnd` array, preserving
  every other event and every existing group. JSON is re-serialized with `JSON.stringify(cfg,null,2)`
  — structurally valid output.

### 3. .gitignore backfill — PASS
- **Append-only, idempotent, in-root.** `ensureGitignoreLine` (`:47-58`) is byte-identical to the
  vetted `lib/install.cjs:117` helper: read-or-empty, skip if any trimmed line already equals the
  target, append with a newline-prefix guard. It only ever writes `<target>/.gitignore` (in-root) and
  **cannot corrupt** an existing file — it only appends whole lines, never rewrites existing content.
  The seeded lines are static literals (`.env` + dot-prefixed continuity temps); the tracked baton
  `latest.md` is deliberately not ignored.

### 4. Removal of `--force`/`_slots` overwrite path — PASS (no sink reopened)
- **The wiki write sink stays create-only + tier/slug-bounded** (the slice-04 invariant). `runWritePage`
  (`wiki.cjs:122`) still enforces `TIERS.includes(tier)` (whitelist) **and** the kebab regex
  `/^[a-z0-9][a-z0-9-]*$/` on the slug, and is now **strictly** create-only:
  `if (fs.existsSync(dest)) fail(...)` with the `--force` escape hatch fully deleted. Removing the
  exception **narrows** the write capability — it cannot reopen a closed path.
- **`_slots` is genuinely inert.** It remains in `TIERS` (so an existing install's `_slots/` dir keeps
  *querying*), but no write path targets it specially anymore; any write attempt routes through the
  same create-only refuse-overwrite gate as every other tier. `recon_find` over
  `wikiForceWritePage`/`OVERWRITABLE_TIER`/`runSetFocus` returns **zero code callers** (only `.scratch`
  finding-docs + prose), and a payload-wide grep shows the only residual `--force`/`set-focus` strings
  are explanatory comments. The dead overwrite branch is gone with no dangling invoker.

### 5. memory.config.json seed — PASS (no secret)
- **Carries no credential.** `payload/.wrxn/memory.config.json` holds only task→engine/model routing
  (`handoff`/`dream` → `claude`/`gemini` model ids). No API key, token, or secret.
- **Copied from the package payload, not fabricated.** The seed is read from
  `__dirname/../payload/.wrxn/memory.config.json` (`:117-121`) so the seeded shape can never drift from
  a fresh install, and a missing payload source is swallowed best-effort (the managed/seeded update
  path lays it anyway). Seeded only when absent (`:116`) — an operator-customized config is preserved.

---

## Findings

### F1 — Stale prose pointers to the removed `handoff` skill (LOW / informational, doc-accuracy)
**Files:** `payload/.claude/skills/synapse/SKILL.md:65,92`,
`payload/.claude/skills/synapse/references/{brackets.md:33,layers.md:82}`,
`payload/.claude/hooks/{session-start.cjs:7 (comment), synapse-engine.cjs:290}`
**Evidence:** these still instruct/mention "run the handoff skill", which auto-memory-05 deletes
(`memory-synth` is the sole baton writer now). `synapse-engine.cjs:290` emits that line as *guidance
text in a nudge* (not an invocation) — it tells the model to run a skill that no longer exists.
**Security impact:** none. No code path *invokes* the missing skill; nothing throws or fails open. This
is purely a documentation/guidance-accuracy gap.
**Remediation (non-blocking, out of this slice's security mandate):** update the synapse skill/docs and
the `synapse-engine` nudge text to point at the automatic SessionEnd synth. Recommend the build/QA
track pick this up; it does not gate this slice.

### F2 — `recursive` rm of a kernel-fixed dir under an operator-writable root (LOW / informational)
**File:** `migrations/007-auto-memory-transition.cjs:94`
**Evidence:** `fs.rmSync(<target>/.claude/skills/handoff, {recursive:true, force:true})`. If an operator
replaced the real `handoff` dir (or an interior segment) with a symlink, a recursive rm could follow an
*interior* real dir. **Not** a vulnerability: every path segment is kernel-fixed, `target` is the
operator's own install root they fully control, and the deleted path is a known-disposable skill dir —
there is no attacker-controlled segment and no traversal *out* of the install via untrusted data. Noted
only for completeness; this matches the established 004 pattern (`migrations/004:88` rm's the `sessions`
tier the same way) and carries no new risk.

---

## Evidence summary
- `migrations/007-auto-memory-transition.cjs` (full read) — defensive, existence-guarded, never-throws.
- `lib/migrate.cjs:52-77` — `target` provenance trusted; success-only receipt recording (resumable).
- `lib/update.cjs:83-86` — migrations run after the file-class update; receipt already persisted.
- `payload/.wrxn/wiki.cjs:122-140` — write sink stays create-only + `TIERS` whitelist + kebab regex.
- `payload/.wrxn/dream.cjs` diff — `set-focus`/`wikiForceWritePage`/`FOCUS_TIER/SLUG` fully removed.
- `payload/.wrxn/memory.config.json` — routing only, no secret.
- `recon_find` (force symbols) — 0 code callers; payload grep — only comments remain.
- `node --test test/auto-memory-migration.test.cjs` — 13/13 pass (clean/bare/corrupt no-throw + e2e).

**Bottom line:** no injection, no path traversal, no secret handling defect, fail-closed on a corrupt
settings.json, the destructive deletes are existence-guarded + exactly bounded, and removing the
`--force`/`_slots` path narrows (not widens) the wiki write capability. The two findings are LOW
documentation/defense-in-depth notes that do not block the slice.
