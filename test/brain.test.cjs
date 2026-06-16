'use strict';

// Tests for `wrxn brain query` — on-demand whole-brain (code+prose) retrieval over the warm serve
// door (recon-brain-recall-03). Mirrors connect.test.cjs's injected-transport seam: the query path
// takes an injected transport + endpoint reader so behavior is unit-testable with NO live serve.
//
// AC-1: query against a warm door returns ranked code+prose hits.
// AC-2: --json emits structured hits; default is human text (name · type · file:line).
// AC-3: --limit forwarded to the door; --type post-filters (prose=Page/Section, code=rest, exact);
//       --neighbors expands each hit to its 1-hop graph neighbors via recon_explain.
// AC-4: no discoverable endpoint (absent / dead-pid) ⇒ a clear error + non-zero exit (not silent).
// AC-5: a malformed / non-200 door response ⇒ a clean error, never a crash.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { promisify } = require('util');
const { execFileSync, execFile, spawnSync } = require('child_process');
const execFileAsync = promisify(execFile);

const PKG_ROOT = path.join(__dirname, '..');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
const brain = require('../lib/brain.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Write the recon-wrxn serve-door discovery file under <root>/.recon-wrxn/serve-endpoint.json.
function writeEndpoint(root, body) {
  const dir = path.join(root, '.recon-wrxn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'serve-endpoint.json'), typeof body === 'string' ? body : JSON.stringify(body));
}

// A guaranteed-dead pid: spawnSync waits for exit + reap, so the pid is freed.
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// A recon_find structured hit factory (the slice-01 keystone per-hit shape).
function fhit(over) {
  return Object.assign(
    { id: '1', name: 'doThing', type: 'Function', file: 'lib/x.cjs', line: 5, score: 0.5, sources: ['bm25'], bm25Score: 3.1, semanticScore: 0.4 },
    over
  );
}

// A configurable injected transport. Records every call; routes find/explain to the given responders.
function fakeTransport(routes) {
  const calls = [];
  const t = async ({ port, path: p, body }) => {
    calls.push({ port, path: p, body });
    if (p === '/api/tools/recon_find') return { statusCode: 200, body: JSON.stringify(routes.find(body)) };
    if (p === '/api/tools/recon_explain') return { statusCode: 200, body: JSON.stringify((routes.explain || (() => ({ neighbors: [] })))(body)) };
    return { statusCode: 404, body: '{}' };
  };
  t.calls = calls;
  return t;
}

const warmDiscover = () => ({ pid: process.pid, port: 4242, root: '/tmp/install' });

// ── AC-1: warm door → ranked code+prose hits ────────────────────────────────────────

test('query: a warm door returns ranked code+prose hits from the injected transport', async () => {
  const hits = [
    fhit({ id: '1', name: 'authFlow', type: 'Function', file: 'lib/auth.cjs', line: 10 }),
    fhit({ id: '2', name: 'Auth notes', type: 'Page', file: '.wrxn/wiki/concepts/auth.md', line: 1 }),
  ];
  const transport = fakeTransport({ find: () => ({ result: '## results', hits }) });
  const res = await brain.query('auth flow', {}, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits.map((h) => h.name), ['authFlow', 'Auth notes'], 'code AND prose come back, ranked');
  // The find door is POSTed with the trimmed query.
  assert.equal(transport.calls[0].path, '/api/tools/recon_find');
  assert.equal(transport.calls[0].body.query, 'auth flow');
});

test('query: a blank query is rejected before any door call', async () => {
  const transport = fakeTransport({ find: () => ({ hits: [] }) });
  await assert.rejects(() => brain.query('   ', {}, { discover: warmDiscover, transport }), /non-empty/i);
  assert.equal(transport.calls.length, 0, 'no door call for an empty query');
});

// ── AC-2: --json structured vs default human text ───────────────────────────────────

test('formatHits: default is human text — name · type · file:line', () => {
  const out = brain.formatHits([fhit({ name: 'doThing', type: 'Function', file: 'lib/x.cjs', line: 5 })], {});
  assert.match(out, /doThing · Function · lib\/x\.cjs:5/);
});

test('formatHits: --json round-trips the structured hits (scores/sources preserved)', () => {
  const hits = [fhit({}), fhit({ id: '2', name: 'Page A', type: 'Page', file: '.wrxn/wiki/a.md', line: 1, sources: ['bm25', 'semantic'] })];
  const out = brain.formatHits(hits, { json: true });
  assert.deepEqual(JSON.parse(out), hits, 'json output is the structured hits, faithfully');
});

test('formatHits: empty result → "no results" (text) and [] (json)', () => {
  assert.equal(brain.formatHits([], {}), 'no results');
  assert.equal(brain.formatHits([], { json: true }), '[]');
});

test('query: --json path returns the same structured hits the door surfaced', async () => {
  const hits = [fhit({ id: '7', name: 'widget', type: 'Class', file: 'lib/w.cjs', line: 2 })];
  const transport = fakeTransport({ find: () => ({ hits }) });
  const res = await brain.query('q', { json: true }, { discover: warmDiscover, transport });
  assert.deepEqual(JSON.parse(brain.formatHits(res.hits, { json: true })), hits);
});

// ── AC-3: --limit / --type / --neighbors ────────────────────────────────────────────

test('query: --limit is forwarded to the door', async () => {
  const transport = fakeTransport({ find: () => ({ hits: [] }) });
  await brain.query('q', { limit: 7 }, { discover: warmDiscover, transport });
  assert.equal(transport.calls[0].body.limit, 7, 'the door is asked for the requested limit');
});

test('query: --type prose post-filters to Page/Section (request carries no type array)', async () => {
  const hits = [fhit({ id: '1', type: 'Function' }), fhit({ id: '2', type: 'Page' }), fhit({ id: '3', type: 'Section' })];
  const transport = fakeTransport({ find: () => ({ hits }) });
  const res = await brain.query('q', { type: 'prose' }, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits.map((h) => h.type).sort(), ['Page', 'Section']);
  assert.ok(!('type' in transport.calls[0].body), 'no type sent to the door — prose is a post-filter');
});

test('query: --type code excludes prose (Page/Section)', async () => {
  const hits = [fhit({ id: '1', type: 'Function' }), fhit({ id: '2', type: 'Page' }), fhit({ id: '3', type: 'Method' })];
  const transport = fakeTransport({ find: () => ({ hits }) });
  const res = await brain.query('q', { type: 'code' }, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits.map((h) => h.type).sort(), ['Function', 'Method']);
});

test('query: --type <ExactNodeType> keeps only that node type', async () => {
  const hits = [fhit({ id: '1', type: 'Function' }), fhit({ id: '2', type: 'Class' }), fhit({ id: '3', type: 'Function' })];
  const transport = fakeTransport({ find: () => ({ hits }) });
  const res = await brain.query('q', { type: 'Class' }, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits.map((h) => h.id), ['2']);
});

test('query: --neighbors fetches each hit\'s 1-hop via recon_explain (name+file) and attaches them', async () => {
  const hits = [fhit({ name: 'authFlow', file: 'lib/auth.cjs' })];
  const transport = fakeTransport({
    find: () => ({ hits }),
    explain: () => ({ neighbors: [{ id: '9', name: 'login', type: 'Function', file: 'lib/login.cjs', line: 3, relationship: 'callers' }] }),
  });
  const res = await brain.query('q', { neighbors: true }, { discover: warmDiscover, transport });
  const explainCall = transport.calls.find((c) => c.path === '/api/tools/recon_explain');
  assert.ok(explainCall, 'recon_explain was POSTed');
  assert.equal(explainCall.body.name, 'authFlow', 'explain keyed by the hit name');
  assert.equal(explainCall.body.file, 'lib/auth.cjs', 'file disambiguates the symbol');
  assert.equal(res.hits[0].neighbors.length, 1);
  assert.equal(res.hits[0].neighbors[0].name, 'login');
});

test('query: --neighbors tolerates the relationship-bucket explain shape', async () => {
  const hits = [fhit({ name: 'authFlow', file: 'lib/auth.cjs' })];
  const transport = fakeTransport({
    find: () => ({ hits }),
    explain: () => ({
      callers: [{ name: 'login', type: 'Function', file: 'lib/login.cjs', line: 3 }],
      callees: [{ name: 'hash', type: 'Function', file: 'lib/hash.cjs', line: 8 }],
    }),
  });
  const res = await brain.query('q', { neighbors: true }, { discover: warmDiscover, transport });
  const names = res.hits[0].neighbors.map((n) => n.name).sort();
  assert.deepEqual(names, ['hash', 'login']);
  const rels = res.hits[0].neighbors.map((n) => n.relationship).sort();
  assert.deepEqual(rels, ['callees', 'callers'], 'bucket name becomes the relationship tag');
});

test('query: without --neighbors, recon_explain is never called', async () => {
  const transport = fakeTransport({ find: () => ({ hits: [fhit({})] }) });
  await brain.query('q', {}, { discover: warmDiscover, transport });
  assert.ok(!transport.calls.some((c) => c.path === '/api/tools/recon_explain'), 'no explain without --neighbors');
});

test('query: a failed per-hit explain degrades to empty neighbors, never crashes the query', async () => {
  const hits = [fhit({ name: 'authFlow', file: 'lib/auth.cjs' })];
  const transport = async ({ path: p, body }) => {
    if (p === '/api/tools/recon_find') return { statusCode: 200, body: JSON.stringify({ hits }) };
    return { statusCode: 500, body: 'boom' }; // explain fails
  };
  const res = await brain.query('q', { neighbors: true }, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits[0].neighbors, [], 'a broken explain leaves the hit without neighbors');
});

test('formatHits: --neighbors renders indented 1-hop lines with the relationship tag', () => {
  const h = fhit({ name: 'authFlow', file: 'lib/auth.cjs', line: 10 });
  h.neighbors = [{ name: 'login', type: 'Function', file: 'lib/login.cjs', line: 3, relationship: 'callers' }];
  const out = brain.formatHits([h], { neighbors: true });
  assert.match(out, /authFlow/);
  assert.match(out, /login/);
  assert.match(out, /callers/);
});

// ── AC-4: no warm door ⇒ a clear, actionable error (non-zero exit at the CLI) ────────

test('query: no discoverable endpoint ⇒ a clear, actionable error (and the door is never called)', async () => {
  let called = false;
  const transport = async () => { called = true; return { statusCode: 200, body: '{"hits":[]}' }; };
  await assert.rejects(
    () => brain.query('anything', {}, { discover: () => null, transport }),
    /not warm|recon serve|open a .*session/i
  );
  assert.equal(called, false, 'a cold door short-circuits before any network call');
});

test('query: a dead-pid endpoint file ⇒ not warm ⇒ a clear error (real discoverEndpoint)', async () => {
  const root = tmp('wrxn-brain-deadpid-');
  writeEndpoint(root, { pid: deadPid(), port: 5 });
  await assert.rejects(() => brain.query('q', {}, { root }), /not warm|recon serve/i);
});

// ── AC-5: malformed / non-200 door response ⇒ a clean error, not a crash ─────────────

test('query: a malformed (non-JSON) door body ⇒ a clean error', async () => {
  const transport = async () => ({ statusCode: 200, body: 'not-json{' });
  await assert.rejects(() => brain.query('q', {}, { discover: warmDiscover, transport }), /malformed/i);
});

test('query: a non-200 door response ⇒ a clean error naming the status', async () => {
  const transport = async () => ({ statusCode: 503, body: 'busy' });
  await assert.rejects(() => brain.query('q', {}, { discover: warmDiscover, transport }), /HTTP 503/);
});

test('query: a 200 body lacking a structured hits array ⇒ a clean error', async () => {
  const transport = async () => ({ statusCode: 200, body: JSON.stringify({ result: '## just markdown' }) });
  await assert.rejects(() => brain.query('q', {}, { discover: warmDiscover, transport }), /unexpected response shape|hits/i);
});

test('query: an empty hits array is a valid success (no results), not an error', async () => {
  const transport = fakeTransport({ find: () => ({ result: 'none', hits: [] }) });
  const res = await brain.query('q', {}, { discover: warmDiscover, transport });
  assert.deepEqual(res.hits, []);
});

// ── discoverEndpoint / pidAlive (the cross-repo discovery contract) ──────────────────

test('pidAlive: true for this live process, false for a reaped pid', () => {
  assert.equal(brain.pidAlive(process.pid), true);
  assert.equal(brain.pidAlive(deadPid()), false);
});

test('discoverEndpoint: absent / malformed / missing-field / dead-pid → null; warm → {pid,port,root}', () => {
  const root = tmp('wrxn-brain-disc-');
  assert.equal(brain.discoverEndpoint(root), null, 'absent file → null');
  writeEndpoint(root, 'not json{');
  assert.equal(brain.discoverEndpoint(root), null, 'malformed → null');
  writeEndpoint(root, { port: 5 });
  assert.equal(brain.discoverEndpoint(root), null, 'missing pid → null');
  writeEndpoint(root, { pid: deadPid(), port: 5 });
  assert.equal(brain.discoverEndpoint(root), null, 'dead pid → null');
  writeEndpoint(root, { pid: process.pid, port: 5 });
  assert.deepEqual(brain.discoverEndpoint(root), { pid: process.pid, port: 5, root }, 'warm → {pid,port,root}');
});

test('discoverEndpoint: walks UP from a subdir to the install root that carries the door file', () => {
  const root = tmp('wrxn-brain-walkup-');
  writeEndpoint(root, { pid: process.pid, port: 6 });
  const sub = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(brain.discoverEndpoint(sub), { pid: process.pid, port: 6, root }, 'discovery walks up to the door');
});

// ── CLI black-box (stdin/stdout, real httpTransport + real discovery) ────────────────

test('CLI: `wrxn brain query` with no warm door → clear error on stderr + exit 2', () => {
  const root = tmp('wrxn-brain-cli-nodoor-');
  let err;
  try {
    execFileSync('node', [WRXN, 'brain', 'query', 'anything at all', '--root', root], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'non-zero exit');
  assert.equal(err.status, 2, 'exit code 2');
  assert.match(String(err.stderr), /not warm|recon serve/i, 'a clear, actionable error');
});

test('CLI: an unknown brain subcommand → exit 2', () => {
  let err;
  try {
    execFileSync('node', [WRXN, 'brain', 'frobnicate'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.status === 2);
});

test('CLI: brain query with no query string → exit 2', () => {
  let err;
  try {
    execFileSync('node', [WRXN, 'brain', 'query'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.status === 2);
});

test('CLI: against a real loopback door, prints formatted whole-brain results', async () => {
  const root = tmp('wrxn-brain-cli-live-');
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/tools/recon_find') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        result: '## hits',
        hits: [{ id: '1', name: 'authFlow', type: 'Function', file: 'lib/auth.cjs', line: 10, score: 0.9, sources: ['bm25', 'semantic'], semanticScore: 0.7 }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  writeEndpoint(root, { pid: process.pid, port });
  try {
    const { stdout } = await execFileAsync('node', [WRXN, 'brain', 'query', 'auth flow', '--root', root]);
    assert.match(stdout, /authFlow/);
    assert.match(stdout, /lib\/auth\.cjs:10/);
    // --json against the same live door re-emits the structured hits.
    const { stdout: jsonOut } = await execFileAsync('node', [WRXN, 'brain', 'query', 'auth flow', '--root', root, '--json']);
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed[0].name, 'authFlow');
    assert.equal(parsed[0].semanticScore, 0.7, 'structured per-hit scores survive --json');
  } finally {
    server.close();
  }
});
