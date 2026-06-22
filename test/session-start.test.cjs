'use strict';

// Black-box tests for the session-start orientation hook (wrxn-kernel-10; trimmed in harvest-01).
// session-start is the SOLE surviving session hook: the session-end episodic writer and the
// session-history turn-trail recorder were retired with the session-capture subsystem (harvest-01).
// The hook injects identity + a resume pointer as additionalContext so every new session opens
// oriented. CONTINUITY DOCTRINE: the deliberate handoff baton (.wrxn/continuity/latest.md) — single
// writer = the handoff skill — is the ONLY resume source; the automatic dated-session-page fallback
// is gone. Each hook run is exercised as the real harness would: a crafted event JSON on stdin, a
// temp install on disk, assertions on the emitted envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HOOKS = path.join(PKG_ROOT, 'payload', '.claude', 'hooks');
const START = path.join(HOOKS, 'session-start.cjs');
const sessionStart = require('../payload/.claude/hooks/session-start.cjs');

const NOW = '2026-06-13T10:00:00.000Z';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Run a hook rooted at the install (CLAUDE_PROJECT_DIR drives the walk-up to the receipt).
function runHook(hookPath, event, target, env) {
  const out = execFileSync('node', [hookPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target, WRXN_NOW: NOW, ...env },
  });
  return out.trim() ? JSON.parse(out) : {};
}

function sessionsDir(target) {
  return path.join(target, '.wrxn', 'wiki', 'sessions');
}
function batonPath(target) {
  return path.join(target, '.wrxn', 'continuity', 'latest.md');
}

// ── the orientation surface (identity + resume) ───────────────────────────────

test('session-start injects an orientation surface with the install identity', () => {
  const target = freshInstall('wrxn-sess-start-');
  const env = runHook(START, { session_id: 'sid-aaa', source: 'startup' }, target);
  const ctx = env.hookSpecificOutput && env.hookSpecificOutput.additionalContext;
  assert.equal(env.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx, 'additionalContext present');
  assert.match(ctx, /wrxn-sess-start-/i, 'identity names the install');
  assert.match(ctx, /project/, 'identity carries the profile');
});

test('session-start on a fresh install reports no prior handoff, no crash', () => {
  const target = freshInstall('wrxn-sess-fresh-');
  const env = runHook(START, { session_id: 'sid-fresh', source: 'startup' }, target);
  assert.match(env.hookSpecificOutput.additionalContext, /no prior|fresh|first session/i);
});

test('session-start fails open ({}) when no install root is resolvable', () => {
  const orphan = tmp('wrxn-sess-orphan-');
  const out = execFileSync('node', [START], {
    input: JSON.stringify({ session_id: 'x' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: orphan, WRXN_NOW: NOW },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {});
});

// ── continuity: the deliberate handoff baton is the sole resume source ─────────

test('session-start surfaces the deliberate handoff baton (the sole resume source)', () => {
  const target = freshInstall('wrxn-sess-baton-');
  // Even with a leftover episodic page on disk, the baton is the only thing surfaced.
  fs.mkdirSync(sessionsDir(target), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(target), '2026-06-10-sid-old.md'), '# leftover episodic page\n');
  // a deliberate handoff baton, written by the handoff skill (its single writer)
  fs.mkdirSync(path.dirname(batonPath(target)), { recursive: true });
  fs.writeFileSync(batonPath(target), '# Handoff\nNEXT: ship issue 11\n');

  const env = runHook(START, { session_id: 'sid-new', source: 'resume' }, target);
  const ctx = env.hookSpecificOutput.additionalContext;
  assert.match(ctx, /ship issue 11/, 'baton content injected');
  assert.match(ctx, /handoff|baton/i, 'baton is labeled as the deliberate continuity slot');
  assert.doesNotMatch(ctx, /2026-06-10-sid-old/, 'the retired session page is never surfaced');
});

// ── S2 / #13 AC1: session-start stamps an exact start-HEAD baseline per session ──
// The reward signal needs "commits made THIS session" to be exact, so session-start records the
// session's start commit (git HEAD) into a tiny per-session marker. The session-end reward shell reads
// it back to derive the git-grounded outcome. Fail-open: a missing git binary / non-repo never blocks
// orientation. The git resolver is injected so the marker-writing core is unit-tested deterministically.

const baselineDir = (target) => path.join(target, '.wrxn', 'baseline');
const baselineFile = (target, sid) => path.join(baselineDir(target), sid);

test('stampStartHead records the resolved HEAD sha into a per-session baseline marker (injected resolver)', () => {
  const target = freshInstall('wrxn-baseline-unit-');
  const stamped = sessionStart.stampStartHead(target, 'sid-base-1', { resolveHead: () => 'deadbeef1234' });
  assert.equal(stamped, true, 'a resolved HEAD is stamped');
  const marker = baselineFile(target, 'sid-base-1');
  assert.ok(fs.existsSync(marker), 'the per-session baseline marker exists');
  const rec = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(rec.head, 'deadbeef1234', 'the marker carries the exact start HEAD sha');
});

test('stampStartHead is fail-open: an unresolvable HEAD writes no marker and never throws', () => {
  const target = freshInstall('wrxn-baseline-failopen-');
  let stamped;
  assert.doesNotThrow(() => {
    stamped = sessionStart.stampStartHead(target, 'sid-base-2', { resolveHead: () => { throw new Error('not a git repo'); } });
  });
  assert.equal(stamped, false, 'no HEAD → no stamp');
  assert.equal(fs.existsSync(baselineFile(target, 'sid-base-2')), false, 'no marker is written when HEAD is unresolvable');
});

test('stampStartHead is keyed per session: distinct sessions get distinct markers', () => {
  const target = freshInstall('wrxn-baseline-perssession-');
  // already-canonical ids (the marker path is now sanitized via safeId — sec-F1)
  sessionStart.stampStartHead(target, 'sid-a', { resolveHead: () => 'aaa111' });
  sessionStart.stampStartHead(target, 'sid-b', { resolveHead: () => 'bbb222' });
  assert.equal(JSON.parse(fs.readFileSync(baselineFile(target, 'sid-a'), 'utf8')).head, 'aaa111');
  assert.equal(JSON.parse(fs.readFileSync(baselineFile(target, 'sid-b'), 'utf8')).head, 'bbb222');
});

test('stampStartHead sanitizes the session id as a path component — a traversal id cannot escape .wrxn/baseline (sec-F1)', () => {
  const target = freshInstall('wrxn-baseline-secf1-');
  // a path-traversal-shaped session id must be canonicalized, never concatenated raw into the marker path.
  const stamped = sessionStart.stampStartHead(target, '../../evil', { resolveHead: () => 'cafe1234' });
  assert.equal(stamped, true, 'a resolved HEAD still stamps — the id is canonicalized, not rejected');
  assert.equal(fs.existsSync(path.join(target, 'evil')), false, 'no marker escapes .wrxn/baseline to the install root');
  assert.deepEqual(fs.readdirSync(baselineDir(target)), ['evil'], 'exactly one sanitized marker, written INSIDE .wrxn/baseline');
});

test('session-start stamps the REAL git HEAD when run over a git repo (integration)', () => {
  const target = freshInstall('wrxn-baseline-integ-');
  execFileSync('git', ['init', '-q'], { cwd: target });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: target });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();

  runHook(START, { session_id: 'sid-real', source: 'startup' }, target);
  const marker = baselineFile(target, 'sid-real');
  assert.ok(fs.existsSync(marker), 'session-start wrote the baseline marker over a real repo');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).head, head, 'the marker holds the actual git HEAD');
});

// ── harvest-01 AC3: the dead "latest dated session page" fallback is trimmed ────

test('session-start does NOT surface a leftover session page when there is no baton (fallback trimmed)', () => {
  const target = freshInstall('wrxn-sess-nofallback-');
  // A leftover dated session page exists (a pre-retirement install) but NO baton was written.
  const sessions = sessionsDir(target);
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, '2026-06-10-sid-old.md'), '# leftover episodic page\n');

  const env = runHook(START, { session_id: 'sid-now', source: 'startup' }, target);
  const ctx = env.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /2026-06-10-sid-old/, 'the dead session-page fallback no longer surfaces the leftover page');
  assert.doesNotMatch(ctx, /\.wrxn\/wiki\/sessions/, 'orientation does not reference the retired sessions tier');
  assert.match(ctx, /no prior|fresh|first session/i, 'with no baton it reports no prior handoff');
});
