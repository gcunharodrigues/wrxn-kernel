# Security Review — #62 transcript-sentinel strip

- **Slice:** wrxn-kernel #62 — `stripInjectedContext` filter on the memory-synth transcript-blob builder
- **Branch / commit:** `fix/62-transcript-sentinel-strip` @ `6462b22`
- **File under review:** `payload/.wrxn/memory-synth.cjs` (diff `git diff main...HEAD`)
- **Reviewer:** security executor (read-only)
- **Build state:** GREEN — `node --test test/memory-synth.test.cjs test/memory-synth-handoff.test.cjs` → 66/66 pass
- **Pushed:** false (read-only review; no push, no edit, no PR)

## Verdict: PASS-WITH-FINDINGS

The change is pure string work over the transcript and introduces **no injection, traversal, or exec
surface**, and **does not weaken secret redaction** (it runs strictly upstream of `redactSecrets` and can
only add, never bypass, redaction). Two LOW findings: (1) a **quadratic-time (ReDoS-class) blowup** the
fail-open `try/catch` does not cover, on the only content channel with no length cap; (2) **over-deletion**
of legitimate content via the unclosed-tag regex. Neither rises to FAIL: the genuinely-untrusted channel
(tool output) bypasses the new filter, and the synth runs in a detached child so a hang never crashes the
session. Both warrant a cheap input bound.

---

## Findings

### F-1 — LOW — Quadratic (ReDoS-class) blowup on uncapped text parts; hang not covered by fail-open

- **Where:** `payload/.wrxn/memory-synth.cjs:210` (closed-block regex), reached from `:240` / `:245`
- **Pattern:** `new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>', 'g')`
- **Mechanism:** With the global flag, for **every** unclosed `<tag>` opening in a content part the lazy
  `[\s\S]*?` scans to end-of-part looking for a `</tag>` that never arrives, then `replace` advances to the
  next opening and rescans. V8's Irregexp has no memoization → total work is `O(occurrences x length)` =
  **O(n^2)** in the size of a single text/string content part (5 sentinels = constant 5x).
- **Measured evidence** (exact regex pair, unclosed `<system-reminder>` x K, no closing tag):

  | input bytes | time |
  |---|---|
  | 34 KB | 15.5 ms |
  | 68 KB | 63.7 ms |
  | 136 KB | 250 ms |
  | 272 KB | 992 ms |
  | 544 KB | 3986 ms |

  Input x2 -> time x4: textbook **quadratic** (not exponential). Extrapolated: ~1 MB ≈ 16 s, ~2 MB ≈ 64 s,
  ~4 MB ≈ minutes — a single oversized content part wedges the synth child.
- **Why the fail-open guard does not catch it:** the `try/catch` at `:207`/`:214` returns the input on a
  **throw**, but a quadratic time blowup is a **hang, not an exception** — the catch never fires. The
  engine timeouts (`CLAUDE_TIMEOUT_MS:280` / `GEMINI_TIMEOUT_MS:281`) wrap the *engine spawn*, which runs
  **after** blob construction, so the blob-build hang is unbounded.
- **Input is NOT bounded before the regex:** `readTranscriptBlob:269` reads the whole transcript with no
  size cap, and the string/text content parts (`:240`,`:245`) are the **only** content types with no
  per-part truncation — `thinking`/`tool_use`/`tool_result` are capped at `THINK_MAX`/`TOOL_USE_MAX`/
  `TOOL_RESULT_MAX` (`:247`,`:249`,`:255`). #62 adds quadratic regex work on top of that pre-existing
  uncapped surface.
- **Exploitability (why LOW, not higher):**
  - The genuinely-untrusted channel — `tool_result` (web fetches, file reads of attacker content) — is
    capped at 200 chars and **does not call `stripInjectedContext`** (`:250-255`). The new regex never
    sees attacker-controlled tool output.
  - The channels that reach the regex are operator-typed prompts and model-generated text — a remote
    attacker does not drive them; the trigger is a self-inflicted pathological paste.
  - The synth runs in a **detached SessionEnd child**; a hang does not block session close (fail-open at
    the session level). Worst case = a wedged background process burning one CPU core for minutes + the
    baton silently not written.
- **Remediation:** bound the input at the top of `stripInjectedContext`, e.g.
  `let out = String(text || '').slice(0, MAX_PART)` with a few-KB cap. This matches the existing
  truncation-cap discipline, kills the quadratic tail, and closes the inherited uncapped-part gap. Hoisting
  the 10 `RegExp` compilations out of the per-part loop is a worthwhile (non-security) follow-up.

### F-2 — LOW — Over-deletion of legitimate content via the unclosed-tag regex (silent data loss)

- **Where:** `payload/.wrxn/memory-synth.cjs:211`
- **Pattern:** `new RegExp('<' + tag + '>[\\s\\S]*$')` — deletes from a sentinel opening to **end-of-part**.
- **Mechanism:** A user or assistant message that legitimately contains a literal `<system-reminder>` (the
  most generic of the five names, and the wrapper this very class of harness note uses) silently loses
  **everything after it** from the handoff/dream blob.
- **Evidence:** by construction; `<system-reminder>` is plausible operator prose. The other four tags
  (`wrxn-orientation`/`synapse-rules`/`recall-surface`/`reference-candidate`) are framework-private and
  unlikely in human text.
- **Impact / severity:** integrity of a **best-effort, fail-open** continuity summary — not a security
  boundary (no disclosure, no privilege change). The issue's own AC #1 explicitly mandates stripping these
  sentinels, so this is a largely accepted tradeoff. LOW.
- **Remediation (optional):** require the **closed** form for the generic `system-reminder` (drop it from
  the open-ended second pass), or anchor the open-ended strip to the leading position where the hook
  injects the block, so a mid-message literal cannot eat the tail.

---

## Cleared (probed, no finding) — with evidence

- **Injection / regex-injection:** the `RegExp` patterns are built **only** from the hardcoded
  `INJECTED_SENTINELS` constant array (`:196`); no transcript or user data flows into the pattern string.
  No injection.
- **Path traversal / command exec:** the change is pure string work (`String`, `.replace`, `new RegExp`).
  It adds no `fs`/`path`/`child_process`/network/`eval` surface. No new traversal or exec path.
- **Secret-handling interaction (the key check):** `stripInjectedContext` runs **inside**
  `buildTranscriptBlob` (`:240`,`:245`), strictly **upstream** of every `redactSecrets` call — handoff
  `:758` (before engine egress) and `:764` (before the durable baton write), dream `:895` (before model
  egress). The strip:
  - does **not** remove or reorder redaction — redaction is a separate downstream pass over the surviving
    blob and still runs on every egress;
  - only **deletes** spans (`replace(..., '')`); it cannot inject text or open an unredacted-egress path;
  - cannot create a leak via concatenation — joining the two sides of a deleted span can only **create**
    additional secret-shaped matches (more redaction), never split an intact secret out of detection; a
    secret straddling into a stripped block has its inner half removed (not egressed) and leaves only a
    non-matching fragment;
  - never logs or persists raw transcript content (no `fs`/`console`/network in the function).
  Net: the secret-redaction posture is preserved or strengthened, never weakened.
- **Fail-open on throw:** a thrown fault returns `String(text || '')` (`:214`); the blob is unaffected and
  `runHandoff`'s `finally` (`:773-778`) always clears the pending/handoff markers, so session-start is
  released regardless. (The *hang* case is the exception — see F-1.)

## ReDoS one-line assessment

Quadratic O(n^2) (measured 2x input -> 4x time, 544 KB ≈ 4 s), **not** exponential; reachable only via
operator-typed/model text (the untrusted tool-output channel bypasses the filter, capped at 200 chars),
detached so no session crash — but the fail-open catch does not cover the hang and the surface is uncapped,
so a cheap input bound is the recommended hardening.
