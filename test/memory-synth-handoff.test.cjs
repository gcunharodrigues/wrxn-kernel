'use strict';

// Tests for the synth's HANDOFF PATH (auto-memory-03) — the background work the detached SessionEnd
// child does: read the stashed payload's transcript_path → bounded blob → engine `handoff` task →
// redact secrets → write the baton .wrxn/continuity/latest.md ATOMICALLY → clear the handoff marker
// to release session-start. It then clears all its markers on EVERY exit (success/fail/trivial), so
// SessionStart never hangs past the safety-cap.
//
// The engine is behind the SAME injectable invoker proven in slice 02 (test/memory-synth.test.cjs):
// a fake invoker returns canned handoff text — NO real `claude -p`, NO network, NO spawn. The synth is
// the SOLE baton writer (continuity doctrine, PRD story 20).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const synth = require('../payload/.wrxn/memory-synth.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function continuityDir(root) {
  const d = path.join(root, '.wrxn', 'continuity');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function batonPath(root) {
  return path.join(root, '.wrxn', 'continuity', 'latest.md');
}
function pendingPath(root) {
  return path.join(root, '.wrxn', 'continuity', '.pending');
}
function handoffMarker(root) {
  return path.join(root, '.wrxn', 'continuity', '.pending-handoff');
}

// Write a transcript file + stash the spawn payload + raise the markers, exactly as the spawn hook did.
function stageSession(root, jsonl) {
  const dir = continuityDir(root);
  const tx = path.join(root, 'session.jsonl');
  fs.writeFileSync(tx, jsonl);
  fs.writeFileSync(pendingPath(root), JSON.stringify({ session_id: 'sid-x', transcript_path: tx, cwd: root }));
  fs.writeFileSync(handoffMarker(root), String(Date.now()));
  return { tx, dir };
}

// A fake invoker (same shape as slice 02): canned text per engine, records the specs it received.
function fakeInvoke(byEngine) {
  const calls = [];
  const invoke = async (spec) => {
    calls.push(spec);
    const r = byEngine[spec.engine];
    return typeof r === 'function' ? r(spec) : r || { ok: false };
  };
  return { invoke, calls };
}

const REAL_SESSION = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'build the auto-handoff slice' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'wrote the spawn hook and the synth path' }] } }),
].join('\n');

// ── AC1 + AC5: SessionEnd → baton written from the transcript, with no manual step ──

test('runHandoff builds the blob from the stashed transcript, synthesizes, and writes the baton', async () => {
  const root = tmp('wrxn-handoff-write-');
  stageSession(root, REAL_SESSION);
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** resumed at the auto-handoff slice\n**Next step** wire SessionStart' } });

  const res = await synth.runHandoff({ root, invoke });

  assert.equal(res.wrote, true, 'the baton was written');
  const baton = fs.readFileSync(batonPath(root), 'utf8');
  assert.match(baton, /TL;DR/, 'the synthesized handoff is the baton body');
  assert.match(baton, /wire SessionStart/, 'the full handoff text is persisted');
  // the engine was fed the handoff system prompt + the transcript blob (built from the stash).
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes('HANDOFF'), 'the handoff system prompt reached the engine');
  assert.ok(calls[0].input.includes('build the auto-handoff slice'), 'the transcript blob reached the engine');
});

test('runHandoff clears the handoff marker on success (releases session-start) and the pending marker', async () => {
  const root = tmp('wrxn-handoff-clear-');
  stageSession(root, REAL_SESSION);
  const { invoke } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** done' } });

  await synth.runHandoff({ root, invoke });

  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff gate is cleared so SessionStart proceeds');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is cleared (no synth in flight)');
});

// ── AC5: the synth is the SOLE writer + clears markers on a FAILED synthesis too ──

test('runHandoff on a null synthesis (no engine) writes NO baton but still clears the markers', async () => {
  const root = tmp('wrxn-handoff-noeng-');
  stageSession(root, REAL_SESSION);
  // claude CLI down + no gemini key → synthesize yields null. The synth must not hang session-start.
  const { invoke } = fakeInvoke({ claude: { ok: false }, gemini: { ok: false } });

  const res = await synth.runHandoff({ root, invoke });

  assert.equal(res.wrote, false, 'nothing synthesized → no baton written (fail-safe)');
  assert.ok(!fs.existsSync(batonPath(root)), 'the baton is not created on a null synthesis');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is STILL cleared so start never hangs');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is cleared on every exit');
});

// ── AC6: a trivial/empty transcript → write nothing, and SPEND NO model call ────
// The load-bearing assertion is the invoker call count: a trivial session must never reach the engine,
// so the operator pays nothing to "summarize" an empty session.

test('runHandoff skips a trivial/empty transcript: no baton, no model call, markers cleared', async () => {
  const root = tmp('wrxn-handoff-trivial-');
  // a near-empty session: one tiny prompt, nothing of substance.
  stageSession(root, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: 'SHOULD NEVER BE CALLED' } });

  const res = await synth.runHandoff({ root, invoke });

  assert.equal(res.wrote, false, 'a trivial session writes no baton');
  assert.equal(res.reason, 'trivial', 'the skip reason is trivial');
  assert.equal(calls.length, 0, 'the engine is NEVER invoked for a trivial session (no model spend)');
  assert.ok(!fs.existsSync(batonPath(root)), 'no baton is created for a trivial session');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is still cleared (start is released)');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is cleared');
});

test('runHandoff with an empty/missing transcript path also skips and clears (no stash → no work)', async () => {
  const root = tmp('wrxn-handoff-empty-');
  // markers raised but the stash has no transcript_path (or the file is empty) → trivial.
  continuityDir(root);
  fs.writeFileSync(pendingPath(root), JSON.stringify({ session_id: 'sid-e', cwd: root }));
  fs.writeFileSync(handoffMarker(root), String(Date.now()));
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: 'NEVER' } });

  const res = await synth.runHandoff({ root, invoke });

  assert.equal(res.wrote, false);
  assert.equal(calls.length, 0, 'no transcript → no engine call');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'marker cleared so start never hangs');
  assert.ok(!fs.existsSync(pendingPath(root)));
});

// ── the detached child's entry: `--from-spawn` routes to runHandoff (integration glue) ──
// The spawn hook launches `node memory-synth.cjs --from-spawn --root <root>`. That invocation MUST
// drive the handoff path (read the stash → baton), not the manual transcript-file CLI. Proven through
// the testable run() core with a fake invoker (no real spawn/engine).

test('run --from-spawn drives the handoff path: reads the stash and writes the baton', async () => {
  const root = tmp('wrxn-handoff-fromspawn-');
  stageSession(root, REAL_SESSION);
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** from-spawn baton' } });

  const code = await synth.run(['--from-spawn', '--root', root], { invoke });

  assert.equal(code, 0, 'the from-spawn path exits 0');
  assert.match(fs.readFileSync(batonPath(root), 'utf8'), /from-spawn baton/, 'the baton was written from the stash');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is cleared (session-start released)');
  assert.equal(calls.length, 1, 'the engine ran once for the handoff');
});

test('run --from-spawn on a trivial stash exits 0, writes no baton, clears markers (no model spend)', async () => {
  const root = tmp('wrxn-handoff-fromspawn-trivial-');
  stageSession(root, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: 'NEVER' } });

  const code = await synth.run(['--from-spawn', '--root', root], { invoke });

  assert.equal(code, 0, 'a trivial session still exits 0 (graceful, no error)');
  assert.equal(calls.length, 0, 'no engine call for a trivial session');
  assert.ok(!fs.existsSync(batonPath(root)));
  assert.ok(!fs.existsSync(handoffMarker(root)), 'markers cleared so start never hangs');
});

// ── AC7: secrets are redacted from the handoff body before the baton is written ──
// A model can echo a credential it saw in the transcript into its summary. The synth must scrub the
// handoff body before persisting it, so the durable baton never hardens a secret (PRD story 19).

test('redactSecrets scrubs common credential shapes from a body', () => {
  const dirty = [
    'export GEMINI_API_KEY=AIzaSyД-not-real-key-1234567890abcd',
    'a github token ghp' + '_0123456789abcdefghijklmnopqrstuvwxyz lives here',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'aws AKIAIOSFODNN7EXAMPLE key',
    'a normal line about wiring SessionStart that must survive',
  ].join('\n');

  const clean = synth.redactSecrets(dirty);

  assert.doesNotMatch(clean, /AIzaSy[\wД-]{10}/, 'a google/gemini api key is redacted');
  assert.doesNotMatch(clean, /ghp_[A-Za-z0-9]{20}/, 'a github token is redacted');
  assert.doesNotMatch(clean, /Bearer eyJ[\w.-]+/, 'a bearer JWT is redacted');
  assert.doesNotMatch(clean, /AKIA[0-9A-Z]{12}/, 'an aws access key id is redacted');
  assert.match(clean, /\[REDACTED\]/, 'redactions are marked');
  assert.match(clean, /wiring SessionStart that must survive/, 'ordinary content is preserved verbatim');
});

test('runHandoff redacts secrets from the synthesized handoff before writing the baton', async () => {
  const root = tmp('wrxn-handoff-redact-');
  stageSession(root, REAL_SESSION);
  // the model echoes a key it saw in the transcript into its handoff.
  const leaky = '**TL;DR** done\n**Open / to confirm** key was ghp' + '_0123456789abcdefghijklmnopqrstuvwxyz';
  const { invoke } = fakeInvoke({ claude: { ok: true, text: leaky } });

  await synth.runHandoff({ root, invoke });

  const baton = fs.readFileSync(batonPath(root), 'utf8');
  assert.doesNotMatch(baton, /ghp_[A-Za-z0-9]{20}/, 'the leaked token never reaches the durable baton');
  assert.match(baton, /\[REDACTED\]/, 'the baton marks the redaction');
  assert.match(baton, /TL;DR/, 'the rest of the handoff is intact');
});

// ── AC5: atomic write — no half-written baton is ever observable ────────────────

test('runHandoff writes the baton atomically (temp + rename, no stray temp left behind)', async () => {
  const root = tmp('wrxn-handoff-atomic-');
  stageSession(root, REAL_SESSION);
  const { invoke } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** atomic' } });

  await synth.runHandoff({ root, invoke });

  const dir = path.join(root, '.wrxn', 'continuity');
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp') || f.endsWith('~'));
  assert.deepEqual(leftovers, [], 'no temp artifact is left in the continuity dir (rename was atomic)');
  assert.ok(fs.existsSync(batonPath(root)), 'the final baton exists at latest.md');
});
