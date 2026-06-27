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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Slice 3 (#85) — scoping + match flags: --session (one session), --since/today (time filter), and
// --regex (pattern match instead of case-insensitive substring). A thin layer over the established
// engine: every filter is an opts field applied during the scan, so it composes with BOTH arms,
// recency order, and dedup. Invalid flag input (bad regex / unparseable --since) fails LOUD — a clear
// one-line message, never a Node crash. --regex is the headline ReDoS risk (user-supplied pattern over
// whole transcripts), so it is length-capped + statically screened for catastrophic-backtracking shapes.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── AC: --session <id> scopes results to a single session (opts.session, both arms) ──

test('opts.session scopes the scan to a single session — other sessions are excluded', () => {
  const root = tmp('wrxn-cs-scope-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy plan in session a')]);
  writeEvents(root, 'sid-b', [prompt('2026-06-26T11:00:00.000Z', 'deploy plan in session b')]);

  const all = searchConversationalLog('deploy plan', {}, root);
  assert.equal(all.total, 2, 'unscoped, both sessions match (baseline)');

  const scoped = searchConversationalLog('deploy plan', { session: 'sid-a' }, root);
  assert.equal(scoped.total, 1, '--session narrows the result set to the one session');
  assert.equal(scoped.hits[0].session, 'sid-a', 'the surviving hit is from the scoped session');
  assert.ok(!scoped.hits.some((h) => h.session === 'sid-b'), 'the other session is excluded');
});

// ── AC: --since <ISO date> drops hits older than the threshold (inclusive of the threshold instant) ──

test('opts.since with an ISO-8601 date filters out hits before that day', () => {
  const root = tmp('wrxn-cs-since-iso-');
  writeEvents(root, 'sid-a', [
    prompt('2026-06-25T23:59:59.000Z', 'deploy plan the day before'),
    prompt('2026-06-26T00:00:00.000Z', 'deploy plan exactly at the threshold'),
    prompt('2026-06-27T09:00:00.000Z', 'deploy plan the day after'),
  ]);

  const res = searchConversationalLog('deploy plan', { since: '2026-06-26' }, root);

  assert.equal(res.total, 2, 'only hits on/after the since date survive');
  const stamps = res.hits.map((h) => h.ts);
  assert.ok(stamps.includes('2026-06-26T00:00:00.000Z'), 'the threshold instant is inclusive');
  assert.ok(stamps.includes('2026-06-27T09:00:00.000Z'), 'a later hit survives');
  assert.ok(!stamps.includes('2026-06-25T23:59:59.000Z'), 'an earlier hit is dropped');
});

// ── AC: --since today keeps only hits from UTC midnight today onward ──────────────

test('opts.since "today" keeps only hits from the start of the current UTC day', () => {
  const root = tmp('wrxn-cs-since-today-');
  const now = new Date().toISOString(); // always >= the start of today → survives the filter
  writeEvents(root, 'sid-a', [
    prompt('2020-01-01T00:00:00.000Z', 'deploy plan long ago'),
    prompt(now, 'deploy plan just now'),
  ]);

  const res = searchConversationalLog('deploy plan', { since: 'today' }, root);

  assert.equal(res.total, 1, 'only the hit from today survives "today"');
  assert.equal(res.hits[0].ts, now, 'the surviving hit is the recent one');
});

// ── AC: an unparseable --since fails LOUD (a clear thrown message), never a silent empty result ──

test('an unparseable opts.since fails loud with a clear message (not a silent empty result)', () => {
  const root = tmp('wrxn-cs-since-bad-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy plan today')]);

  assert.throws(
    () => searchConversationalLog('deploy plan', { since: 'not-a-real-date' }, root),
    (err) => {
      assert.match(err.message, /--since/, 'the error names the offending flag');
      assert.match(err.message, /date/i, 'the error explains a date was expected');
      assert.equal(err.userFacing, true, 'the error is flagged user-facing so the CLI prints it cleanly');
      return true;
    },
    'a garbage --since must fail loud, not silently drop every hit',
  );
});

// ── AC: --regex switches matching from case-insensitive substring to a regex pattern ──

test('opts.regex matches a regular expression instead of a case-insensitive substring', () => {
  const root = tmp('wrxn-cs-regex-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'the gate decision shipped via OIDC')]);

  // a pattern with regex metacharacters: as a literal substring it matches nothing…
  assert.equal(searchConversationalLog('gate.*decision', {}, root).total, 0, 'substring mode treats .* literally → no match');

  // …but in regex mode it matches across the gap.
  const res = searchConversationalLog('gate.*decision', { regex: true }, root);
  assert.equal(res.total, 1, 'regex mode matches the pattern');
  assert.match(res.hits[0].snippet, /gate decision/, 'the snippet carries the matched line');

  // regex is case-SENSITIVE (the default substring mode is case-insensitive; switching to regex is a power
  // tool where case-sensitivity is the universal regex default — grep/ripgrep/sed all behave this way).
  assert.equal(searchConversationalLog('GATE', { regex: true }, root).total, 0, 'regex mode is case-sensitive');
  assert.equal(searchConversationalLog('GATE', {}, root).total, 1, 'substring mode stays case-insensitive');
});

// ── AC: an invalid --regex pattern fails LOUD with a clear message (never a raw Node SyntaxError/crash) ──

test('an invalid opts.regex pattern fails loud with a clear, user-facing message', () => {
  const root = tmp('wrxn-cs-regex-bad-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy plan today')]);

  assert.throws(
    () => searchConversationalLog('(unterminated', { regex: true }, root),
    (err) => {
      assert.match(err.message, /--regex/, 'the error names the offending flag');
      assert.match(err.message, /pattern/i, 'the error explains the pattern is the problem');
      assert.equal(err.userFacing, true, 'the error is user-facing so the CLI prints it cleanly (no raw stack)');
      return true;
    },
    'a malformed regex must fail loud, not surface a raw Node SyntaxError',
  );
});

// ── SECURITY: a catastrophic-backtracking --regex (ReDoS) is rejected at COMPILE, before any matching ──
// The headline risk: --regex compiles a user-supplied pattern and runs it over whole transcripts. Node has
// no native regex timeout and ADR-0008 forbids a worker/child to bound it, so the defense is STATIC — the
// classic catastrophic family ((a+)+, (a*)*, (.*)*, overlapping alternation under a quantifier) is screened
// out before it can ever touch input. Rejection happens at compile, so NO input can trigger the blowup.

test('a catastrophic-backtracking --regex pattern is rejected loud and fast (ReDoS defense)', () => {
  const root = tmp('wrxn-cs-redos-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy the gate today')]);

  for (const evil of ['(a+)+$', '(a*)*', '(.*)*', '(a|a)+']) {
    const t0 = Date.now();
    assert.throws(
      () => searchConversationalLog(evil, { regex: true }, root),
      (err) => {
        assert.match(err.message, /--regex/, `${evil}: the error names the flag`);
        assert.match(err.message, /reject|backtrack/i, `${evil}: the error explains the rejection`);
        assert.equal(err.userFacing, true, `${evil}: the error is user-facing`);
        return true;
      },
      `${evil} must be rejected as a catastrophic pattern`,
    );
    // rejection is at compile (O(pattern length)), so it returns near-instantly — a hang here would mean the
    // pattern reached the matcher. A generous bound proves the short-circuit without being clock-flaky.
    assert.ok(Date.now() - t0 < 1000, `${evil}: rejection must be fast (no backtracking reached the matcher)`);
  }

  // a length-capped pattern is also rejected loud (bounds adversarial pattern complexity).
  assert.throws(() => searchConversationalLog('a'.repeat(300), { regex: true }, root), /too long/i, 'an over-long pattern is rejected');

  // …but a safe pattern (alternation with no outer quantifier) is still allowed and matches.
  assert.doesNotThrow(() => searchConversationalLog('(deploy|ship)', { regex: true }, root), 'a safe alternation is not over-rejected');
  assert.equal(searchConversationalLog('(deploy|ship)', { regex: true }, root).total, 1, 'the safe pattern still matches');
});

// ── AC: the flags compose with BOTH arms, the recency sort, and the cross-arm dedup, all at once ──
// The filters live inside consider(), which both arms feed, so composition is emergent: --session + --since
// applied together must scope by session AND time across the event arm AND the transcript arm, the cross-arm
// duplicate must still collapse to one, and the survivors must stay newest-first.

test('--session + --since compose across both arms — scope, time-filter, dedup, and recency hold together', () => {
  const home = tmp('wrxn-cs-home-');
  const root = tmp('wrxn-cs-compose-');

  // sid-keep: a cross-arm duplicate (alpha, in BOTH arms), an OLD event (before --since), and an
  // assistant-only transcript turn (beta, the newest). sid-other: a recent event that --session excludes.
  writeEvents(root, 'sid-keep', [
    prompt('2026-06-26T10:00:00.000Z', 'deploy plan alpha'), // dup of the transcript turn below
    prompt('2026-06-24T09:00:00.000Z', 'deploy plan OLD before the since floor'),
  ]);
  writeEvents(root, 'sid-other', [prompt('2026-06-26T11:00:00.000Z', 'deploy plan gamma in another session')]);
  writeTranscript(home, root, 'sid-keep', [
    turn('user', '2026-06-26T10:00:00.000Z', 'deploy plan alpha', 'sid-keep'), // dup of the event above
    turn('assistant', '2026-06-26T12:00:00.000Z', 'deploy plan beta from the assistant', 'sid-keep'),
  ]);

  const res = searchConversationalLog('deploy plan', { transcriptsHome: home, session: 'sid-keep', since: '2026-06-25' }, root);

  assert.equal(res.total, 2, 'scope + since + dedup leave exactly two hits');
  assert.equal(res.degraded, false, 'the transcript arm was reachable — no degrade');
  assert.ok(res.hits.every((h) => h.session === 'sid-keep'), '--session excluded the other session (gamma)');
  assert.ok(!res.hits.some((h) => h.ts === '2026-06-24T09:00:00.000Z'), '--since dropped the OLD hit');

  // recency: the assistant turn (12:00) on top, then the deduped alpha (10:00).
  assert.deepEqual(res.hits.map((h) => h.ts), ['2026-06-26T12:00:00.000Z', '2026-06-26T10:00:00.000Z'], 'survivors stay newest-first');
  assert.equal(res.hits[0].role, 'assistant', 'the newest survivor is the assistant turn (transcript-only)');
  assert.equal(res.hits[1].role, 'user', 'the cross-arm duplicate collapsed to the one user hit');

  // --regex composes with --session through the same per-record gate.
  const rx = searchConversationalLog('alpha|beta', { transcriptsHome: home, session: 'sid-keep', regex: true }, root);
  assert.ok(rx.total >= 1 && rx.hits.every((h) => h.session === 'sid-keep'), 'a regex search still respects --session scope');
});

// ── AC: the CLI wires --session and --regex through to the engine (exit 0) ──────

test('the CLI honors --session (scopes) and --regex (pattern match)', () => {
  const root = tmp('wrxn-cs-cli-flags-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'alpha keyword in session a')]);
  writeEvents(root, 'sid-b', [prompt('2026-06-26T11:00:00.000Z', 'beta keyword in session b')]);

  // --session scopes: only sid-a's content surfaces (asserted by content, since scoped rows render "this session").
  const scoped = spawnSync('node', [ENGINE, 'keyword', '--root', root, '--session', 'sid-a'], { encoding: 'utf8' });
  assert.equal(scoped.status, 0, '--session exits 0');
  assert.match(scoped.stdout, /alpha keyword/, 'the scoped session content is printed');
  assert.ok(!/beta keyword/.test(scoped.stdout), 'the other session is excluded by --session');

  // --regex: a metacharacter pattern matches only with the flag.
  writeEvents(root, 'sid-c', [prompt('2026-06-26T12:00:00.000Z', 'the gate decision shipped')]);
  const plain = spawnSync('node', [ENGINE, 'gate.*decision', '--root', root], { encoding: 'utf8' });
  assert.match(plain.stdout, /nothing found/i, 'without --regex the metacharacters are literal → nothing found');
  const rx = spawnSync('node', [ENGINE, 'gate.*decision', '--root', root, '--regex'], { encoding: 'utf8' });
  assert.equal(rx.status, 0, '--regex exits 0');
  assert.match(rx.stdout, /gate decision/, 'with --regex the pattern matches');
});

// ── AC + SECURITY: invalid flag input fails LOUD at the CLI boundary — a clean one-line stderr, no stack ──
// "Never a crash": the operator sees one actionable line and a non-zero exit, never a Node stack trace or an
// absolute path. Covers a bad regex, a catastrophic (ReDoS) regex, and an unparseable --since.

test('the CLI fails loud on a bad regex / catastrophic regex / unparseable --since (clean stderr, non-zero exit)', () => {
  const root = tmp('wrxn-cs-cli-bad-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy plan today')]);

  // a clean, user-facing failure: non-zero exit, a single chat-search: line, no Node stack, no absolute path.
  const assertClean = (res, label) => {
    assert.notEqual(res.status, 0, `${label}: exits non-zero`);
    assert.equal(res.stdout.trim(), '', `${label}: nothing on stdout`);
    const err = res.stderr.trim();
    assert.ok(err.startsWith('chat-search:'), `${label}: stderr is a clean chat-search line`);
    assert.equal(err.split('\n').length, 1, `${label}: exactly one line on stderr`);
    assert.ok(!/\n?\s+at\s/.test(res.stderr), `${label}: no Node stack frame leaks`);
    assert.ok(!res.stderr.includes(ENGINE), `${label}: no absolute engine path leaks`);
  };

  const badRegex = spawnSync('node', [ENGINE, '(unterminated', '--root', root, '--regex'], { encoding: 'utf8' });
  assertClean(badRegex, 'bad regex');
  assert.match(badRegex.stderr, /--regex/, 'bad regex: names the flag');

  const t0 = Date.now();
  const redos = spawnSync('node', [ENGINE, '(a+)+$', '--root', root, '--regex'], { encoding: 'utf8' });
  assertClean(redos, 'catastrophic regex');
  assert.match(redos.stderr, /reject|backtrack/i, 'catastrophic regex: explains the rejection');
  assert.ok(Date.now() - t0 < 5000, 'catastrophic regex: rejected fast, never hung the CLI');

  const badSince = spawnSync('node', [ENGINE, 'deploy', '--root', root, '--since', 'not-a-date'], { encoding: 'utf8' });
  assertClean(badSince, 'bad since');
  assert.match(badSince.stderr, /--since/, 'bad since: names the flag');
});

// ── SECURITY: --session is sanitized to a safe id charset — it can never widen scope or traverse a path ──
// The scope is a pure exact-match on each record's session field (the value is never used to build a path),
// so traversal/widening are structurally impossible; this charset guard makes that explicit and fails loud
// on a malformed id rather than silently matching nothing.

test('an unsafe opts.session id is rejected loud (no path traversal, no scope widening)', () => {
  const root = tmp('wrxn-cs-session-bad-');
  writeEvents(root, 'sid-a', [prompt('2026-06-26T10:00:00.000Z', 'deploy plan today')]);

  for (const bad of ['../../etc/passwd', 'sid a', 'sid/../b', '*', '']) {
    assert.throws(
      () => searchConversationalLog('deploy plan', { session: bad }, root),
      (err) => {
        assert.match(err.message, /--session/, `${JSON.stringify(bad)}: names the flag`);
        assert.equal(err.userFacing, true, `${JSON.stringify(bad)}: user-facing`);
        return true;
      },
      `${JSON.stringify(bad)} must be rejected as an unsafe session id`,
    );
  }

  // a real session id (alnum + hyphen, like the harness UUIDs and the event sids) still scopes fine.
  assert.equal(searchConversationalLog('deploy plan', { session: 'sid-a' }, root).total, 1, 'a valid session id still scopes');
});
