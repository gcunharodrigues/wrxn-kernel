---
id: auto-memory-07
title: "dream.cjs secretScan npm_ threshold (36) narrower than redactSecrets threshold (20)"
labels: [needs-triage, enhancement]
severity: LOW
found-by: qa-walker (integration walk, 2026-06-20)
defer: true
---

## Parent

Promise: `acceptance/auto-memory/PRD.md` Story 19:
> As an operator, I want secrets redacted from the handoff and never written into a dream page, so that a durable artifact never hardens a credential.

## Promise vs Observed

**Promise:** secrets are never hardened into a dream wiki page.

**Observed:** the two secret-scan boundaries use different minimum lengths for the `npm_` token shape:

- `payload/.wrxn/memory-synth.cjs` `REDACTIONS`: `/\bnpm_[A-Za-z0-9]{20,}\b/g` — catches 20+ chars (correct for granular tokens that may be shorter than 36).
- `payload/.wrxn/dream.cjs` `SECRET_PATTERNS`: `/npm_[A-Za-z0-9]{36}/` — catches exactly 36+ chars (the legacy token length).

A hallucinated `npm_`-prefixed string of 20–35 characters in a proposal body passes the dream gate's secret scan and reaches the wiki page.

## Why this is LOW and DEFER

1. **The model cannot see a real token.** `redactSecrets` scrubs the blob BEFORE it is sent to the model (any `npm_` token 20+ chars is replaced with `[REDACTED]`). The model cannot echo a real credential it never saw.
2. **A hallucinated 20–35 char string is not a real credential.** Real npm tokens (both legacy and granular forms) are 36+ chars; a shorter string is not a usable token.
3. **Pre-existing gap.** `dream.cjs`'s `SECRET_PATTERNS` predate auto-memory; auto-memory did not introduce this gap and actually tightened the main threat path (the blob is scrubbed before model-send; the manual dream skill has no such scrub at all).
4. **No real-world scenario produces a blocked credential.** The double-scrub in `runHandoff` (before model-send and before baton-write) is the load-bearing control.

## Repro (theoretical only)

```js
// In a proposal body produced by a model:
const body = '# Title\n\nThe npm_Abcdefghijklmnopqrstuvwxyz token was used.';
// "npm_Abcdefghijklmnopqrstuvwxyz" — 4 + 26 chars, post-npm_ span = 26 < 36
// dream.cjs SECRET_PATTERNS[2] does not match; page is written.
// Real risk: near zero (model received [REDACTED] blob; 26-char npm_ string is not a valid token).
```

## Fix (when ready)

Align `dream.cjs` `SECRET_PATTERNS` npm_ entry to `/npm_[A-Za-z0-9]{20,}/` to match `redactSecrets`. One-line change, no behavior change for any real credential shape.

```diff
-  /npm_[A-Za-z0-9]{36}/,                 // npm automation token
+  /npm_[A-Za-z0-9]{20,}/,                // npm automation token (≥20 covers all real formats)
```
