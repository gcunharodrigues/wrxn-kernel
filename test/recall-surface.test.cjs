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

// ── self-contained: node stdlib only (no kernel-lib / recon import) ──────────────────

test('the hook imports nothing outside the node standard library', () => {
  const src = fs.readFileSync(RECALL, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the hook has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});
