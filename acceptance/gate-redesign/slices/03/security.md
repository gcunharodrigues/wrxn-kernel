# Security review — slice gate-03 (`wrxn ship`: autonomous PR + auto-merge promote path)

- **Slice:** `acceptance/gate-redesign/issues/03-ship-devops-rewrite.md` · ADR `docs/adr/0007-push-gate-pr-ci-automerge.md`
- **Commit reviewed:** `0c7f6ab` on `gate-redesign` (`lib/ship.cjs` *new*, `bin/wrxn.cjs` ship cmd, `payload/.claude/agents/devops.md` rewrite, `test/ship.test.cjs` *new*, `test/agent-conformance.test.cjs`)
- **Reviewer:** security executor (read-only)
- **Date:** 2026-06-19

## Verdict: PASS-WITH-FINDINGS

0 critical · 0 high · 0 medium · **2 low** · 3 informational, under the documented threat model (solo
operator; AFK `reviewer`/`security` run *before* the PR; the agent promotes on the operator's `gh` token;
runs **attended**). This slice is a real net security improvement: it deletes a client-side env-flag gate the
2026-06-19 audit proved a **live no-op** (F1) and replaces it with a promote path that is **shell-free**,
**fail-closed**, **token-agnostic** (it never touches the token), and that holds **zero** trunk-merge authority
of its own — it pushes a feature branch and opens a PR, then defers entirely to the server-enforced gate-02
ruleset. Both findings are defense-in-depth hardening; neither blocks the build.

## Posture calls (the lenses asked for)

| Lens | Call | Basis |
| --- | --- | --- |
| Command / argument injection — shell metachars | **PASS** | `spawnSync(step.cmd, step.args, {encoding:'utf8'})` (`lib/ship.cjs:46`) — **no `shell` option → `shell:false`**. `$()`, backticks, `;`, `\|`, `&&`, newlines in title/body/branch/base are inert literal argv elements; no shell to interpret them. Mirrors the reviewed `lib/connect.cjs` prior art. |
| Argument / flag injection — title & body especially | **PASS** | Every user value is bound **positionally to its own flag**: `--base <base> --head <branch> --title <title> --body <body>` (`lib/ship.cjs:34`). `gh` (cobra/pflag) and `git` consume the immediately-following token as that flag's value even if it begins with `-`, so a `--title "--malicious"` becomes the literal title, **not** a new flag. No `--` confusion, no arg-splitting. |
| Secret / token handling | **PASS** | `ship.cjs` never reads, references, echoes, logs, or persists any token; `gh` authenticates from its own credential store. No env auth, **no file writes at all**. Success detail is minimal (`cmd args[0] exited N` + stderr; `:51`); `gh`/`git` don't print tokens to stderr. Auto-merge **does not widen authority** (see below). |
| Fail posture (fail-closed) | **PASS** | `ship()` returns on the first `!r.ok` (`lib/ship.cjs:63-66`) — a failed push **never** reaches `gh pr create`/`gh pr merge` (no partial promote; test-pinned). `defaultInvoke` is fail-closed: ENOENT/spawn error → `ok:false` (`:47-48`), non-zero exit → `ok:false` (`:51`). A crash cannot read as success. |
| `devops.md` least-privilege | **PASS-WITH-FINDING (LOW-2)** | The new process uses only **Read + Bash**; `Edit`/`Write` are now dead capability left over from the deleted settings.local.json dance. Recommend tightening — non-blocking. |
| Authority model (new client-side bypass?) | **PASS** | `ship` only ever pushes the **feature branch** (`git push -u origin <branch>`, `:33`) and opens a PR; it has **no trunk-push primitive** and never merges itself. The trunk is server-protected by the gate-02 ruleset. Strictly stronger than the removed Bash-only hook (ADR: "a client-side hook can never be hard enforcement"). |

## Findings

### LOW-1 — `branch` rides as a bare positional into `git push` / `gh pr merge` (no `--` end-of-options guard)
- **`lib/ship.cjs:33`** (`args: ['push', '-u', 'origin', branch]`) and **`:35`** (`args: ['pr', 'merge', branch, '--auto', '--squash']`).
- **Issue:** unlike title/body/base/head, `branch` is **not** bound to a preceding flag — it is a standalone positional. A value beginning with `-` is therefore eligible to be parsed as an **option** by `git`/`gh` rather than a ref. e.g. `branch = "--mirror"` → `git push -u origin --mirror` (push *all* refs); `branch = "--repo"` → `gh pr merge --repo --auto --squash` (flag/value confusion). This is the classic argument-injection residue that shell-free spawning does **not** by itself close.
- **Severity:** **LOW**, triple-mitigated: (a) the default branch comes from `git branch --show-current` (`bin/wrxn.cjs:479`), and git porcelain will not produce/check-out a dash-leading ref, so the auto path can't yield one; (b) reaching it via `--branch` requires the operator to deliberately type a dash-leading value (self-harm); (c) the command runs **attended**. There is no untrusted-input path to `branch` in this threat model.
- **Fix:** insert an end-of-options separator before the positional where the tool supports it — `gh pr merge -- <branch>` (cobra honours `--`), and pass the branch to `git push` as an explicit `refs/heads/<branch>` refspec (or validate `branch` against `^[A-Za-z0-9][A-Za-z0-9._/-]*$` in `buildShipPlan`, rejecting a leading `-`, alongside the existing blank check at `:29`).

### LOW-2 — `devops` agent keeps `Edit`/`Write`, now-dead capability beyond the promote path's need
- **`payload/.claude/agents/devops.md`** frontmatter `tools: Read, Edit, Write, Bash`.
- **Issue:** the rewritten process needs **Read** (verify the gate inputs) + **Bash** (`wrxn ship`, then `gh pr view --json autoMergeRequest`); the structured report is **returned**, not written to a file. `Edit`/`Write` existed solely for the deleted set→push→unset `settings.local.json` dance — the very mechanism this slice removes. Leaving them grants the one push-path agent standing authority to mutate managed/source files, exactly the authority the redesign set out to strip from the promote step. Not a *new* exploit (attended; the body still forbids editing managed files without the token), but it violates least-privilege and contradicts the slice's own intent.
- **Severity:** **LOW**, non-blocking.
- **Fix:** tighten to `tools: Read, Bash`. (Verified against the new body — no step writes or edits a file.)

## Informational (not findings)

- **INFO-1 — `ship.ship()` is not wrapped in try/catch at the CLI** (`bin/wrxn.cjs:498`), unlike the dry-run `buildShipPlan` call (`:488-493`). Harmless today (branch/title are pre-validated at `:485-486`, so the inner `buildShipPlan` can't throw, and `spawnSync` reports errors via the return object rather than throwing) — and an uncaught throw would still exit non-zero = **fail-closed**, just with a stack trace. A defensive try/catch → `return 2` would make a hypothetical spawn-layer throw a clean "promote halted" instead.
- **INFO-2 — the ENOENT error detail joins *all* args** (`lib/ship.cjs:48`, `${step.cmd} ${step.args.join(' ')} did not run`), echoing title+body to the terminal — but **only** when the binary is missing, and title/body are destined to be **public PR content**, not secrets; no token is ever in `args`. Operator note (not a code defect): do not place a secret in `--body`, since it also becomes a public PR body. The success path already prints only `args[0]` (`:51`).
- **INFO-3 — `ship` does not guard `branch === base`** (a `wrxn ship --branch main` would `git push -u origin main`). By design it relies wholly on the gate-02 server ruleset to block direct pushes to the trunk — consistent with the ADR's server-enforced model. A belt-and-suspenders `if (branch === base) refuse` in `buildShipPlan` would harden the client too, but is not required by the model.

## What is solid (verified, not assumed)
- **No shell on any path.** The only child-process calls in the slice are `spawnSync(step.cmd, step.args, {encoding:'utf8'})` (`lib/ship.cjs:46`, no `shell` key) and `execFileSync('git', ['-C', root, 'branch', '--show-current'], …)` (`bin/wrxn.cjs:479`, args-array, `root` is `path.resolve`d). No `exec`/`execSync`/`shell:true` anywhere. Metacharacters in title/body/branch/base cannot execute or chain commands.
- **Flag values are positionally bound.** `buildShipPlan` (`lib/ship.cjs:32-36`) places each user value immediately after its own `--flag`, so a flag-looking value is consumed as that flag's argument, not as injected `gh`/`git` options. The one exception (the bare `branch` positional) is LOW-1.
- **Fail-closed, stop-on-first-failure.** `ship()` halts on the first failed step (`:63-66`); `defaultInvoke` counts a step as success **iff** it actually ran and exited 0 (`:47-51`). A failed push provably never opens a PR or arms auto-merge (`test/ship.test.cjs` "ship STOPS at the first failing step").
- **Token never handled.** `ship.cjs` performs no auth, reads no token env/file, writes no file, and emits no token to stdout/stderr. `gh` owns its own credentials.
- **Auto-merge does not widen authority.** `gh pr merge --auto --squash` arms a *deferred* merge that GitHub performs only when the required CI checks pass; with no ruleset/required-checks `gh` errors (no merge = fail-closed). It cooperates with the gate-02 server gate rather than bypassing it.
- **No new client bypass.** `ship` exposes no trunk-push or self-merge primitive — it pushes a feature branch and opens a PR. Authority over `main` is entirely server-side (gate-02), which the ADR establishes as the only control that survives every client path (terminal, IDE, MCP, API, `--no-verify`). The only caller of the `ship` builder is the validated `bin/wrxn.cjs` CLI path (grep-confirmed; nothing reaches the command builder unguarded).
