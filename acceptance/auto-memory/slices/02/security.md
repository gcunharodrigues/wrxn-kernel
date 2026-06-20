# Security review — auto-memory-02 (synth engine layer: injectable invoker + config + manual CLI)

- **Slice commit:** `f20e19d` (base `624b2e0`)
- **Diff surface:** `payload/.wrxn/memory-synth.cjs` (new, 462 lines), `payload/.wrxn/memory.config.json` (new, seeded), `manifest.json` (+2 entries), `test/memory-synth.test.cjs` (new, 16 tests — all green locally).
- **Reviewer:** security executor (defensive review; no code/test/source modified; nothing pushed).

## Verdict: PASS-WITH-FINDINGS → **PASS** (F1 resolved on re-verification)

> **RE-VERIFICATION 2026-06-20 (fix commit `b732f13`).** F1 (MED) RESOLVED: `lib/install.cjs:91` now calls `ensureGitignoreLine(target, '.env')` (idempotent; beside the intact `.recon-wrxn/` + `.wrxn/reinforce.json` ignores), pinned by `test/install.test.cjs:85` (`/^\.env$/m` + single-line idempotency). `node --test test/install.test.cjs test/memory-synth.test.cjs` → 27/27 green; full suite 820. The "gitignored `.env`" doc-claim is now true for fresh `wrxn init`. **Carry-forwards:** existing-install `.env` backfill → slice 05 migration; F2 (transcript→engine prompt-injection/secret-egress) handoff-body redaction (story 19) → slice 03 auto path. NOTE: re-verified mechanically by the orchestrator (Bash + tests) because the security-agent re-run was blocked by a transient API 529; the fix is the exact one-line gitignore the original review prescribed.

The in-scope security surface is sound: the Gemini key travels in the `x-goog-api-key` **header** (never URL/argv/log), `claude -p` is spawned via an **argv array on stdin** with the recursion sentinel and a bounded timeout (no `shell:true`), config/`.env` parsing uses `JSON.parse` + a pure `KEY=value` parser (no `eval`/`require` of untrusted content), and every new branch is **fail-closed** (missing key / missing CLI / engine error → `null` → caller writes nothing, never throws, never partial-writes). The transcript blob reaches only the LLM (stdin / HTTPS body), never a shell/exec sink.

One **MEDIUM** finding (the kernel never makes `.env` gitignored, contradicting the design and this file's own doc-comment) and one **INFO/accepted** documented exposure (prompt-injection + secret-egress via the transcript blob — by-design for this manual-CLI slice, with a forward-looking requirement for the auto path).

---

## Findings

### F1 — `.env` holding `GEMINI_API_KEY` is not gitignored by the kernel (MEDIUM)

**Evidence**
- `payload/.wrxn/memory-synth.cjs:105` doc-comment asserts the property: *"Parse the install's **gitignored** `.env`…"*; `:116` reads `fs.readFileSync(path.join(root, '.env'), …)`; `:428` lifts `GEMINI_API_KEY` from it.
- `lib/install.cjs:86-88` — the installer adds exactly two ignore lines (`ensureGitignoreLine(target, '.recon-wrxn/')`, `ensureGitignoreLine(target, '.wrxn/reinforce.json')`). It never adds `.env`.
- No payload `.gitignore` ignores `.env` (none exists); the kernel root `.gitignore` only lists `node_modules/ *.tgz .DS_Store .recon/`.
- PRD story 14 — *"I want the Gemini API key in a gitignored `.env`, so that the fallback works without committing a secret"* — is listed in this issue's scope (`02-engine-layer-config-cli.md` → "User stories: …14…").

**Exploit / harm**
An operator enabling the gemini fallback follows the only documented path: write the real `GEMINI_API_KEY` into `<install>/.env`. Because nothing in `wrxn init`/`update` ignores `.env`, a routine `git add -A && git commit && git push` in the install repo commits the live key and pushes it to the remote — the credential hardens into git history. The design promised this control (story 14) and the code's own comment claims it ("the install's gitignored `.env`"), but the control is absent.

**Mitigation (one line)**
Add `ensureGitignoreLine(target, '.env')` in `lib/install.cjs` beside the existing two lines, so every `init`/`update` guarantees `.env` is ignored (idempotent, same helper). Alternatively seed a `.gitignore` `.env` entry + a migration for existing installs.

**Severity rationale**
MEDIUM, not HIGH: the secret is opt-in (exists only if the operator creates `.env`) and exposure needs a second operator action (commit + push); `.env` is a widely-known do-not-commit convention and many operators carry a global gitignore. But it is a real credential-egress path the design said it had closed. **Scope note:** this gap may be intended for the migration/seed slice (PRD slice 6); it is surfaced here so it is not lost, because story 14 is in *this* issue's scope and this file already asserts the property as true.

### F2 — Transcript blob → LLM: prompt-injection + secret-egress (INFO / accepted, by-design)

**Evidence**
- `buildTranscriptBlob` (`:158-197`) renders prompts, assistant text, thinking, `tool_use`, and `tool_result` into one blob; it is fed to the engine as `claude` **stdin** (`buildClaudeSpec:233` → `invokeClaude:284` `input`) or as the gemini request **body** (`buildGeminiSpec:252`).

**Exposure (two facets, both acceptable for this slice)**
1. **Prompt injection** — transcript content (incl. attacker-influenceable pasted text / `tool_result`) reaches the model and could steer the synthesized text. Acceptable here: the synth only *returns* text (the CLI prints it); it writes nothing durable in this slice. The load-bearing defense for the durable (dream) path is the slice-04 `--source` quote-verify gate; the handoff path's blast radius is a possibly-manipulated baton (operator-facing), not permanent recall.
2. **Secret egress** — any secret that appeared in the session is in the blob and, on the fallback path, is transmitted to the external Gemini endpoint (`generativelanguage.googleapis.com`). This is by-design (mirrors the proven `aimem-handoff-synth` reference) and opt-in (operator supplies the key), and in this slice runs **only** via the manual CLI the operator explicitly invokes.

**Forward-looking requirement (not this slice)**
The handoff-redaction control (PRD story 19) must land before the **auto** (SessionEnd-hook) path ships, so an unattended synth does not silently egress session secrets to a third party without operator consent in the loop.

**Confirmed safe:** no transcript content ever reaches a shell/exec sink — `claude` runs via an argv array (no `shell:true`) with the blob on stdin; gemini via an HTTPS body. The only argv interpolation is `model` (config-controlled, a discrete token).

---

## Positive controls confirmed (PASS basis)

- **Secret in header, never URL/argv/log.** `buildGeminiSpec:249` puts the key on `x-goog-api-key`; the URL `:248` carries no key; `invokeGemini:309` sends it via the headers object and `u.pathname + u.search` (search is empty). The key is never `console.log`'d, never placed in `detail`, and `detail` is never printed (grep-confirmed; `runEngine:356` consumes only `r.ok`/`r.text`). Not on any command line (gemini is HTTPS, not a subprocess).
- **Gemini host is fixed.** Host is hardcoded in the template literal; `model` interpolates only into the *path* segment, so `new URL(...)` always resolves `hostname = generativelanguage.googleapis.com` — a malicious/garbled `model` cannot redirect the key to an attacker host (authority is parsed before the path).
- **`claude -p` spawn is safe.** `buildClaudeSpec:228-237` → argv `['-p','--model',model]`, prompt+blob on **stdin** (`input`), `WRXN_MEMORY_SYNTH=1` in the **child env** (`env:{[SENTINEL]:'1'}`), `timeoutMs=120000`. `invokeClaude:284` uses `spawnSync(cmd, argsArray, …)` — **no `shell:true`**, so `model` metacharacters are inert; `maxBuffer:32MB` bounds stdout (overflow → `r.error`/`status==null` → `ok:false`, fail-safe).
- **Recursion-guard half delivered correctly.** The sentinel is set on every claude spawn env; the reading side (spawn-hook no-op) is a later slice and no SessionEnd hook exists yet, so there is no live recursion/fork-bomb surface in this slice. Gemini spawns no subprocess, so it needs no sentinel.
- **Config/`.env` parsing is injection-free.** `loadConfig:84-102` = `JSON.parse` in try/catch → defaults on any failure. `loadEnv:112-133` = pure `KEY=value` string parsing in try/catch → `{}` on absent/unreadable. No `eval`, no `require()` of untrusted content (only stdlib requires at the top). Malformed config/`.env` degrades, never throws or executes.
- **Fail-closed posture on every new branch.** Missing key → `runEngine:350` returns `null` *without* calling the invoker (no keyless request); missing CLI → ENOENT → `invokeClaude:291` `ok:false`; invoker throw → `runEngine:358` caught → `null`; both engines fail → `synthesize:374` `null` → `run:430-433` writes nothing to stdout and exits 1; top-level `:441` `.catch` exits 1. No partial write, no uncontrolled throw.
- **No drift to existing controls.** `manifest.json` only *adds* two entries (`.wrxn/memory-synth.cjs` managed, `.wrxn/memory.config.json` seeded); no existing entry changed. `settings.json`/hooks untouched (correctly deferred to later slices). The seeded `memory.config.json` contains only `{engine,model}` — no secret.

## Path-traversal note (no finding)
The CLI `file` positional and `--root` are operator-supplied on a local tool; reading the named transcript is the intended function (no privilege boundary crossed). `findInstallRoot:382` walks up at most 12 levels doing read-only `existsSync` checks. No write occurs anywhere in this slice. No traversal vulnerability.
