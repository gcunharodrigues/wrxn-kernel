'use strict';

// Tests for wrxn connect + the connections registry (wrxn-kernel-21).
// AC-1: connect registers a valid interface (mcp + cli), each validated by invocation.
// AC-2: a bad/unreachable interface is REJECTED with a useful error.
// AC-3: scopes stored; credential POINTER resolves to state; the secret value is never shipped.
// AC-4: the registry is agent-readable — lookup (list/get), not a briefing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const connect = require('../lib/connect.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
// A deterministic invoker stand-in: declared-reachable names succeed, all else fails.
function fakeInvoke(reachable) {
  return (entry) =>
    reachable.includes(entry.command)
      ? { ok: true, detail: `stub: ${entry.command} reachable` }
      : { ok: false, detail: `stub: ${entry.command} not found` };
}

// ── AC-1: register a valid interface, validated by invocation ───────────────────

test('registers a cli connection when the interface is reachable', () => {
  const root = tmp('wrxn-conn-cli-');
  const res = connect.registerConnection(
    root,
    { name: 'git', transport: 'cli', command: 'git', scopes: ['repo'], owner: 'devops' },
    { invoke: fakeInvoke(['git']) }
  );
  assert.equal(res.entry.name, 'git');
  assert.equal(res.entry.transport, 'cli');
  assert.ok(res.validated.ok, 'interface was validated by invocation');
  assert.deepEqual(connect.findConnection(root, 'git').scopes, ['repo']);
});

test('registers an mcp socket when the launcher is reachable', () => {
  const root = tmp('wrxn-conn-mcp-');
  const res = connect.registerConnection(
    root,
    { name: 'recon', transport: 'mcp', command: 'recon', args: ['serve'], scopes: ['read'] },
    { invoke: fakeInvoke(['recon']) }
  );
  assert.equal(res.entry.transport, 'mcp');
  assert.deepEqual(res.entry.args, ['serve'], 'mcp launch args preserved');
  assert.ok(res.validated.ok);
});

test('default invoker proves a real cli by invocation (node is on PATH)', () => {
  const root = tmp('wrxn-conn-real-');
  // No injected invoker → the real spawn runs. `node --version` must succeed.
  const res = connect.registerConnection(root, { name: 'node', transport: 'cli', command: 'node' });
  assert.ok(res.validated.ok, 'real node binary validated by invocation');
});

// ── AC-2: a bad/unreachable interface is REJECTED with a useful error ───────────

test('rejects an unreachable interface with a useful error, and does NOT register it', () => {
  const root = tmp('wrxn-conn-unreach-');
  assert.throws(
    () => connect.registerConnection(
      root,
      { name: 'ghost', transport: 'cli', command: 'definitely-not-a-real-binary-xyz' },
      { invoke: fakeInvoke([]) }
    ),
    /unreachable/i
  );
  assert.equal(connect.findConnection(root, 'ghost'), null, 'rejected interface is not persisted');
});

test('rejects a schema-invalid entry with a useful error', () => {
  const root = tmp('wrxn-conn-schema-');
  assert.throws(
    () => connect.registerConnection(root, { name: '', transport: 'smoke', command: '' }, { invoke: fakeInvoke([]) }),
    /transport must be one of|name is required|command is required/
  );
});

test('the real default invoker rejects a missing binary (ENOENT → useful detail)', () => {
  const r = connect.defaultInvoke({ transport: 'cli', command: 'definitely-not-a-real-binary-xyz' });
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not run|ENOENT/);
});

// ── AC-3: scopes stored; credential pointer resolves to state, never shipped ────

test('stores the credential POINTER, never the secret value', () => {
  const root = tmp('wrxn-conn-cred-');
  process.env.WRXN_TEST_TOKEN = 'super-secret-value';
  const res = connect.registerConnection(
    root,
    { name: 'api', transport: 'cli', command: 'git', credential: 'env:WRXN_TEST_TOKEN', scopes: ['send'] },
    { invoke: fakeInvoke(['git']) }
  );
  // The pointer is stored; the secret never appears in the registry on disk.
  assert.equal(res.entry.credential, 'env:WRXN_TEST_TOKEN');
  const onDisk = fs.readFileSync(connect.registryPath(root), 'utf8');
  assert.ok(!onDisk.includes('super-secret-value'), 'the secret VALUE is never written to the registry');
  assert.ok(res.credential.resolved, 'pointer resolves to state (env var is set)');
  delete process.env.WRXN_TEST_TOKEN;
});

test('an env credential pointer reports unresolved when the var is absent', () => {
  const root = tmp('wrxn-conn-cred-missing-');
  delete process.env.WRXN_ABSENT_TOKEN;
  const c = connect.resolveCredential('env:WRXN_ABSENT_TOKEN', root);
  assert.equal(c.kind, 'env');
  assert.equal(c.resolved, false);
});

test('a state credential pointer resolves to a file under the install root', () => {
  const root = tmp('wrxn-conn-cred-state-');
  fs.mkdirSync(path.join(root, '.wrxn', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'secrets', 'tok'), 'x');
  const c = connect.resolveCredential('state:.wrxn/secrets/tok', root);
  assert.equal(c.kind, 'state');
  assert.equal(c.resolved, true);
});

// ── AC-4: registry is agent-readable — lookup, not a briefing ───────────────────

test('listConnections returns all registered connections for agent lookup', () => {
  const root = tmp('wrxn-conn-list-');
  connect.registerConnection(root, { name: 'git', transport: 'cli', command: 'git' }, { invoke: fakeInvoke(['git', 'recon']) });
  connect.registerConnection(root, { name: 'recon', transport: 'mcp', command: 'recon' }, { invoke: fakeInvoke(['git', 'recon']) });
  const names = connect.listConnections(root).map((c) => c.name).sort();
  assert.deepEqual(names, ['git', 'recon']);
});

test('re-registering the same name upserts (no duplicate rows)', () => {
  const root = tmp('wrxn-conn-upsert-');
  connect.registerConnection(root, { name: 'git', transport: 'cli', command: 'git', scopes: ['a'] }, { invoke: fakeInvoke(['git']) });
  connect.registerConnection(root, { name: 'git', transport: 'cli', command: 'git', scopes: ['b'] }, { invoke: fakeInvoke(['git']) });
  const all = connect.listConnections(root);
  assert.equal(all.length, 1, 'upsert by name');
  assert.deepEqual(all[0].scopes, ['b'], 'latest registration wins');
});

// ── Finding fixes (21-findings: f1 mcp crash, f2 path escape, f3 corrupt registry) ──

test('f1: default invoker rejects an mcp launcher that crashes on launch (nonzero exit)', () => {
  const r = connect.defaultInvoke({ transport: 'mcp', command: 'node', args: ['-e', 'process.exit(1)'] });
  assert.equal(r.ok, false);
  assert.match(r.detail, /crashed on launch/);
});

test('f1: an mcp launcher that exits clean (0) within the probe is still reachable', () => {
  const r = connect.defaultInvoke({ transport: 'mcp', command: 'node', args: ['-e', ';'] });
  assert.equal(r.ok, true);
});

test('f2: a state credential pointer that escapes root via ../ never resolves', () => {
  const root = tmp('wrxn-conn-escape-');
  const c = connect.resolveCredential('state:../../../etc/passwd', root);
  assert.equal(c.kind, 'state');
  assert.equal(c.resolved, false);
  assert.equal(c.escaped, true);
});

test('f3: a present-but-corrupt registry throws instead of silently emptying', () => {
  const root = tmp('wrxn-conn-corrupt-');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(connect.registryPath(root), '{ this is not json');
  assert.throws(() => connect.listConnections(root), /corrupt/);
  // and register refuses to clobber it:
  assert.throws(
    () => connect.registerConnection(root, { name: 'x', transport: 'cli', command: 'git' }, { invoke: () => ({ ok: true, detail: 'stub' }) }),
    /corrupt/
  );
});

// ── CLI surface (CLI-First) ─────────────────────────────────────────────────────

test('CLI: wrxn connect add registers a real cli tool, list + get read it back', () => {
  const root = tmp('wrxn-conn-cli-e2e-');
  execFileSync('node', [WRXN, 'connect', 'add', 'node', '--transport', 'cli', '--command', 'node', '--scopes', 'exec', '--root', root], { encoding: 'utf8' });
  const list = execFileSync('node', [WRXN, 'connect', 'list', '--root', root], { encoding: 'utf8' });
  assert.match(list, /"name": "node"/);
  const got = JSON.parse(execFileSync('node', [WRXN, 'connect', 'get', 'node', '--root', root], { encoding: 'utf8' }));
  assert.equal(got.transport, 'cli');
  assert.deepEqual(got.scopes, ['exec']);
});

test('CLI: wrxn connect add --args registers an mcp socket launcher with its args', () => {
  const root = tmp('wrxn-conn-cli-mcp-args-');
  // `node -e ;` spawns, holds nothing, exits 0 — a reachable, argless-safe socket stand-in.
  execFileSync('node', [WRXN, 'connect', 'add', 'echo-mcp', '--transport', 'mcp', '--command', 'node', '--args', '-e,;', '--root', root], { encoding: 'utf8' });
  const got = JSON.parse(execFileSync('node', [WRXN, 'connect', 'get', 'echo-mcp', '--root', root], { encoding: 'utf8' }));
  assert.equal(got.transport, 'mcp');
  assert.deepEqual(got.args, ['-e', ';'], 'mcp launch args registered via the CLI');
});

test('CLI: wrxn connect add rejects an unreachable interface with exit 2', () => {
  const root = tmp('wrxn-conn-cli-reject-');
  assert.throws(
    () => execFileSync('node', [WRXN, 'connect', 'add', 'ghost', '--transport', 'cli', '--command', 'definitely-not-a-real-binary-xyz', '--root', root], { encoding: 'utf8', stdio: 'pipe' }),
    /unreachable/i
  );
});
