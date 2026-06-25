'use strict';

// #70 — the fake-secrets fixture helper, self-verified.
//
// Test files need real-FORMAT (but fabricated) secret tokens to exercise the detect/redact paths.
// A LITERAL `xoxb-…`/`AKIA…`/`sk_live_…` in source trips GitHub push protection + GitGuardian by
// format (it forced a push-protection bypass to land #39). The fix: assemble each fixture at RUNTIME
// from split pieces so no contiguous scannable token exists in source, while the assembled string
// still matches the production pattern under test. This file is the proof of BOTH halves:
//   1. each builder's output still trips the REAL production scanner/redactor (so coverage is intact);
//   2. no scannable literal remains anywhere under test/ (the #70 grep verdict, locked as a test).
//
// The production reference is sidecar.cjs: it carries the full canonical SECRET_PATTERNS set (#39)
// PLUS its own extras, and exports both secretScan and redactSecrets — so every shape a builder makes
// is checked against the same code that guards real egress.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fake = require('./helpers/fake-secrets.cjs');
const sidecar = require('../payload/.claude/hooks/sidecar.cjs');

// ── half 1: every builder still matches a production secret pattern ──────────────────
// Dynamically cover EVERY exported builder, so a new shape can't be added without this proof.
for (const [name, build] of Object.entries(fake)) {
  if (typeof build !== 'function') continue;
  test(`fake.${name}() still trips the production scanner + redactor (fixture stays live)`, () => {
    const val = build();
    assert.equal(typeof val, 'string', `${name}() returns a string`);
    assert.equal(sidecar.secretScan(val), 'contains_secret', `${name}() must match a production pattern`);
    const redacted = sidecar.redactSecrets(`pre ${val} post`);
    assert.ok(!redacted.includes(val), `${name}() must be scrubbed by production redaction`);
    assert.match(redacted, /^pre .* post$/s, `${name}() redaction preserves surrounding text`);
  });
}

// ── half 2: no scannable secret literal remains in any test/ source (the #70 verdict) ──
// The canonical 14 high-signal shapes a scanner flags by FORMAT, plus Slack `xapp-` (an app-level
// token the production set does not catch but GitGuardian still flags). The generic KEY=value shape
// (#14) is intentionally excluded: it is not a high-entropy provider token and legitimately appears
// across the suite (documented config keys like GEMINI_API_KEY=…), so it is not a scanner trip.
const SCANNABLE = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /xapp-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /AIza[0-9A-Za-z._-]{10,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/,
  /npm_[A-Za-z0-9]{20,}/,
  /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/,
];

function walkCjs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCjs(full));
    else if (entry.name.endsWith('.cjs')) out.push(full);
  }
  return out;
}

test('no scannable secret literal survives anywhere under test/ (#70 grep verdict, locked)', () => {
  const root = __dirname;
  const offenders = [];
  for (const file of walkCjs(root)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of SCANNABLE) {
      const m = re.exec(src);
      if (m) offenders.push(`${path.relative(root, file)}: ${m[0].slice(0, 48)}`);
    }
  }
  assert.deepEqual(offenders, [], `secret-shaped literals must be assembled at runtime, never written in source:\n${offenders.join('\n')}`);
});
