'use strict';

// Black-box tests for the session lifecycle hooks (wrxn-kernel-10).
// Each hook is exercised as the real harness would: a crafted event JSON on stdin, a temp
// install on disk, assertions on the emitted envelope and the install's own files. The
// continuity doctrine is enforced here: SessionEnd writes ONLY dated session pages; the
// baton (.wrxn/continuity/latest.md) has a single writer (the handoff skill) and the
// SessionStart orientation surface gives it precedence over the automatic episodic record.

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
const END = path.join(HOOKS, 'session-end.cjs');
const HISTORY = path.join(HOOKS, 'session-history.cjs');

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

// ── AC-1: SessionStart yields the orientation surface (identity + resume) ──────

test('session-start injects an orientation surface with the install identity', () => {
  const target = freshInstall('wrxn-sess-start-');
  const env = runHook(START, { session_id: 'sid-aaa', source: 'startup' }, target);
  const ctx = env.hookSpecificOutput && env.hookSpecificOutput.additionalContext;
  assert.equal(env.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(ctx, 'additionalContext present');
  assert.match(ctx, /wrxn-sess-start-/i, 'identity names the install');
  assert.match(ctx, /project/, 'identity carries the profile');
});

test('session-start on a fresh install reports no prior session, no crash', () => {
  const target = freshInstall('wrxn-sess-fresh-');
  const env = runHook(START, { session_id: 'sid-fresh', source: 'startup' }, target);
  assert.match(env.hookSpecificOutput.additionalContext, /fresh|no prior|first session/i);
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

// ── AC-2: SessionEnd writes a session page into the wiki sessions tier ─────────

test('session-end writes a dated page into the wiki sessions tier', () => {
  const target = freshInstall('wrxn-sess-end-');
  runHook(HISTORY, { session_id: 'sid-bbb', prompt: 'a captured turn' }, target);
  runHook(END, { session_id: 'sid-bbb', reason: 'clear' }, target);
  const files = fs.readdirSync(sessionsDir(target)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1, 'exactly one session page written');
  assert.match(files[0], /^2026-06-13-/, 'page is dated from WRXN_NOW');
  const body = fs.readFileSync(path.join(sessionsDir(target), files[0]), 'utf8');
  assert.match(body, /tier: sessions/, 'page is tagged sessions tier');
  assert.match(body, /sid-bbb/, 'page records the session id');
});

test('session-end NEVER writes the continuity baton (clobber fix)', () => {
  const target = freshInstall('wrxn-sess-noclobber-');
  // Pre-seed a deliberate baton (as the handoff skill would).
  fs.mkdirSync(path.dirname(batonPath(target)), { recursive: true });
  fs.writeFileSync(batonPath(target), 'BATON: finish issue 10\n');
  runHook(END, { session_id: 'sid-ccc', reason: 'exit' }, target);
  assert.equal(fs.readFileSync(batonPath(target), 'utf8'), 'BATON: finish issue 10\n', 'baton untouched by SessionEnd');
});

test('session-end keeps the frontmatter single-line for a pathological session id', () => {
  const target = freshInstall('wrxn-sess-frontmatter-');
  // A session id carrying a newline must NOT break the parsed `description:` frontmatter line.
  runHook(HISTORY, { session_id: 'sid\ninjected: evil', prompt: 'a turn' }, target);
  runHook(END, { session_id: 'sid\ninjected: evil', reason: 'clear' }, target);
  const files = fs.readdirSync(sessionsDir(target)).filter((f) => f.endsWith('.md'));
  const body = fs.readFileSync(path.join(sessionsDir(target), files[0]), 'utf8');
  const fm = body.split('---')[1]; // the frontmatter block
  const descLines = fm.split('\n').filter((l) => l.startsWith('description:'));
  assert.equal(descLines.length, 1, 'exactly one description line — frontmatter not corrupted');
  // The newline collapsed to a space, so "injected: evil" survives as inline value TEXT — it must
  // NOT have become its own top-level frontmatter key (which a raw newline would have produced).
  assert.ok(!fm.split('\n').some((l) => l.trim().startsWith('injected:')), 'no injected frontmatter key');
});

// ── foundation-honesty-02: session-end hygiene (reap, skip-empty, bounded) ────
// SessionEnd is the episodic writer AND the session's janitor: it reaps the ending
// session's scratch state and bounds the sessions tier — without ever touching the baton.

test('session-end reaps the ending session first-touch marker (.touched)', () => {
  const target = freshInstall('wrxn-sess-reap-');
  // code-intel-push records a first-touch marker when a code file is edited this session.
  const histDir = path.join(target, '.wrxn', 'history');
  fs.mkdirSync(histDir, { recursive: true });
  const touched = path.join(histDir, 'sid-reap.touched');
  fs.writeFileSync(touched, 'lib/install.cjs\n');
  // The session also captured a turn, so a page is written alongside the reap.
  runHook(HISTORY, { session_id: 'sid-reap', prompt: 'edit some code' }, target);
  assert.ok(fs.existsSync(touched), 'precondition: first-touch marker present before end');

  runHook(END, { session_id: 'sid-reap', reason: 'clear' }, target);
  assert.ok(!fs.existsSync(touched), 'first-touch marker reaped at session end');
});

test('session-end writes NO page for an empty session (no captured turns)', () => {
  const target = freshInstall('wrxn-sess-empty-');
  // No HISTORY turn recorded → no trail → an empty session.
  runHook(END, { session_id: 'sid-empty', reason: 'clear' }, target);
  const pages = fs.existsSync(sessionsDir(target))
    ? fs.readdirSync(sessionsDir(target)).filter((f) => f.endsWith('.md'))
    : [];
  assert.equal(pages.length, 0, 'empty session leaves no page');
});

test('session-end bounds sessions-dir growth (cap + rotation), baton untouched', () => {
  const target = freshInstall('wrxn-sess-cap-');
  // A deliberate baton must survive even as session pages rotate out around it.
  fs.mkdirSync(path.dirname(batonPath(target)), { recursive: true });
  fs.writeFileSync(batonPath(target), 'BATON: keep me\n');

  const dates = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'];
  dates.forEach((d, i) => {
    const sid = `cap-${i}`;
    const now = `${d}T10:00:00.000Z`;
    runHook(HISTORY, { session_id: sid, prompt: `turn ${i}` }, target, { WRXN_NOW: now });
    runHook(END, { session_id: sid, reason: 'clear' }, target, { WRXN_NOW: now, WRXN_SESSIONS_MAX: '3' });
  });

  const pages = fs.readdirSync(sessionsDir(target)).filter((f) => f.endsWith('.md')).sort();
  assert.equal(pages.length, 3, 'sessions dir capped at WRXN_SESSIONS_MAX');
  assert.deepEqual(
    pages,
    ['2026-06-03-cap-2.md', '2026-06-04-cap-3.md', '2026-06-05-cap-4.md'],
    'the three most-recent pages survive; the two oldest were reaped',
  );
  assert.equal(fs.readFileSync(batonPath(target), 'utf8'), 'BATON: keep me\n', 'baton untouched by rotation');
});

// ── AC-3: history capture records the turn trail ──────────────────────────────

test('session-history appends the prompt to the session trail', () => {
  const target = freshInstall('wrxn-sess-hist-');
  const env = runHook(HISTORY, { session_id: 'sid-ddd', prompt: 'build the lifecycle hooks' }, target);
  assert.deepEqual(env, {}, 'history hook is a pass-through recorder, never injects/blocks');
  const trail = path.join(target, '.wrxn', 'history', 'sid-ddd.trail');
  assert.ok(fs.existsSync(trail), 'trail file created for the session');
  assert.match(fs.readFileSync(trail, 'utf8'), /build the lifecycle hooks/);
});

// ── AC-4: e2e open + turns + close → page carries the trail ───────────────────

test('e2e: start → history×2 → end produces a page carrying the turn trail', () => {
  const target = freshInstall('wrxn-sess-e2e-');
  runHook(START, { session_id: 'sid-e2e', source: 'startup' }, target);
  runHook(HISTORY, { session_id: 'sid-e2e', prompt: 'first turn' }, target);
  runHook(HISTORY, { session_id: 'sid-e2e', prompt: 'second turn' }, target);
  runHook(END, { session_id: 'sid-e2e', reason: 'clear' }, target);

  const files = fs.readdirSync(sessionsDir(target)).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 1);
  const body = fs.readFileSync(path.join(sessionsDir(target), files[0]), 'utf8');
  assert.match(body, /first turn/, 'trail turn 1 in the page');
  assert.match(body, /second turn/, 'trail turn 2 in the page');

  // A subsequent SessionStart now surfaces the just-written session page as the resume.
  const env = runHook(START, { session_id: 'sid-e2e-2', source: 'startup' }, target);
  assert.match(env.hookSpecificOutput.additionalContext, /2026-06-13-/, 'next start resumes from the last session page');
});

// ── AC-5: deliberate handoff baton takes precedence at the next start ──────────

test('session-start gives the deliberate baton precedence over the session page', () => {
  const target = freshInstall('wrxn-sess-baton-');
  // An automatic session page exists...
  runHook(HISTORY, { session_id: 'sid-old', prompt: 'did some work' }, target);
  runHook(END, { session_id: 'sid-old', reason: 'clear' }, target);
  // ...and a deliberate handoff baton was written by the handoff skill.
  fs.mkdirSync(path.dirname(batonPath(target)), { recursive: true });
  fs.writeFileSync(batonPath(target), '# Handoff\nNEXT: ship issue 11\n');

  const env = runHook(START, { session_id: 'sid-new', source: 'resume' }, target);
  const ctx = env.hookSpecificOutput.additionalContext;
  assert.match(ctx, /ship issue 11/, 'baton content injected');
  assert.match(ctx, /handoff|baton/i, 'baton is labeled as the deliberate continuity slot');
});
