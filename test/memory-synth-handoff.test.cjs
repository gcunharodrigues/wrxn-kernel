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
function synthLogPath(root) {
  return path.join(root, '.wrxn', 'continuity', '.synth.log');
}

// A no-op injected sleep so the retry loop runs instantly in tests (no wall-clock wait).
const noSleep = () => {};

// A fake invoke whose claude engine returns `{ok:false}` for the first `failures` calls, then succeeds
// with `text`. Records the per-engine call count so a test can prove the retry happened (and is bounded).
function flakyClaude(failures, text) {
  const calls = [];
  let n = 0;
  const invoke = async (spec) => {
    calls.push(spec);
    if (spec.engine !== 'claude') return { ok: false };
    n += 1;
    return n <= failures ? { ok: false, detail: 'transient' } : { ok: true, text };
  };
  return { invoke, calls };
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
  // the handoff runs FIRST through the engine (auto-memory-04 adds a dream call after it; the fake's
  // non-JSON text makes dream abstain, so it writes nothing here — the handoff contract is unchanged).
  assert.ok(calls.length >= 1, 'the engine ran for the handoff');
  assert.ok(String(calls[0].input).includes('HANDOFF'), 'the FIRST engine call is the handoff');
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

// ── AC7 (qa-walk F-01 + security F2, MED): bare-in-prose vendor token shapes are redacted ──
// High-signal token shapes that appear BARE in prose (not as KEY=value) slipped past REDACTIONS —
// notably the `npm_…` publish/automation token (qa-walk MEDIUM, acceptance/.../06-npm-token-…). These
// shapes have appeared in-chat in this project, so the synth must scrub them from the handoff body.
test('redactSecrets scrubs bare-in-prose vendor token shapes (npm/github-pat/stripe/pem/bearer)', () => {
  const dirty = [
    'publish with npm' + '_abcdefghij1234567890abcdefghij123456 now', // npm_ + exactly 36 chars (real shape)
    'use github_pat' + '_11ABCDEFG0abcdefghijkl_AbCdEf1234567890AbCdEf1234567890 for ci',
    'stripe live key sk_live' + '_0123456789abcdefghijABCDEFGHIJ here',
    'openai project key sk-proj' + '-0123456789abcdef_ABCDEFGHIJ-klmno here',
    '-----BEGIN PRIV' + 'ATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEw\n-----END PRIVATE KEY-----',
    'Authorization: Bearer abc123DEF456ghi789JKL012mno345',
    'a normal sentence about the SessionStart hold that must survive',
  ].join('\n');

  const clean = synth.redactSecrets(dirty);

  assert.doesNotMatch(clean, /npm_[A-Za-z0-9]{20}/, 'an npm token is redacted');
  assert.doesNotMatch(clean, /github_pat_[A-Za-z0-9_]{20}/, 'a github fine-grained PAT is redacted');
  assert.doesNotMatch(clean, /sk_live_[A-Za-z0-9]{20}/, 'a stripe live key is redacted');
  assert.doesNotMatch(clean, /sk-proj-[A-Za-z0-9_-]{20}/, 'an openai project-scoped key is redacted');
  assert.doesNotMatch(clean, /BEGIN PRIVATE KEY/, 'a PEM private-key block is redacted');
  assert.doesNotMatch(clean, /Bearer abc123DEF456/, 'an opaque bearer token is redacted');
  assert.match(clean, /the SessionStart hold that must survive/, 'ordinary content is preserved verbatim');
});

// Resolves qa-walk finding acceptance/auto-memory/issues/06-npm-token-missing-from-redactions.md —
// the documented repro is a bare 40-char npm token in prose (and the same token in a Bearer context).
test('redactSecrets resolves the issue-06 npm-token repro (bare + Bearer-wrapped)', () => {
  const bare = synth.redactSecrets('npm' + '_abcdefghij1234567890abcdefghij1234567890 token here');
  assert.doesNotMatch(bare, /npm_[A-Za-z0-9]{20}/, 'the bare npm token from the repro is redacted');
  const wrapped = synth.redactSecrets('Authorization: Bearer npm' + '_abcdefghij1234567890abcdefghij1234567890');
  assert.doesNotMatch(wrapped, /npm_[A-Za-z0-9]{20}/, 'the Bearer-wrapped npm token from the repro is redacted');
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

// ── AC7 (security, HIGH): the blob is redacted BEFORE it egresses to the external model ──
// runHandoff feeds the transcript blob to `synthesize`, which sends it to `claude -p` (and, on the
// gemini fallback, POSTs it off-box to a third-party API). A credential in the transcript must be
// scrubbed BEFORE it leaves the box — output-only redaction is too late, the secret has already
// egressed. The load-bearing assertion is what the invoker RECEIVES, not just what the baton holds.

test('runHandoff redacts the transcript blob BEFORE it reaches the engine (no secret egress)', async () => {
  const root = tmp('wrxn-handoff-egress-');
  // the transcript itself carries planted credentials (a user pasted them into the session).
  const leakySession = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'publish with npm' + '_abcdefghij1234567890abcdefghij1234567890 and key sk' + '-0123456789abcdefghijABCDEFGHIJ now' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'wiring the auto-handoff slice and the SessionStart hold' }] } }),
  ].join('\n');
  stageSession(root, leakySession);
  // capture the blob the engine receives (the input that egresses off-box).
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** done' } });

  await synth.runHandoff({ root, invoke });

  assert.equal(calls.length, 1, 'the engine was invoked once');
  const sent = calls[0].input; // what reaches `claude -p` (and would POST to gemini on fallback)
  // a shape already in REDACTIONS — this isolates the EGRESS-TIMING fix (redact the blob before send).
  assert.doesNotMatch(sent, /sk-[A-Za-z0-9]{20}/, 'the openai-style key is scrubbed before egress to the model');
  assert.match(sent, /\[REDACTED\]/, 'the blob the engine received was redacted');
  assert.match(sent, /wiring the auto-handoff slice/, 'ordinary transcript content still reaches the engine');
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

// ── synth-handoff-fix-01 AC1+AC3: a transient first-call engine failure is RETRIED → baton still written ──
// The detached SessionEnd child's first `claude -p` call after the parent tears down intermittently
// returns no output (`ok:false`). A single flaky call must no longer cost the whole handoff: the engine
// spawn is retried (bounded), so a fail-then-succeed run writes the baton as normal. Driven through the
// existing injectable `invoke` seam with a no-op injected sleep — no real `claude -p`, no wall sleep.

test('runHandoff retries a transient engine failure (ok:false) then writes the baton on the retry', async () => {
  const root = tmp('wrxn-handoff-retry1-');
  stageSession(root, REAL_SESSION);
  // claude fails once (the transient first-call-after-parent-exit), then succeeds.
  const { invoke, calls } = flakyClaude(1, '**TL;DR** resumed after one transient miss\n**Next step** ship it');

  const res = await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(res.wrote, true, 'the retry recovered the handoff and the baton was written');
  assert.match(fs.readFileSync(batonPath(root), 'utf8'), /resumed after one transient miss/, 'the recovered handoff is the baton');
  assert.equal(calls.length, 2, 'the engine was retried once (2 attempts: the transient miss + the success)');
});

test('runHandoff recovers from TWO transient failures (3rd attempt succeeds) and writes the baton', async () => {
  const root = tmp('wrxn-handoff-retry2-');
  stageSession(root, REAL_SESSION);
  const { invoke, calls } = flakyClaude(2, '**TL;DR** recovered on the third attempt');

  const res = await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(res.wrote, true, 'two transient misses are within the retry budget → baton written');
  assert.match(fs.readFileSync(batonPath(root), 'utf8'), /recovered on the third attempt/);
  assert.equal(calls.length, 3, 'three total attempts (2 retries) were spent');
});

// ── synth-handoff-fix-01 AC3+AC4: retries are BOUNDED and the fail-safe is intact ──
// When every attempt fails (a real engine outage, not a transient blip), the retry must give up after a
// bounded number of attempts, write NO baton, leave any prior baton untouched, and STILL clear the
// markers (the existing fail-safe). The retry only adds bounded attempts before that fail-safe.

test('runHandoff gives up after 3 bounded attempts on a persistent failure, preserves the prior baton, clears markers', async () => {
  const root = tmp('wrxn-handoff-allfail-');
  stageSession(root, REAL_SESSION);
  // a prior good baton exists — it must survive a failed synth untouched (never replaced with nothing).
  const prior = '**TL;DR** the PREVIOUS session baton that must be preserved\n';
  fs.writeFileSync(batonPath(root), prior);
  // claude never succeeds and there is no gemini key → only claude is attempted, and it is bounded.
  const { invoke, calls } = flakyClaude(99, 'NEVER REACHED');

  const res = await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(res.wrote, false, 'a persistent failure writes no baton (fail-safe)');
  assert.equal(res.reason, 'no-engine', 'the give-up reason is no-engine');
  assert.equal(calls.length, 3, 'attempts are BOUNDED to 3 total (no infinite retry)');
  assert.equal(fs.readFileSync(batonPath(root), 'utf8'), prior, 'the prior baton is preserved byte-for-byte');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is still cleared so session-start never hangs');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is still cleared');
});

// ── synth-handoff-fix-01 AC2: the gemini-no-key early-out is UNCHANGED — no retry, no request ──
// The retry only fires for a transient `ok:false`. A `gemini` engine with no API key must still fail
// immediately to its own path (no key → no request) — it never reaches the invoker, retried or not.

test('runHandoff: a gemini fallback with no API key is never invoked and is not retried (no key → no request)', async () => {
  const root = tmp('wrxn-handoff-nokey-');
  stageSession(root, REAL_SESSION);
  // claude persistently fails; the gemini fallback has no key (no .env). Capture every engine reached.
  const { invoke, calls } = flakyClaude(99, 'NEVER');

  const res = await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(res.wrote, false);
  assert.ok(calls.length >= 1 && calls.every((c) => c.engine === 'claude'), 'gemini is NEVER invoked without a key — only claude attempts were made');
});

// ── synth-handoff-fix-01 AC5: every synth run appends ONE outcome line to .wrxn/continuity/.synth.log ──
// A missed baton must never be silent again. Each run records task, engine, attempts, and outcome
// (wrote / trivial / no-engine / error). The log is install state under .wrxn/continuity/ (gitignored,
// never shipped). The write is best-effort/fail-open — a logging fault never affects the handoff.

function readSynthLogLines(root) {
  return fs.readFileSync(synthLogPath(root), 'utf8').trim().split('\n').filter(Boolean);
}

test('runHandoff appends one synth-log line on a successful write (task, engine, attempts, outcome=wrote)', async () => {
  const root = tmp('wrxn-handoff-log-ok-');
  stageSession(root, REAL_SESSION);
  const { invoke } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** logged' } });

  await synth.runHandoff({ root, invoke, sleep: noSleep });

  const lines = readSynthLogLines(root);
  assert.equal(lines.length, 1, 'exactly one outcome line per synth run');
  const line = lines[0];
  assert.match(line, /handoff/, 'the task is recorded');
  assert.match(line, /claude/, 'the producing engine is recorded');
  assert.match(line, /attempts=1/, 'the attempt count is recorded');
  assert.match(line, /wrote/, 'the outcome is recorded');
  assert.match(line, /sid-x/, 'the session id from the stash is recorded');
});

test('the synth-log line records the real attempt count when a transient failure was retried', async () => {
  const root = tmp('wrxn-handoff-log-retry-');
  stageSession(root, REAL_SESSION);
  const { invoke } = flakyClaude(1, '**TL;DR** logged after a retry'); // one transient miss, then success on attempt 2.

  await synth.runHandoff({ root, invoke, sleep: noSleep });

  const lines = readSynthLogLines(root);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /attempts=2/, 'the log shows 2 attempts (the retry is visible)');
  assert.match(lines[0], /wrote/);
});

test('runHandoff logs outcome=no-engine when every attempt fails (the miss is never silent)', async () => {
  const root = tmp('wrxn-handoff-log-fail-');
  stageSession(root, REAL_SESSION);
  const { invoke } = fakeInvoke({ claude: { ok: false }, gemini: { ok: false } });

  await synth.runHandoff({ root, invoke, sleep: noSleep });

  const lines = readSynthLogLines(root);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no-engine/, 'a failed synth is recorded as no-engine, so the operator can see the miss');
});

test('runHandoff logs outcome=trivial for a trivial session (engine recorded as "-", no model call)', async () => {
  const root = tmp('wrxn-handoff-log-trivial-');
  stageSession(root, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: 'NEVER' } });

  await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(calls.length, 0, 'a trivial session spends no model call');
  const lines = readSynthLogLines(root);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /trivial/, 'the trivial skip is logged');
  assert.match(lines[0], /attempts=0/, 'no attempts were spent on a trivial session');
});

// ── synth-handoff-fix-01 (security LOW): a session id with control chars cannot forge a log line ──
// session_id comes from the untrusted `.pending` stash (transcript-adjacent). A value carrying a
// newline/tab would inject extra rows into the tab-separated .synth.log, forging fake outcomes and
// destroying the log's diagnosability. The id must be sanitized (strip control chars) before it goes
// into the line, so one synth run ALWAYS produces exactly one well-formed line.
test('runHandoff sanitizes a session id with a newline: exactly one log line, no forged second row', async () => {
  const root = tmp('wrxn-handoff-log-forge-');
  continuityDir(root); // ensure .wrxn/continuity exists for the marker writes below.
  const tx = path.join(root, 'session.jsonl');
  fs.writeFileSync(tx, REAL_SESSION);
  // a malicious/garbled session id that tries to forge a second tab-separated outcome line.
  const forged = 'abc\nFORGED\toutcome=wrote';
  fs.writeFileSync(pendingPath(root), JSON.stringify({ session_id: forged, transcript_path: tx, cwd: root }));
  fs.writeFileSync(handoffMarker(root), String(Date.now()));
  const { invoke } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** logged with a hostile id' } });

  await synth.runHandoff({ root, invoke, sleep: noSleep });

  const raw = fs.readFileSync(synthLogPath(root), 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one log line — the newline in the id did not forge a second row');
  assert.doesNotMatch(raw, /\nFORGED/, 'the forged second line never appears in the log');
  assert.match(lines[0], /abc/, 'the sanitized id keeps its printable head');
  assert.doesNotMatch(lines[0], /[\t\r\n]FORGED/, 'no control char survives inside the id field');
  assert.match(lines[0], /wrote/, 'the real outcome is still recorded on the single line');
});

test('the synth log is best-effort: a logging fault never blocks the baton write or the marker clear', async () => {
  const root = tmp('wrxn-handoff-log-failopen-');
  stageSession(root, REAL_SESSION);
  // make the log path UNWRITABLE: pre-create .synth.log as a directory so appendFileSync throws.
  fs.mkdirSync(synthLogPath(root));
  const { invoke } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** baton survives a broken log' } });

  const res = await synth.runHandoff({ root, invoke, sleep: noSleep });

  assert.equal(res.wrote, true, 'the baton is still written even though the log write faulted');
  assert.match(fs.readFileSync(batonPath(root), 'utf8'), /baton survives a broken log/);
  assert.ok(!fs.existsSync(handoffMarker(root)), 'markers are still cleared despite the logging fault');
});

// ── synth-handoff-fix-01 AC6: the handoff prompt forbids any preamble leaking into the durable baton ──
// A flaky run could leak a "Let me synthesize…" preamble or a thinking block into latest.md. The handoff
// prompt must explicitly instruct the model to emit ONLY the handoff document — paralleling the dream
// prompt's "STRICT JSON … no commentary" directive. Pin the directive so it cannot regress.

test('HANDOFF_PROMPT contains an explicit output-only directive (no preamble / no commentary / no thinking)', () => {
  const p = synth.HANDOFF_PROMPT;
  assert.match(p, /output only/i, 'the prompt says to output ONLY the handoff document');
  assert.match(p, /\bpreamble\b/i, 'the prompt forbids a preamble');
  assert.match(p, /\bcommentary\b/i, 'the prompt forbids commentary');
  assert.match(p, /\bthinking\b/i, 'the prompt forbids a thinking block');
});

// ── synth-handoff-fix-01 (correction pass, QA F-01): a model preamble is STRIPPED before the baton ──
// The output-only prompt directive is non-deterministic: a live run still sometimes opens with a
// conversational preamble (e.g. "Per the session baton, the operator chose…") BEFORE the required
// **TL;DR**. The durable baton (PRD story 5) must contain ONLY the handoff document, so the synth applies
// a deterministic strip — anchored on the canonical `**TL;DR` marker — after synthesize and before the
// baton is written. A handoff with no marker passes through UNCHANGED (fail-open safety net).

test('runHandoff strips a conversational preamble so the baton starts at **TL;DR**', async () => {
  const root = tmp('wrxn-handoff-preamble-');
  stageSession(root, REAL_SESSION);
  // the model leaks a preamble sentence before the required TL;DR (the live F-01 shape).
  const withPreamble = 'Per the session baton, the operator chose to ship it.\n\n**TL;DR** — resumed at the slice\n\n**Goal** — wire it up';
  const { invoke } = fakeInvoke({ claude: { ok: true, text: withPreamble } });

  await synth.runHandoff({ root, invoke });

  const baton = fs.readFileSync(batonPath(root), 'utf8');
  assert.ok(baton.startsWith('**TL;DR'), 'the baton starts at the **TL;DR** marker (preamble dropped)');
  assert.doesNotMatch(baton, /Per the session baton, the operator chose/, 'the conversational preamble never reaches the durable baton');
  assert.match(baton, /resumed at the slice/, 'the real handoff body is preserved');
  assert.match(baton, /wire it up/, 'the rest of the handoff is intact');
});

test('runHandoff leaves a handoff with NO **TL;DR** marker unchanged (fail-open — never mangle)', async () => {
  const root = tmp('wrxn-handoff-nomarker-');
  stageSession(root, REAL_SESSION);
  // a (degenerate) handoff that does not contain the marker — the strip must NOT eat it.
  const noMarker = '**Goal** — wire the SessionStart hold\n**Next step** — ship the fix';
  const { invoke } = fakeInvoke({ claude: { ok: true, text: noMarker } });

  await synth.runHandoff({ root, invoke });

  const baton = fs.readFileSync(batonPath(root), 'utf8');
  assert.match(baton, /wire the SessionStart hold/, 'the body is preserved when there is no marker to anchor on');
  assert.match(baton, /ship the fix/, 'nothing is dropped from a no-marker handoff (fail-open)');
});
