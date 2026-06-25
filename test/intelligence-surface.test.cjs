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

// ── AC: wiki-lint flags a dead [[wikilink]] (S2 #21) ──────────────────────────

test('wiki-lint flags a [[wikilink]] whose target page does not exist', () => {
  const target = freshInstall('wrxn-lint-deadlink-');
  writePage(target, 'concepts', 'src-page', 'see [[ghost-page]] for more');
  const env = runHook(LINT, { session_id: 'sid-dead', reason: 'clear' }, target);
  const c = ctx(env);
  assert.ok(c, 'a dead wikilink injects a report');
  assert.match(c, /ghost-page/, 'names the dead link target');
  assert.match(c, /src-page/, 'names the page that holds the dead link');
});

test('wiki-lint is silent on a [[wikilink]] whose target page exists', () => {
  const target = freshInstall('wrxn-lint-livelink-');
  writePage(target, 'concepts', 'src-page', 'see [[target-page]] for more');
  writePage(target, 'gotchas', 'target-page', 'the destination');
  const env = runHook(LINT, { session_id: 'sid-live', reason: 'clear' }, target);
  assert.deepEqual(env, {}, 'a resolvable wikilink → no flag');
});

// ── AC: wiki-lint ignores [[wikilinks]] inside fenced code blocks (#28) ────────
// A [[slug]] shown as example syntax inside a ``` fence is illustrative, not navigable — it must not be
// flagged dead even when no page matches it. The live [[target-page]] outside the fence still resolves.
test('wiki-lint ignores a [[wikilink]] inside a fenced code block (#28)', () => {
  const target = freshInstall('wrxn-lint-fenced-');
  writePage(
    target,
    'concepts',
    'doc-page',
    ['real prose linking [[target-page]] outside the fence', '', '```md', 'syntax: write [[nonexistent-page]] to link a page', '```', '', 'more prose'].join('\n')
  );
  writePage(target, 'gotchas', 'target-page', 'the destination');
  const env = runHook(LINT, { session_id: 'sid-fenced', reason: 'clear' }, target);
  assert.deepEqual(env, {}, 'the in-fence [[nonexistent-page]] is illustrative → no flag; the live link resolves');
});

// the fence strip must be SURGICAL — a real dead link in prose outside the fence still flags, and the
// in-fence example is the only thing suppressed (guards against blinding the linter to the whole page).
test('wiki-lint still flags a dead [[wikilink]] in prose beside a fenced code block (#28)', () => {
  const target = freshInstall('wrxn-lint-fenced-live-');
  writePage(
    target,
    'concepts',
    'doc-page2',
    ['see [[ghost-page]] for more', '', '```', 'example: [[also-not-real]] inside code', '```'].join('\n')
  );
  const env = runHook(LINT, { session_id: 'sid-fenced2', reason: 'clear' }, target);
  const c = ctx(env);
  assert.ok(c, 'the out-of-fence dead link still flags');
  assert.match(c, /ghost-page/, 'names the real dead link outside the fence');
  assert.ok(!/also-not-real/.test(c), 'the in-fence example is NOT flagged');
});

// ── AC: wiki-lint flags duplicate page titles (S2 #21) ────────────────────────

test('wiki-lint flags two pages that share the same title', () => {
  const target = freshInstall('wrxn-lint-dup-');
  // Two pages with the same name: identity slug — left unmerged. writePage uses the slug as the
  // filename, so to collide the name across files we write the second page by hand.
  writePage(target, 'concepts', 'first-copy', 'well formed');
  const dir = path.join(target, '.wrxn', 'wiki', 'gotchas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'second-copy.md'),
    ['---', 'name: first-copy', 'description: dup notes', 'tier: gotchas', '---', '', 'body', ''].join('\n')
  );
  const env = runHook(LINT, { session_id: 'sid-dup', reason: 'clear' }, target);
  const c = ctx(env);
  assert.ok(c, 'a duplicate title injects a report');
  assert.match(c, /duplicate/i, 'labels the finding as a duplicate');
  assert.match(c, /first-copy/, 'names the shared title');
});

test('wiki-lint is report-only — it never edits a page while flagging issues', () => {
  const target = freshInstall('wrxn-lint-reportonly-');
  writePage(target, 'concepts', 'has-dead-link', 'points at [[nowhere]]');
  const dir = path.join(target, '.wrxn', 'wiki', 'concepts');
  const file = path.join(dir, 'has-dead-link.md');
  const before = fs.readFileSync(file, 'utf8');
  const env = runHook(LINT, { session_id: 'sid-ro', reason: 'clear' }, target);
  assert.ok(ctx(env), 'the dead link is flagged');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the page on disk is byte-identical (report-only)');
});

// ── AC: wikilink extraction is not ReDoS-able (S2 finding #29) ─────────────────
// The old extractor `/\[\[([^\]]+)\]\]/g` backtracks O(n²) on runs of `[` — a 50KB `[`-heavy body
// took ~2.1s standalone, hanging the session-Stop hook. The bounded class `[^\]\[]+` keeps it linear.
// Driven through the real seam (the spawned hook over a page on disk) with a generous wall-clock bound
// the pre-fix quadratic would blow but the fixed pattern clears with room to spare.

test('wiki-lint scans a bracket-heavy page promptly — no quadratic backtracking (#29)', () => {
  const target = freshInstall('wrxn-lint-redos-');
  // Tens of KB of `[` — every `[[` start position made the greedy class re-consume the whole run.
  writePage(target, 'concepts', 'pathological', '['.repeat(50000));
  const start = Date.now();
  const env = runHook(LINT, { session_id: 'sid-redos', reason: 'clear' }, target);
  const elapsedMs = Date.now() - start;
  // Generous bound (CI-safe) yet far below the ~2.1s the old pattern needed; includes process spawn.
  assert.ok(
    elapsedMs < 1000,
    `lint over a [-heavy body must return promptly (was ${elapsedMs}ms) — the old regex took ~2.1s`
  );
  // A `[`-only run contains no closeable `]]`, so it yields no wikilinks → nothing to flag → silent.
  assert.deepEqual(env, {}, 'a bracket run has no resolvable wikilink target → no flag');
});

test('wiki-lint still extracts slug / |alias / #anchor and survives malformed bracket runs (#29)', () => {
  const target = freshInstall('wrxn-lint-bounded-');
  // One dead link per stripped form, plus a malformed `[[[[` run that must not crash or false-flag.
  writePage(
    target,
    'concepts',
    'forms',
    'bare [[ghost-bare]], aliased [[ghost-alias|shown]], anchored [[ghost-anchor#sec]], junk [[[['
  );
  // A live link whose target exists must stay silent (proves the bare-slug match still resolves).
  writePage(target, 'gotchas', 'real-target', 'destination');
  writePage(target, 'concepts', 'live', 'see [[real-target]]');

  const env = runHook(LINT, { session_id: 'sid-bounded', reason: 'clear' }, target);
  const c = ctx(env);
  assert.ok(c, 'the three dead links inject a report');
  assert.match(c, /ghost-bare/, 'plain [[slug]] still extracted');
  assert.match(c, /ghost-alias/, '[[slug|alias]] still stripped to the bare slug');
  assert.match(c, /ghost-anchor/, '[[slug#anchor]] still stripped to the bare slug');
  assert.ok(!/shown/.test(c) && !/sec/.test(c), 'the alias/anchor are dropped, not treated as the target');
  assert.ok(!/real-target/.test(c), 'a wikilink whose target page exists is not flagged');
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
