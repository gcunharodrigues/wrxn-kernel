# Security review — `integration/flow-redesign`

**Scope:** `git diff main...integration/flow-redesign` (wrxn-kernel infra: node-stdlib libs, `bin/wrxn.cjs` CLI, payload markdown agents + skills).
**Reviewer discipline:** `/security-review` (defensive).
**Date:** 2026-06-18

## Verdict: PASS-WITH-FINDINGS

No high/critical issues. The security-sensitive surfaces are sound: `git` is invoked without a shell (no command injection), gates fail **closed**, no secrets are read or logged, the push-authority model is intact, and least-privilege is largely observed. The only real defects are two **local-only hardening gaps** in the new `wrxn flow status` CLI (path traversal + an unescaped regex built from the `prd` arg and issue filenames), both bounded to a tool the operator runs against their own repo, with no privilege boundary crossed. Four informational notes round it out.

Diff surface reviewed: `bin/wrxn.cjs` (+flow status), `lib/flow-status.cjs`, `lib/agent-conformance.cjs`, `lib/compass-coverage.cjs`, `payload/.claude/agents/{builder,devops,qa-walker,researcher,reviewer,security}.md`, `payload/.claude/skills/{compass,qa-walk}/SKILL.md`, `payload/.synapse/pipeline`, `manifest.json`, tests. Libs are **package code** (not in manifest → not shipped to installs; run from the kernel against the operator's cwd). Agents + compass skill ship as `managed`/`project` payload.

---

## Findings (severity-ranked)

### F1 — Path traversal via `prd` in `wrxn flow status` (Low)
**`bin/wrxn.cjs`** (flow status handler):
```js
const root = path.resolve(args.flags.root || process.cwd());
const issuesDir = path.join(root, '.scratch', prd, 'issues');   // prd = args._[2], unvalidated
...
fs.readdirSync(issuesDir) ... fs.readFileSync(path.join(issuesDir, f), 'utf8')
// and findArtifactFile() joins prd into .scratch/<prd>/ candidates
```
`prd` flows unsanitized into `path.join`. `wrxn flow status ../../../../some/dir` resolves `issuesDir` outside `.scratch/<prd>`, letting the command list and read `*.md` files (and probe artifact-file existence) anywhere under the filesystem the operator can read.

**Risk:** Low. This is a local operator-run CLI; the operator already holds that FS read access, so no privilege boundary is crossed. It becomes meaningful only if `flow status` is ever driven by a less-trusted `prd` (e.g., a slug derived from issue/PRD text in an AFK flow), where it would turn into arbitrary `*.md` disclosure. Read-only; no write/exec.

**Fix:** validate `prd` against `/^[A-Za-z0-9._-]+$/` (reject up front), and/or assert containment after resolution, e.g. `path.resolve(issuesDir).startsWith(path.resolve(root, '.scratch') + path.sep)` before reading.

### F2 — Unescaped regex built from `prd` + issue filenames (Low)
**`bin/wrxn.cjs`** (greenCommit detection):
```js
const re = new RegExp(`\\[${id}\\]|\\b${id}\\b`);   // no escaping, no try/catch, inside a per-issue loop
const commitLine = gitLog.split('\n').find((l) => re.test(l));
```
`id = `${prdPrefix}-${num}`` where `prdPrefix = prd.split('-')[0]` (operator arg) and `num = numMatch ? numMatch[1] : stem` — `stem` is the issue **filename** minus `.md`, used raw whenever the filename is not digit-prefixed. So both the `prd` arg and arbitrary issue filenames are interpolated **unescaped** into a `RegExp`.

**Risk:** Low. Three consequences: (1) **crash/DoS** — `prd='a)'` or a file like `weird(.md` yields an invalid pattern → `new RegExp` throws `SyntaxError`; it is outside any try/catch, so it is caught only by the top-level `main().then(_, err => …)` (prints `wrxn: Invalid regular expression…`, exit 1, no stack/secret leak) — the command aborts; (2) **ReDoS** — a crafted filename such as `(.*a)*b.md` becomes a catastrophic-backtracking regex tested against every commit line (requires write access to `.scratch/<prd>/issues/`); (3) **wrong gate detection** — metacharacters in `id` change which commit lines match (a correctness, not security, effect). All local.

**Fix:** regex-escape the interpolation — `const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');` then `new RegExp(\`\\[${e}\\]|\\b${e}\\b\`)` — or drop the regex for literal checks (`l.includes('['+id+']')`). Wrapping the build in try/catch is cheap defense-in-depth.

### F3 — devops push dance leaves a residual window on interruption (Low / Informational)
**`payload/.claude/agents/devops.md`** correctly mandates the full interlock — step 2 sets `WRXN_ACTIVE_AGENT=devops` under the `env` key of `.claude/settings.local.json`, step 4 **REMOVES** it and states *"This cleanup is mandatory, even if the push failed."* That closes the push-failure case. The unaddressed case is the **agent itself being interrupted** (crash / context exhaustion / user abort) between step 3 (push) and step 4 (unset): the flag then persists in `settings.local.json`, silently defeating the anti-accidental-push gate (`enforce-push-authority.cjs` allows any push while `WRXN_ACTIVE_AGENT === 'devops'`) until a human notices.

**Risk:** Low. `settings.local.json` is machine-local/gitignored (does not propagate), and by design the gate is **anti-accidental, not anti-malicious** (the hook comment + Constitution Art. I frame it as a deliberate-act interlock; the hook fails OPEN). Note the hook and constitution are **not modified in this diff** — they are pre-existing context.

**Fix (hardening):** instruct devops to **assert the flag is absent at start** and treat a pre-existing `WRXN_ACTIVE_AGENT` as a stop/self-heal condition, so a leaked flag from a prior interrupted run is caught rather than silently relied upon.

### F4 — reviewer & security carry `Write` + `Bash` despite being review-only roles (Informational)
**`reviewer.md`** / **`security.md`** grant `tools: Read, Grep, Bash, Write, …`. A "fresh-eyes reviewer" is conceptually read-only on source, but both **must** write their gate artifact (`review-<id>.md` / the security report) and use `Bash` to inspect the diff (`git diff/log`, recon CLI). The grants are therefore justified by the artifact + inspection requirements. The "Write is scoped to the marker ONLY" constraint is **prompt-enforced**, not tool-enforced — the agent-tool model has no path-scoped Write. Acceptable, but noted because nothing machine-bounds it (see F5).

Positive: privilege separation is otherwise clean — only `builder` and `devops` hold `Edit`; `qa-walker` and `researcher` correctly lack `Edit`; `researcher` has no `Bash` (least-privilege for a web-research role).

### F5 — conformance validator is presence-only, not least-privilege (Informational)
**`lib/agent-conformance.cjs`** `validateAgentFile` only flags `tools.length === 0` (*"agent declares no tools"*) and never bounds the grant — the comment is explicit: *"presence, not a frozen list — new MCP tools are valid."* So an **over-grant** (e.g., adding `Bash` or `Edit` to `researcher`) still passes conformance. This is by design (the write-an-agent doctrine), but it means "least-privilege" is convention-enforced, not machine-checked; the validator's least-privilege framing slightly oversells what it guards.

### F6 — `__proto__`/key handling in the parsers (Informational, not exploitable)
- **`lib/compass-coverage.cjs`** `parseBuckets`: `buckets[bucket] = skills` with `bucket` taken from parsed markdown. A `__proto__:` line invokes `setPrototypeOf` on the **local** `buckets` object — **not** global `Object.prototype` pollution — and is silently dropped from the later `Object.values(buckets)`. No exploit; the only source is the managed `compass/SKILL.md`. Defensive nit: build with `Object.create(null)` or skip `__proto__`/`constructor` keys.
- **`lib/agent-conformance.cjs`** / **`lib/flow-status.cjs`**: the `EXECUTORS[type]` and `arts[id]` lookups with a `__proto__` key return `Object.prototype` rather than `undefined`, producing a confusing-but-safe result (no crash, no write, no pollution). Both are reads; callers are tests / the local CLI. Not exploitable.

---

## What was verified clean (PASS evidence)

- **No command injection.** Git is the only external process: `execFileSync('git', ['-C', root, 'log', '--all', '--oneline'], { encoding:'utf8', stdio:['pipe','pipe','pipe'] })` — array args, **no `shell:true`**, so arguments go to `git` via `execve` with no shell parsing. Only `root` (a resolved path) reaches git via `-C`; `prd` and the issue `id` never reach the git call.
- **Fail-closed gate posture.** A gate is "done" only on positive evidence: `lib/flow-status.cjs` `gatesFor` requires a **non-empty string** per artifact field (no false pass). In the CLI, a missing git binary / non-repo is caught → `gitLog=''` → build gates stay `pending`; missing artifact files → gate `pending`; an unreadable `issuesDir` returns **exit 2** (an explicit error, not a silent pass). Missing input ⇒ not-passed.
- **No secret handling in the diff.** No token/env-secret is read, written, or logged. The only env read anywhere near this change is the pre-existing `WRXN_ACTIVE_AGENT` interlock (a role flag, not a credential). The top-level error handler prints `err.message` only (no stack/secret). The npmrc/publish path is outside this diff.
- **Push authority intact.** `enforce-push-authority.cjs` (unchanged here) gates remote ops on `WRXN_ACTIVE_AGENT === 'devops'`; every non-devops agent (`builder`, `reviewer`, `security`, `qa-walker`, `researcher`) carries a hard *"Never `git push`"* constraint, and `devops.md` is the single sanctioned push path with a mandatory set→push→**unset**. So devops is the only pusher by both prompt and hook (modulo F3's interruption window).
- **No ReDoS in the static parsers.** `parseBuckets` / `parseAgentFile` use lazy `[\s\S]*?` with fixed terminators over the managed SKILL.md / agent files — no catastrophic backtracking, and the inputs are kernel-controlled.
- **Manifest correctness.** New libs are absent from `manifest.json` (package code, not shipped); the six agents + `compass/SKILL.md` are classified `managed`/`project` (correct for prompt payload). No state/seeded misclassification.
- **The new payload markdown adds no executable surface.** `qa-walk/SKILL.md` only adds the agent-vs-operator walk-modes prose (its pre-existing "Execution guardrails" remain); `compass/SKILL.md`'s "live read" is an LLM read-only instruction; `.synapse/pipeline` is doctrine text.

---

## Recommendation
Mergeable. F1 + F2 are cheap, self-contained hardening of `wrxn flow status` (input-validate `prd`, escape the regex) and are worth folding in before relying on `flow status` with any non-operator-supplied `prd`. F3–F6 are documentation/defensive nits to track, not blockers.
