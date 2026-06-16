'use strict';

// Black-box tests for the intelligence-surface hooks (wrxn-kernel-11).
// The recall machinery: reference-detect (propose-capture on a URL), recall-surface (nudge when a
// captured page matches the prompt topic), code-intel-push (first-touch-gated freshness nudge on a
// file edit), wiki-lint (flag a malformed page at session close). Each hook is self-contained and
// fail-open; exercised here exactly as the harness would — event JSON on stdin, a temp install on
// disk, assertions on the emitted envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HOOKS = path.join(PKG_ROOT, 'payload', '.claude', 'hooks');
const REF = path.join(HOOKS, 'reference-detect.cjs');
const RECALL = path.join(HOOKS, 'recall-surface.cjs');
const INTEL = path.join(HOOKS, 'code-intel-push.cjs');
const LINT = path.join(HOOKS, 'wiki-lint.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

function runHook(hookPath, event, target, env) {
  const out = execFileSync('node', [hookPath], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target, ...env },
  });
  return out.trim() ? JSON.parse(out) : {};
}

function ctx(env) {
  return env.hookSpecificOutput && env.hookSpecificOutput.additionalContext;
}

// Write a wiki page directly (simulating a captured reference / knowledge page).
function writePage(target, tier, slug, body) {
  const dir = path.join(target, '.wrxn', 'wiki', tier);
  fs.mkdirSync(dir, { recursive: true });
  const page = ['---', `name: ${slug}`, `description: ${slug} notes`, `tier: ${tier}`, '---', '', body, ''].join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), page);
}

// ── AC: reference-detect proposes capture on a URL (propose, never auto-ingest) ──

test('reference-detect nudges to capture a URL — propose, never auto', () => {
  const target = freshInstall('wrxn-ref-url-');
  const env = runHook(REF, { prompt: 'check this out https://example.com/paper on retrieval' }, target);
  const c = ctx(env);
  assert.ok(c, 'a reference-candidate nudge is injected');
  assert.match(c, /https:\/\/example\.com\/paper/, 'the URL is surfaced');
  assert.match(c, /propose|offer|confirm/i, 'the nudge is propose-then-confirm');
  assert.match(c, /never auto|do not auto|not auto/i, 'explicitly never auto-ingests');
});

test('reference-detect is silent on a prompt with no reference signal', () => {
  const target = freshInstall('wrxn-ref-none-');
  const env = runHook(REF, { prompt: 'refactor the parser to handle edge cases' }, target);
  assert.deepEqual(env, {}, 'no URL / marker → no nudge');
});

// recall-surface now queries the warm Brain door (hybrid prose recall) instead of the wiki substring
// engine — its dedicated coverage lives in recall-surface.test.cjs. Its fail-open-with-no-install-root
// behavior is still exercised by the shared loop at the bottom of this file.

// ── AC: recon freshness + code-intel push fires on file touch, first-touch gated ─

test('code-intel-push fires a freshness nudge on the first touch of a code file', () => {
  const target = freshInstall('wrxn-intel-first-');
  const ev = { session_id: 'sid-intel', tool_name: 'Edit', tool_input: { file_path: path.join(target, 'lib/foo.cjs') } };
  const env = runHook(INTEL, ev, target);
  const c = ctx(env);
  assert.ok(c, 'first touch injects a code-intel nudge');
  assert.match(c, /lib\/foo\.cjs/, 'names the touched file');
  assert.match(c, /recon|index|freshness|code-intel/i, 'mentions recon/code-intel freshness');
});

test('code-intel-push is gated — a second touch of the same file is silent', () => {
  const target = freshInstall('wrxn-intel-gate-');
  const ev = { session_id: 'sid-gate', tool_name: 'Write', tool_input: { file_path: path.join(target, 'lib/foo.cjs') } };
  const first = runHook(INTEL, ev, target);
  assert.ok(ctx(first), 'first touch nudges');
  const second = runHook(INTEL, ev, target);
  assert.deepEqual(second, {}, 'second touch of the same file this session is suppressed');
});

test('code-intel-push ignores a non-code file', () => {
  const target = freshInstall('wrxn-intel-noncode-');
  const ev = { session_id: 'sid-x', tool_name: 'Write', tool_input: { file_path: path.join(target, 'README.md') } };
  assert.deepEqual(runHook(INTEL, ev, target), {}, 'non-code touch → no nudge');
});

// ── AC: wiki lint flags a malformed page at stop ──────────────────────────────

test('wiki-lint flags a malformed page at session close', () => {
  const target = freshInstall('wrxn-lint-bad-');
  writePage(target, 'concepts', 'good-page', 'well formed');
  // A malformed page: no frontmatter at all.
  const dir = path.join(target, '.wrxn', 'wiki', 'gotchas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.md'), 'just a body, no frontmatter\n');

  const env = runHook(LINT, { session_id: 'sid-lint', reason: 'clear' }, target);
  const c = ctx(env);
  assert.ok(c, 'lint injects a report when a malformed page exists');
  assert.match(c, /broken/, 'names the malformed page');
  assert.ok(!/good-page/.test(c), 'does not flag the well-formed page');
});

test('wiki-lint is silent when every page is well-formed', () => {
  const target = freshInstall('wrxn-lint-clean-');
  writePage(target, 'concepts', 'good-page', 'well formed');
  const env = runHook(LINT, { session_id: 'sid-clean', reason: 'clear' }, target);
  assert.deepEqual(env, {}, 'all pages valid → no flag');
});

// ── fail-open: no install root resolvable → {} for every hook ──────────────────

test('every intelligence hook fails open with no install root', () => {
  const orphan = tmp('wrxn-intel-orphan-');
  for (const [hook, ev] of [
    [REF, { prompt: 'https://x.com' }],
    [RECALL, { prompt: 'kubernetes networking pods' }],
    [INTEL, { session_id: 's', tool_name: 'Edit', tool_input: { file_path: path.join(orphan, 'a.cjs') } }],
    [LINT, { session_id: 's' }],
  ]) {
    const out = execFileSync('node', [hook], {
      input: JSON.stringify(ev),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: orphan },
    });
    assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {}, `${path.basename(hook)} fails open`);
  }
});
