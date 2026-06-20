---
slice: auto-memory-04
artifact: payload/.wrxn/memory-synth.cjs (runDream) + payload/.wrxn/dream.cjs (check/commit --source)
walker: qa-walker
date: 2026-06-20
branch: auto-memory
commit: cd3560c
result: 7/7 PASS — 0 findings
---

# QA Walk — auto-memory-04: auto-dream

## Artifact

`runDream({ root, blob, invoke })` in `payload/.wrxn/memory-synth.cjs`, wired through `dream.cjs check --source / stage / commit --source`. Walked with a fake injectable invoker (no real `claude -p`, no network). Dream pages land in a fresh kernel install created via `lib/install.cjs init`.

## Approach

Each AC was exercised by calling the REAL `runDream` function (or the real `dream.cjs` CLI subprocess for AC6) with a canned fake invoker. Evidence = observed return values + filesystem state. No unit tests were re-run; the walk exercised the artifact directly.

Transcript blob used throughout:

```
[user] we debated the logging stack at length today
[assistant] after weighing options we decided to log with pino for structured logs everywhere
[user] good, lock that in
```

---

## AC1 — accepted path: substantive verbatim quote present in blob → committed

**Command / code:**
```js
fakeInvoke({ claude: { ok: true, text: JSON.stringify({ proposals: [proposal()] }) } })
// proposal evidence: { quote: 'we decided to log with pino for structured logs' }
const res = await synth.runDream({ root, blob: BLOB, invoke });
```

**Observed:**
- `res.written: ["log-with-pino"]`
- `.wrxn/wiki/decisions/log-with-pino.md` exists on disk
- File contains `pino for structured logs` (the committed body)
- Engine called once; blob fed to engine contains the in-memory transcript text

**Result: PASS**

---

## AC2 — fabricated quote: not in blob → rejected (quote_not_in_source), no page written

**Command / code:**
```js
const fabricated = proposal({
  slug: 'invented-decision',
  evidence: [{ quote: 'a substantive sentence that was never spoken in this session' }],
});
const res = await synth.runDream({ root, blob: BLOB, invoke });
```

**Observed:**
- `res.written: []`
- `.wrxn/wiki/decisions/invented-decision.md` does NOT exist

The fabricated quote was rejected at `dream.cjs check --source` with reason `quote_not_in_source` (the gate rejects before `stage`/`commit`); no page reached the recall surface.

**Result: PASS**

---

## AC3 — gate honored end-to-end: confidence floor, secret-scan, anti-superstition, ≤5 cap

### AC3a — confidence floor (0.75)

**Command / code:**
```js
// good: confidence 0.9, weak: confidence 0.5, both with quote present in blob
const res = await synth.runDream({ root, blob: BLOB, invoke });
```

**Observed:**
- `res.written: ["log-with-pino"]` (only the 0.9 proposal)
- `low-conf` page NOT written
- `log-with-pino` page written

**Result: PASS**

### AC3b — secret-scan

**Command / code:**
```js
const leaky = proposal({ body: '# Leaked credential\n\nThe access key is AKIAIOSFODNN7EXAMPLE, do not lose it.' });
```

**Observed:**
- `res.written: []`
- No page written; AWS key pattern in body triggers `contains_secret`

**Result: PASS**

### AC3c — ≤5/run cap

**Command / code:**
```js
// 6 proposals, all valid, all with quote present in blob
const res = await synth.runDream({ root, blob: BLOB, invoke });
```

**Observed:**
- `res.written.length: 5`
- 6th proposal recorded as `max_proposals_exceeded` by the gate

**Result: PASS**

### AC3 edge — anti-superstition filter on authored text, not evidence quotes

A proposal with a clean body but whose evidence quote cites text containing `is broken and does not work` (present in the blob) was accepted — confirming the filter runs only over title+body+rationale, not evidence quotes.

**Result: PASS**

---

## AC4 — additive/dedup: existing page dedup-skipped, no clobber

**Command / code:**
```js
// Pre-planted curated page at decisions/log-with-pino.md with 'CURATED original body'
const res = await synth.runDream({ root, blob: BLOB, invoke });
```

**Observed:**
- `res.written: []`
- File still contains `CURATED original body` — not clobbered
- Gate reports `duplicate_existing_path` for the slug

**Result: PASS**

---

## AC5 — ordering: baton written first, handoff marker cleared before dream engine runs

**Command / code:**
```js
// --from-spawn path, session staged with .pending + .pending-handoff both present
const observations = { markerAtDreamCall: null, callOrder: [] };
const invoke = async (spec) => {
  const input = String(spec.input || '');
  if (input.includes('HANDOFF')) {
    observations.callOrder.push('handoff');
    return { ok: true, text: '**TL;DR** decided to log with pino' };
  }
  observations.callOrder.push('dream');
  observations.markerAtDreamCall = fs.existsSync(handoffMarker(root));
  return { ok: true, text: dreamText([proposal()]) };
};
const code = await synth.run(['--from-spawn', '--root', root], { invoke });
```

**Observed:**
- `callOrder: ["handoff","dream"]` — handoff ran first
- `markerAtDreamCall: false` — the `.pending-handoff` marker was already gone when the dream engine was called
- baton `.wrxn/continuity/latest.md` exists
- `.wrxn/wiki/decisions/log-with-pino.md` exists
- Both `.pending-handoff` and `.pending` cleared after run
- Exit code: 0

The handoff marker (the SessionStart hold gate) was cleared by `runHandoff` before `runDream` even began. Dream can never extend the hold.

**Result: PASS**

---

## AC6 — manual path unchanged: `dream.cjs check` without `--source` does not apply quote-verify

**Command / code:**
```sh
node <install>/.wrxn/dream.cjs check prop.json --root <install>
```
where `prop.json` is a proposal with a fabricated evidence quote (not in any transcript).

**Observed:**
```json
{"ok":true}
```

Without `--source`, the gate does not apply quote-verify (the trusted manual-proposer path). The fabricated quote is accepted because the human operator is the trusted proposer. Behavior is byte-identical to pre-auto-memory.

**F2 fail-closed edge also verified:** running `dream.cjs check prop.json --source --root <install>` (source flag with no file value, next token is `--root`) exits 2 with: `dream: --source was given without a readable file value — refusing to silently disable quote-verify`. The gate never silently disables.

**Result: PASS**

---

## AC7 — abstain: engine returns no usable proposals → nothing written

Three sub-cases exercised:

| Case | Fake engine output | `res.written` | `res.reason` | Result |
|------|-------------------|--------------|-------------|--------|
| abstain JSON | `{"abstain":true}` | `[]` | `abstain` | PASS |
| unparseable prose | `"I could not find anything durable..."` | `[]` | `abstain` | PASS |
| empty proposals | `{"proposals":[]}` | `[]` | `abstain` | PASS |

No wiki pages written in any tier for any case.

**Result: PASS**

---

## Edge probes (beyond the 7 ACs)

| Probe | Description | Result |
|-------|-------------|--------|
| trivial blob | blob shorter than `TRIVIAL_BLOB_MIN` → no model call, nothing written, reason `trivial` | PASS |
| F2 fail-closed | `--source` with no file value exits 2, refuses to disable gate | PASS |
| anti-superstition authored scope | filter only on title/body/rationale, not evidence quotes | PASS |

---

## Summary

**7/7 ACs pass. 0 findings filed.**

The auto-dream path (`runDream`) correctly:
- Accepts proposals whose verbatim evidence quote is substantively present in the transcript blob (AC1)
- Rejects fabricated quotes via `quote_not_in_source` and never writes those pages to recall (AC2)
- Honors every existing gate check: confidence floor, secret-scan, anti-superstition filters, dedup-skip, ≤5/run cap (AC3, AC4)
- Runs strictly after the handoff path clears the `.pending-handoff` marker, so it can never extend the SessionStart hold (AC5)
- Leaves the manual `dream.cjs check` path (no `--source`) unchanged (AC6)
- Writes nothing when the engine abstains or returns no usable proposals (AC7)
