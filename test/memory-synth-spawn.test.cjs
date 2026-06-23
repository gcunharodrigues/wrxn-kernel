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
