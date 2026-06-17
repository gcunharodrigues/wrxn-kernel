'use strict';

// Black-box tests for the reactive drift-detect hook (sync-07).
// drift-detect is a PostToolUse (Edit|Write) hook: when an edit touches a SOURCE file that downstream
// wiki docs declare `derived_from:`, it injects a <drift> nudge naming those docs — so drift surfaces
// immediately, not only at the next batch `wrxn sync`. Self-contained + fail-open + mechanical (no LLM,
// no recon, no sync-loop coupling). Exercised exactly as the harness would: event JSON on stdin, a temp
// install on disk, assertions on the emitted envelope.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HOOK = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'drift-detect.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

function runHook(event, target) {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  return out.trim() ? JSON.parse(out) : {};
}

function ctx(env) {
  return env.hookSpecificOutput && env.hookSpecificOutput.additionalContext;
}

// An Edit/Write PostToolUse event touching `relFile` (resolved under the install root, as the real
// harness passes an absolute path).
function editEvent(target, relFile) {
  return { session_id: 'sid-drift', tool_name: 'Edit', tool_input: { file_path: path.join(target, relFile) } };
}

// Write a raw .md page under a wiki tier — used for the corrupt-frontmatter case.
function writeRaw(target, tier, slug, content) {
  const dir = path.join(target, '.wrxn', 'wiki', tier);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), content);
}

// Write a well-formed doc page whose frontmatter carries the given derived_from line(s).
// `derivedLines` is the literal frontmatter block for the key (e.g. ['derived_from: lib/foo.cjs'] or a
// multi-line block list).
function writeDoc(target, tier, slug, derivedLines) {
  const page = ['---', `name: ${slug}`, `description: ${slug} notes`, `tier: ${tier}`, ...derivedLines, '---', '', `# ${slug}`, ''].join('\n');
  writeRaw(target, tier, slug, page);
}

// ── AC2: a scalar derived_from match emits a <drift> nudge naming the doc ──────

test('drift-detect nudges naming the doc when an edited source is declared derived_from (scalar)', () => {
  const target = freshInstall('wrxn-drift-scalar-');
  writeDoc(target, 'concepts', 'foo-notes', ['derived_from: lib/foo.cjs']);

  const env = runHook(editEvent(target, 'lib/foo.cjs'), target);
  const c = ctx(env);
  assert.ok(c, 'a drift nudge is injected');
  assert.match(c, /<drift>/, 'emits a <drift> block');
  assert.match(c, /lib\/foo\.cjs/, 'names the edited source');
  assert.match(c, /foo-notes/, 'names the affected downstream doc');
});

// ── AC2: list form + path#symbol anchor + ./relative form, every affected doc named ──

test('drift-detect matches list + path#symbol + ./relative forms and names every affected doc', () => {
  const target = freshInstall('wrxn-drift-forms-');
  // inline list with a #symbol anchor on the matching entry
  writeDoc(target, 'concepts', 'inline-doc', ['derived_from: [lib/other.cjs, lib/foo.cjs#parseThing]']);
  // block list, ./relative form of the same source
  writeDoc(target, 'decisions', 'block-doc', ['derived_from:', '  - ./lib/foo.cjs', '  - lib/unrelated.cjs']);

  const env = runHook(editEvent(target, 'lib/foo.cjs'), target);
  const c = ctx(env);
  assert.ok(c, 'a drift nudge is injected');
  assert.match(c, /inline-doc/, 'names the inline-list doc (anchor stripped, matched)');
  assert.match(c, /block-doc/, 'names the block-list doc (./relative form normalized, matched)');
});

// ── AC3: an edit with no downstream docs is silent ────────────────────────────

test('drift-detect is silent when the edited path has no downstream docs', () => {
  const target = freshInstall('wrxn-drift-none-');
  writeDoc(target, 'concepts', 'foo-notes', ['derived_from: lib/foo.cjs']);

  // edit a different, unreferenced file
  const env = runHook(editEvent(target, 'lib/unreferenced.cjs'), target);
  assert.deepEqual(env, {}, 'no doc declares derived_from this path → no nudge');
});

// ── AC4: fail-open — a corrupt provenance doc that WOULD match stays silent (edit proceeds) ──

test('drift-detect fails open (silent) when a matching doc has corrupt frontmatter', () => {
  const target = freshInstall('wrxn-drift-corrupt-');
  // a doc that, if parsed, declares derived_from the edited file — but its frontmatter is broken
  // (no closing delimiter). The hook must not throw and must not nudge.
  writeRaw(target, 'concepts', 'broken', '---\nname: broken\nderived_from: lib/foo.cjs\n(no closing fence)\n');

  const env = runHook(editEvent(target, 'lib/foo.cjs'), target);
  assert.deepEqual(env, {}, 'corrupt provenance source → silent, edit proceeds');
});

// ── AC4: fail-open — no install root resolvable → {} ──────────────────────────

test('drift-detect fails open with no install root', () => {
  const orphan = tmp('wrxn-drift-orphan-');
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify(editEvent(orphan, 'lib/foo.cjs')),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: orphan },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {}, 'no wrxn.install.json walking up → {}');
});

// ── AC5: wired in settings.json (PostToolUse Edit|Write) AND managed in the manifest ──

test('drift-detect.cjs is wired in settings PostToolUse(Edit|Write) and managed in the manifest', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'settings.json'), 'utf8'));
  const post = (settings.hooks.PostToolUse || []).filter((g) => /Edit\|Write/.test(g.matcher || ''));
  const cmds = post.flatMap((g) => (g.hooks || []).map((h) => h.command));
  assert.ok(
    cmds.some((c) => /drift-detect\.cjs/.test(c)),
    'drift-detect.cjs is registered under PostToolUse Edit|Write'
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/drift-detect.cjs');
  assert.ok(entry, 'drift-detect.cjs has a manifest entry');
  assert.equal(entry.class, 'managed', 'classified managed');
  assert.equal(entry.profile, 'project', 'project profile');
});
