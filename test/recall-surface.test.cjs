'use strict';

// Tests for the recall-surface hook's hybrid prose recall (recon-brain-recall-04, ADR 0002).
// The hook discovers recon-wrxn's warm serve door, POSTs a prose-scoped query, and injects a
// <recall-surface> block ONLY when a prose hit clears the relevance gate — the semantic cosine floor
// (>= 0.4) OR BM25+semantic consensus, NEVER the fused RRF score. Everything else Abstains (silent).
//
// Structure mirrors the kernel's seams: decideRecall is a PURE gate/format fn (no IO); recallFromDoor
// is the IO shell with an INJECTED transport (tests never hit the network, mirroring connect.cjs);
// the CLI is exercised black-box (stdin->stdout) like hooks-boundary/hooks-managed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const RECALL = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'recall-surface.cjs');
const recall = require('../payload/.claude/hooks/recall-surface.cjs');
const reward = require('../payload/.claude/hooks/reward.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A temp install root (carries the wrxn.install.json the hook's root resolution looks for).
function installRoot(prefix) {
  const root = tmp(prefix);
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify({ version: '0.0.0' }));
  return root;
}

// Write the recon-wrxn serve-door discovery file. Chmod 0600 to model a properly-secured producer:
// the hook refuses a group/world-writable discovery file (it could have been planted), so a trusted
// fixture must be tightly permissioned. The endpoint path is returned so a test can loosen it.
function writeEndpoint(root, body) {
  const dir = path.join(root, '.recon-wrxn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'serve-endpoint.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  fs.chmodSync(file, 0o600);
  return file;
}

// A guaranteed-dead pid: spawnSync waits for exit + reap, so the pid is freed.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// Allocate then release a real port — connecting to it yields ECONNREFUSED (a dead door).
function freeClosedPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// A prose-Page hit factory; override fields per case.
function hit(over) {
  return Object.assign(
    { id: '1', name: 'Some Page', type: 'Page', file: '.wrxn/wiki/concepts/some-page.md', line: 1 },
    over
  );
}

function runCli(root, event, extraEnv) {
  const out = execFileSync('node', [RECALL], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...extraEnv },
  });
  return out.trim() ? JSON.parse(out) : {};
}

// ── decideRecall — the PURE gate/format fn ─────────────────────────────────────────

test('decideRecall: qualifies on the semantic cosine floor (>= 0.4)', () => {
  const block = recall.decideRecall([hit({ sources: ['semantic'], semanticScore: 0.42, score: 0.31 })]);
  assert.ok(block, 'a floor-clearing prose hit injects');
  assert.match(block, /<recall-surface>[\s\S]*some-page[\s\S]*<\/recall-surface>/, 'names the slug inside the block');
});

test('decideRecall: qualifies on consensus (both arms) even below the floor', () => {
  const block = recall.decideRecall([hit({ sources: ['bm25', 'semantic'], semanticScore: 0.12 })]);
  assert.ok(block, 'a both-arm consensus hit injects even with a sub-floor cosine');
});

test('decideRecall: a high-RRF, sub-floor, non-consensus hit is SUPPRESSED (RRF is NOT the gate)', () => {
  // The crux of ADR 0002: a huge fused `score` cannot rescue a hit below the cosine floor that
  // also lacks consensus. If this surfaced, the gate would be reading RRF — it must not.
  const tempting = hit({
    name: 'Tempting Lexical Match',
    file: '.wrxn/wiki/concepts/tempting.md',
    sources: ['bm25'],
    score: 0.99,
    bm25Score: 22.5,
    semanticScore: 0.18,
  });
  assert.equal(recall.decideRecall([tempting]), null, 'high RRF does not clear the per-arm gate');
});

test('decideRecall: code-typed hits are filtered out (prose only)', () => {
  const fn = hit({ name: 'doThing', type: 'Function', file: 'lib/x.cjs', sources: ['bm25', 'semantic'], semanticScore: 0.95 });
  assert.equal(recall.decideRecall([fn]), null, 'a strongly-scored code symbol still never surfaces');
});

test('decideRecall: with mixed hits, only the prose slug surfaces — never the code symbol', () => {
  const code = hit({ name: 'spawnWidget', type: 'Function', file: 'lib/widgetry.cjs', sources: ['bm25', 'semantic'], semanticScore: 0.97 });
  const page = hit({ name: 'Prompt parsing notes', type: 'Section', file: '.wrxn/wiki/concepts/prompt-parsing.md', sources: ['semantic'], semanticScore: 0.5 });
  const block = recall.decideRecall([code, page]);
  assert.ok(block, 'the qualifying prose hit injects');
  assert.match(block, /prompt-parsing/, 'the prose slug is present');
  assert.ok(!/widgetry|spawnWidget/.test(block), 'no code symbol leaks into the recall block');
});

test('decideRecall: all prose sub-floor & non-consensus → Abstain (null)', () => {
  const hits = [
    hit({ sources: ['bm25'], semanticScore: 0.2 }),
    hit({ name: 'B', file: '.wrxn/wiki/concepts/b.md', sources: ['semantic'], semanticScore: 0.39 }),
  ];
  assert.equal(recall.decideRecall(hits), null, 'nothing clears → silent');
});

test('decideRecall: cosine exactly 0.4 qualifies; 0.39 (no consensus) abstains', () => {
  assert.ok(recall.decideRecall([hit({ sources: ['semantic'], semanticScore: 0.4 })]), 'the floor is inclusive');
  assert.equal(recall.decideRecall([hit({ sources: ['semantic'], semanticScore: 0.39 })]), null, 'just below the floor abstains');
});

test('qualifies: a semanticScore WITHOUT "semantic" in sources does NOT clear the floor (producer-drift defense)', () => {
  // The floor clause requires the dense arm to actually be present — not just a stray cosine number.
  // Today these always co-occur; this guards against a future producer emitting a score without the
  // source tag, which must not be trusted as a dense-arm relevance signal.
  const drift = hit({ sources: ['bm25'], semanticScore: 0.9, score: 0.5 });
  assert.equal(recall.qualifies(drift), false, 'a high cosine with no semantic source is not a floor pass');
  assert.equal(recall.decideRecall([drift]), null, 'and it does not surface');
  assert.equal(recall.qualifies(hit({ sources: ['semantic'], semanticScore: 0.9 })), true, 'with the dense arm present it qualifies');
});

test('decideRecall: injects at most 3 hits and stays <= 600 chars', () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    hit({
      id: String(i),
      name: `Long verbose prose page number ${i} ` + 'x'.repeat(60),
      file: `.wrxn/wiki/concepts/page-${i}-with-a-fairly-long-descriptive-slug-name.md`,
      sources: ['bm25', 'semantic'],
      semanticScore: 0.7,
    })
  );
  const block = recall.decideRecall(many);
  assert.ok(block.length <= 600, `block must be <= 600 chars, got ${block.length}`);
  const bullets = block.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length >= 1 && bullets.length <= 3, `top <= 3 bullets, got ${bullets.length}`);
  assert.match(block, /<\/recall-surface>$/, 'the block is always closed even after truncation');
});

test('decideRecall: empty / non-array input → null', () => {
  assert.equal(recall.decideRecall([]), null);
  assert.equal(recall.decideRecall(undefined), null);
  assert.equal(recall.decideRecall(null), null);
});

// ── recallFromDoor — the IO shell, with an injected transport ───────────────────────

test('recallFromDoor: a warm door returns qualifying prose hits → injects the block (contract pinned)', async () => {
  const root = installRoot('wrxn-recall-warm-');
  writeEndpoint(root, { pid: process.pid, port: 65001 });
  let seen;
  const transport = async (args) => {
    seen = args;
    return {
      statusCode: 200,
      body: JSON.stringify({
        result: '## results',
        hits: [
          { id: '1', name: 'Brain door discovery', type: 'Page', file: '.wrxn/wiki/concepts/brain-door.md', line: 1, score: 0.9, sources: ['bm25', 'semantic'], bm25Score: 5, semanticScore: 0.66 },
        ],
      }),
    };
  };
  const block = await recall.recallFromDoor(root, '  how does brain door discovery work  ', { transport });
  assert.match(block, /<recall-surface>/);
  assert.match(block, /brain-door/, 'slug derived from the prose hit');
  // Cross-repo contract pins (slice 03 / QA): endpoint port, find path, body shape, trimmed query.
  assert.equal(seen.path, '/api/tools/recon_find', 'POSTs the recon_find door');
  assert.equal(seen.port, 65001, 'uses the port from serve-endpoint.json');
  assert.equal(seen.body.limit, 15, 'fetches WIDER than the TOP_N it injects, so prose below code hits is not truncated pre-filter');
  assert.equal(seen.body.query, 'how does brain door discovery work', 'the prompt is trimmed');
  assert.ok(!('type' in seen.body), 'sends NO type — prose scope is a post-filter, not a request field');
});

test('recallFromDoor: a transport timeout fails open to null', async () => {
  const root = installRoot('wrxn-recall-timeout-');
  writeEndpoint(root, { pid: process.pid, port: 65002 });
  const transport = async () => {
    throw new Error('recall door timeout');
  };
  assert.equal(await recall.recallFromDoor(root, 'a prompt long enough to query', { transport }), null);
});

test('recallFromDoor: a non-200 response fails open to null', async () => {
  const root = installRoot('wrxn-recall-503-');
  writeEndpoint(root, { pid: process.pid, port: 65003 });
  const transport = async () => ({ statusCode: 503, body: 'busy' });
  assert.equal(await recall.recallFromDoor(root, 'a prompt long enough to query', { transport }), null);
});

test('recallFromDoor: a malformed JSON body fails open to null', async () => {
  const root = installRoot('wrxn-recall-badbody-');
  writeEndpoint(root, { pid: process.pid, port: 65004 });
  const transport = async () => ({ statusCode: 200, body: 'not-json{' });
  assert.equal(await recall.recallFromDoor(root, 'a prompt long enough to query', { transport }), null);
});

test('recallFromDoor: no endpoint file → null, and the transport is NEVER called', async () => {
  const root = installRoot('wrxn-recall-noep-');
  let called = false;
  const spy = async () => {
    called = true;
    return { statusCode: 200, body: '{"hits":[]}' };
  };
  const res = await recall.recallFromDoor(root, 'a prompt about kubernetes networking', { transport: spy });
  assert.equal(res, null);
  assert.equal(called, false, 'a cold door short-circuits before any network call');
});

test('recallFromDoor: a dead-pid endpoint → null, and the transport is NEVER called', async () => {
  const root = installRoot('wrxn-recall-deadpid-');
  writeEndpoint(root, { pid: deadPid(), port: 65005 });
  let called = false;
  const spy = async () => {
    called = true;
    return { statusCode: 200, body: '{"hits":[]}' };
  };
  const res = await recall.recallFromDoor(root, 'a prompt about kubernetes networking', { transport: spy });
  assert.equal(res, null, 'a dead pid means the brain is not warm');
  assert.equal(called, false);
});

test('recallFromDoor: fetches WIDER than TOP_N so prose ranked below the code hits still surfaces', async () => {
  // Repro of the prose under-recall bug: the door ranks code in the top slots; a qualifying prose page
  // sits at rank 5. A narrow limit:3 fetch truncated it away BEFORE the prose post-filter (a spurious
  // Abstain). The fix fetches wide, THEN prose-filters + gates, THEN caps at TOP_N.
  const root = installRoot('wrxn-recall-wide-');
  writeEndpoint(root, { pid: process.pid, port: 65013 });
  const corpus = [
    { id: 'c1', name: 'doA', type: 'Function', file: 'lib/a.cjs', line: 1, sources: ['bm25', 'semantic'], semanticScore: 0.9 },
    { id: 'c2', name: 'doB', type: 'Function', file: 'lib/b.cjs', line: 1, sources: ['bm25', 'semantic'], semanticScore: 0.9 },
    { id: 'c3', name: 'doC', type: 'Function', file: 'lib/c.cjs', line: 1, sources: ['bm25', 'semantic'], semanticScore: 0.9 },
    { id: 'p4', name: 'Unrelated note', type: 'Page', file: '.wrxn/wiki/concepts/unrelated.md', line: 1, sources: ['bm25'], semanticScore: 0.1 },
    { id: 'p5', name: 'Deploy runbook', type: 'Page', file: '.wrxn/wiki/concepts/deploy-runbook.md', line: 1, sources: ['semantic'], semanticScore: 0.7 },
  ];
  // A transport that, like the real door, RESPECTS the requested limit (truncates to body.limit).
  const transport = async ({ body }) => ({ statusCode: 200, body: JSON.stringify({ result: '', hits: corpus.slice(0, body.limit) }) });
  const block = await recall.recallFromDoor(root, 'how do we deploy the runbook to prod', { transport });
  assert.ok(block, 'the qualifying prose at rank 5 surfaces (no spurious Abstain)');
  assert.match(block, /deploy-runbook/, 'the rank-5 prose page is the one injected');
});

// ── ownership/permission guard on the discovery file (a planted/loose file is not warm) ─────

test('recallFromDoor: a group/world-writable endpoint is refused (not warm), transport NEVER called', async () => {
  const root = installRoot('wrxn-recall-wwrite-');
  const file = writeEndpoint(root, { pid: process.pid, port: 65010 });
  fs.chmodSync(file, 0o666); // an attacker could rewrite host/port → prompt exfil / context injection
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: '{"hits":[]}' }; };
  assert.equal(await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: spy }), null);
  assert.equal(called, false, 'no network POST to a discovery file an attacker could have planted');
});

test('recallFromDoor: a foreign-owned endpoint (uid mismatch) is refused, transport NEVER called', async () => {
  const root = installRoot('wrxn-recall-foreign-');
  writeEndpoint(root, { pid: process.pid, port: 65011 }); // 0600, but pretend a different user owns it
  const realGetuid = process.getuid;
  process.getuid = () => realGetuid.call(process) + 1;
  try {
    let called = false;
    const spy = async () => { called = true; return { statusCode: 200, body: '{"hits":[]}' }; };
    assert.equal(await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: spy }), null);
    assert.equal(called, false);
  } finally {
    process.getuid = realGetuid;
  }
});

test('discoverEndpoint: a well-owned 0600 endpoint is trusted (warm)', () => {
  const root = installRoot('wrxn-recall-owned-');
  writeEndpoint(root, { pid: process.pid, port: 65012 });
  assert.deepEqual(recall.discoverEndpoint(root), { pid: process.pid, port: 65012 }, 'a tightly-owned file is warm');
});

// ── httpTransport: wall-clock deadline + response-body cap (the real transport) ──────

test('httpTransport: an idle-evading trickle response is bounded by the wall-clock (no hang)', async () => {
  // The idle req.setTimeout never fires against a dribble; the independent wall-clock must still bound
  // the request so a trickle can't delay a prompt past the hook budget.
  let iv = null, liveRes = null;
  const server = http.createServer((req, res) => {
    liveRes = res;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    iv = setInterval(() => { try { res.write('x'); } catch {} }, 20);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const start = Date.now();
    const outcome = await Promise.race([
      recall.httpTransport({ port, path: '/x', body: {}, timeoutMs: 100 }).then(() => 'resolved', (e) => 'rejected:' + e.message),
      new Promise((r) => setTimeout(() => r('watchdog'), 1500)),
    ]);
    assert.match(outcome, /^rejected:.*timeout/i, 'the wall-clock rejected the stalled request (not hung, not resolved)');
    assert.ok(Date.now() - start < 1400, 'rejected well within the watchdog window');
  } finally {
    if (iv) clearInterval(iv);
    if (liveRes) { try { liveRes.destroy(); } catch {} }
    server.close();
  }
});

test('httpTransport: a response body over the cap is aborted, not buffered unbounded', async () => {
  const huge = Buffer.alloc(300 * 1024, 0x78); // 300KB > the ~256KB cap
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(huge); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => recall.httpTransport({ port, path: '/x', body: {}, timeoutMs: 2000 }),
      /too large|cap|exceed/i,
      'an over-cap body is rejected rather than accumulated'
    );
  } finally {
    server.close();
  }
});

test('recallFromDoor: the query is capped at 512 chars', async () => {
  const root = installRoot('wrxn-recall-cap-');
  writeEndpoint(root, { pid: process.pid, port: 65006 });
  let seen;
  const transport = async (args) => {
    seen = args;
    return { statusCode: 200, body: '{"hits":[]}' };
  };
  await recall.recallFromDoor(root, 'x'.repeat(1000), { transport });
  assert.equal(seen.body.query.length, 512, 'a long prompt is trimmed to the 512-char cap');
});

// ── discoverEndpoint / pidAlive ─────────────────────────────────────────────────────

test('pidAlive: true for this live process, false for a reaped pid', () => {
  assert.equal(recall.pidAlive(process.pid), true);
  assert.equal(recall.pidAlive(deadPid()), false);
});

test('discoverEndpoint: cold / malformed / missing fields → null; warm → {pid,port}', () => {
  const root = installRoot('wrxn-recall-disc-');
  assert.equal(recall.discoverEndpoint(root), null, 'absent file → null');
  writeEndpoint(root, 'not json{');
  assert.equal(recall.discoverEndpoint(root), null, 'malformed JSON → null');
  writeEndpoint(root, { port: 5 });
  assert.equal(recall.discoverEndpoint(root), null, 'missing pid → null');
  writeEndpoint(root, { pid: process.pid });
  assert.equal(recall.discoverEndpoint(root), null, 'missing port → null');
  writeEndpoint(root, { pid: process.pid, port: 5 });
  assert.deepEqual(recall.discoverEndpoint(root), { pid: process.pid, port: 5 }, 'warm → {pid,port}');
});

// ── stdin->stdout black-box contract (mirrors hooks-boundary / hooks-managed) ────────

test('black-box: a valid event with no warm door emits a valid {} envelope (never throws)', () => {
  const root = installRoot('wrxn-recall-bb-nodoor-');
  assert.deepEqual(runCli(root, { prompt: 'how does the recall gate decide to abstain here' }), {});
});

test('black-box: unparseable stdin → {}', () => {
  const root = installRoot('wrxn-recall-bb-badstdin-');
  const out = execFileSync('node', [RECALL], {
    input: 'not json{',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {});
});

test('black-box: a trivial (too-short) prompt → {}', () => {
  const root = installRoot('wrxn-recall-bb-trivial-');
  assert.deepEqual(runCli(root, { prompt: 'ok' }), {});
});

test('black-box: a warm door at a closed port fails open to {} end-to-end (real transport)', async () => {
  const port = await freeClosedPort();
  const root = installRoot('wrxn-recall-bb-closed-');
  writeEndpoint(root, { pid: process.pid, port });
  assert.deepEqual(runCli(root, { prompt: 'how does brain door discovery work end to end' }), {});
});

// ── reinforce: the coalesced access-recency sidecar (harvest-08 / D2) ────────────────
// When Recall surfaces prose pages, stamp each page's "last used" day into .wrxn/reinforce.json — a
// compact map keyed by the page's WIKI-ROOT-RELATIVE PATH (the join key recon harvest-07/D1 reads;
// pinned on both sides). Coalesced to <= 1 write/page/day. Best-effort: any fault is swallowed and the
// surfacing always proceeds. Clock is injected (`now`) so day-granularity is deterministic.

const REINFORCE_REL = path.join('.wrxn', 'reinforce.json');
function readSidecar(root) {
  return JSON.parse(fs.readFileSync(path.join(root, REINFORCE_REL), 'utf8'));
}
// A warm door whose recon_find returns exactly the given prose hits (all gate-clearing).
function proseDoor(files) {
  const hits = files.map((f, i) =>
    hit({ id: String(i), name: `Page ${i}`, type: 'Page', file: f, sources: ['bm25', 'semantic'], semanticScore: 0.7 })
  );
  return async () => ({ statusCode: 200, body: JSON.stringify({ result: '', hits }) });
}

test('wikiRelPath: strips the .wrxn/wiki/ prefix to the wiki-root-relative path (the D1 join key)', () => {
  assert.equal(recall.wikiRelPath('.wrxn/wiki/concepts/foo.md'), 'concepts/foo.md', 'prefix stripped');
  assert.equal(recall.wikiRelPath('./.wrxn/wiki/decisions/bar.md'), 'decisions/bar.md', 'tolerates a leading ./');
  assert.equal(recall.wikiRelPath('/abs/install/.wrxn/wiki/gotchas/baz.md'), 'gotchas/baz.md', 'tolerates an absolute path');
  assert.equal(recall.wikiRelPath('lib/x.cjs'), null, 'a non-wiki file has no join key');
  assert.equal(recall.wikiRelPath(''), null);
  assert.equal(recall.wikiRelPath(undefined), null);
});

test('dayStamp: day-granular UTC (YYYY-MM-DD), intraday time ignored (the coalescing grain)', () => {
  assert.equal(recall.dayStamp(new Date('2026-06-17T01:02:03.000Z')), '2026-06-17');
  assert.equal(recall.dayStamp(new Date('2026-06-17T23:59:59.999Z')), '2026-06-17', 'same day regardless of time');
  assert.equal(recall.dayStamp(new Date('2026-06-18T00:00:00.000Z')), '2026-06-18', 'rolls at the UTC day boundary');
});

test('reinforce (via recallFromDoor): surfacing page X stamps X keyed by wiki-rel path + today', async () => {
  const root = installRoot('wrxn-reinforce-x-');
  writeEndpoint(root, { pid: process.pid, port: 65020 });
  const now = new Date('2026-06-17T10:00:00.000Z');
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/some-page.md']),
    now,
  });
  assert.ok(block, 'recall still surfaces');
  assert.deepEqual(
    readSidecar(root),
    { 'concepts/some-page.md': '2026-06-17' },
    'keyed by the wiki-root-relative path (D1 contract) with todays day'
  );
});

test('reinforce: a second recall of X the same day is a coalesced no-op (file byte-identical)', async () => {
  const root = installRoot('wrxn-reinforce-coalesce-');
  writeEndpoint(root, { pid: process.pid, port: 65021 });
  const now = new Date('2026-06-17T10:00:00.000Z');
  const door = proseDoor(['.wrxn/wiki/concepts/x.md']);
  await recall.recallFromDoor(root, 'surface page x for the brain once', { transport: door, now });
  const first = fs.readFileSync(path.join(root, REINFORCE_REL));
  await recall.recallFromDoor(root, 'surface page x for the brain again same day', { transport: door, now });
  const second = fs.readFileSync(path.join(root, REINFORCE_REL));
  assert.ok(first.equals(second), 'second same-day recall leaves the sidecar byte-identical (<= 1 write/page/day, no growth)');
});

test('reinforce: a recall of a different page Y adds Y (per-page coalescing, not a global daily lock)', async () => {
  const root = installRoot('wrxn-reinforce-y-');
  writeEndpoint(root, { pid: process.pid, port: 65022 });
  const now = new Date('2026-06-17T10:00:00.000Z');
  await recall.recallFromDoor(root, 'surface page x for the brain', { transport: proseDoor(['.wrxn/wiki/concepts/x.md']), now });
  await recall.recallFromDoor(root, 'now surface page y for the brain', { transport: proseDoor(['.wrxn/wiki/gotchas/y.md']), now });
  assert.deepEqual(
    readSidecar(root),
    { 'concepts/x.md': '2026-06-17', 'gotchas/y.md': '2026-06-17' },
    'both pages tracked, each keyed by its wiki-root-relative path'
  );
});

test('reinforce: the same page on a LATER day updates its timestamp (day-granular recency advances)', async () => {
  const root = installRoot('wrxn-reinforce-nextday-');
  writeEndpoint(root, { pid: process.pid, port: 65023 });
  const door = proseDoor(['.wrxn/wiki/concepts/x.md']);
  await recall.recallFromDoor(root, 'surface x on day one please', { transport: door, now: new Date('2026-06-17T10:00:00.000Z') });
  await recall.recallFromDoor(root, 'surface x on day two please', { transport: door, now: new Date('2026-06-18T09:00:00.000Z') });
  assert.deepEqual(readSidecar(root), { 'concepts/x.md': '2026-06-18' }, 'recency advanced to the later day');
});

test('reinforce: a malformed existing sidecar → recall still surfaces, stamp skipped (fail-open, untouched)', async () => {
  const root = installRoot('wrxn-reinforce-corrupt-');
  writeEndpoint(root, { pid: process.pid, port: 65024 });
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, REINFORCE_REL), 'not json{ broken');
  const block = await recall.recallFromDoor(root, 'surface x despite a corrupt sidecar', {
    transport: proseDoor(['.wrxn/wiki/concepts/x.md']),
    now: new Date('2026-06-17T10:00:00.000Z'),
  });
  assert.ok(block, 'recall surfaces despite a corrupt sidecar (non-blocking side effect)');
  assert.equal(
    fs.readFileSync(path.join(root, REINFORCE_REL), 'utf8'),
    'not json{ broken',
    'the corrupt sidecar is left untouched — stamp skipped, never clobbered'
  );
});

test('reinforce: an unwritable sidecar path → recall still surfaces, no throw (best-effort write)', async () => {
  const root = installRoot('wrxn-reinforce-unwritable-');
  writeEndpoint(root, { pid: process.pid, port: 65025 });
  // Make the sidecar PATH a directory → readFileSync/writeFileSync on it raise EISDIR → must be swallowed.
  fs.mkdirSync(path.join(root, '.wrxn', 'reinforce.json'), { recursive: true });
  const block = await recall.recallFromDoor(root, 'surface x with an unwritable sidecar path here', {
    transport: proseDoor(['.wrxn/wiki/concepts/x.md']),
    now: new Date('2026-06-17T10:00:00.000Z'),
  });
  assert.ok(block, 'recall is unaffected by an unwritable sidecar (the stamp fault is swallowed)');
});

test('reinforce: never throws even on a bad root (best-effort, pure side effect)', () => {
  const dir = tmp('wrxn-reinforce-badroot-');
  const badRoot = path.join(dir, 'a-file-not-a-dir');
  fs.writeFileSync(badRoot, 'x'); // root is a FILE → every fs op under it throws ENOTDIR
  assert.doesNotThrow(() =>
    recall.reinforce(badRoot, [hit({ file: '.wrxn/wiki/concepts/x.md' })], new Date('2026-06-17T00:00:00.000Z'))
  );
});

test('reinforce: an invalid clock never throws (the full side effect stays fail-open)', () => {
  // Defends the refactor: the day-stamp must be computed inside the swallowed envelope, so a bad `now`
  // (an Invalid Date → toISOString RangeError) can never escape and break the recall surfacing.
  const root = installRoot('wrxn-reinforce-badnow-');
  assert.doesNotThrow(() => recall.reinforce(root, [hit({ file: '.wrxn/wiki/concepts/x.md' })], new Date('not-a-date')));
  assert.equal(fs.existsSync(path.join(root, REINFORCE_REL)), false, 'a fault before the write leaves no sidecar');
});

test('reinforce: only PROSE pages are stamped — a code hit alongside prose is never keyed in', async () => {
  const root = installRoot('wrxn-reinforce-prose-only-');
  writeEndpoint(root, { pid: process.pid, port: 65027 });
  const transport = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      result: '',
      hits: [
        { id: 'c', name: 'spawnWidget', type: 'Function', file: 'lib/widgetry.cjs', line: 1, sources: ['bm25', 'semantic'], semanticScore: 0.95 },
        { id: 'p', name: 'Deploy runbook', type: 'Page', file: '.wrxn/wiki/concepts/deploy-runbook.md', line: 1, sources: ['semantic'], semanticScore: 0.7 },
      ],
    }),
  });
  const block = await recall.recallFromDoor(root, 'how do we deploy the runbook to prod', { transport, now: new Date('2026-06-17T10:00:00.000Z') });
  assert.ok(block, 'the prose hit surfaces');
  assert.deepEqual(readSidecar(root), { 'concepts/deploy-runbook.md': '2026-06-17' }, 'only the prose page is stamped; the code symbol never enters the sidecar');
});

test('reinforce: when recall ABSTAINS (nothing qualifies), no sidecar is written', async () => {
  const root = installRoot('wrxn-reinforce-abstain-');
  writeEndpoint(root, { pid: process.pid, port: 65026 });
  const transport = async () => ({
    statusCode: 200,
    body: JSON.stringify({ result: '', hits: [hit({ file: '.wrxn/wiki/concepts/x.md', sources: ['bm25'], semanticScore: 0.1 })] }),
  });
  const block = await recall.recallFromDoor(root, 'a prompt that surfaces nothing qualifying at all', { transport, now: new Date('2026-06-17T10:00:00.000Z') });
  assert.equal(block, null, 'nothing clears the gate → abstain');
  assert.equal(fs.existsSync(path.join(root, REINFORCE_REL)), false, 'no surfacing → no recency stamp (reinforcement = recall surfacing only, AC4)');
});

// ── surfaced-log: the per-session record of what recall surfaced (S1 / #12) ──────────
// When recall actually surfaces prose pages, record that SESSION's surfaced (qualifying) page-paths
// into .wrxn/surfaced.json — a compact map { "<session_id>": ["<wiki-rel-path>", …] } via the shared
// coalesced-sidecar helper. Same join key as reinforce (wiki-root-relative). Coalesced (re-surfacing
// the SAME set for a session is a no-op), fail-open (any fault leaves recall unchanged), no secret.

const SURFACED_REL = path.join('.wrxn', 'surfaced.json');
function readSurfaced(root) {
  return JSON.parse(fs.readFileSync(path.join(root, SURFACED_REL), 'utf8'));
}

test('surfacedLog: records the session\'s surfaced (qualifying) page-paths keyed by session id', () => {
  const root = installRoot('wrxn-surfaced-rec-');
  const hits = [
    hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 }),
    hit({ file: '.wrxn/wiki/gotchas/b.md', sources: ['semantic'], semanticScore: 0.6 }),
  ];
  recall.surfacedLog(root, 'sess-123', recall.qualifyingHits(hits));
  assert.deepEqual(
    readSurfaced(root),
    { 'sess-123': ['concepts/a.md', 'gotchas/b.md'] },
    'the surfaced set is keyed by session id, valued by wiki-root-relative path (join-key parity with reinforce)'
  );
});

test('surfacedLog: re-surfacing the identical set for the same session is a coalesced no-op (byte-identical)', () => {
  const root = installRoot('wrxn-surfaced-coalesce-');
  const hits = recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]);
  recall.surfacedLog(root, 'sess-1', hits);
  const first = fs.readFileSync(path.join(root, SURFACED_REL));
  recall.surfacedLog(root, 'sess-1', hits); // same session, same surfaced set
  const second = fs.readFileSync(path.join(root, SURFACED_REL));
  assert.ok(first.equals(second), 'an unchanged surfaced set leaves the sidecar byte-identical (no churn)');
});

test('surfacedLog: a different session adds its own key (per-session, not a global lock)', () => {
  const root = installRoot('wrxn-surfaced-multi-');
  recall.surfacedLog(root, 'sess-1', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  recall.surfacedLog(root, 'sess-2', recall.qualifyingHits([hit({ file: '.wrxn/wiki/gotchas/b.md', sources: ['semantic'], semanticScore: 0.6 })]));
  assert.deepEqual(
    readSurfaced(root),
    { 'sess-1': ['concepts/a.md'], 'sess-2': ['gotchas/b.md'] },
    'each session keeps its own surfaced record'
  );
});

test('surfacedLog: the same session surfacing a NEW set updates that session to the new set', () => {
  const root = installRoot('wrxn-surfaced-update-');
  recall.surfacedLog(root, 'sess-1', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  recall.surfacedLog(root, 'sess-1', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/c.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  assert.deepEqual(readSurfaced(root), { 'sess-1': ['concepts/c.md'] }, 'the session\'s surfaced set advances to the latest surfacing');
});

test('surfacedLog: no session id → no write (the session key is the record key)', () => {
  const root = installRoot('wrxn-surfaced-nosid-');
  recall.surfacedLog(root, '', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  recall.surfacedLog(root, undefined, recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  assert.equal(fs.existsSync(path.join(root, SURFACED_REL)), false, 'without a session id there is no record to write');
});

test('surfacedLog: an empty surfaced set → no write (nothing to record)', () => {
  const root = installRoot('wrxn-surfaced-empty-');
  recall.surfacedLog(root, 'sess-1', []);
  assert.equal(fs.existsSync(path.join(root, SURFACED_REL)), false, 'no surfaced paths → no surfaced-log file');
});

test('surfacedLog: only PROSE wiki paths are recorded — a code hit alongside prose is never keyed in', () => {
  const root = installRoot('wrxn-surfaced-proseonly-');
  // qualifyingHits already drops code; pass a raw mix to surfacedPaths via surfacedLog to also prove the
  // projection itself drops a non-wiki file even if one slipped through.
  recall.surfacedLog(root, 'sess-1', [
    hit({ name: 'spawnWidget', type: 'Function', file: 'lib/widgetry.cjs' }),
    hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 }),
  ]);
  assert.deepEqual(readSurfaced(root), { 'sess-1': ['concepts/a.md'] }, 'a non-wiki path is dropped from the surfaced record');
});

test('surfacedLog: a malformed existing sidecar → no throw, left untouched (fail-open via the shared helper)', () => {
  const root = installRoot('wrxn-surfaced-corrupt-');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, SURFACED_REL), 'not json{ broken');
  assert.doesNotThrow(() =>
    recall.surfacedLog(root, 'sess-1', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]))
  );
  assert.equal(fs.readFileSync(path.join(root, SURFACED_REL), 'utf8'), 'not json{ broken', 'the corrupt surfaced-log is left untouched');
});

test('surfacedLog: never throws even on a bad root (best-effort, pure side effect)', () => {
  const dir = tmp('wrxn-surfaced-badroot-');
  const badRoot = path.join(dir, 'a-file-not-a-dir');
  fs.writeFileSync(badRoot, 'x'); // root is a FILE → every fs op under it throws ENOTDIR
  assert.doesNotThrow(() =>
    recall.surfacedLog(badRoot, 'sess-1', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]))
  );
});

test('surfacedLog: a secret-shaped page path is never written (no-secret via the shared helper)', () => {
  // A wiki-rel key should never carry a secret, but the no-secret guarantee must hold structurally:
  // if a session id or path ever embedded a token shape, the helper refuses the whole write.
  const root = installRoot('wrxn-surfaced-secret-');
  recall.surfacedLog(root, 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', recall.qualifyingHits([hit({ file: '.wrxn/wiki/concepts/a.md', sources: ['bm25', 'semantic'], semanticScore: 0.7 })]));
  assert.equal(fs.existsSync(path.join(root, SURFACED_REL)), false, 'a record carrying a secret-shaped value is refused, not written');
});

test('recallFromDoor: when recall surfaces, the session\'s surfaced pages are logged under its session id', async () => {
  const root = installRoot('wrxn-surfaced-e2e-');
  writeEndpoint(root, { pid: process.pid, port: 65030 });
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/a.md', '.wrxn/wiki/gotchas/b.md']),
    now: new Date('2026-06-22T10:00:00.000Z'),
    sessionId: 'sess-e2e',
  });
  assert.ok(block, 'recall surfaces');
  assert.deepEqual(
    readSurfaced(root),
    { 'sess-e2e': ['concepts/a.md', 'gotchas/b.md'] },
    'end-to-end: after recall fires, the surfaced-log holds that session\'s surfaced pages (the exact qualifying set)'
  );
});

test('recallFromDoor: when recall ABSTAINS, no surfaced-log is written (ignores non-surfaced)', async () => {
  const root = installRoot('wrxn-surfaced-abstain-');
  writeEndpoint(root, { pid: process.pid, port: 65031 });
  const transport = async () => ({
    statusCode: 200,
    body: JSON.stringify({ result: '', hits: [hit({ file: '.wrxn/wiki/concepts/x.md', sources: ['bm25'], semanticScore: 0.1 })] }),
  });
  const block = await recall.recallFromDoor(root, 'a prompt that surfaces nothing qualifying at all', { transport, now: new Date('2026-06-22T10:00:00.000Z'), sessionId: 'sess-abstain' });
  assert.equal(block, null, 'nothing clears the gate → abstain');
  assert.equal(fs.existsSync(path.join(root, SURFACED_REL)), false, 'no surfacing → no surfaced-log (logged = surfaced only)');
});

test('recallFromDoor: surfacing with no session id still surfaces, writes no surfaced-log (fail-open on a missing id)', async () => {
  const root = installRoot('wrxn-surfaced-noid-');
  writeEndpoint(root, { pid: process.pid, port: 65032 });
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/a.md']),
    now: new Date('2026-06-22T10:00:00.000Z'),
    // no sessionId
  });
  assert.ok(block, 'recall still surfaces without a session id');
  assert.equal(fs.existsSync(path.join(root, SURFACED_REL)), false, 'no session id → no surfaced record, but surfacing is unaffected');
});

// ── SHADOW (#13 / S2): the reward slice writes counts but NEVER moves a recall rank ──
// S2 ships in shadow: a reward sidecar (.wrxn/reward.json) is written at session-end, but recall's
// ranking/output is byte-identical to before — the re-rank is S3 (behind a recorded mode constant).
// Two independent proofs: recall-surface consults NO reward state, and decideRecall's output does not
// change when a populated reward sidecar exists on disk.

// S3 supersedes the S2 "recall references no reward at all" structural lock: S3 adds the re-rank, so
// recall now READS reward factors (in live mode) to re-order candidates. The enduring invariant is that
// recall stays a READ-ONLY consumer — it never WRITES reward counts (updateReward is session-end's sole
// job); the no-op-in-shadow guarantee is now behavioural (locked byte-identical below), not structural.
test('S3 invariant: recall consumes reward read-only — it never calls updateReward (writing counts stays session-end\'s job)', () => {
  const src = fs.readFileSync(RECALL, 'utf8');
  assert.doesNotMatch(src, /updateReward/, 'recall must never WRITE reward counts — it only reads factors to re-rank');
});

test('SHADOW: decideRecall output is byte-identical whether or not a populated reward sidecar exists', () => {
  const hits = [
    hit({ name: 'Alpha Page', file: '.wrxn/wiki/concepts/alpha.md', sources: ['semantic'], semanticScore: 0.42 }),
    hit({ name: 'Beta Page', file: '.wrxn/wiki/gotchas/beta.md', sources: ['bm25', 'semantic'], semanticScore: 0.12 }),
  ];
  const baseline = recall.decideRecall(hits);
  assert.ok(baseline, 'sanity: these hits surface a block');

  // A reward sidecar that, IF S2 re-ranked, would clearly reorder (beta hugely preferred over alpha).
  const root = installRoot('wrxn-recall-shadow-');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.wrxn', 'reward.json'),
    JSON.stringify({ 'concepts/alpha.md': { s: 0, f: 99 }, 'gotchas/beta.md': { s: 99, f: 0 } }, null, 2) + '\n'
  );

  // decideRecall is pure and takes no reward input → its output cannot change. The block and the bullet
  // ORDER are identical: alpha still precedes beta (input order), proving no reward re-rank occurred.
  assert.equal(recall.decideRecall(hits), baseline, 'recall output is unchanged by the reward state (shadow)');
  assert.ok(baseline.indexOf('alpha') < baseline.indexOf('beta'), 'order follows the hits, not the reward counts');
});

// ── S3 re-rank: decideRecall accepts a reward lookup and re-ranks by score × factor before top-N ──
// The pure seam. A reward lookup is { <wiki-rel-path>: factor } (factors come from rewardFactor; the
// caller pre-computes them). Given a non-empty lookup, candidates are re-ranked by base relevance score
// × reward factor BEFORE the TOP_N cut. An absent / empty lookup is the IDENTITY (door order preserved)
// — that is the shadow no-op, locked separately. decideRecall stays PURE: the lookup is injected.

test('decideRecall (live lookup): a higher-reward page outranks a lower-reward one (re-rank by factor)', () => {
  // Two equally-relevant, equally-qualifying prose hits; DOOR order puts the low-reward page first.
  // With the reward lookup, the proven page must surface first — the re-rank moved it.
  const hits = [
    hit({ name: 'Loser Page', file: '.wrxn/wiki/concepts/loser.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
    hit({ name: 'Winner Page', file: '.wrxn/wiki/concepts/winner.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
  ];
  const lookup = { 'concepts/loser.md': 0.2, 'concepts/winner.md': 1.8 }; // winner is the proven page
  const block = recall.decideRecall(hits, lookup);
  assert.ok(block, 'both qualify → a block surfaces');
  assert.ok(block.indexOf('winner') < block.indexOf('loser'), 'the higher-reward page is ranked first');
  // and the door order alone (no lookup) keeps the loser first — proving the lookup is what moved it
  const doorOrder = recall.decideRecall(hits);
  assert.ok(doorOrder.indexOf('loser') < doorOrder.indexOf('winner'), 'without a lookup the door order is preserved');
});

// A door returning the two reward fixtures (Loser then Winner) in DOOR order, both equally relevant.
function rewardDoor() {
  return async () => ({
    statusCode: 200,
    body: JSON.stringify({
      result: '',
      hits: [
        hit({ name: 'Loser', file: '.wrxn/wiki/concepts/loser.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
        hit({ name: 'Winner', file: '.wrxn/wiki/concepts/winner.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
      ],
    }),
  });
}

// A lopsided reward sidecar on disk: winner proven (s≫f), loser disproven (f≫s).
function writeReward(root, counts) {
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'reward.json'), JSON.stringify(counts, null, 2) + '\n');
}

test('recallFromDoor (live mode, test-forced): reads .wrxn/reward.json and re-ranks surfaced pages by reward', async () => {
  const root = installRoot('wrxn-recall-live-');
  writeEndpoint(root, { pid: process.pid, port: 65040 });
  writeReward(root, { 'concepts/loser.md': { s: 0, f: 40 }, 'concepts/winner.md': { s: 40, f: 0 } });
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: rewardDoor(),
    rewardMode: 'live',
  });
  assert.ok(block, 'recall surfaces');
  assert.ok(block.indexOf('winner') < block.indexOf('loser'), 'live mode re-ranked the proven page above the disproven one');
});

// ── THE HEADLINE GUARANTEE: in the shipped default (shadow), recall is byte-identical to pre-reward ──
// behaviour even with a fully-populated reward.json on disk. This is the AC that de-risks the ship: ①
// can merge to trunk as a provable recall no-op; the live flip is a later, gated change.

test('SHADOW (shipped default): a fully-populated reward.json does NOT move a recall rank — byte-identical', async () => {
  const root = installRoot('wrxn-recall-shadow-e2e-');
  writeEndpoint(root, { pid: process.pid, port: 65041 });
  // a lopsided reward that, IF applied, would clearly reorder (winner ≫ loser)
  writeReward(root, { 'concepts/loser.md': { s: 0, f: 99 }, 'concepts/winner.md': { s: 99, f: 0 } });

  // the pre-reward (door-order) baseline for these exact hits — exactly what recall emitted before S3
  const doorHits = [
    hit({ name: 'Loser', file: '.wrxn/wiki/concepts/loser.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
    hit({ name: 'Winner', file: '.wrxn/wiki/concepts/winner.md', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }),
  ];
  const baseline = recall.decideRecall(doorHits); // single-arg = the pre-S3 behaviour

  // full recall path in the SHIPPED mode (shadow, default): reward.json on disk must be ignored entirely
  const shadowBlock = await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: rewardDoor() });
  assert.equal(shadowBlock, baseline, 'shadow recall is byte-identical to pre-reward recall despite a populated reward.json');
  assert.ok(shadowBlock.indexOf('loser') < shadowBlock.indexOf('winner'), 'door order preserved — reward had zero influence');

  // non-vacuous: the SAME inputs under live WOULD reorder, proving shadow deliberately declined to apply it
  const liveBlock = await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: rewardDoor(), rewardMode: 'live' });
  assert.ok(liveBlock.indexOf('winner') < liveBlock.indexOf('loser'), 'the reward IS live-relevant — shadow chose not to apply it');
});

test('SHIPPED_REWARD_MODE defaults to shadow (the live flip is never a silent default)', () => {
  assert.equal(recall.SHIPPED_REWARD_MODE, 'shadow', 'the shipped reward mode is shadow until the offline lift gate flips it');
});

// ── rev-F2 (S3 review): lock the shadow no-op at the IO boundary, not just the output ──────────────
// The byte-identical tests above prove shadow OUTPUT is unchanged. This locks the STRONGER, structural
// guarantee: in shadow the recall path performs ZERO reads of .wrxn/reward.json. A future "read-then-
// neutralize" refactor could keep the output byte-identical while quietly re-introducing the read (and
// with it the perf/attack surface the shadow ship exists to avoid); a read-count spy catches that.
test('rev-F2 — SHADOW performs ZERO reads of .wrxn/reward.json (the no-op is IO-locked, not just output-locked)', async () => {
  const root = installRoot('wrxn-recall-shadow-noio-');
  writeEndpoint(root, { pid: process.pid, port: 65056 });
  writeReward(root, { 'concepts/loser.md': { s: 0, f: 99 }, 'concepts/winner.md': { s: 99, f: 0 } });

  const REWARD_SUFFIX = path.join('.wrxn', 'reward.json');
  const realRead = fs.readFileSync;
  let rewardReads = 0;
  // recall-surface calls `fs.readFileSync` as a property at call time, so replacing the property on the
  // shared fs module object is observed by the hook. Count only reads of the reward sidecar.
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.endsWith(REWARD_SUFFIX)) rewardReads++;
    return realRead.call(this, p, ...rest);
  };
  try {
    const shadowBlock = await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: rewardDoor() });
    assert.ok(shadowBlock, 'shadow still surfaces a block — the recall path WAS exercised');
    assert.equal(rewardReads, 0, 'SHADOW must NEVER read .wrxn/reward.json (a read-then-neutralize refactor would regress this)');

    // Non-vacuous: the SAME spy DOES count a read under live mode — so the zero above is a real guarantee.
    rewardReads = 0;
    await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: rewardDoor(), rewardMode: 'live' });
    assert.ok(rewardReads >= 1, 'LIVE mode reads reward.json — proving the spy counts real reads (the shadow zero is meaningful)');
  } finally {
    fs.readFileSync = realRead;
  }
});

// ── S5 / kernel #16: the shipped mode is DERIVED from the recorded gate verdict, not hard-coded ──
// Mirrors recon's `SHIPPED_DECAY_MODE === selectDecayMode(<live gate verdict>)` lock. The constant is
// `selectRewardMode(RECORDED_REWARD_VERDICT)` — so it can never silently drift to 'live'; flipping the
// recorded verdict (after the lift gate passes on real data + operator ratifies) is the ONLY path.
test('SHIPPED_REWARD_MODE is selectRewardMode(RECORDED_REWARD_VERDICT) — derived from the verdict, not a literal', () => {
  assert.equal(
    recall.SHIPPED_REWARD_MODE,
    reward.selectRewardMode(reward.RECORDED_REWARD_VERDICT),
    'the shipped mode is locked to the recorded verdict (no silent drift to live)'
  );
  assert.equal(recall.SHIPPED_REWARD_MODE, 'shadow', 'and the recorded verdict still yields shadow');

  // AC3 "not hard-coded": the source derives the constant via selectRewardMode, never a bare string literal.
  const src = fs.readFileSync(RECALL, 'utf8');
  assert.match(src, /SHIPPED_REWARD_MODE\s*=\s*selectRewardMode\(/, 'the constant is derived from the verdict');
  assert.doesNotMatch(
    src,
    /SHIPPED_REWARD_MODE\s*=\s*['"](shadow|live)['"]/,
    'the constant is NOT a hard-coded string literal'
  );
});

// ── fail-open: a missing / corrupt reward store → neutral lookup → recall proceeds unchanged ──

test('readRewardLookup: a missing reward.json → null (neutral); a well-formed store → a path→factor map', () => {
  const root = installRoot('wrxn-recall-reward-read-');
  assert.equal(recall.readRewardLookup(root), null, 'no reward.json → null lookup (the common pre-gate case)');
  writeReward(root, { 'concepts/winner.md': { s: 40, f: 0 }, 'concepts/loser.md': { s: 0, f: 40 } });
  const lookup = recall.readRewardLookup(root);
  assert.ok(lookup['concepts/winner.md'] > 1, 'a proven page maps to a factor above neutral');
  assert.ok(lookup['concepts/loser.md'] < 1, 'a disproven page maps to a factor below neutral');
});

test('live mode: a corrupt reward.json fails open to a neutral re-rank — recall still surfaces in door order', async () => {
  const root = installRoot('wrxn-recall-reward-corrupt-');
  writeEndpoint(root, { pid: process.pid, port: 65042 });
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'reward.json'), 'not json{ broken');
  assert.equal(recall.readRewardLookup(root), null, 'a corrupt store reads as a neutral (null) lookup');
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: rewardDoor(), rewardMode: 'live' });
  assert.ok(block, 'recall still surfaces despite a corrupt reward store (fail-open)');
  assert.ok(block.indexOf('loser') < block.indexOf('winner'), 'a corrupt store → neutral → door order preserved');
});

// ── self-contained: node stdlib + co-located payload siblings only (no kernel-lib / recon import) ──
// The hook may require a SIBLING module that ships alongside it in the payload hooks dir (e.g. the
// shared sidecar helper) — itself self-contained — but nothing outside: no kernel-lib, no recon, no
// third-party package. A relative require is allowed only when it resolves to a real file inside the
// hooks dir (and that sibling is independently held to the same node-stdlib bar by its own test).

test('the hook imports nothing outside the node standard library or its co-located payload siblings', () => {
  const src = fs.readFileSync(RECALL, 'utf8');
  const hooksDir = path.dirname(RECALL);
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the hook has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    if (m.startsWith('.')) {
      const resolved = path.resolve(hooksDir, m);
      assert.ok(resolved.startsWith(hooksDir + path.sep), `${m} must resolve inside the hooks dir — no reaching outside the payload`);
      assert.ok(fs.existsSync(resolved), `${m} must be a real co-located sibling module`);
      continue;
    }
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── S1 recall-exclusion teeth (#20): drop stale / superseded pages BEFORE ranking/top-N ──────────────
// Curation flags retired pages in their FRONTMATTER (harvest stamps `stale:` / `superseded_by:`). A recon
// FindHit carries NO frontmatter, so the exclusion reads each candidate page's frontmatter from disk via
// an INJECTED reader (DI, mirroring the injected clock / reward lookup) — the core stays a pure black box.
// decideRecall / qualifyingHits gain an optional `exclude` predicate (true ⇒ drop). Absent ⇒ no exclusion
// ⇒ output byte-identical to today (the no-op). The predicate is built from a pure supersession resolver
// over a { path → frontmatter } view that fails SAFE on a cycle / dangling successor (exclude, never throw).

// A reward-neutral, gate-clearing prose hit at a given wiki path (for ordering/exclusion assertions).
function pageHit(file, over) {
  return hit(Object.assign({ file, name: file, type: 'Page', sources: ['bm25', 'semantic'], semanticScore: 0.7, score: 0.5 }, over));
}

test('decideRecall (exclude): a stale page is dropped before top-N — a live page it would have displaced surfaces', () => {
  // TOP_N is 3. Four qualifying prose hits in door order; the FIRST three include a stale page that, if it
  // kept its slot, would push the fourth (live) page out of the top-N. Excluding it BEFORE the cut lets the
  // live page surface in its place.
  const hits = [
    pageHit('.wrxn/wiki/concepts/a.md'),
    pageHit('.wrxn/wiki/concepts/stale.md'),
    pageHit('.wrxn/wiki/concepts/c.md'),
    pageHit('.wrxn/wiki/concepts/live.md'),
  ];
  const exclude = (h) => h.file === '.wrxn/wiki/concepts/stale.md';
  const block = recall.decideRecall(hits, null, exclude);
  assert.ok(block, 'the remaining qualifying pages still surface');
  assert.ok(!/concepts\/stale|\bstale\b/.test(block), 'the stale page never occupies a top-N slot');
  assert.match(block, /live/, 'the live page it would have displaced now surfaces in its place');
});

// ── buildExclusion — the PURE supersession resolver over a { path → frontmatter } view ───────────────
// Builds the exclude predicate from a frontmatter view. A page is retired (excluded) when its frontmatter
// sets a truthy `stale:` OR carries a `superseded_by:` pointer (it is not its own live head). The walk
// resolves transitively to the live head and fails SAFE on a cycle / dangling successor (exclude, never
// throw). The view is keyed by the SAME path the hit carries (hit.file), so the predicate reads off the hit.

test('buildExclusion: a page with truthy stale: frontmatter is excluded', () => {
  const view = { '.wrxn/wiki/concepts/a.md': { stale: 'concepts/gone-source.md' } };
  const exclude = recall.buildExclusion(view);
  assert.equal(exclude(pageHit('.wrxn/wiki/concepts/a.md')), true, 'a stale page is excluded');
  assert.equal(exclude(pageHit('.wrxn/wiki/concepts/unflagged.md')), false, 'an unflagged page is kept');
});

test('buildExclusion: a page carrying superseded_by: is excluded', () => {
  const view = {
    '.wrxn/wiki/concepts/old.md': { superseded_by: '.wrxn/wiki/concepts/new.md' },
    '.wrxn/wiki/concepts/new.md': {},
  };
  const exclude = recall.buildExclusion(view);
  assert.equal(exclude(pageHit('.wrxn/wiki/concepts/old.md')), true, 'the superseded page is excluded');
  assert.equal(exclude(pageHit('.wrxn/wiki/concepts/new.md')), false, 'the live replacement (head) is kept');
});

test('buildExclusion: supersession resolves transitively — A→B→C surfaces C, excludes A and B', () => {
  const A = '.wrxn/wiki/concepts/a.md', B = '.wrxn/wiki/concepts/b.md', C = '.wrxn/wiki/concepts/c.md';
  const view = {
    [A]: { superseded_by: B },
    [B]: { superseded_by: C },
    [C]: {}, // the live head
  };
  const exclude = recall.buildExclusion(view);
  assert.equal(exclude(pageHit(A)), true, 'A (head of the chain) is excluded');
  assert.equal(exclude(pageHit(B)), true, 'B (mid-chain) is excluded');
  assert.equal(exclude(pageHit(C)), false, 'C (the live head) surfaces');
  assert.equal(recall.resolveHead(A, view), C, 'A resolves transitively to the live head C');
});

test('buildExclusion: a supersession CYCLE fails safe — both pages excluded, no throw / no hang', () => {
  const A = '.wrxn/wiki/concepts/a.md', B = '.wrxn/wiki/concepts/b.md';
  const view = { [A]: { superseded_by: B }, [B]: { superseded_by: A } }; // A→B→A
  let exclude;
  assert.doesNotThrow(() => { exclude = recall.buildExclusion(view); }, 'building over a cyclic view never throws');
  assert.doesNotThrow(() => {
    assert.equal(exclude(pageHit(A)), true, 'a cycle member is excluded (fail safe)');
    assert.equal(exclude(pageHit(B)), true, 'the other cycle member is excluded (fail safe)');
  }, 'evaluating the predicate over a cycle terminates and never throws');
  assert.equal(recall.resolveHead(A, view), null, 'a cyclic chain has no live head (null sentinel)');
});

test('buildExclusion: a DANGLING successor fails safe — the page is excluded, no throw', () => {
  const old = '.wrxn/wiki/concepts/old.md';
  const view = { [old]: { superseded_by: '.wrxn/wiki/concepts/does-not-exist.md' } }; // successor absent
  const exclude = recall.buildExclusion(view);
  assert.equal(exclude(pageHit(old)), true, 'a page whose successor is missing is excluded (fail safe)');
  assert.equal(recall.resolveHead(old, view), null, 'a dangling chain resolves to no head (null)');
});

test('buildExclusion: a self-superseding page (A→A) fails safe — excluded, no hang', () => {
  const A = '.wrxn/wiki/concepts/a.md';
  const view = { [A]: { superseded_by: A } }; // degenerate 1-cycle
  const exclude = recall.buildExclusion(view);
  assert.equal(recall.resolveHead(A, view), null, 'a self-pointer is a cycle → no head');
  assert.equal(exclude(pageHit(A)), true, 'the self-superseding page is excluded (fail safe)');
});

test('buildExclusion: TOTAL — a garbage view / nullish hit never throws and never excludes', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const exclude = recall.buildExclusion(bad);
    assert.equal(typeof exclude, 'function', 'always returns a predicate');
    assert.equal(exclude(pageHit('.wrxn/wiki/concepts/a.md')), false, 'a non-object view never excludes (fail-open)');
  }
  const exclude = recall.buildExclusion({ '.wrxn/wiki/concepts/a.md': { stale: 'x' } });
  for (const badHit of [null, undefined, {}, { file: 42 }, { file: '' }]) {
    assert.equal(exclude(badHit), false, 'a hit with no usable path is kept, never throws');
  }
});

// ── #25: parseRetirement interprets the YAML scalar — `stale: false` means NOT stale ─────────────────
// parseRetirement is a raw-text line scanner, not a full YAML parser, so it captured the scalar as a
// STRING. `stale: false` then yielded the string 'false', which is truthy in JS → buildExclusion's
// `if (fm.stale)` wrongly excluded a page the author explicitly marked not-stale. A YAML-falsy scalar
// (false / no / null / ~ / 0 / empty) means NOT stale → the key must be dropped; only a truthy flag
// excludes. (Harvest itself only ever writes `stale: <source-path>` (truthy) or omits the key, so this
// only bites a human who hand-writes `stale: false` to un-flag — but the contract must honour them.)
test('parseRetirement: a YAML-falsy stale scalar is dropped — `stale: false` / `no` / `0` is NOT stale', () => {
  for (const falsy of ['false', 'False', 'FALSE', 'no', 'No', 'null', '~', '0']) {
    const fm = recall.parseRetirement(`---\nstale: ${falsy}\n---\n\n# p\n`);
    assert.equal(fm.stale, undefined, `stale: ${falsy} is YAML-falsy → key dropped (NOT stale)`);
  }
});

test('parseRetirement: a truthy stale scalar is still captured — `stale: true` / `yes` / a source path', () => {
  assert.equal(recall.parseRetirement('---\nstale: true\n---\n').stale, 'true', '`true` is captured');
  assert.equal(recall.parseRetirement('---\nstale: yes\n---\n').stale, 'yes', '`yes` is captured');
  assert.equal(
    recall.parseRetirement('---\nstale: concepts/gone-source.md\n---\n').stale,
    'concepts/gone-source.md',
    'the harvest-written source path (the real-world case) is captured unchanged'
  );
});

test('buildExclusion (#25): a page explicitly marked `stale: false` is NOT excluded (kept)', () => {
  // The headline bug repro: a human un-flags a page with `stale: false`. The string 'false' is truthy
  // in JS, so the pre-fix reader excluded it — contradicting YAML semantics and the AC word "truthy".
  const view = { '.wrxn/wiki/concepts/not-stale.md': recall.parseRetirement('---\nstale: false\n---\n') };
  const exclude = recall.buildExclusion(view);
  assert.equal(exclude(pageHit('.wrxn/wiki/concepts/not-stale.md')), false, 'a `stale: false` page is kept, not excluded');
});

test('recallFromDoor (#25): a page flagged `stale: false` on disk surfaces — falsy means not-stale, end-to-end', async () => {
  const root = installRoot('wrxn-recall-e2e-stalefalse-');
  writeEndpoint(root, { pid: process.pid, port: 65054 });
  writeWikiPage(root, '.wrxn/wiki/concepts/keepme.md', { stale: 'false' });
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/keepme.md']),
  });
  assert.ok(block, 'a `stale: false` page is NOT retired → recall still surfaces');
  assert.match(block, /keepme/, 'the explicitly-not-stale page surfaces (falsy honoured end-to-end)');
});

test('decideRecall: exclusion runs BEFORE the reward re-rank — an excluded top-reward page never surfaces', () => {
  // The excluded page has the highest reward factor; if exclusion ran AFTER the re-rank it would win a
  // slot. Excluding it first means it is gone before reward (or the gate, or the cut) is ever consulted.
  const hits = [
    pageHit('.wrxn/wiki/concepts/keep.md'),
    pageHit('.wrxn/wiki/concepts/retired.md'),
  ];
  const lookup = { 'concepts/retired.md': 1.9, 'concepts/keep.md': 0.3 }; // retired would dominate the re-rank
  const exclude = (h) => h.file === '.wrxn/wiki/concepts/retired.md';
  const block = recall.decideRecall(hits, lookup, exclude);
  assert.ok(block, 'the kept page still surfaces');
  assert.ok(!/retired/.test(block), 'the excluded page never surfaces even though it had the top reward factor');
  assert.match(block, /keep/, 'only the live page remains');
});

test('decideRecall: an excluded page that clears the gate strongly is still dropped (exclusion precedes the gate)', () => {
  // A lone strongly-qualifying prose hit — but it is retired. Exclusion before the gate ⇒ Abstain (null),
  // proving the excluded page is removed before the qualify check would have admitted it.
  const strong = pageHit('.wrxn/wiki/concepts/retired.md', { sources: ['bm25', 'semantic'], semanticScore: 0.95 });
  const exclude = (h) => h.file === '.wrxn/wiki/concepts/retired.md';
  assert.equal(recall.decideRecall([strong], null, exclude), null, 'a strong-but-retired sole hit yields Abstain');
});

// ── the end-to-end exclusion wiring through recallFromDoor (reads page frontmatter from disk) ─────────
// The IO shell reads each candidate hit's page frontmatter from <root>/<hit.file> and builds the exclude
// predicate; tests write real wiki pages so the disk read is exercised. THE HEADLINE NO-OP (AC-6): with
// no flagged pages, the block is byte-identical to the pre-exclusion baseline (decideRecall single-arg).

// Write a wiki page file under the install root with optional frontmatter keys, so the shell's disk read
// sees a real page. `fm` is a {key: value} map of frontmatter scalars (e.g. { stale: '...' }).
function writeWikiPage(root, relFile, fm) {
  const abs = path.join(root, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = ['---', ...Object.entries(fm || {}).map(([k, v]) => `${k}: ${v}`), '---', '', `# ${path.basename(relFile)}`, '', 'body'];
  fs.writeFileSync(abs, lines.join('\n') + '\n');
}

test('recallFromDoor: with NO flagged pages, the block is byte-identical to the pre-exclusion baseline (AC-6 no-op)', async () => {
  const root = installRoot('wrxn-recall-noop-');
  writeEndpoint(root, { pid: process.pid, port: 65050 });
  const files = ['.wrxn/wiki/concepts/a.md', '.wrxn/wiki/gotchas/b.md'];
  for (const f of files) writeWikiPage(root, f, {}); // present, but NO stale / superseded_by
  // the pre-exclusion baseline for these exact gate-clearing hits (what recall emitted before S1)
  const baselineHits = files.map((f, i) => hit({ id: String(i), name: `Page ${i}`, type: 'Page', file: f, sources: ['bm25', 'semantic'], semanticScore: 0.7 }));
  const baseline = recall.decideRecall(baselineHits); // single-arg = pre-S1 behaviour
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', { transport: proseDoor(files) });
  assert.equal(block, baseline, 'unflagged recall is byte-identical to the pre-exclusion baseline');
});

test('recallFromDoor: a candidate whose page on disk is flagged stale: is excluded end-to-end', async () => {
  const root = installRoot('wrxn-recall-e2e-stale-');
  writeEndpoint(root, { pid: process.pid, port: 65051 });
  writeWikiPage(root, '.wrxn/wiki/concepts/live.md', {});
  writeWikiPage(root, '.wrxn/wiki/concepts/stale.md', { stale: 'concepts/gone-source.md' });
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/stale.md', '.wrxn/wiki/concepts/live.md']),
  });
  assert.ok(block, 'the live page still surfaces');
  assert.ok(!/concepts\/stale|\bstale\b/.test(block), 'the disk-flagged stale page is excluded end-to-end');
  assert.match(block, /live/, 'only the live page surfaces');
});

test('recallFromDoor: a candidate superseded on disk (A→B→C) surfaces only the live head C', async () => {
  const root = installRoot('wrxn-recall-e2e-super-');
  writeEndpoint(root, { pid: process.pid, port: 65052 });
  writeWikiPage(root, '.wrxn/wiki/concepts/a.md', { superseded_by: '.wrxn/wiki/concepts/b.md' });
  writeWikiPage(root, '.wrxn/wiki/concepts/b.md', { superseded_by: '.wrxn/wiki/concepts/c.md' });
  writeWikiPage(root, '.wrxn/wiki/concepts/c.md', {});
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/a.md', '.wrxn/wiki/concepts/b.md', '.wrxn/wiki/concepts/c.md']),
  });
  assert.ok(block, 'the live head surfaces');
  assert.match(block, /\bc\b|concepts\/c/, 'the live head C surfaces');
  assert.ok(!/concepts\/a\b/.test(block) && !/concepts\/b\b/.test(block), 'the superseded ancestors A and B are excluded');
});

test('recallFromDoor: exclusion reads frontmatter best-effort — an unreadable page is treated as unflagged (kept, no throw)', async () => {
  // A candidate whose page file is MISSING on disk (the door returned a hit for a since-deleted page).
  // The frontmatter read fails; exclusion must fail-open (treat as unflagged → keep) and never throw.
  const root = installRoot('wrxn-recall-e2e-missingpage-');
  writeEndpoint(root, { pid: process.pid, port: 65053 });
  // note: no writeWikiPage — the file does not exist on disk
  const block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
    transport: proseDoor(['.wrxn/wiki/concepts/ghost.md']),
  });
  assert.ok(block, 'a candidate whose page is unreadable is kept (fail-open), recall still surfaces');
  assert.match(block, /ghost/, 'the unflagged-by-default page surfaces');
});

// ── #26: the exclusion reader is CONFINED to the real wiki root (path-traversal defense-in-depth) ─────
// readExclusionView turns a hit.file into a real fs.readFileSync path. The pre-fix guard was a substring
// check (`wikiRelPath != null`) with no canonicalization and no `..` rejection, so a hit.file like
// `.wrxn/wiki/../../../secret` passed it and the join resolved OUTSIDE the wiki root (readFileSync also
// follows symlinks). The fix RESOLVES the path and reads ONLY files truly under <root>/.wrxn/wiki/ —
// an escaping / absolute / symlink-escaping path is treated as unreadable (unflagged, kept), fail-open,
// never read, never throws. Black-box proof: a real flagged-`stale:` file PLANTED OUTSIDE the wiki root,
// pointed at by an escaping hit.file, must NOT exclude its hit (which it would iff the reader read it).

test('readExclusionView (#26): a `..`-escaping hit.file is NOT read — its flag never lands in the view', () => {
  const root = installRoot('wrxn-excl-traversal-');
  // A page OUTSIDE the wiki root that, IF read, would flag the hit stale (proving the read happened).
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'outside-secret.md'), '---\nstale: pwned\n---\n\n# x\n');
  const escaping = '.wrxn/wiki/../outside-secret.md'; // resolves to <root>/.wrxn/outside-secret.md (outside the wiki root)
  let view;
  assert.doesNotThrow(() => { view = recall.readExclusionView(root, [{ file: escaping, type: 'Page' }]); });
  // confined → unflagged: either the path is omitted entirely, or it is recorded as empty frontmatter.
  assert.deepEqual(view[escaping] || {}, {}, 'an escaping path is treated as unflagged — its outside `stale:` flag is never read');
});

test('readExclusionView (#26): a deep `..` escape to a sibling OUTSIDE the install root is refused (not read)', () => {
  const root = installRoot('wrxn-excl-deep-');
  // A flagged file in a SIBLING dir of the install root (fully outside it), reachable only by climbing out.
  const sibling = path.join(path.dirname(root), `${path.basename(root)}-sibling-secret.md`);
  fs.writeFileSync(sibling, '---\nstale: pwned\n---\n\n# x\n');
  // From the wiki root (<root>/.wrxn/wiki) climb out three levels (wiki → .wrxn → root → parent) to the
  // sibling. The path still contains the '.wrxn/wiki/' substring (slips the old indexOf guard) yet
  // resolves fully OUTSIDE the install root.
  const escaping = `.wrxn/wiki/../../../${path.basename(root)}-sibling-secret.md`;
  // sanity: this genuinely resolves outside the wiki root (and outside the install root) under both join and resolve
  assert.equal(path.resolve(root, escaping), sibling, 'fixture: the escaping path really resolves to the outside sibling');
  let view;
  assert.doesNotThrow(() => { view = recall.readExclusionView(root, [{ file: escaping, type: 'Page' }]); });
  assert.deepEqual(view[escaping] || {}, {}, 'a deep escape is unflagged — its outside `stale:` flag is never read');
});

test('readExclusionView (#26): a legitimate in-root page is still read normally (no regression)', () => {
  const root = installRoot('wrxn-excl-inroot-');
  writeWikiPage(root, '.wrxn/wiki/concepts/real.md', { stale: 'concepts/gone.md' });
  const f = '.wrxn/wiki/concepts/real.md';
  const view = recall.readExclusionView(root, [{ file: f, type: 'Page' }]);
  assert.equal(view[f] && view[f].stale, 'concepts/gone.md', 'a genuinely-in-root page is read and its flag captured');
});

test('recallFromDoor (#26): an escaping candidate fails open — its outside `stale:` flag cannot retire it', async () => {
  const root = installRoot('wrxn-recall-e2e-traversal-');
  writeEndpoint(root, { pid: process.pid, port: 65055 });
  // Plant a stale-flagged file OUTSIDE the wiki root; the door returns a hit whose path escapes to it.
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'evil.md'), '---\nstale: pwned\n---\n\n# evil\n');
  const escaping = '.wrxn/wiki/../evil.md';
  let block;
  await assert.doesNotReject(async () => {
    block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
      transport: proseDoor([escaping]),
    });
  }, 'an escaping candidate never makes recall throw (fail-open)');
  assert.ok(block, 'the candidate is treated as unflagged (its outside flag was never read) → recall surfaces');
  assert.match(block, /evil/, 'the page surfaces — the path-traversal read was refused, not honoured');
});

test('recallFromDoor (#26): a symlink INSIDE the wiki root pointing OUTSIDE is not followed to read external content', async function () {
  const root = installRoot('wrxn-recall-e2e-symlink-');
  writeEndpoint(root, { pid: process.pid, port: 65056 });
  // A stale-flagged file outside the wiki root; a symlink at a legitimate in-root path points to it.
  const outside = path.join(root, 'outside-stale.md');
  fs.writeFileSync(outside, '---\nstale: pwned\n---\n\n# outside\n');
  fs.mkdirSync(path.join(root, '.wrxn', 'wiki', 'concepts'), { recursive: true });
  const linkRel = '.wrxn/wiki/concepts/link.md';
  try {
    fs.symlinkSync(outside, path.join(root, linkRel));
  } catch (e) {
    return; // platform without symlink support (e.g. restricted Windows) → skip
  }
  let block;
  await assert.doesNotReject(async () => {
    block = await recall.recallFromDoor(root, 'a prompt long enough to query the door', {
      transport: proseDoor([linkRel]),
    });
  }, 'a symlink-escaping candidate never makes recall throw (fail-open)');
  assert.ok(block, 'the symlinked page is treated as unflagged (external content not followed) → recall surfaces');
  assert.match(block, /link/, 'the page surfaces — the symlink to outside content was not followed for the flag');
});

// ── S4 structural recall arm (#23): edit-aware second recon_find query, RRF-fused with the prompt arm ──
// Adapted (no-invention): recon-wrxn exposes no DOCUMENTED_BY code→wiki edge, so F is kernel-only — it
// REUSES the .touched per-session edited-paths list (written by code-intel-push) to seed a SECOND
// recon_find query against the SAME door, then RRF-fuses that ranked list with the prompt-semantic list
// BEFORE the exclusion / gate / reward / top-N. The query-builder and the fusion are PURE black boxes;
// the structural fetch is injected (DI). Empty .touched or any structural fault → no-op (byte-identical).

// ── buildStructuralQuery — PURE: edited paths → a recon_find seed (file basenames, tokenized, deduped) ──

test('buildStructuralQuery: maps touched paths to a deduped basename token seed', () => {
  assert.equal(
    recall.buildStructuralQuery(['payload/.claude/hooks/recall-surface.cjs', 'lib/recall-engine.cjs']),
    'recall surface engine',
    'basenames (sans extension) are tokenized on non-alphanumerics and deduped (recall appears once)'
  );
  assert.equal(recall.buildStructuralQuery(['lib/foo.cjs']), 'foo', 'a single path yields its basename token');
});

test('buildStructuralQuery: empty / non-array / junk input → empty string (the no-op seed)', () => {
  assert.equal(recall.buildStructuralQuery([]), '', 'no edits → empty seed');
  assert.equal(recall.buildStructuralQuery(undefined), '', 'non-array → empty seed');
  assert.equal(recall.buildStructuralQuery([null, 42, '']), '', 'unusable entries are skipped → empty seed');
});

// ── rrfFuse — PURE reciprocal-rank fusion of two ranked hit lists (deduped by page key) ───────────────

test('rrfFuse: a page present in BOTH arms outranks pages present in only one (summed reciprocal ranks)', () => {
  const both = hit({ file: '.wrxn/wiki/concepts/both.md', name: 'Both' });
  const aOnly = hit({ file: '.wrxn/wiki/concepts/a-only.md', name: 'A only' });
  const bOnly = hit({ file: '.wrxn/wiki/concepts/b-only.md', name: 'B only' });
  // semantic arm ranks [both, aOnly]; structural arm ranks [both, bOnly] → `both` accrues two contributions
  const fused = recall.rrfFuse([both, aOnly], [both, bOnly]);
  assert.deepEqual(fused.map((h) => h.file), [
    '.wrxn/wiki/concepts/both.md',     // in both arms → highest fused score
    '.wrxn/wiki/concepts/a-only.md',   // rank-2 of arm A (1/(k+2)) beats rank-2 of arm B by first-seen tie order
    '.wrxn/wiki/concepts/b-only.md',
  ], 'the consensus page leads; each page appears once (deduped by file key)');
});

test('rrfFuse: IDENTITY when one list is empty — the non-empty list is returned in order, same objects', () => {
  // This property is the cornerstone of the no-op guarantee: empty .touched → structural arm yields [] →
  // the prompt-semantic list flows through fusion unchanged (same order, same hit references).
  const a = hit({ file: '.wrxn/wiki/concepts/a.md', name: 'A' });
  const b = hit({ file: '.wrxn/wiki/concepts/b.md', name: 'B' });
  const c = hit({ file: '.wrxn/wiki/concepts/c.md', name: 'C' });
  const list = [a, b, c];
  const fusedRight = recall.rrfFuse(list, []);
  assert.deepEqual(fusedRight, list, 'rrfFuse(list, []) preserves order');
  assert.equal(fusedRight[0], a, 'and preserves the exact hit object references (no copies)');
  assert.deepEqual(recall.rrfFuse([], list), list, 'rrfFuse([], list) is likewise the identity');
  assert.deepEqual(recall.rrfFuse([], []), [], 'two empty arms → []');
});

// ── readTouched — REUSE the .touched per-session edited-paths list (written by code-intel-push) ───────
// code-intel-push appends each first-touched relPath to .wrxn/history/<safeId(sid)>.touched. The
// structural arm reads it back; the session-id → filename transform MUST match code-intel-push exactly,
// so this helper mirrors its safeId. No new persistence path is created — the arm only READS .touched.

function safeIdForTouched(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}
function writeTouched(root, sessionId, lines) {
  const dir = path.join(root, '.wrxn', 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safeIdForTouched(sessionId)}.touched`), lines.join('\n') + '\n');
}

test('readTouched: reads the session .touched file back as a deduped, order-preserving path list', () => {
  const root = installRoot('wrxn-touched-read-');
  writeTouched(root, 'sess-s4', ['lib/a.cjs', 'lib/b.cjs', 'lib/a.cjs', '  ', 'lib/c.cjs']);
  assert.deepEqual(
    recall.readTouched(root, 'sess-s4'),
    ['lib/a.cjs', 'lib/b.cjs', 'lib/c.cjs'],
    'blank lines dropped, duplicates collapsed, first-seen order kept'
  );
});

test('readTouched: an absent .touched file → [] (the common no-edits case, never throws)', () => {
  const root = installRoot('wrxn-touched-absent-');
  assert.deepEqual(recall.readTouched(root, 'sess-none'), [], 'no edits this session → empty list');
  assert.doesNotThrow(() => recall.readTouched(root, undefined), 'a missing session id never throws');
});

// ── the structural arm wired through recallFromDoor: a query-discriminating door (DI) ─────────────────
// A transport that answers the prompt-semantic query and the edit-seeded structural query DIFFERENTLY,
// so a test can prove a page reachable ONLY via the structural arm surfaces after fusion.

// `byQuery` maps a recon_find query string → the prose files that query returns (each a gate-clearing hit).
function splitArmDoor(byQuery) {
  return async ({ body }) => {
    const files = byQuery[body.query] || [];
    const hits = files.map((f, i) =>
      hit({ id: `${body.query}-${i}`, name: f, type: 'Page', file: f, sources: ['bm25', 'semantic'], semanticScore: 0.7 })
    );
    return { statusCode: 200, body: JSON.stringify({ result: '', hits }) };
  };
}

test('recallFromDoor (S4): a page reachable only via the edit-seeded structural arm surfaces after fusion', async () => {
  const root = installRoot('wrxn-s4-surface-');
  writeEndpoint(root, { pid: process.pid, port: 65060 });
  writeTouched(root, 'sess-s4', ['lib/recall-engine.cjs']); // → structural query 'recall engine'
  const PROMPT = 'how should I tune the deploy runbook for prod';
  const SEMANTIC_PAGE = '.wrxn/wiki/concepts/deploy-runbook.md';
  const STRUCTURAL_PAGE = '.wrxn/wiki/concepts/recall-engine.md'; // mentions the edited symbol, NOT the prompt
  const door = splitArmDoor({
    [PROMPT.slice(0, 512)]: [SEMANTIC_PAGE],          // the prompt arm finds only the runbook page
    'recall engine': [STRUCTURAL_PAGE],               // the edit-seeded arm finds the recall-engine page
  });

  // CONTROL: with NO .touched the structural arm is dormant → the structural page must NOT surface.
  const rootNoTouch = installRoot('wrxn-s4-control-');
  writeEndpoint(rootNoTouch, { pid: process.pid, port: 65061 });
  const control = await recall.recallFromDoor(rootNoTouch, PROMPT, { transport: door, sessionId: 'sess-s4' });
  assert.ok(control, 'control surfaces the semantic page');
  assert.match(control, /deploy-runbook/, 'control: the prompt-semantic page surfaces');
  assert.ok(!/recall-engine/.test(control), 'control: with no edits, the structural page is NOT reachable');

  // WITH .touched the structural arm fires and the recall-engine page is fused in and surfaces.
  const block = await recall.recallFromDoor(root, PROMPT, { transport: door, sessionId: 'sess-s4' });
  assert.ok(block, 'recall surfaces');
  assert.match(block, /recall-engine/, 'the edit-seeded structural page surfaces via the structural arm + fusion');
  assert.match(block, /deploy-runbook/, 'the prompt-semantic page still surfaces too (both arms fused)');
});

test('recallFromDoor (S4 no-op): empty .touched → byte-identical to the pre-S4 semantic-only baseline', async () => {
  const root = installRoot('wrxn-s4-noop-');
  writeEndpoint(root, { pid: process.pid, port: 65062 });
  // NO writeTouched — the structural arm must stay dormant.
  const PROMPT = 'how should I tune the deploy runbook for prod';
  const SEMANTIC_PAGE = '.wrxn/wiki/concepts/deploy-runbook.md';
  const STRUCTURAL_PAGE = '.wrxn/wiki/concepts/recall-engine.md';
  // The door HAS a structural answer ready — proving the no-op holds because the arm never fires, not
  // because the door lacks structural content to contribute.
  const door = splitArmDoor({ [PROMPT]: [SEMANTIC_PAGE], 'recall engine': [STRUCTURAL_PAGE] });
  // The pre-S4 baseline: exactly the block recall emitted for the prompt arm alone (the door's prompt hit).
  const promptHit = hit({ id: `${PROMPT}-0`, name: SEMANTIC_PAGE, type: 'Page', file: SEMANTIC_PAGE, sources: ['bm25', 'semantic'], semanticScore: 0.7 });
  const baseline = recall.decideRecall([promptHit]);
  const block = await recall.recallFromDoor(root, PROMPT, { transport: door, sessionId: 'sess-s4' });
  assert.equal(block, baseline, 'with no edits, recall is byte-identical to the pre-S4 semantic-only output');
  assert.ok(!/recall-engine/.test(block), 'the dormant structural arm contributes nothing');
});

test('recallFromDoor (S4 fail-open): a structural-query fault → arm empty, recall unchanged, never throws', async () => {
  const root = installRoot('wrxn-s4-failopen-');
  writeEndpoint(root, { pid: process.pid, port: 65063 });
  writeTouched(root, 'sess-s4', ['lib/recall-engine.cjs']); // arm fires with query 'recall engine'
  const PROMPT = 'how should I tune the deploy runbook for prod';
  const SEMANTIC_PAGE = '.wrxn/wiki/concepts/deploy-runbook.md';
  // The SEMANTIC arm succeeds; the STRUCTURAL query blows up (timeout / refused / 500 — all reach here).
  const transport = async ({ body }) => {
    if (body.query === 'recall engine') throw new Error('structural door blew up');
    return { statusCode: 200, body: JSON.stringify({ result: '', hits: [hit({ id: '0', name: SEMANTIC_PAGE, type: 'Page', file: SEMANTIC_PAGE, sources: ['bm25', 'semantic'], semanticScore: 0.7 })] }) };
  };
  const baseline = recall.decideRecall([hit({ id: '0', name: SEMANTIC_PAGE, type: 'Page', file: SEMANTIC_PAGE, sources: ['bm25', 'semantic'], semanticScore: 0.7 })]);
  let block;
  await assert.doesNotReject(async () => {
    block = await recall.recallFromDoor(root, PROMPT, { transport, sessionId: 'sess-s4' });
  }, 'a structural-arm fault never makes recall throw (fail-open)');
  assert.equal(block, baseline, 'a structural fault leaves recall byte-identical to the semantic-only baseline');
  assert.match(block, /deploy-runbook/, 'the semantic arm still surfaces');
});

test('recallFromDoor (S4 + S1): a stale page arriving via the structural arm is STILL excluded (over the fused set)', async () => {
  // Fusion runs BEFORE diskExclusion, so the S1 exclusion view is built from the FULL fused candidate set
  // (both arms). A page retired in its frontmatter must never reach a top-N slot regardless of which arm
  // surfaced it — proving S1's guarantee is preserved across the new structural path.
  const root = installRoot('wrxn-s4-s1-');
  writeEndpoint(root, { pid: process.pid, port: 65064 });
  writeTouched(root, 'sess-s4', ['lib/old-engine.cjs']); // → structural query 'old engine'
  const PROMPT = 'how should I tune the deploy runbook for prod';
  const LIVE = '.wrxn/wiki/concepts/deploy-runbook.md';  // semantic arm, live
  const STALE = '.wrxn/wiki/concepts/old-engine.md';     // structural arm, flagged stale on disk
  writeWikiPage(root, LIVE, {});
  writeWikiPage(root, STALE, { stale: 'concepts/gone-source.md' });
  const door = splitArmDoor({ [PROMPT]: [LIVE], 'old engine': [STALE] });
  const block = await recall.recallFromDoor(root, PROMPT, { transport: door, sessionId: 'sess-s4' });
  assert.ok(block, 'the live page still surfaces');
  assert.match(block, /deploy-runbook/, 'the live semantic page surfaces');
  assert.ok(!/old-engine/.test(block), 'the disk-flagged stale page is excluded even though it arrived via the structural arm');
});
