---
id: auto-memory-06
title: "npm_ token shape missing from redactSecrets REDACTIONS array"
labels: [needs-triage, bug]
severity: MEDIUM
found-by: qa-walker (auto-memory-03 walk, 2026-06-20)
---

## Parent

Promise broken: `acceptance/auto-memory/issues/03-auto-handoff-end-to-end.md` AC7:
> Secrets are redacted from the handoff body.

PRD story 19:
> As an operator, I want secrets redacted from the handoff and never written into a dream page, so that a durable artifact never hardens a credential.

## Promise vs Observed

**Promise:** `redactSecrets` in `payload/.wrxn/memory-synth.cjs` scrubs common credential shapes from the synthesized handoff body before it is written to the baton.

**Observed:** `npm_` publish/automation tokens pass through `redactSecrets` unchanged. The `REDACTIONS` array covers AWS (`AKIA…`), GitHub (`gh[pousr]_…`), Slack (`xox[baprs]-…`), OpenAI (`sk-…`), Gemini (`AIza…`), JWTs, and `KEY/TOKEN/SECRET/PASSWORD=value` assignments — but does not include the `npm_` token shape.

## Repro (copy-pasteable)

```js
const synth = require('./payload/.wrxn/memory-synth.cjs');
const out = synth.redactSecrets('npm_abcdefghij1234567890abcdefghij1234567890 token here');
console.log(out);
// prints: npm_abcdefghij1234567890abcdefghij1234567890 token here  (not redacted)
```

Also not caught when in a Bearer context:
```js
synth.redactSecrets('Authorization: Bearer npm_abcdefghij1234567890abcdefghij1234567890')
// still not redacted
```

## Evidence excerpt

```
NOT REDACTED  npm_ token
  original: npm_abcdefghij1234567890abcdefghij1234567890 in text
  output:   npm_abcdefghij1234567890abcdefghij1234567890 in text
NOT REDACTED  Bearer npm_
  original: Authorization: Bearer npm_abcdefghij1234567890abcdefghij1234567890
  output:   Authorization: Bearer npm_abcdefghij1234567890abcdefghij1234567890
```

Confirmed by running `synth.redactSecrets()` directly against the real module at commit `cd3cdda`.

## Fix

Add one pattern to the `REDACTIONS` array in `payload/.wrxn/memory-synth.cjs`:

```js
/\bnpm_[A-Za-z0-9]{20,}\b/g,  // npm publish / automation tokens
```

Add a corresponding assertion to `test/memory-synth-handoff.test.cjs` `redactSecrets` test:
```js
assert.doesNotMatch(clean, /npm_[A-Za-z0-9]{20}/, 'an npm token is redacted');
```

## Risk context

npm tokens have appeared in-chat in this project's history. The `npm_` shape is a well-known credential (npm publish tokens, CI automation tokens). Without this pattern a model that echoes a token it saw in the transcript can persist it in the durable baton.
