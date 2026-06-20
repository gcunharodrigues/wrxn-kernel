---
slice: auto-memory-03
artifact: auto-handoff end-to-end (memory-synth-spawn.cjs + memory-synth.cjs runHandoff + session-start.cjs hold)
walked-at: 2026-06-20
branch: auto-memory
commit: cd3cdda
walker: qa-walker executor (fresh context — not the builder)
---

# QA-Walk — auto-memory-03: auto-handoff end-to-end

## Promises (source)

Issue `acceptance/auto-memory/issues/03-auto-handoff-end-to-end.md`, 8 ACs:

1. On SessionEnd, the baton is written automatically from the session transcript with no manual step (verified end-to-end with a fake invoker).
2. The spawn hook returns `{}` immediately and runs the synth detached (never blocks session close).
3. Recursion guard: with `WRXN_MEMORY_SYNTH=1` set, the spawn hook spawns nothing; unset → it spawns. Unit-tested.
4. SessionStart holds until the handoff marker clears OR the safety-cap age elapses, then injects the baton; the poll decision is unit-tested without wall-clock sleeps.
5. The synth is the SOLE baton writer (continuity doctrine) and clears its markers on every exit (success/fail), so start never hangs beyond the cap.
6. A trivial/empty transcript → the synth writes nothing and clears markers (no model spend).
7. Secrets are redacted from the handoff body.
8. The new spawn hook is registered in the manifest and wired on `SessionEnd` in the payload `settings.json`; existing `session-start` tests stay green.

## Artifacts exercised

- `payload/.claude/hooks/memory-synth-spawn.cjs` — the SessionEnd spawn hook
- `payload/.wrxn/memory-synth.cjs` — the background synthesizer (`runHandoff`, `run --from-spawn`, `redactSecrets`)
- `payload/.claude/hooks/session-start.cjs` — the hold (`holdDecision`, `holdForHandoff`)
- `manifest.json` — registration check
- `payload/.claude/settings.json` — wiring check

All walks drove the REAL module files. The injectable fake invoker was used to replace LLM calls; NO real `claude -p`, NO network. This matches the PRD testing decision (story 26) and mirrors the slice-02 pattern.

Sandbox: `/tmp/wrxn-qa-walk-03-3uqTnc/install` — a minimal fake wrxn install (`wrxn.install.json`) in a temp dir. All writes were confined to that sandbox.

---

## Walk plan

| # | Behavior (promise) | Commands / probes | Expected |
|---|---|---|---|
| P1 | AC2: hook returns `{}` immediately | `echo ... | node memory-synth-spawn.cjs` | stdout=`{}`, exit 0 |
| P2 | AC3: recursion guard blocks spawn (sentinel set) | `WRXN_MEMORY_SYNTH=1 node memory-synth-spawn.cjs` | `{}`, no markers written |
| P3 | AC3: without sentinel → markers written, spawn attempted | `node memory-synth-spawn.cjs` (no sentinel) | markers present, `{}` |
| P4 | AC1+AC5: `runHandoff` writes baton, clears markers | `runHandoff({root, fakeInvoke})` | baton written, markers cleared |
| P5 | AC5: `runHandoff` on null synthesis → no baton, markers cleared | `fakeInvoke({claude:fail,gemini:fail})` | `wrote=false`, markers cleared |
| P6 | AC5: `runHandoff` throws → markers cleared (start never hangs) | `fakeInvoke(throws)` | `wrote=false`, markers cleared |
| P7 | AC6: trivial transcript → no baton, 0 engine calls | tiny JSONL + `runHandoff` | `reason=trivial`, 0 calls |
| P8 | AC6: empty/missing transcript_path → no baton, 0 engine calls | stash without `transcript_path` | `reason=trivial`, 0 calls |
| P9 | AC7: secrets redacted from baton | leaky synth output + `runHandoff` | `[REDACTED]` in baton, no raw secrets |
| P10 | AC7: `redactSecrets` covers AWS/GitHub/Gemini/JWT/KEY= shapes | `synth.redactSecrets(dirty)` | all shapes scrubbed |
| P11 | AC1: `run --from-spawn` routes to `runHandoff` and writes baton | `synth.run(['--from-spawn','--root',root],{fakeInvoke})` | baton written, exit 0 |
| P12 | AC4: `holdDecision` pure function — no marker | `holdDecision({markerExists:false,...})` | `'proceed'` |
| P13 | AC4: `holdDecision` — fresh marker | `holdDecision({markerExists:true,markerAgeMs:5000,capMs:60000})` | `'wait'` |
| P14 | AC4: `holdDecision` — marker at/over cap | `holdDecision({markerAgeMs:60000,capMs:60000})` | `'proceed'` |
| P15 | AC4: `holdForHandoff` loop — marker clears after 3 polls | injected clock + unlink on poll 3 | `'cleared'`, polls=3 |
| P16 | AC4: `holdForHandoff` — cap elapses, marker never clears | injected clock 10s/step, cap 60s | `'capped'`, polls≤8 |
| P17 | AC4: `holdForHandoff` — no marker → immediate proceed | no marker file | `'cleared'`, polls=0 |
| P18 | AC8: manifest registers `memory-synth-spawn.cjs` | `manifest.files.find(...)` | entry present, `class:managed` |
| P19 | AC8: `settings.json` wires `SessionEnd` → spawn hook | inspect `settings.json` | `SessionEnd` block present |
| P20 | AC8: existing session-start tests stay green | `node --test test/session-start.test.cjs test/session-start-hold.test.cjs` | 11/11 pass |
| E1 | EDGE: empty transcript file | empty JSONL + `runHandoff` | trivial, 0 calls, markers cleared |
| E2 | EDGE: whitespace-only JSONL | whitespace JSONL + `runHandoff` | trivial, 0 calls, markers cleared |
| E3 | EDGE: planted secrets in synth output | dirty handoff text + `runHandoff` | `[REDACTED]` present, no raw tokens |
| E4 | EDGE: synth throws → markers still cleared | throwing invoker + `runHandoff` | markers cleared, `wrote=false` |
| E5 | EDGE: hold — marker clears mid-poll → baton readable | injected clock + write baton on poll 2 | `'cleared'`, baton readable |
| E6 | EDGE: safety-cap — synth never clears marker | injected clock, marker never removed | `'capped'`, polls≤8 |
| E7 | EDGE: bad input — no stdin | `node memory-synth-spawn.cjs < /dev/null` | `{}`, exit 0 |
| E8 | EDGE: bad input — malformed JSON stdin | `echo 'not json {{{' | node memory-synth-spawn.cjs` | `{}`, exit 0 |
| E9 | EDGE: bad input — unknown `--task` to synth CLI | `node memory-synth.cjs --task nonexistent ...` | exit 2, usage error |
| E10 | EDGE: bad input — missing transcript arg to synth CLI | `node memory-synth.cjs --task handoff` | exit 2, usage |
| E11 | EDGE: repeat-run spawn hook — safe double fire | hook called twice in sequence (sentinel set) | both `{}`, no crash |

---

## Execution

### P1 — AC2: spawn hook returns {} immediately

```
Command: echo '{"session_id":"qa-ac2","transcript_path":"/tmp/x.jsonl","cwd":"<sandbox>"}' | node memory-synth-spawn.cjs
Exit: 0  Stdout: {}
```
PASS

### P2 — AC3: recursion guard with sentinel set

```
Command: WRXN_MEMORY_SYNTH=1 CLAUDE_PROJECT_DIR=<sandbox> node memory-synth-spawn.cjs <payload>
Exit: 0  Stdout: {}
pending marker: NO  handoff marker: NO
```
PASS — no markers written when sentinel is set.

### P3 — AC3: without sentinel → markers written

```
Command: CLAUDE_PROJECT_DIR=<sandbox> node memory-synth-spawn.cjs <payload>
Exit: 0  Stdout: {}
pending marker: YES  handoff marker: YES
pending content: {"session_id":"qa-ac3-nospawn","transcript_path":"/tmp/x.jsonl","cwd":"<sandbox>"}
```
PASS — both markers raised before the spawn returns.

### P4 — AC1+AC5: runHandoff writes baton, clears markers

```
Drive: synth.runHandoff({root:SANDBOX, fakeInvoke({claude:{ok:true,text:'**TL;DR** wired...'}})})
res.wrote: true  engine calls: 1
baton excerpt: **TL;DR** wired auto-handoff e2e
handoff marker: cleared  pending marker: cleared
stray temp files: none
transcript blob reached engine: YES ('wire the auto-handoff slice' in input)
```
PASS

### P5 — AC5: null synthesis → no baton, markers cleared

```
Drive: runHandoff with fakeInvoke({claude:fail, gemini:fail})
res.wrote: false  reason: no-engine
baton exists: NO  handoff marker: cleared  pending marker: cleared
```
PASS

### P6 — AC5: synth throws → markers cleared

```
Drive: runHandoff with invoke=async()=>{throw new Error('engine crash!')}
res.wrote: false  reason: no-engine
handoff marker: cleared  pending marker: cleared
```
PASS — the throw is caught in `runEngine` → returns null → `no-engine` path; the `finally` in `runHandoff` runs unconditionally.

### P7 — AC6: trivial transcript → no baton, 0 engine calls

```
Drive: stageSession('{"type":"user","message":{"role":"user","content":"hi"}}')
       runHandoff({fakeInvoke with claude:ok})
res.wrote: false  reason: trivial  engine calls: 0
baton exists: NO  handoff marker: cleared  pending marker: cleared
```
PASS

### P8 — AC6: empty/missing transcript_path → trivial

```
Drive: pendingPath stash has no transcript_path → blob=''
res.wrote: false  reason: trivial  engine calls: 0
handoff marker: cleared
```
PASS

### P9 — AC7: secrets redacted from baton

```
Drive: leaky handoff text containing sk-proj..., Bearer eyJ...
       runHandoff → redactSecrets applied before write
baton contains [REDACTED]: true
/sk-[A-Za-z0-9]{20,}/ in baton: false
/Bearer eyJ[\w.-]+/ in baton: false
normal prose preserved: YES
```
PASS for sk-/JWT shapes.

FINDING: npm_ token shape NOT covered — see finding filed below.

### P10 — AC7: redactSecrets coverage

```
synth.redactSecrets(dirty) — systematic probe of all patterns:
REDACTED  AWS key (AKIA...)
REDACTED  GitHub PAT (ghp_...)
REDACTED  Slack token (xoxb-...)
REDACTED  OpenAI key (sk-...)
REDACTED  Gemini key (AIzaSy...)
REDACTED  JWT Bearer (eyJ...)
REDACTED  KEY=value assignment
NOT REDACTED  npm_ token (npm_abcdefghij1234567890abcdefghij1234567890)
NOT REDACTED  Bearer npm_ token
```
FINDING — npm_ token shape is absent from REDACTIONS array in `memory-synth.cjs`. Filed as finding F-01.

### P11 — AC1: run --from-spawn routes to runHandoff

```
Drive: synth.run(['--from-spawn','--root',SANDBOX], {fakeInvoke({claude:{ok:true,text:'**TL;DR** from-spawn baton written'}})})
exit: 0  baton: **TL;DR** from-spawn baton written
handoff marker: cleared  engine calls: 1
```
PASS

### P12–P14 — AC4: holdDecision pure function

```
holdDecision({markerExists:false, markerAgeMs:0, capMs:60000}) → 'proceed'  PASS
holdDecision({markerExists:true, markerAgeMs:5000, capMs:60000}) → 'wait'   PASS
holdDecision({markerExists:true, markerAgeMs:60000, capMs:60000}) → 'proceed' PASS
holdDecision({markerExists:true, markerAgeMs:90000, capMs:60000}) → 'proceed' PASS
```
PASS

### P15 — AC4: holdForHandoff loop clears

```
Drive: injected clock (1s/step), marker removed on poll 3
result: 'cleared'  polls: 3
```
PASS

### P16 — AC4: holdForHandoff safety-cap

```
Drive: injected clock (10s/step, cap 60s), marker never removed
result: 'capped'  polls: 6
```
PASS — stopped at 6 polls (≤8), well within cap.

### P17 — AC4: holdForHandoff no marker

```
Drive: no marker file
result: 'cleared'  polls: 0
```
PASS

### P18 — AC8: manifest registration

```
manifest.files.find(f => f.path === '.claude/hooks/memory-synth-spawn.cjs')
→ {"path":".claude/hooks/memory-synth-spawn.cjs","class":"managed","profile":"project"}
```
PASS

### P19 — AC8: settings.json SessionEnd wiring

```
settings.hooks.SessionEnd[0].hooks[0].command:
  "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs\""
```
PASS

### P20 — AC8: existing session-start tests green

```
node --test test/session-start.test.cjs test/session-start-hold.test.cjs
# tests 11  pass 11  fail 0
```
PASS

### E1 — EDGE: empty transcript file

```
Drive: empty JSONL file → runHandoff
reason: trivial  engine calls: 0  markers cleared: YES
```
PASS

### E2 — EDGE: whitespace-only JSONL

```
Drive: whitespace JSONL → runHandoff
reason: trivial  engine calls: 0  markers cleared: YES
```
PASS

### E3 — EDGE: planted secrets in synth output

```
Drive: dirty handoff with sk-/npm_/Bearer/AWS_SECRET → runHandoff
sk- redacted: YES  Bearer JWT redacted: YES
npm_ redacted: NO  (FINDING — see F-01)
AWS_SECRET redacted: YES
[REDACTED] markers present: YES
```
FINDING F-01 also observed here.

### E4 — EDGE: synth throws → markers cleared

```
Drive: throwing invoker
wrote: false  handoff marker: cleared  pending marker: cleared
```
PASS

### E5 — EDGE: hold — marker clears mid-poll → baton readable

```
Drive: injected clock, unlink marker + write baton on poll 2
result: 'cleared'  polls: 2
baton readable after hold: YES ('**TL;DR** injected by session-start...')
```
PASS

### E6 — EDGE: safety-cap

```
Drive: injected clock, marker never removed
result: 'capped'  polls: 6
```
PASS

### E7 — EDGE: no stdin

```
node memory-synth-spawn.cjs < /dev/null
exit: 0  stdout: {}
```
PASS

### E8 — EDGE: malformed JSON stdin

```
echo 'not json {{{' | node memory-synth-spawn.cjs
exit: 0  stdout: {}
```
PASS

### E9 — EDGE: unknown --task

```
node memory-synth.cjs --task nonexistent /tmp/x.jsonl
exit: 2
stderr: memory-synth: unsupported task "nonexistent" — known tasks: handoff
```
PASS

### E10 — EDGE: missing transcript arg

```
node memory-synth.cjs --task handoff
exit: 2
stderr: Usage: node .wrxn/memory-synth.cjs --task handoff <transcript-file> [--root <dir>]
```
PASS

### E11 — EDGE: repeat-run spawn hook

```
Call 1: exit=0  stdout='{}'
Call 2: exit=0  stdout='{}'
Both return {}: YES
```
PASS

---

## Findings

### F-01 — npm_ token shape missing from REDACTIONS array

**Severity:** MEDIUM

**AC broken:** AC7 (secrets are redacted from the handoff body); PRD story 19.

**Promise:** "I want secrets redacted from the handoff and never written into a dream page, so that a durable artifact never hardens a credential."

**Observed:** `npm_` tokens (npm publish/automation tokens) pass through `redactSecrets` unchanged. The pattern `npm_[A-Za-z0-9]{20,}` is absent from the `REDACTIONS` array in `payload/.wrxn/memory-synth.cjs`.

**Repro:**
```js
const synth = require('./payload/.wrxn/memory-synth.cjs');
const out = synth.redactSecrets('npm_abcdefghij1234567890abcdefghij1234567890 token here');
// out === 'npm_abcdefghij1234567890abcdefghij1234567890 token here'  (unchanged)
```

**Evidence:**
```
NOT REDACTED  npm_ token
  original: npm_abcdefghij1234567890abcdefghij1234567890 in text
  output:   npm_abcdefghij1234567890abcdefghij1234567890 in text
NOT REDACTED  Bearer npm_
  original: Authorization: Bearer npm_abcdefghij1234567890abcdefghij1234567890
  output:   Authorization: Bearer npm_abcdefghij1234567890abcdefghij1234567890
```

**Context:** npm tokens have been pasted in-chat multiple times in this project's history (memory.md), making this a real-world risk. `gh*_` (GitHub) and `sk-` (OpenAI) are covered; npm is not.

**Fix:** Add `/\bnpm_[A-Za-z0-9]{20,}\b/g` to the `REDACTIONS` array in `payload/.wrxn/memory-synth.cjs`.

---

## Verdict

**FINDINGS (1)**

- F-01 (MEDIUM) — npm_ token shape missing from REDACTIONS; AC7 partially unmet

Walk coverage:
- 8/8 ACs exercised
- 31 commands/probes run (20 plan items + 11 edge probes)
- 30 PASS, 1 FINDING

ACs 1, 2, 3, 4, 5, 6, 8: fully PASS.
AC7: PARTIAL — 7 of 8 credential shapes redacted; npm_ token is the gap.

Note: this walk ran in fresh context (not the builder's session). The injectable fake invoker was used as designed by the PRD (story 26) — no real LLM or network calls were made. All writes were confined to `/tmp/wrxn-qa-walk-03-3uqTnc/` (sandboxed temp dir).
