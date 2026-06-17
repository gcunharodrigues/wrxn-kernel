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
