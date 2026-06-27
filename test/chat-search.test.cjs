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
const { searchConversationalLog, renderHit, resolveTranscriptDir } = require(ENGINE);
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
// The closed allow-list is fs + path + os: os is for home-dir resolution only (the transcript arm lives
// under ~/.claude/projects, #84). The boundary that matters holds — no http(s)/net/child_process, no
// recon/serve, no embedding import — so a future edit that reaches the network or spawns a daemon fails here.

test('the engine requires only node fs + os + path (no recon/serve/embeddings/daemon/network)', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  const mods = [...new Set([...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(
    mods,
    ['fs', 'os', 'path'],
    'the engine depends only on fs + os + path — no recon/serve/http(s)/net/child_process/embedding import',
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Slice 2 (#84) — the harness-transcript arm: ~/.claude/projects/<slug>/*.jsonl. The only source of
// ASSISTANT turns and full user/assistant message content. The transcripts home is injected via
// opts.transcriptsHome so every test is hermetic (it never touches the operator's real ~/.claude).
// ════════════════════════════════════════════════════════════════════════════════════════════════

// The harness slug for an install root: every non-alphanumeric char → '-' (verified against the real
// ~/.claude/projects dir names, e.g. /home/guilherme/.claude → -home-guilherme--claude). The engine maps
// root → slug → <home>/<slug>/, so a fixture must live under the SAME derived slug to be found.
function slugForRoot(root) {
  return String(root).replace(/[^A-Za-z0-9]/g, '-');
}

// Lay a harness transcript JSONL at <home>/<slug-of-root>/<sid>.jsonl, one JSON record per line, exactly
// as Claude Code writes it. `records` are full transcript-shaped lines (type + message{role,content} + …).
function writeTranscript(home, root, sid, records) {
  const dir = path.join(home, slugForRoot(root));
  fs.mkdirSync(dir, { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), body);
}

// One transcript turn in the harness shape: top-level type/timestamp/sessionId + message{role,content}.
// `content` is a string OR a text-block array — the engine flattens both. role mirrors type (user|assistant).
const turn = (type, ts, content, sid) => ({ type, timestamp: ts, sessionId: sid, message: { role: type, content } });

// ── AC: the transcript arm surfaces an ASSISTANT turn (the only arm that carries one) ──

test('the transcript arm surfaces an assistant turn with string content (the event arm never has one)', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-asst-');
  writeTranscript(home, root, 'sid-t', [
    turn('assistant', '2026-06-26T10:00:00.000Z', 'the gate decision was to ship via OIDC', 'sid-t'),
  ]);

  const res = searchConversationalLog('gate decision', { transcriptsHome: home }, root);

  assert.equal(res.total, 1, 'the assistant turn matches');
  assert.equal(res.hits[0].role, 'assistant', 'role is assistant — only the transcript arm carries assistant turns');
  assert.match(res.hits[0].snippet, /gate decision/, 'the snippet carries the matched text');
  assert.equal(res.hits[0].session, 'sid-t', 'the hit carries the transcript session id');
  assert.equal(res.hits[0].ts, '2026-06-26T10:00:00.000Z', 'the hit carries the transcript timestamp');
});

// ── AC: message.content as a text-block ARRAY is flattened; non-text blocks + unknown line types are dropped ──

test('the transcript arm flattens a text-block array (dropping thinking/tool blocks) and skips unknown line types', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-arr-');
  writeTranscript(home, root, 'sid-t', [
    // an assistant turn whose content is a text-block array mixed with non-text blocks — only `text` is conversation.
    turn('assistant', '2026-06-26T11:00:00.000Z', [
      { type: 'thinking', thinking: 'a MULLINGTOKEN that lives only in a thinking block' },
      { type: 'text', text: 'we will migrate publishing to OIDC trusted publishing' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm run TOOLTOKEN' } },
    ], 'sid-t'),
    // an unknown line type carrying the term must never surface.
    { type: 'summary', timestamp: '2026-06-26T11:01:00.000Z', sessionId: 'sid-t', summary: 'a SUMMARYTOKEN recap line' },
  ]);

  const res = searchConversationalLog('trusted publishing', { transcriptsHome: home }, root);
  assert.equal(res.total, 1, 'the assistant text block matches');
  assert.equal(res.hits[0].role, 'assistant', 'the hit is the assistant turn');
  assert.match(res.hits[0].snippet, /migrate publishing to OIDC/, 'the text block is flattened into the snippet');

  // non-text blocks are framework noise, not message content → dropped, not searchable.
  assert.equal(searchConversationalLog('MULLINGTOKEN', { transcriptsHome: home }, root).total, 0, 'a thinking block is not searchable');
  assert.equal(searchConversationalLog('TOOLTOKEN', { transcriptsHome: home }, root).total, 0, 'a tool_use block is not searchable');
  // an unknown line type (summary / system / …) is skipped entirely.
  assert.equal(searchConversationalLog('SUMMARYTOKEN', { transcriptsHome: home }, root).total, 0, 'an unknown line type is skipped');
});

// ── AC: hook-injected context is stripped before matching — a block merely HOLDING the term is not a hit ──

test('injected framework context is stripped before matching — a term inside a synapse block is not a hit', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-strip-');
  // a user turn whose content is a hook-injected <synapse-rules> block (carrying a term) PLUS the real
  // prompt. The injected block is framework noise — a term living ONLY inside it must NOT surface.
  const content = '<synapse-rules>\nalways honor the INJECTEDONLY directive\n</synapse-rules>\nplease refactor the parser';
  writeTranscript(home, root, 'sid-t', [turn('user', '2026-06-26T12:00:00.000Z', content, 'sid-t')]);

  // the term that lives ONLY inside the injected block → no hit (it is stripped before matching).
  assert.equal(
    searchConversationalLog('INJECTEDONLY', { transcriptsHome: home }, root).total,
    0,
    'a term present only inside an injected <synapse-rules> block is not a hit',
  );
  // the real prompt text (outside the block) still matches, and the surfaced snippet is free of injected noise.
  const real = searchConversationalLog('refactor the parser', { transcriptsHome: home }, root);
  assert.equal(real.total, 1, 'the real prompt text outside the injected block still matches');
  assert.ok(!/synapse-rules/.test(real.hits[0].snippet), 'the injected block is gone from the surfaced snippet');
});

// ── AC: secrets in transcript-derived output are redacted (events are pre-redacted upstream) ──

test('secrets in transcript-derived output are redacted before they leave the engine', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-redact-');
  // an assistant turn that echoes a credential next to the search term (synthetic, pattern-matching shape).
  const secret = 'sk-' + 'A'.repeat(40); // OpenAI-style secret-key shape — redactSecrets must scrub it
  writeTranscript(home, root, 'sid-t', [
    turn('assistant', '2026-06-26T13:00:00.000Z', `the deploy credential is ${secret} for the gate`, 'sid-t'),
  ]);

  const res = searchConversationalLog('deploy', { transcriptsHome: home }, root);
  assert.equal(res.total, 1, 'the turn matches the term');
  assert.ok(!res.hits[0].snippet.includes(secret), 'the raw secret never appears in the surfaced snippet');
  assert.match(res.hits[0].snippet, /\[REDACTED\]/, 'the secret is replaced with [REDACTED]');
});

// ── AC: a prompt present in BOTH arms surfaces once — dedup by (session, timestamp, text) ──

test('a prompt present in both arms is de-duplicated by (session, timestamp, text) — it appears once', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-dedup-');
  const ts = '2026-06-26T14:00:00.000Z';
  const sid = 'sid-dup';
  const text = 'remember the baton echo decision';
  // the SAME user prompt lands in BOTH arms: emit-event's event log AND the harness transcript.
  writeEvents(root, sid, [{ ts, kind: 'prompt', text }]);
  writeTranscript(home, root, sid, [turn('user', ts, text, sid)]);

  const res = searchConversationalLog('baton echo', { transcriptsHome: home }, root);
  assert.equal(res.total, 1, 'the cross-arm duplicate collapses to a single hit');
  assert.equal(res.hits[0].session, sid, 'the surviving hit carries the shared session id');
  assert.equal(res.hits[0].role, 'user', 'the surviving hit is the user prompt');
});

// ── AC: missing/unreadable transcript dir → events-only results + an explicit note (loud degrade, never crash) ──

test('a missing transcript dir degrades to events-only with an explicit loud note (never a crash)', () => {
  const root = tmp('wrxn-cs-degrade-');
  const home = tmp('wrxn-cs-emptyhome-'); // a real but EMPTY transcripts home → this root's slug dir is absent.
  writeEvents(root, 'sid-a', [prompt('2026-06-26T15:00:00.000Z', 'the event-only baton echo line')]);

  let res;
  assert.doesNotThrow(() => {
    res = searchConversationalLog('baton echo', { transcriptsHome: home }, root);
  }, 'a missing transcript dir must never crash the scan');

  assert.equal(res.total, 1, 'the event-log hit still surfaces');
  assert.equal(res.hits[0].role, 'user', 'the surviving hit is from the event-log arm');
  assert.equal(res.degraded, true, 'the result flags the transcript-arm degrade');
  assert.match(res.rendered, /transcript arm unavailable/i, 'the rendered result carries an explicit events-only degrade note');
  assert.match(res.rendered, /baton echo/, 'the event-log hit is still rendered alongside the note');
});

// ── SECURITY: the transcript dir maps root → ~/.claude/projects/<slug>; the slug must be path-bounded ──

test('the transcript-dir resolver bounds the slug — no path-traversal escape, no cross-project leak', () => {
  const home = tmp('wrxn-cs-sec-home-');
  const base = path.resolve(home);

  // (1) a traversal-laden root: every non-alphanumeric char becomes '-', so no '/', '\\' or '..' survives —
  //     the resolved dir is strictly UNDER the base, never the real /etc target.
  const dir = resolveTranscriptDir('/home/x/../../../../etc/wrxn-pwned', home);
  assert.ok(dir && dir.startsWith(base + path.sep), 'a traversal-laden root resolves under the transcripts base');
  assert.ok(!dir.includes('..'), 'no .. survives in the resolved transcript dir');
  assert.ok(!dir.startsWith('/etc'), 'the traversal target is unreachable');

  // (2) a degenerate root that would map to the base ITSELF (which would read EVERY project) is refused.
  assert.equal(resolveTranscriptDir([], home), null, 'a root that yields an empty slug must NOT map to the base dir');
  assert.equal(resolveTranscriptDir('', home), null, 'an empty root resolves to no transcript dir');
  assert.equal(resolveTranscriptDir('/a/project', ''), null, 'an absent home resolves to no transcript dir');
});

// ── robustness: an unreadable transcript ENTRY is skipped (per-file), not a full arm degrade (never crash) ──

test('an unreadable transcript entry is skipped — good transcript hits still surface and the arm is not degraded', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-tbad-');
  writeTranscript(home, root, 'sid-good', [turn('assistant', '2026-06-26T16:00:00.000Z', 'the good transcript baton echo', 'sid-good')]);
  // a directory entry whose name ends in .jsonl → readFileSync throws EISDIR (a stand-in for chmod-000 / TOCTOU).
  fs.mkdirSync(path.join(home, slugForRoot(root), 'bad.jsonl'));

  let res;
  assert.doesNotThrow(() => {
    res = searchConversationalLog('baton echo', { transcriptsHome: home }, root);
  }, 'an unreadable transcript entry must not crash the scan');
  assert.equal(res.total, 1, 'the good transcript file still yields its hit');
  assert.equal(res.hits[0].role, 'assistant', 'the surviving hit is the assistant turn');
  assert.equal(res.degraded, false, 'a readable dir with one bad entry is NOT a full arm degrade');
});

// ── robustness: a present-but-EMPTY transcript dir is reachable → events-only, but NOT a degrade (no note) ──

test('a present-but-empty transcript dir is consulted (not a degrade) and the event-log hits still surface', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-tempty-');
  fs.mkdirSync(path.join(home, slugForRoot(root)), { recursive: true }); // the dir EXISTS but holds no .jsonl
  writeEvents(root, 'sid-a', [prompt('2026-06-26T16:30:00.000Z', 'event arm baton echo only')]);

  const res = searchConversationalLog('baton echo', { transcriptsHome: home }, root);
  assert.equal(res.total, 1, 'the event-log hit surfaces');
  assert.equal(res.degraded, false, 'a present empty transcript dir was reachable → no degrade');
  assert.ok(!/transcript arm unavailable/.test(res.rendered), 'no degrade note when the arm was reachable');
});

// ── robustness: a malformed line + a drifted (non-string/array) content are skipped per-record (never crash) ──

test('a malformed transcript line and a drifted message.content are skipped — only the clean turn surfaces', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-drift-');
  const dir = path.join(home, slugForRoot(root));
  fs.mkdirSync(dir, { recursive: true });
  // a transcript with: a garbage (non-JSON) line, a user turn whose content is a NUMBER (shape drift),
  // and one well-formed assistant turn. Only the clean turn surfaces and the scan never throws.
  const body = [
    '{ this is not valid json',
    JSON.stringify({ type: 'user', timestamp: '2026-06-26T17:00:00.000Z', sessionId: 'sid-d', message: { role: 'user', content: 42 } }),
    JSON.stringify(turn('assistant', '2026-06-26T17:01:00.000Z', 'a clean baton echo turn', 'sid-d')),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'sid-d.jsonl'), body);

  let res;
  assert.doesNotThrow(() => {
    res = searchConversationalLog('baton echo', { transcriptsHome: home }, root);
  }, 'a malformed line / drifted content must not crash the scan');
  assert.equal(res.total, 1, 'only the well-formed assistant turn surfaces');
  assert.equal(res.degraded, false, 'the dir was readable — per-line drift is not a full arm degrade');
});
