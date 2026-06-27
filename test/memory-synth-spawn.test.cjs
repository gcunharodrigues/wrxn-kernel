'use strict';

// Black-box tests for the SessionEnd spawn hook (auto-memory-03) — payload/.claude/hooks/memory-synth-spawn.cjs.
// The hook's whole job is to return {} IMMEDIATELY and launch the background synth DETACHED, never
// blocking session close. The synth's real work (transcript → baton) is the other seam (memory-synth.cjs)
// and is tested there. Here the spawn itself is the seam: an INJECTABLE spawner (mirrors how
// memory-synth.cjs injects its invoker, lib/protect.cjs its gh/git invoker) records what would be
// spawned so we assert detachment + the recursion guard with NO real child process.
//
// The recursion guard (PRD story 17): spawning `claude -p` from a SessionEnd hook would, inside that
// synth session, fire SessionEnd again → fork-bomb. WRXN_MEMORY_SYNTH=1 in the synth's env makes this
// hook no-op. We test both arms (set → spawns nothing; unset → spawns + writes the pending markers).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HOOK = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'memory-synth-spawn.cjs');
const spawnHook = require(HOOK);

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

function continuityDir(root) {
  return path.join(root, '.wrxn', 'continuity');
}

// A fake detached spawner: records every spawn call (cmd, args, opts) and returns a stub child with an
// unref() spy, so we can prove the hook detached and never waited.
function fakeSpawner() {
  const calls = [];
  let unrefs = 0;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref: () => { unrefs += 1; } };
  };
  return { spawn, calls, unrefCount: () => unrefs };
}

// Drive the hook's testable core directly (the seam), feeding a fake spawner + payload + env.
function runCore(root, payload, env, spawner) {
  return spawnHook.run({
    payload,
    root,
    env,
    spawn: spawner.spawn,
  });
}

// ── AC2: returns {} immediately and spawns the synth DETACHED ──────────────────

test('spawn hook returns {} and launches the synth detached (never blocks session close)', () => {
  const root = freshInstall('wrxn-synth-spawn-');
  const sp = fakeSpawner();
  const out = runCore(
    root,
    { session_id: 'sid-1', transcript_path: '/tmp/whatever.jsonl', cwd: root },
    {},
    sp,
  );
  assert.deepEqual(out, {}, 'the hook returns an empty envelope (no additionalContext, no block)');
  assert.equal(sp.calls.length, 1, 'exactly one synth process is spawned');
  const c = sp.calls[0];
  assert.equal(c.cmd, 'node', 'the synth is a node process');
  assert.match(c.args.join(' '), /memory-synth\.cjs/, 'it launches the synth script');
  assert.equal(c.opts.detached, true, 'the child is detached');
  assert.equal(c.opts.stdio, 'ignore', "stdio is ignored so the parent doesn't wait on pipes");
  assert.equal(sp.unrefCount(), 1, 'the child is unref()d so the event loop does not hold the parent');
});

// ── AC3: the recursion guard ───────────────────────────────────────────────────

test('recursion guard: with WRXN_MEMORY_SYNTH set the hook spawns NOTHING (no fork-bomb)', () => {
  const root = freshInstall('wrxn-synth-spawn-guard-');
  const sp = fakeSpawner();
  const out = runCore(
    root,
    { session_id: 'sid-2', transcript_path: '/tmp/x.jsonl', cwd: root },
    { WRXN_MEMORY_SYNTH: '1' },
    sp,
  );
  assert.deepEqual(out, {}, 'still returns {} (the SessionEnd of the synth-spawned session is a no-op)');
  assert.equal(sp.calls.length, 0, 'nothing is spawned when the recursion sentinel is set');
  // and it must not write the pending markers either — that work belongs to the real session only.
  assert.ok(!fs.existsSync(path.join(continuityDir(root), '.pending')), 'no pending marker under the guard');
});

// ── AC1/AC5 (spawn side): the pending markers are written before the detached synth runs ──
// The synth clears them on exit; here we prove the SPAWN side stages them (so SessionStart can detect
// an in-flight synth even before the child has done anything).

test('spawn hook stashes the payload and writes both pending markers before launching', () => {
  const root = freshInstall('wrxn-synth-spawn-markers-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-3', transcript_path: '/tmp/t.jsonl', cwd: root };
  runCore(root, payload, {}, sp);

  const dir = continuityDir(root);
  assert.ok(fs.existsSync(path.join(dir, '.pending')), 'the .pending marker is written (synth in flight)');
  assert.ok(fs.existsSync(path.join(dir, '.pending-handoff')), 'the .pending-handoff marker gates session-start');

  // the stashed payload is what the detached synth reads — assert it round-trips the transcript path.
  const stashRaw = fs.readFileSync(path.join(dir, '.pending'), 'utf8');
  const stashed = JSON.parse(stashRaw);
  assert.equal(stashed.transcript_path, '/tmp/t.jsonl', 'the stash carries the transcript path for the synth');
  assert.equal(stashed.session_id, 'sid-3', 'the stash carries the session id');
});

// ── fail-open: the hook NEVER blocks session close, even on a fault ─────────────

test('spawn hook fails open ({}) — a spawner that throws never breaks session close', () => {
  const root = freshInstall('wrxn-synth-spawn-failopen-');
  const out = spawnHook.run({
    payload: { session_id: 'x', transcript_path: '/tmp/x.jsonl', cwd: root },
    root,
    env: {},
    spawn: () => { throw new Error('spawn exploded'); },
  });
  assert.deepEqual(out, {}, 'a spawn failure degrades to {} (session close is never blocked)');
});

// ── end-to-end through the real process boundary (stdin → stdout {}) ────────────
// Exercise the hook exactly as the Claude Code harness would: SessionEnd JSON on stdin, {} on stdout,
// exit 0. We point WRXN_MEMORY_SYNTH at the env to neutralize the real spawn (guard arm) so the test
// never launches an actual detached node — proving the wire contract without a real child.

test('the hook process emits {} on stdout for a SessionEnd event (wire contract)', () => {
  const root = freshInstall('wrxn-synth-spawn-wire-');
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 'sid-wire', transcript_path: '/tmp/x.jsonl', cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, WRXN_MEMORY_SYNTH: '1' },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {}, 'stdout is {} and exit is 0');
});

// ── #45 once-per-session guard: the SessionEnd hook is idempotent per session ────
// The harness fires SessionEnd more than once per session (clear / exit / logout end-paths). Without a
// guard the hook spawns a fresh detached synth on EACH fire, and N synths race on one shared `.pending`
// stash + pollute .synth.log (the incident: session 6898c0a9 logged `wrote`, then a spurious `no-engine`
// 2.16s later). The hook now CLAIMS the session ATOMICALLY (an exclusive-create marker keyed by a
// sanitized session_id) before it stages markers + spawns, so exactly ONE synth launches per session.

test('two SessionEnd fires for the SAME session_id spawn the synth exactly once (#45 once-per-session)', () => {
  const root = freshInstall('wrxn-synth-spawn-once-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-dup', transcript_path: '/tmp/t.jsonl', cwd: root };

  const out1 = runCore(root, payload, {}, sp);
  // sentinels: a 2nd fire that re-ran the body would OVERWRITE these markers — they must survive untouched,
  // proving the 2nd fire no-oped BEFORE the marker writes (wrote no `.pending`/`.pending-handoff`).
  const dir = continuityDir(root);
  fs.writeFileSync(path.join(dir, '.pending'), 'SENTINEL-pending');
  fs.writeFileSync(path.join(dir, '.pending-handoff'), 'SENTINEL-handoff');
  const out2 = runCore(root, payload, {}, sp);

  assert.deepEqual(out1, {}, 'the first fire returns {}');
  assert.deepEqual(out2, {}, 'the second fire also returns {} (never blocks session close)');
  assert.equal(sp.calls.length, 1, 'the synth is spawned EXACTLY once across two fires for one session');
  assert.equal(sp.unrefCount(), 1, 'only the first fire launched (and unref()d) a synth');
  assert.equal(fs.readFileSync(path.join(dir, '.pending'), 'utf8'), 'SENTINEL-pending', 'the 2nd fire wrote NO .pending (no re-stash racing the synth)');
  assert.equal(fs.readFileSync(path.join(dir, '.pending-handoff'), 'utf8'), 'SENTINEL-handoff', 'the 2nd fire wrote NO .pending-handoff');
});

test('two fires with DIFFERENT session_ids each spawn once (#45 the claim is per-session, not global)', () => {
  const root = freshInstall('wrxn-synth-spawn-persession-');
  const sp = fakeSpawner();
  runCore(root, { session_id: 'sid-A', transcript_path: '/tmp/a.jsonl', cwd: root }, {}, sp);
  runCore(root, { session_id: 'sid-B', transcript_path: '/tmp/b.jsonl', cwd: root }, {}, sp);
  assert.equal(sp.calls.length, 2, 'a different session is a distinct claim → it launches its own synth');
  assert.equal(sp.unrefCount(), 2, 'both fires launched (and unref()d) a synth');
});

test('the no-session-id path is preserved: every fire still spawns (cannot dedup without an id) (#45)', () => {
  const root = freshInstall('wrxn-synth-spawn-nosid-');
  const sp = fakeSpawner();
  // a payload with no session_id (the harness occasionally omits it) — today's spawn-every-time behavior
  // MUST be preserved (and the missing id must not crash the guard).
  runCore(root, { transcript_path: '/tmp/x.jsonl', cwd: root }, {}, sp);
  runCore(root, { transcript_path: '/tmp/x.jsonl', cwd: root }, {}, sp);
  assert.equal(sp.calls.length, 2, 'with no id to claim, both fires spawn (no-session-id path unchanged)');
});

// ── #45 / sec: the per-session marker derives from a SANITIZED session_id (no traversal) ────────
// session_id is attacker-influenceable (it reaches this hook from the harness payload). Concatenated raw
// into the marker path, a `../../evil` id would escape .wrxn/continuity and let an exclusive-create land an
// arbitrary file at the install root. safeId canonicalizes it, so the marker stays INSIDE the markers dir.
// Mirrors the session-start safeId traversal test (sec-F1).

test('the once-per-session marker is sanitized — a traversal session_id cannot escape the markers dir (#45)', () => {
  const root = freshInstall('wrxn-synth-spawn-traversal-');
  const sp = fakeSpawner();
  runCore(root, { session_id: '../../evil', transcript_path: '/tmp/x.jsonl', cwd: root }, {}, sp);

  const dir = continuityDir(root);
  assert.equal(fs.existsSync(path.join(root, 'evil')), false, 'no marker escapes the continuity dir to the install root');
  assert.equal(fs.existsSync(path.join(dir, '.spawned-evil')), true, 'the sanitized per-session marker lives INSIDE .wrxn/continuity');
  assert.equal(sp.calls.length, 1, 'the (sanitized) first fire still spawns its synth');
});

// ── #104 LOG-SKIP: a marker-present dedup skip appends one benign `skip` row to .synth.log ─────────
// The #45 `wx` claim blocks a re-spawn silently — so a resume's re-armed end that DID re-spawn is
// indistinguishable in the log from a benign double-fire that was deduped. To make the dedup diagnosable,
// a marker-present skip now appends exactly ONE row matching the synth log's canonical tab-separated
// six-field shape (timestamp, session id, task `handoff`, engine `-`, `attempts=0`, outcome `skip`) BEFORE
// returning {}. The session id is sanitized (control/tab/newline stripped, length-capped) so it cannot forge
// extra rows. Outcome `skip` is a NON-failure token, so the #51 baton-staleness guard never false-warns on
// a benign dedup. Best-effort / fail-open: a logging fault never affects the dedup.

const { releaseSpawnClaim, batonStaleness, parseSynthLog } = require('../payload/.claude/hooks/session-start.cjs');
const synthLog = (root) => path.join(continuityDir(root), '.synth.log');

test('a marker-present dedup skip appends exactly one canonical `skip` row to .synth.log (#104)', () => {
  const root = freshInstall('wrxn-synth-spawn-skiplog-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-skip', transcript_path: '/tmp/t.jsonl', cwd: root };
  runCore(root, payload, {}, sp); // 1st fire: claims + spawns (the real synth is faked → it writes NO log)
  runCore(root, payload, {}, sp); // 2nd fire (same id, same instance): claim EEXIST → skip → logs one row

  assert.equal(sp.calls.length, 1, 'the dedup skip spawns nothing (the #45 wx claim still blocks the 2nd fire)');
  const lines = fs.readFileSync(synthLog(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'exactly one skip row is appended (one row per blocked fire)');
  const f = lines[0].split('\t');
  assert.equal(f.length, 6, 'the row is the canonical tab-separated six-field shape');
  assert.ok(Number.isFinite(Date.parse(f[0])), 'field 0 is an ISO timestamp');
  assert.equal(f[1], 'sid-skip', 'field 1 is the (sanitized) session id');
  assert.equal(f[2], 'handoff', 'field 2 task = handoff');
  assert.equal(f[3], '-', 'field 3 engine = - (no engine ran for a skip)');
  assert.equal(f[4], 'attempts=0', 'field 4 attempts=0 (nothing was attempted)');
  assert.equal(f[5], 'skip', 'field 5 outcome = skip');
});

test('a tab/newline in the session id cannot forge extra skip rows or columns (#104 sec)', () => {
  const root = freshInstall('wrxn-synth-spawn-skipsanitize-');
  const sp = fakeSpawner();
  // a hostile id that, UNSANITIZED, would inject a second row (\n) and extra columns (\t) into the log.
  const payload = { session_id: 'inj\t9\t9\t9\t9\tFORGED\nROW-TWO\t-\tx\ty\tz', transcript_path: '/tmp/t.jsonl', cwd: root };
  runCore(root, payload, {}, sp); // 1st fire: claims (safeId path) + spawns
  runCore(root, payload, {}, sp); // 2nd fire: claim EEXIST → skip → one SANITIZED row

  const lines = fs.readFileSync(synthLog(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'the newline in the id did NOT forge a second log row');
  const f = lines[0].split('\t');
  assert.equal(f.length, 6, 'the tabs in the id did NOT forge extra columns');
  assert.equal(f[5], 'skip', 'the trailing outcome is still skip (not displaced by injected fields)');
  assert.doesNotMatch(f[1], /[\t\n]/, 'the session-id field carries no control separators');
});

test('a `skip` row is benign to the #51 baton-staleness guard — no false freeze warning (#104 pin)', () => {
  const root = freshInstall('wrxn-synth-spawn-skipbenign-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-benign', transcript_path: '/tmp/t.jsonl', cwd: root };
  runCore(root, payload, {}, sp); // claims + spawns
  runCore(root, payload, {}, sp); // skip → writes the real skip row

  // through the REAL #51 decision path: the actual written row parses to a non-failure → no warning.
  const rows = parseSynthLog(fs.readFileSync(synthLog(root), 'utf8'));
  assert.equal(rows.length, 1, 'the skip row parses as a complete six-field row');
  assert.equal(rows[0].outcome, 'skip', 'its outcome is the skip token');
  assert.equal(batonStaleness({ batonMtimeMs: Date.now(), rows }), null, 'a lone skip row never warns (skip is not failure rot)');
  // and as the NEWEST row right after a healthy write, a skip still must not warn (skip is a non-failure token).
  const T = 1_700_000_000_000;
  assert.equal(
    batonStaleness({ batonMtimeMs: T, rows: [
      { timestampMs: T + 50, sessionId: 'A', outcome: 'wrote' },
      { timestampMs: T + 5000, sessionId: 'B', outcome: 'skip' },
    ] }),
    null,
    'a skip newest-after-wrote → still no warn',
  );
});

// ── #104 CORE (integration): release re-arms the SessionEnd synth across a resume ─────────────────
// The whole #104 flow through the REAL seams: the persistent claim blocks a within-instance re-spawn (#45),
// but a SessionStart release (releaseSpawnClaim) frees the claim so the resumed session's next end synths
// again — exactly what was frozen before (SessionEnd fires per process, not per session id).

test('releaseSpawnClaim re-arms the synth: after a SessionStart release the next end re-spawns (#104)', () => {
  const root = freshInstall('wrxn-synth-spawn-rearm-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-resume', transcript_path: '/tmp/t.jsonl', cwd: root };

  runCore(root, payload, {}, sp); // 1st end: claims + spawns
  runCore(root, payload, {}, sp); // 2nd end, SAME instance (no SessionStart between): the persistent claim blocks it (#45)
  assert.equal(sp.calls.length, 1, 'the persistent claim blocks a re-spawn until released (#45 intact)');

  assert.equal(releaseSpawnClaim(root, 'sid-resume'), true, 'a resume (SessionStart) releases the persistent claim');

  runCore(root, payload, {}, sp); // the resumed session ends with content → it MUST synth again
  assert.equal(sp.calls.length, 2, 'after the release the next SessionEnd re-spawns (the baton is no longer frozen)');
});

test('a skip-log write fault never affects the dedup (best-effort / fail-open) (#104)', () => {
  const root = freshInstall('wrxn-synth-spawn-skiplogfault-');
  const dir = continuityDir(root);
  fs.mkdirSync(dir, { recursive: true });
  // the session is already claimed → the next fire will skip and try to log...
  fs.writeFileSync(path.join(dir, '.spawned-sid-logfault'), ''); // safeId('sid-logfault') is identity
  // ...but .synth.log is a DIRECTORY, so the append faults (EISDIR). It must be swallowed — the dedup stands.
  fs.mkdirSync(path.join(dir, '.synth.log'), { recursive: true });
  const sp = fakeSpawner();

  let out;
  assert.doesNotThrow(() => {
    out = runCore(root, { session_id: 'sid-logfault', transcript_path: '/tmp/t.jsonl', cwd: root }, {}, sp);
  });
  assert.deepEqual(out, {}, 'the skip still returns {} despite the logging fault');
  assert.equal(sp.calls.length, 0, 'the dedup holds — a log fault never causes a (re)spawn');
});

// ── #105 CONTENT-VERSIONED CLAIM: the marker stamps the transcript byte size, and a marker-present end
// re-arms the synth when the transcript GREW materially since the stamp (a missed-resume self-heal) ──────
// Slice 1 (#104) made the .spawned-<sid> marker a zero-byte existence file released on SessionStart. If
// that release is MISSED (e.g. a multi-terminal continuation whose new process never released the claim),
// the baton stays frozen. Slice 2 makes the dedup CONTENT-AWARE: the marker is stamped with the session
// transcript's byte size (+ a timestamp) at claim time; on a later marker-present end the hook compares the
// CURRENT transcript size to the stamped size — growth past a small threshold (>1 KB) is a genuine
// continuation → re-stamp + spawn; no material growth is a true same-end duplicate → skip (slice 1). Any
// fault (absent/unreadable transcript path, stat fault, unparseable marker) falls back to the existence-only
// claim and is fully fail-open: never throws, never double-fires on a fault.

// A REAL transcript file whose byte size the stamp/growth logic stats. Bytes are filler — only the SIZE matters.
function writeTranscript(root, bytes, name = 'session.jsonl') {
  const p = path.join(root, name);
  fs.writeFileSync(p, 'x'.repeat(bytes));
  return p;
}
function growTranscript(p, extra) {
  fs.appendFileSync(p, 'y'.repeat(extra));
}
function readMarker(root, sid) {
  return JSON.parse(fs.readFileSync(path.join(continuityDir(root), `.spawned-${sid}`), 'utf8'));
}

test('the claim stamps the marker with the transcript byte size + an ISO timestamp (round-trips) (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-stamp-');
  const sp = fakeSpawner();
  const transcript = writeTranscript(root, 4096);
  runCore(root, { session_id: 'sid-stamp', transcript_path: transcript, cwd: root }, {}, sp);

  assert.equal(sp.calls.length, 1, 'a fresh claim still spawns the synth');
  const marker = readMarker(root, 'sid-stamp');
  assert.equal(marker.size, 4096, 'the marker carries the transcript byte size measured at claim time');
  assert.ok(Number.isFinite(Date.parse(marker.at)), 'the marker carries an ISO timestamp (write → read round-trips)');
});

test('marker present + transcript grew past the threshold → re-arm: the synth re-spawns and the marker re-stamps (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-rearm105-');
  const sp = fakeSpawner();
  const transcript = writeTranscript(root, 2000);
  const payload = { session_id: 'sid-grow', transcript_path: transcript, cwd: root };

  runCore(root, payload, {}, sp); // 1st end: claims + stamps size=2000 + spawns
  assert.equal(sp.calls.length, 1, 'the first end claims and spawns');

  growTranscript(transcript, 5000); // the resumed session did real work: +5000 bytes (> 1 KiB threshold)
  runCore(root, payload, {}, sp); // 2nd end, marker present, transcript GREW → genuine continuation → re-arm

  assert.equal(sp.calls.length, 2, 'the marker-present end RE-SPAWNS the synth because the transcript grew materially');
  assert.equal(readMarker(root, 'sid-grow').size, 7000, 'the marker is re-stamped to the new transcript size');
});

test('marker present + no material growth → no re-spawn; one `skip` row is logged (slice 1 preserved) (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-flat105-');
  const sp = fakeSpawner();
  const transcript = writeTranscript(root, 3000);
  const payload = { session_id: 'sid-flat', transcript_path: transcript, cwd: root };

  runCore(root, payload, {}, sp); // 1st end: claims + stamps size=3000 + spawns
  runCore(root, payload, {}, sp); // 2nd end, marker present, transcript UNCHANGED → same-end duplicate → skip

  assert.equal(sp.calls.length, 1, 'a flat transcript is a true same-end duplicate — it does NOT re-spawn');
  const lines = fs.readFileSync(synthLog(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'the same-end duplicate appends exactly one `skip` row (#104 behavior preserved)');
  assert.equal(lines[0].split('\t')[5], 'skip', 'the row outcome is the benign skip token');
});

test('threshold boundary: growth of EXACTLY 1 KiB does NOT re-arm (re-arm requires strictly more) (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-boundary105-');
  const sp = fakeSpawner();
  const transcript = writeTranscript(root, 3000);
  const payload = { session_id: 'sid-edge', transcript_path: transcript, cwd: root };

  runCore(root, payload, {}, sp); // claims size=3000 + spawns
  growTranscript(transcript, 1024); // grow by EXACTLY the threshold → 4024 (1024 is not > 1024)
  runCore(root, payload, {}, sp); // marker present, growth == threshold → still a skip, no re-arm

  assert.equal(sp.calls.length, 1, 'growth equal to the threshold is below the re-arm bar (strict greater-than)');
  assert.equal(readMarker(root, 'sid-edge').size, 3000, 'the marker keeps its original stamp (no re-stamp on a skip)');
});

test('unreadable transcript path → existence-only fallback (slice 1): claim+spawn then skip, never throws (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-badpath105-');
  const sp = fakeSpawner();
  // transcript_path points at a file that does not exist → statSync throws → size unknown at every step.
  const payload = { session_id: 'sid-badpath', transcript_path: path.join(root, 'does-not-exist.jsonl'), cwd: root };

  let out1;
  assert.doesNotThrow(() => { out1 = runCore(root, payload, {}, sp); }); // marker absent → claim (size:null) + spawn
  runCore(root, payload, {}, sp); // marker present, no usable baseline → existence-only skip (slice 1)

  assert.deepEqual(out1, {}, 'the hook still returns {} on the unreadable-path claim');
  assert.equal(sp.calls.length, 1, 'with no measurable size the dedup is existence-only — exactly one spawn');
  assert.equal(readMarker(root, 'sid-badpath').size, null, 'an unreadable transcript stamps a null baseline');
  const lines = fs.readFileSync(synthLog(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'the second fire falls back to a slice-1 skip (one row logged)');
});

test('absent transcript_path key → existence-only fallback, fail-open (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-nopath105-');
  const sp = fakeSpawner();
  const payload = { session_id: 'sid-nopath', cwd: root }; // no transcript_path at all

  assert.doesNotThrow(() => {
    runCore(root, payload, {}, sp); // claim (size:null) + spawn
    runCore(root, payload, {}, sp); // existence-only skip
  });
  assert.equal(sp.calls.length, 1, 'a missing transcript_path degrades to the existence-only claim (one spawn)');
});

test('a transcript that VANISHES between fires never double-fires the synth (fail-open) (#105)', () => {
  const root = freshInstall('wrxn-synth-spawn-vanish105-');
  const sp = fakeSpawner();
  const transcript = writeTranscript(root, 5000);
  const payload = { session_id: 'sid-vanish', transcript_path: transcript, cwd: root };

  runCore(root, payload, {}, sp); // claims size=5000 + spawns
  fs.rmSync(transcript); // the transcript disappears → the next fire cannot measure CURRENT size (stat fault)

  let out2;
  assert.doesNotThrow(() => { out2 = runCore(root, payload, {}, sp); });
  assert.deepEqual(out2, {}, 'the stat fault degrades to {} (session close is never blocked)');
  assert.equal(sp.calls.length, 1, 'an unmeasurable current size defaults to skip — the synth never double-fires');
  const lines = fs.readFileSync(synthLog(root), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1, 'the indeterminate fire logs a benign skip, not a re-arm');
});

test('a corrupt (unparseable) marker baseline → fallback skip, never re-arms on garbage (#105 fail-open)', () => {
  const root = freshInstall('wrxn-synth-spawn-corrupt105-');
  const dir = continuityDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.spawned-sid-corrupt'), 'not-json{{{'); // safeId is identity; garbage stamp
  const transcript = writeTranscript(root, 9000); // a large CURRENT size that would re-arm IF the baseline parsed
  const sp = fakeSpawner();

  let out;
  assert.doesNotThrow(() => {
    out = runCore(root, { session_id: 'sid-corrupt', transcript_path: transcript, cwd: root }, {}, sp);
  });
  assert.deepEqual(out, {}, 'a corrupt baseline degrades to {}');
  assert.equal(sp.calls.length, 0, 'no usable baseline → existence-only skip (a corrupt marker never triggers a re-arm)');
});
