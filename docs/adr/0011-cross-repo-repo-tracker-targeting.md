# ADR 0011 — Cross-repo `--repo owner/repo` tracker targeting for to-prd / to-issues / triage

- **Status:** Accepted (2026-06-28) — PRD #114 (`grill-me`, 5 forks), expands #92. **Closes the
  cross-repo seam ADR 0009 documented** (delivers the "close" half of #81 AC#4).
- **Context:** When the operator develops the kernel **from a workspace-install session**, `to-prd` /
  `to-issues` / `triage` publish to *this install's* configured tracker (local-markdown `.scratch/`),
  not the kernel's GitHub tracker. So speccing a kernel feature has **no pipeline path** — the operator
  goes manual on the kernel tracker (`gh issue create -R …`), bypassing the four-phase flow and tripping
  the main-thread **Pipeline-adherence guard**. ADR 0009 identified this cross-repo seam as the guard's
  **root enabler** and deliberately scoped its fix out as "its own feature, own ADR when built"
  (ADR 0009, decision pt 6). #89/#90 shipped the **"document"** half (ADR 0009 + the guard); this ADR
  records the **"close"** half.

## Decision

Add a `--repo owner/repo` GitHub-target override to `to-prd`, `to-issues`, and `triage`, resolved
through **one shared helper** — `payload/.wrxn/tracker-target.cjs` (the `.wrxn/*.cjs` pattern the skills
already invoke: `chat-search.cjs`, `dream.cjs`, `wiki.cjs`). Locked choices:

1. **One pure decision core + an injected gh boundary**, mirroring `lib/release-cut.cjs`. The pure
   `resolveTarget(rawRepo, defaultConfig)` returns a descriptor `{ mechanism: 'github' | 'local', repo,
   ghBaseArgs }`; the gh create/label/close side-effects run through an injected `gh` runner, so the
   decision + emitted spec are unit-testable with **no live gh**. All three skills resolve through this
   one module, so validation, label handling, and gh-arg construction are identical across them.
2. **`--repo owner/repo` is the GitHub-target override.** **Absent** → `{ mechanism:'local' }`, the
   install's configured default (local-md `.scratch/`), unchanged. **Present + valid** → `{
   mechanism:'github', repo, ghBaseArgs:['-R', repo] }`, published via `gh`. Targets are GitHub by
   construction (the flag is `owner/repo`-shaped); works for the kernel **and** `recon-wrxn`.
3. **No git-remote inference.** The tracker TYPE is a config choice, not derivable from the remote — the
   install proves it (GitHub remote, local-md tracker). The repo is passed explicitly to `gh -R`.
4. **Label vocab = the shared wrxn triage states** (`ready-for-agent` / `backlog` / `epic`), applied via
   `gh … --label`. No per-target label config; `gh` errors loud if the target lacks a label (free remote
   validation), and the helper never swallows that — a mis-labeled issue never lands silently. An
   off-vocab label is refused before the boundary (no silent mis-label from our side).
5. **Validation is loud and pre-publish.** A malformed / empty / whitespace / trailing `--repo` (not
   exactly `owner/repo`) throws a user-facing error **before any side-effect**, so a bad invocation never
   half-files. **Absent** (the flag omitted) is distinct from **empty** (the flag passed with no value):
   omitted → local; empty → refuse.
6. **`to-prd --repo` and `to-issues --repo` hit the SAME target**, so a slice's "Parent" reference is a
   real issue number on that tracker.
7. **One vertical slice:** the resolver + the three skill wirings + the docs land together as a single
   tracer bullet (#115).

## Considered and rejected

- **Git-remote inference of the target** — conflates the install's GitHub remote with its local-md
  tracker; the tracker type is configured, not derived (decision pt 3).
- **A config mapping of target names → repos** — YAGNI for two GitHub siblings; explicit `owner/repo`
  is clearer and needs no new state.
- **Non-GitHub targets / a general any-tracker abstraction** — the targets are GitHub (kernel +
  recon-wrxn); a generic tracker-type layer is speculative.
- **Per-target label config / auto-creating missing labels** — `gh` failing loud on an absent label is
  free validation; the operator creates the label once. Auto-create hides a mis-configured target.
- **Reconfiguring the install's DEFAULT tracker** — the override is per-invocation by design; the
  default stays local-md so existing install-local workflows are untouched.

## Consequences

- **Snake eats tail:** this PRD + its slice are the **last** manual cross-repo filing — once shipped, the
  flag removes its own need, eliminating the Pipeline-adherence guard's **root cause** (not just warning
  on the symptom, ADR 0009). #81 AC#4 is now closed on both halves (document + close).
- **The helper ships as a managed payload file** (`.wrxn/tracker-target.cjs`, registered in
  `manifest.json`); like every managed file it is kernel-owned and overwritten on update.
- **Kernel change** propagates only on publish + per-install `npx @gcunharodrigues/wrxn update`; WRXN-OS
  updates last.

## Sources

PRD #114 (`grill-me`, 2026-06-28; expands #92) / issue #115. ADR 0009 (the cross-repo seam this closes;
decision pt 6 scoped the fix here). #81 AC#4 ("close or document" — #89/#90 documented, this closes).
`lib/release-cut.cjs` (the pure-core + injected-boundary test-seam prior art).
`payload/.claude/skills/setup-matt-pocock-skills/issue-tracker-github.md` (the reused `gh` mechanics).
