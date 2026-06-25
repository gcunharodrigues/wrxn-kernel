---
type: qa-walk
issue: "62"
artifact: "payload/.wrxn/memory-synth.cjs"
branch: "fix/62-transcript-sentinel-strip"
head: "9bcac54"
date: "2026-06-24"
verdict: PASS
---

# QA-Walk — #62 transcript sentinel strip

**Artifact:** `payload/.wrxn/memory-synth.cjs`
**Entry points exercised:** `buildTranscriptBlob`, `readTranscriptBlob`, `runHandoff`, `run`
**Branch / HEAD:** `fix/62-transcript-sentinel-strip` @ `9bcac54`
**Walker context:** fresh qa-walker executor (not the builder context)

---

## Walk plan

Derived from issue #62 ACs. Five behavioral promises + three mandatory edge probes per the spine.

| # | Behavior (AC ref) | Invocation | Expected |
|---|-------------------|-----------|---------|
| P1 | Baton echo killed — orientation block with "Shipped kernel 0.15.0" + real work | `buildTranscriptBlob(fixture-p1.jsonl)` | blob excludes baton span; includes real turns |
| P2 | Per-turn injections stripped — `<synapse-rules>`, `<recall-surface>`, `<reference-candidate>` on later turns | `buildTranscriptBlob(fixture-p2.jsonl)` | sentinel bodies absent; user intent survives |
| P3 | Orientation-only → trivial; no egress | `runHandoff({root, invoke:fake})` with orientation-only fixture | `wrote=false, reason=trivial`; invoke never called; no baton written; markers cleared |
| P4a | Sentinel mid-prose — trailing text survives (phase-2 anchoring) | `buildTranscriptBlob(fixture-p4a-midprose.jsonl)` | sentinel tag name and trailing prose survive; only a leading block is stripped |
| P4b | Large (>64 KB) text part — no hang, no throw (ReDoS guard) | `buildTranscriptBlob` with 70 KB 'a' repeated | returns in <500 ms; no throw; content present |
| P5 | Heavy session unaffected — real user/assistant/tool turns captured | `buildTranscriptBlob(fixture-p5-heavy.jsonl)` | all turns present; `[tool_use Write]`; `[tool_result]` |
| E1 | Bad input — malformed JSONL lines skipped | `buildTranscriptBlob` with interleaved garbage | no throw; valid line survives |
| E2 | Empty state | `buildTranscriptBlob('')` | empty blob, no throw |
| E3 | Repeat-run / idempotency | same fixture called twice | identical blobs |
| E4 | Unclosed sentinel block (transcript truncation) | string-content line with `<wrxn-orientation>…` never closed | stripped, no throw |
| E5 | `system-reminder` sentinel | text part with `<system-reminder>…</system-reminder>` + user text | block stripped; user text survives |
| C1 | `run()` CLI — no engine output → exit 1 + stderr | `run(['--task','handoff', tx], {invoke:→{ok:false}})` | exit 1, stderr message, no stdout |
| C2 | `run()` CLI — unknown task → exit 2 | `run(['--task','nonexistent-task', ...])` | exit 2 |
| C3 | `run()` CLI — missing file arg → exit 2 | `run(['--task','handoff'])` | exit 2 |

All commands are read-only against disposable fixtures or a temp root; no network egress; no real LLM called.

---

## Execution evidence

Driver: `/tmp/.../walk-62-driver.cjs`
Fixtures: temp JSONL files under scratchpad/walk-62-fixtures/

### P1 — Baton echo killed

```
$ node walk-62-driver.cjs  (P1 section)
```

Blob preview (actual output):
```
[system] Some additional context here.
[user] Let us fix bug #62 by stripping the baton from the transcript blob.
[assistant] I will strip the hook-injected context from buildTranscriptBlob.
[user] Good, the fix is in place. Commit this change.
```

- "Shipped kernel 0.15.0" absent from blob: PASS
- "next step #45" absent from blob: PASS
- "fix bug #62" present: PASS
- "strip the hook-injected context" present: PASS

### P2 — Per-turn injections stripped

Blob preview (actual output):
```
[user] Can you review this PR?
[assistant] I reviewed the PR and it looks good.
[user] Please also add a test.
[assistant] Adding the test now.
```

- `<synapse-rules>` body ("no side effects") absent: PASS
- `<recall-surface>` body ("kernel 0.13.3 shipped") absent: PASS
- `<reference-candidate>` body ("example.com") absent: PASS
- "Can you review this PR?" present: PASS
- "Please also add a test." present: PASS

### P3 — Orientation-only → trivial

```
runHandoff({ root: tmpRoot, invoke: fakeInvoke, sleep: noSleep })
→ { wrote: false, blob: '', reason: 'trivial' }
```

- `wrote=false, reason='trivial'`: PASS
- `fakeInvoke` never called: PASS
- `latest.md` not created: PASS
- `.pending` cleared: PASS
- `.pending-handoff` cleared: PASS

### P4a — Sentinel mid-prose anchoring

Blob preview:
```
[user] The tag <wrxn-orientation> appears in this design doc but it is just a sentinel name, not a real block. The actual feature is the handoff stripping.
[assistant] Correct, the prose mention of the sentinel should not cause the trailing text to be stripped.
```

- "handoff stripping" (trailing text) survives: PASS
- "wrxn-orientation" tag name in prose survives: PASS

### P4b — Large part (>64 KB)

```
elapsed: 0 ms; blob length: 71687
```

- No throw: PASS
- Returned in <500 ms (0 ms): PASS
- Content present in blob: PASS

### P5 — Heavy session unaffected

Blob preview:
```
[user] Let us build the authentication module for the new service.
[assistant] I will start by defining the token schema.
[user] Use JWT with RS256, not HS256. The public key is stored in .env.
[assistant] Got it. RS256 with the public key from .env. I am writing the verify function now.
[tool_use] [tool_use Write] {"file_path":"/tmp/auth.js","content":"function verify(token) { return jwt.verify(token, publicKey, {algorithms:['RS256']}); }"}
[tool_result] [tool_result] File written successfully
[assistant] Done. The verify function is in place.
```

All five turn types captured: PASS × 5

### Edge probes

| Probe | Result |
|-------|--------|
| E1 bad-input (garbage JSONL) | PASS — malformed lines skipped, real turn survives |
| E2 empty-state (empty JSONL) | PASS — empty blob, no throw |
| E3 repeat-run | PASS — identical blobs on two calls |
| E4 unclosed sentinel | PASS — "Shipped kernel 0.15.0" absent, no throw |
| E5 system-reminder | PASS — block stripped, user text survives |

### CLI run() surface

| Check | Result |
|-------|--------|
| C1 no-engine → exit 1 + stderr | PASS |
| C2 unknown task → exit 2 | PASS |
| C3 missing file arg → exit 2 | PASS |

---

## Verdict

**PASS**

34 promised behaviors checked, 34 commands + assertions run, 0 deviations.

**Headline:** The baton echo is dead. An orientation block carrying "Shipped kernel 0.15.0" produces a blob with zero trace of the prior baton. Real work turns survive unmodified. An orientation-only session resolves `trivial` without calling the LLM. Phase-2 anchoring is correct: a sentinel name appearing mid-prose does not strip the trailing text.

**Coverage:**
- 5 behavioral promises (P1–P5) from ACs 1–3
- 5 edge probes (E1–E5): bad-input / empty-state / repeat-run / unclosed-block / system-reminder sentinel
- 3 CLI surface probes (C1–C3): no-engine exit, bad-task exit, missing-arg exit
- 34 total assertions, 34 PASS, 0 FAIL

0 findings filed.
