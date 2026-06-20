# Security review — auto-memory-03 (auto-handoff end-to-end)

**Verdict: PASS-WITH-FINDINGS**
**Scope:** commit `cd3cdda` on branch `auto-memory` — `payload/.claude/hooks/memory-synth-spawn.cjs` (new),
`payload/.wrxn/memory-synth.cjs` (`runHandoff` / `redactSecrets` / `writeBatonAtomic` / `readPending` / `--from-spawn`),
`payload/.claude/hooks/session-start.cjs` (hold), plus the `manifest.json` + `settings.json` wiring.
**Findings:** 2 (1 HIGH, 1 LOW). No FAIL-class issue (no injection, no traversal escape, no fail-open hang).
**Headline judgment:** redaction runs **before the baton write (✓)** but **NOT before the transcript egresses to the external model (✗)** — the load-bearing gap (F1).

---

## F1 — HIGH — Transcript egresses to the external model UNredacted (redaction covers the write, not the send)

- **Where:** `payload/.wrxn/memory-synth.cjs:473-475` (`runHandoff`).
  ```
  const text = await synthesize({ task:'handoff', prompt:PROMPTS.handoff, blob, ... }); // blob sent RAW
  ...
  const body = redactSecrets(text);   // redaction applied ONLY to the model OUTPUT
  writeBatonAtomic(root, ...);
  ```
- **Evidence (live trace):** a transcript line `my prod token is ghp_16C7e42F…B4a please use it…` produces a
  `spec.input` containing the verbatim `ghp_…` token sent to the engine. For the `claude` engine this is the
  local CLI stdin (`invokeClaude`, `memory-synth.cjs:286-292`); for the **`gemini` fallback** the raw blob is
  the HTTPS POST body to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
  (`buildGeminiSpec`, `memory-synth.cjs:246-259`). So any credential typed/pasted in any session **egresses to a
  third-party API** when the claude CLI is unavailable and a Gemini key is configured.
- **Why it matters:** the PRD (stories 14/19) and this review's mandate require redaction *before* (a) the send and
  (b) the write. Only (b) is implemented. `redactSecrets` scrubs the model's *summary*, but the input the model
  *sees* — and that the gemini path *transmits off-box* — is unscrubbed.
- **Concrete exploit:** operator pastes `GEMINI_API_KEY` / `npm_…` / `ghp_…` mid-session on a machine with no
  `claude` CLI login → SessionEnd synth POSTs the full transcript (token included) to Google's endpoint. The
  durable baton may end up clean while the secret has already left the machine.
- **Remediation:** redact the **blob** before it reaches `synthesize` (scrub once, feed the scrubbed blob to both
  engines), in addition to the existing output scrub. Minimal change in `runHandoff`:
  `const blob = redactSecrets(rawBlob);` before the `synthesize` call. Defence-in-depth: keep the post-synthesis
  `redactSecrets(text)` as well (the model can still echo a secret it reconstructs).

## F2 — LOW — `redactSecrets` misses bare tokens in prose for several common shapes

- **Where:** `payload/.wrxn/memory-synth.cjs:402-410` (`REDACTIONS`).
- **Evidence (empirical, ran against `redactSecrets`):** unredacted bare-in-prose shapes —
  `npm_…` (npm publish token, **explicitly named in scope**), `sk_live_…`/`rk_live_…` (Stripe),
  `sk-proj-…` (OpenAI project keys — the hyphen in `sk-proj-` breaks the `\bsk-[A-Za-z0-9]{20,}\b` class),
  `github_pat_…` (fine-grained PAT), an `Authorization: Bearer <opaque>` non-JWT, AWS *secret* keys (40-char
  base64, no fixed prefix), generic 64-hex secrets, and PEM `-----BEGIN … PRIVATE KEY-----` headers.
- **Mitigating fact (severity = LOW, not HIGH):** the `\b…(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+`
  catch-all **does** redact the *assignment/header* form of most of these (`NPM_TOKEN=`, `STRIPE_SECRET_KEY=`,
  `OPENAI_API_KEY=`, `_authToken=`, `GH_TOKEN=`). The residual leak is the **bare token in free prose** with no
  `KEY=` context. This codebase's own operators are documented (MEMORY.md) to paste raw `npm_…` tokens into chat —
  exactly the bare-in-prose shape that slips.
- **Why it matters:** the baton is durable and auto-injected into the next session, so a bare token that slips
  hardens into recall. Note F2 only bounds the *output* leak; F1 is the dominant exposure.
- **Remediation:** add high-signal bare-token patterns: `\bnpm_[A-Za-z0-9]{36}\b`, `\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b`,
  `\bsk-proj-[A-Za-z0-9_-]{20,}\b`, `\bgithub_pat_[A-Za-z0-9_]{20,}\b`, `Bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}`,
  and a PEM `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` block. Fixing F1 (scrub the
  blob) and F2 (broaden the patterns) compose: redact a superset on input *and* output.

---

## Cleared — probed and found safe

- **Command / argument injection — NONE.** Both spawn sites use the argv-array form, never a shell:
  `spawnFn('node', [synth, '--from-spawn', '--root', root], { … })` (`memory-synth-spawn.cjs:61`) and
  `spawnSync(spec.cmd, spec.args, …)` (`memory-synth.cjs:286`). No `shell:true`, no `exec`/`execSync`, no
  string-interpolation of any payload field into a command anywhere in the three files. A `transcript_path` (or any
  payload value) containing shell metacharacters is only ever an argv element / a `readFileSync` argument — it
  cannot reach a shell.
- **Path traversal — bounded, no escalation.** `readTranscriptBlob` reads `transcript_path` verbatim with no
  root-confinement (`memory-synth.cjs:200-208`), so an absolute/`../` path *would* be read. But (1) `transcript_path`
  originates from the **host-emitted Claude Code SessionEnd payload**, stashed verbatim — to forge it an actor must
  already hold write access inside `.wrxn/continuity/` (inside the trust boundary); and (2) the blob builder skips
  every non-JSON line, so `/etc/passwd` and other non-JSONL files yield an **empty blob** (no arbitrary-file exfil
  via the summary). The **write** paths are constants-only: the baton is `path.join(root, '.wrxn','continuity','latest.md')`
  and the markers/temp are likewise root-anchored constants — **no attacker data reaches any write path**, so the
  baton/stash/markers cannot be redirected outside the install root. *(Optional hardening, not blocking: confine the
  read to the install root or to a `.jsonl` under the OS transcript dir as defence-in-depth.)*
- **Recursion guard — holds (no fork-bomb).** Spawn hook no-ops (spawns nothing, writes no markers) when
  `WRXN_MEMORY_SYNTH` is set (`memory-synth-spawn.cjs:49`); when it spawns the synth it sets the sentinel in the
  child env (`:64`); the synth's `claude -p` spawn inherits it (`buildClaudeSpec` env `:236` + `invokeClaude`
  `{ ...process.env, ...spec.env }` `:288`), so the headless session's SessionEnd hits the no-op branch.
  Verified end-to-end (set → 0 spawns / 0 markers; unset → 1 spawn / child sentinel=1). Blast is further bounded by
  the per-engine `spawnSync` timeout (120 s) + `stdio:'ignore'` + `unref()`.
- **Fail-safe markers / no hang — correct.** `runHandoff` clears `.pending-handoff` then `.pending` in a `finally`
  on **every** exit; verified across trivial / no-engine / **invoker-throws** / success — markers always cleared,
  baton written only on success. The SessionStart hold is independently capped: `holdDecision` proceeds at/over
  `HOLD_CAP_MS` (60 s), plus a wall-elapsed-since-entry cap (`session-start.cjs:124`) and a single-pass guard when no
  waiter is injected (`:126`) — a SIGKILLed synth that never clears the marker cannot hang session start. Fail-open
  hooks (any fault → `{}`) over a fail-closed-on-hang hold: the right posture.
- **Prompt-injection / baton poisoning — inherent-by-design, reasonably bounded, NOT failed.** The baton (a
  transcript-derived model summary) is injected raw into next-session `additionalContext`, wrapped in a labeled
  `<wrxn-orientation>…</wrxn-orientation>` envelope (`session-start.cjs:152-164`); the body is neither
  directive-escaped nor secret-scrubbed at injection time. This is the feature's intended trust boundary (auto-inject
  a handoff). It is bounded by: the model is a *summarization* layer (not verbatim passthrough), the labeled envelope,
  and that the trust source is the operator's own prior session — not an external attacker. Per scope this is not a
  FAIL. The actionable residue is the missing **redaction** (F1/F2), which the design *does* intend to enforce and
  currently under-enforces.

## Build state
Buildable and green: `test/memory-synth-handoff.test.cjs`, `test/memory-synth-spawn.test.cjs`,
`test/session-start-hold.test.cjs`, `test/memory-synth-wiring.test.cjs` → 25/25 pass (the +25 the commit claims).
