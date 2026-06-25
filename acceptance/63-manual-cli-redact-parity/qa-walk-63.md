---
issue: 63
branch: fix/63-manual-cli-redact-parity
head: f465a4a
walked-by: qa-walker (isolated executor)
date: 2026-06-24
verdict: PASS
findings-filed: 0
---

# QA-walk report — #63 manual CLI synth path redaction parity

## Artifact

`payload/.wrxn/memory-synth.cjs` on branch `fix/63-manual-cli-redact-parity` at `f465a4a`.
Entry point: `module.exports.run(args, { invoke, out, err })` — the testable CLI core.

## Promises checked (from issue #63 ACs)

| AC | Promise |
|----|---------|
| AC-1 | `run()` manual path applies `redactSecrets` to the blob before `synthesize` — parity with `runHandoff:729` and `runDream:866` |
| AC-2a | Egressed blob contains `[REDACTED]` for each planted credential shape; no raw secret survives |
| AC-2b | Clean transcript (no credential shapes) — egressed blob is byte-identical to `readTranscriptBlob(file)`; handoff output still produced |
| AC-3 | `runHandoff` (the automatic path) likewise redacts before egress — all three sinks behave identically |
| AC-3b | `runDream` likewise redacts before egress |
| AC-4 | `--task dream` redacts before egress |
| AC-4b | Unknown `--task` exits non-zero cleanly; invoke is never called (no blob egress) |
| AC-5 | Missing transcript file: no throw, graceful exit, blob is empty |

## Walk plan (derived from ACs, written before execution)

All probes run via the REAL `run()` / `runHandoff` / `runDream` with an injectable fake invoke that
captures every spec handed to it. No real `claude -p` or network calls are made.

| # | Behavior | Invocation | Expected |
|---|----------|------------|---------|
| P1 | Headline: secret never egresses on manual path | `run(['--task','handoff',<secret-fixture>,…], {invoke:fake})` | captured `spec.input` contains `[REDACTED]` for all 5 patterns; raw values absent |
| P2 | Clean transcript unchanged | `run(['--task','handoff',<clean-fixture>,…], {invoke:fake})` | blob byte-identical to `readTranscriptBlob(file)`; invoke called → output |
| P3 | Parity: runHandoff | `runHandoff({ root, invoke:fake })` with stash pointing at secret fixture | egressed blob: `[REDACTED]` present, raw secrets absent |
| P3b | Parity: runDream | `runDream({ root, blob:rawBlob, invoke:fake })` with secret blob | egressed blob: `[REDACTED]` present, raw secrets absent |
| P4 | `--task dream` redacts | `run(['--task','dream',<secret-fixture>,…], {invoke:fake})` | egressed blob contains `[REDACTED]`, raw secrets absent |
| P4b | Bad input: unknown task | `run(['--task','unknown_task_xyz',…], {invoke:fake})` | exits 2, invoke never called, stderr names the unknown task |
| P4c | Bad input: no file arg | `run(['--task','handoff'], {invoke:fake})` | exits 2, usage line on stderr, invoke never called |
| P5 | Fail-open: missing file | `run(['--task','handoff','/nonexistent/…'],…)` | no throw, exits 0, egressed blob empty |
| Edge.2 | Empty-state: empty transcript | `run([…,<empty-file>,…],…)` | no throw, exits 0 |
| Edge.3 | Repeat-run idempotency | two identical runs against secret fixture | egressed blobs identical both times |

### Secret patterns planted in fixture

| Name | Raw value (first 30 chars) | REDACTIONS pattern |
|------|----------------------------|-------------------|
| github_pat | `ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz…` | `gh[pousr]_[A-Za-z0-9]{20,}` |
| google_key | `AIzaSyAbcdefghij1234567890-XYZ…` | `AIza[0-9A-Za-z._-]{10,}` |
| token_assign | `SOME_TOKEN=super_secret_value_…` | `KEY/TOKEN/SECRET = value` |
| jwt | `eyJhbGciOiJIUzI1NiIsInR5cCI6I…` | JWT 3-part `eyJ…` form |
| pem | `-----BEGIN PRIVATE KEY-----\n…` | PEM block regex |

## Execution — evidence per step

Driver: `/tmp/.../scratchpad/walk-driver-63.cjs` (throwaway, not in repo).
All assertions run against `payload/.wrxn/memory-synth.cjs` at HEAD `f465a4a`.

### P1 — Headline: secret never egresses via `run()` manual path

```
Command: run(['--task','handoff',<secret-fixture>,'--root',<tempRoot>], {invoke:fake})
Exit code: 0
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P1.0 run() exits 0 | PASS | code=0 |
| P1.1 invoke called | PASS | 1 call captured |
| P1.2 Claude spec captured | PASS | spec.input length=1882 |
| P1.3 [REDACTED] in egressed input | PASS | confirmed present |
| P1.4 no raw secret values in blob | PASS | checked 5 patterns, all clear |
| P1.5 each pattern individually absent | PASS | blob excerpt: `[user] Please set [REDACTED] and also use the key [REDACTED]\n[assistant] Sure. Your GitHub PAT is [REDACTED] and the JWT [REDACTED]\n[user] [REDACTED]` |

**Line changed**: `payload/.wrxn/memory-synth.cjs:972` — `const blob = redactSecrets(readTranscriptBlob(file))` — the
fix applies `redactSecrets` at the single seam before `synthesize` is called. This is byte-parity with
`runHandoff:729` (`safeBlob = redactSecrets(blob)`) and `runDream:866` (`safeBlob = redactSecrets(blob)`).

### P2 — Clean transcript unchanged (no over-redaction)

```
Command: run(['--task','handoff',<clean-fixture>,'--root',<tempRoot>], {invoke:fake})
Exit code: 0
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P2.0 exits 0 | PASS | code=0 |
| P2.3 blob byte-identical | PASS | len=343; `redactSecrets` is pure — passes ordinary prose unchanged |
| P2.4 invoke called, output produced | PASS | invoke called 1 time |

### P3 — Parity: `runHandoff`

```
runHandoff({ root: <tempRoot-with-stash>, invoke: fake })
Stash: { session_id: "test-walk-63", transcript_path: <secret-fixture> }
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P3.1 invoke called | PASS | 1 call |
| P3.3 no raw secrets in egressed blob | PASS | all clear |
| P3.4 [REDACTED] present | PASS | confirmed |

`runHandoff:729` was already correct before this fix. The walk confirms it still holds.

### P3b — Parity: `runDream`

```
runDream({ root: <tempRoot>, blob: rawBlobFromSecretFixture, invoke: fake })
fake returns: '{"abstain":true}' (structurally abstains; runDream exits before touching dream.cjs CLI)
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P3b.1 invoke called | PASS | 1 call |
| P3b.3 no raw secrets in egressed blob | PASS | all clear |
| P3b.4 [REDACTED] present | PASS | confirmed |

`runDream:866` applies `redactSecrets(blob)` as a defense-in-depth layer even when the caller
already pre-redacted. Both layers confirmed active.

### P4 — `--task dream` redacts

```
Command: run(['--task','dream',<secret-fixture>,'--root',<tempRoot>], {invoke:fake})
fake returns: '{"abstain":true}'
Exit code: 0
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P4.0 exits 0 | PASS | code=0 |
| P4.3 no raw secrets in egressed blob | PASS | all clear |

### P4b — Unknown `--task` exits non-zero, no egress

```
Command: run(['--task','unknown_task_xyz',<secret-fixture>,'--root',<tempRoot>], {invoke:fake})
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P4b.0 exits non-zero | PASS | code=2 |
| P4b.1 invoke never called | PASS | 0 captures |
| P4b.2 stderr names the bad task | PASS | `memory-synth: unsupported task "unknown_task_xyz" — known tasks: handoff, dream` |

### P4c (Edge) — Bad input: no file arg

```
Command: run(['--task','handoff'], {invoke:fake})
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| Edge.0 exits 2 | PASS | code=2 |
| Edge.1 invoke not called | PASS | 0 captures |
| stderr | PASS | `Usage: node .wrxn/memory-synth.cjs --task handoff <transcript-file> [--root <dir>]` |

### P5 — Fail-open: missing transcript file

```
Command: run(['--task','handoff','/nonexistent/path.jsonl','--root',<tempRoot>], {invoke:fake})
```

| Assertion | Result | Evidence |
|-----------|--------|---------|
| P5.0 no throw, exits 0 | PASS | code=0 (readTranscriptBlob returns '' on ENOENT) |
| P5.1 egressed blob empty | PASS | blob length=0 (nothing sensitive from a missing file) |

### Edge.2 — Empty-state: empty transcript file

| Assertion | Result | Evidence |
|-----------|--------|---------|
| Edge.2 no throw, exits 0 | PASS | code=0 |

### Edge.3 — Repeat-run idempotency

| Assertion | Result | Evidence |
|-----------|--------|---------|
| Edge.3 blobs identical both runs | PASS | blob len=152 both times |

## Findings filed

None. All 26 assertions pass.

## Verdict

**PASS** — 26 assertions across 10 probes; 0 findings; 0 issues filed.

Walk coverage:
- 5 AC promises checked (AC-1 through AC-5)
- 3 entry points exercised (`run()` manual path, `runHandoff`, `runDream`)
- 5 secret patterns confirmed redacted on every egress path
- 3 edge probes executed: bad input (no file, unknown task), empty state (empty transcript, missing file), repeat-run idempotency
- Headline security question answered: a planted secret (`ghp_…`, `AIza…`, `SOME_TOKEN=…`, JWT, PEM block) does NOT egress to the external model on the manual CLI path after this fix.

Caveat: this walk ran in a qa-walker executor with no knowledge of the implementation beyond the artifact surface and the issue ACs. The injectable-invoke seam makes the egress point directly observable — evidence is the captured spec, not inference from source.
