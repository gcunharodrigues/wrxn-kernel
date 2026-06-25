'use strict';

// Black-box tests for the chat-search engine (kernel #83, slice 1 — the EVENT-LOG arm only).
// The seam is the engine function searchConversationalLog(query, opts, roots): it scans the
// Conversational log's event-log arm — <root>/.wrxn/events/*.jsonl (the pre-redacted user prompts
// emit-event.cjs appends) — and returns recency-first structured hits. No Brain, no embeddings, no
// daemon (ADR 0008); never wired as a per-prompt hook (ADR 0002 boundary).
//
// Fixtures are written straight into a temp dir's .wrxn/events/ — the same fixture-then-assert style as
// test/intelligence-surface.test.cjs — and records carry emit-event.cjs's real field shape (the engine
// reads fields by name, so key order is irrelevant):
//   prompt → { ts, sid, kind: 'prompt', text }   tool → { ts, sid, kind: 'tool', tool, target }
// Only prompt records carry text, so only they can match in this arm (assistant turns are #84).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const ENGINE = path.join(PKG_ROOT, 'payload', '.wrxn', 'chat-search.cjs');
const { searchConversationalLog, renderHit } = require(ENGINE);
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Lay a session's event log (one JSON record per line) at <root>/.wrxn/events/<sid>.jsonl, exactly as
// emit-event.cjs appends it. `records` are partial; the sid is injected to match the <sid>.jsonl name.
function writeEvents(root, sid, records) {
  const dir = path.join(root, '.wrxn', 'events');
  fs.mkdirSync(dir, { recursive: true });
  const body = records.map((r) => JSON.stringify({ sid, ...r })).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), body);
}

const prompt = (ts, text) => ({ ts, kind: 'prompt', text });

// ── AC: case-insensitive keyword (substring) match over the event-log arm ──────

test('keyword match returns the prompt that contains the term', () => {
  const root = tmp('wrxn-chatsearch-match-');
  writeEvents(root, 'sid-a', [
    prompt('2026-06-25T10:00:00.000Z', 'fix the baton echo bug'),
    prompt('2026-06-25T10:05:00.000Z', 'refactor the parser'),
  ]);

  const res = searchConversationalLog('baton echo', {}, root);

  assert.equal(res.total, 1, 'exactly one prompt matches the term');
  const hit = res.hits[0];
  assert.match(hit.snippet, /baton echo/, 'the snippet carries the matched text');
  assert.equal(hit.role, 'user', "a prompt record's role is user");
  assert.equal(hit.session, 'sid-a', 'the hit carries its session id');
  assert.ok(hit.ts, 'the hit carries a timestamp');
});

// ── AC: hits are recency-first (most-recent timestamp on top), across all sessions ──

test('hits are returned most-recent-first across all of the project sessions', () => {
  const root = tmp('wrxn-chatsearch-recency-');
  // Two sessions; the matching prompts are deliberately out of time order on disk so a no-sort scan
  // would return them in the wrong order.
  writeEvents(root, 'sid-old', [
    prompt('2026-06-25T09:00:00.000Z', 'deploy plan: ship the gate'),
    prompt('2026-06-25T11:00:00.000Z', 'deploy plan: roll back'),
  ]);
  writeEvents(root, 'sid-new', [prompt('2026-06-25T13:00:00.000Z', 'deploy plan revisited')]);

  const res = searchConversationalLog('deploy plan', {}, root);

  assert.equal(res.total, 3, 'all three prompts match the term');
  const stamps = res.hits.map((h) => h.ts);
  assert.deepEqual(
    stamps,
    ['2026-06-25T13:00:00.000Z', '2026-06-25T11:00:00.000Z', '2026-06-25T09:00:00.000Z'],
    'hits are ordered newest timestamp first',
  );
});

// ── AC: no match → an explicit "nothing found" result (never a throw, never silence) ──

test('a term that matches nothing yields an explicit nothing-found result, not a throw', () => {
  const root = tmp('wrxn-chatsearch-none-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'unrelated chatter')]);

  let res;
  assert.doesNotThrow(() => {
    res = searchConversationalLog('quantum tunnelling', {}, root);
  }, 'no match must resolve to a result, never throw');

  assert.equal(res.found, false, 'found is explicitly false');
  assert.equal(res.total, 0, 'zero hits');
  assert.deepEqual(res.hits, [], 'the hit list is empty');
  assert.match(res.rendered, /nothing found/i, 'the rendered result states nothing was found');
  assert.match(res.rendered, /quantum tunnelling/, 'the rendered notice echoes the searched term');
});

// ── AC: each hit renders "timestamp · session (or 'this session') · role · snippet" ──

test('renderHit formats the hit line and substitutes "this session" for the active sid', () => {
  const hit = { ts: '2026-06-25T10:00:00.000Z', session: 'sid-live', role: 'user', snippet: 'the gate decision' };

  const past = renderHit(hit, { session: 'sid-other' });
  assert.equal(
    past,
    '2026-06-25T10:00:00.000Z · sid-live · user · the gate decision',
    'a hit from another session renders timestamp · session · role · snippet',
  );

  const current = renderHit(hit, { session: 'sid-live' });
  assert.match(current, /this session/, 'a hit from the active session renders "this session"');
  assert.ok(!current.includes('sid-live'), 'the raw sid is replaced, not appended');
  assert.equal(current.split(' · ').length, 4, 'four middle-dot-separated fields');
});

// ── AC: the snippet carries ±1 line of context, not the whole message ──────────

test('the snippet is the matching line with ±1 line of context, not the whole message', () => {
  const root = tmp('wrxn-chatsearch-snippet-');
  const multi = ['header far above', 'the line before', 'pivotal MARKER decision', 'the line after', 'footer far below'].join('\n');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', multi)]);

  const res = searchConversationalLog('MARKER', {}, root);

  assert.equal(res.total, 1, 'the multi-line prompt matches once');
  const snip = res.hits[0].snippet;
  assert.match(snip, /pivotal MARKER decision/, 'the matching line is in the snippet');
  assert.match(snip, /the line before/, 'one line of context before is included');
  assert.match(snip, /the line after/, 'one line of context after is included');
  assert.ok(!/header far above/.test(snip), 'a line two above the match is excluded');
  assert.ok(!/footer far below/.test(snip), 'a line two below the match is excluded');
});

// ── AC: case-insensitive substring match by default ────────────────────────────

test('matching is case-insensitive by default and the snippet preserves original case', () => {
  const root = tmp('wrxn-chatsearch-ci-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'The Baton ECHO Protocol')]);

  const res = searchConversationalLog('baton echo', {}, root);

  assert.equal(res.total, 1, 'a lowercase query matches mixed-case text');
  assert.match(res.hits[0].snippet, /Baton ECHO/, 'the snippet keeps the original casing');
});

// ── AC: operator-invocable CLI — node .wrxn/chat-search.cjs <term> --root <dir> ──

test('the CLI prints the rendered hits for an operator-typed term (exit 0)', () => {
  const root = tmp('wrxn-chatsearch-cli-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'remember the baton echo')]);

  const out = execFileSync('node', [ENGINE, 'baton echo', '--root', root], { encoding: 'utf8' });

  assert.match(out, /baton echo/, 'the CLI prints the matching snippet');
  assert.match(out, /sid-a/, 'the CLI prints the session column');
});

test('the CLI prints an explicit nothing-found notice on no match (exit 0)', () => {
  const root = tmp('wrxn-chatsearch-cli-none-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'unrelated chatter')]);

  // execFileSync throws on a non-zero exit; nothing-found is a result, not an error → it must exit 0.
  const out = execFileSync('node', [ENGINE, 'no-such-term-here', '--root', root], { encoding: 'utf8' });

  assert.match(out, /nothing found/i, 'the CLI reports nothing found rather than crashing or printing silence');
});

// ── AC: chat-search ships as a kernel payload skill (engine + SKILL.md), laid on init ──

test('chat-search engine + skill are managed/project payload files laid on init', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  for (const rel of ['.wrxn/chat-search.cjs', '.claude/skills/chat-search/SKILL.md']) {
    const entry = manifest.files.find((f) => f.path === rel);
    assert.ok(entry, `${rel} is not in the manifest`);
    assert.equal(entry.class, 'managed', `${rel} must be a managed file`);
    assert.equal(entry.profile, 'project', `${rel} must be project-profile (every install)`);
  }

  const root = freshInstall('wrxn-chatsearch-ship-');
  assert.ok(fs.existsSync(path.join(root, '.wrxn', 'chat-search.cjs')), 'init lays the engine');

  const skillMd = path.join(root, '.claude', 'skills', 'chat-search', 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), 'init lays the skill');
  const body = fs.readFileSync(skillMd, 'utf8');
  assert.match(body, /^---/, 'SKILL.md opens with YAML frontmatter');
  assert.match(body, /name:\s*chat-search/, 'frontmatter names the skill');
});

// ── AC: chat-search is NEVER registered as an automatic hook (ADR 0002 boundary) ──

test('chat-search is not wired into any settings.json hook (no automatic per-prompt surface)', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'settings.json'), 'utf8'));
  const hooksJson = JSON.stringify(settings.hooks || {});
  assert.ok(
    !/chat-search/.test(hooksJson),
    'chat-search must not appear in any hook event — it is deliberate-only (ADR 0002 keeps raw chat off the auto-surface)',
  );
});

// ── AC: pure in-process scan — no Brain, no embeddings, no serve/daemon, no network (ADR 0008) ──

test('the engine requires only node fs + path (no recon/serve/embeddings/daemon/network)', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  const mods = [...new Set([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(
    mods,
    ['fs', 'path'],
    'the engine depends only on fs + path — no recon/serve/http(s)/net/child_process/embedding import',
  );
});

// ── F1 regression: an unreadable .jsonl entry must not crash the scan (the never-crash AC) ──
// A directory whose name ends in `.jsonl` passes the listEventFiles filter, and readFileSync on it
// throws EISDIR — a permission-independent stand-in for a chmod-000 file / TOCTOU-deleted / broken
// symlink entry. The scan must skip that one entry (fail-closed on it) and still return the good hits.

test('an unreadable .jsonl entry is skipped — the scan returns the good hits and never throws', () => {
  const root = tmp('wrxn-chatsearch-badfile-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'keep the baton echo line')]);
  fs.mkdirSync(path.join(root, '.wrxn', 'events', 'bad.jsonl')); // a dir entry → readFileSync throws EISDIR

  let res;
  assert.doesNotThrow(() => {
    res = searchConversationalLog('baton echo', {}, root);
  }, 'an unreadable entry must not crash the scan mid-flight');

  assert.equal(res.total, 1, 'the good file still yields its hit');
  assert.equal(res.hits[0].session, 'sid-a', 'the hit comes from the readable session');
});

// ── F1 regression (CLI boundary): an unreadable entry must not crash or leak a stack/paths ──
// The entrypoint hardening's behavioral guarantee: the operator never sees a Node trace or an absolute
// path on stderr — the CLI skips the bad entry, prints the good hit, and exits 0 with stderr clean.

test('the CLI skips an unreadable entry — exits 0 with the good hit and no stack/paths on stderr', () => {
  const root = tmp('wrxn-chatsearch-cli-badfile-');
  writeEvents(root, 'sid-a', [prompt('2026-06-25T10:00:00.000Z', 'keep the baton echo line')]);
  fs.mkdirSync(path.join(root, '.wrxn', 'events', 'bad.jsonl'));

  const res = spawnSync('node', [ENGINE, 'baton echo', '--root', root], { encoding: 'utf8' });

  assert.equal(res.status, 0, 'the CLI exits 0 (skips the bad entry, never crashes)');
  assert.match(res.stdout, /baton echo/, 'the good hit is printed to stdout');
  assert.equal(res.stderr.trim(), '', 'nothing leaks to stderr — no Node stack trace, no absolute path');
});

// ── #87 regression: a tool record must never surface, even with a stray `text` field ──
// The documented invariant is "only prompt records can match". The guard must key on kind === 'prompt',
// not merely on the presence of a text field — so a (today hypothetical) tool record carrying text is
// skipped regardless, and a schema drift cannot silently surface tool rows with role 'tool'.

test('a kind:"tool" record carrying a text field never surfaces (only prompts match)', () => {
  const root = tmp('wrxn-chatsearch-toolguard-');
  writeEvents(root, 'sid-a', [
    { ts: '2026-06-25T10:00:00.000Z', kind: 'tool', tool: 'Bash', target: '', text: 'baton echo inside a tool record' },
  ]);

  const res = searchConversationalLog('baton echo', {}, root);

  assert.equal(res.total, 0, 'a non-prompt record is not eligible to match, even with a stray text field');
  assert.equal(res.found, false, 'the result is nothing-found, not a tool hit');
  assert.ok(!res.hits.some((h) => h.role === 'tool'), 'no tool-role hit is ever returned');
});
