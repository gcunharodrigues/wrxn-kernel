'use strict';

// Tests for the `wrxn sync` REPORT adapter (sync-04). The adapter discovers recon-wrxn's warm serve
// door, POSTs `recon_drift` (the pure indexed-graph stale set from sync-03), and REPORTS which docs are
// stale + the source symbol that moved. Report only — no writes/regen/re-stamp (those are sync-05/06).
//
// Seams mirror recall-surface.cjs: summarizeDrift is a PURE fn over the parsed door response (no IO);
// driftFromDoor is the IO shell with an INJECTED transport (tests never touch the network); the CLI is
// exercised black-box (stdin/argv -> stdout). Door discovery is the recall-surface contract.
//
// Status contract:
//   warm door + a stale set        -> 'drift'        (AC2 — reports the stale files + moved symbol)
//   warm door + an empty stale set -> 'synced'       (AC3 — "all synced", never manufactures output)
//   cold/dead door, throw, non-200, malformed body -> 'unavailable' (AC5 — fail-soft, never throws)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const SYNC_REL = '.wrxn/sync.cjs';
const SYNC = path.join(PKG_ROOT, 'payload', SYNC_REL);
const sync = require('../payload/.wrxn/sync.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A temp install root carrying the wrxn.install.json the adapter's root resolution walks up to find.
function installRoot(prefix) {
  const root = tmp(prefix);
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify({ version: '0.0.0' }));
  return root;
}

// A full fresh install (for the manifest/laydown + black-box CLI assertions).
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Write the recon-wrxn serve-door discovery file, chmod 0600 (the adapter refuses a loose/planted file).
function writeEndpoint(root, body) {
  const dir = path.join(root, '.recon-wrxn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'serve-endpoint.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  fs.chmodSync(file, 0o600);
  return file;
}

// A guaranteed-dead pid (spawnSync reaps it before returning).
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// A recon_drift door body: a stale set + an optional unwatermarked bucket (sync-03 AC4/AC5 shape).
function driftBody(over) {
  return JSON.stringify(Object.assign({ stale: [], unwatermarked: [] }, over || {}));
}

const STALE = {
  doc: '.wrxn/wiki/concepts/auth-flow.md',
  symbol: 'src/auth.ts#login',
  synced_to: 'a1b2c3d4',
  current: 'e5f6a7b8',
};

function runCli(target, args) {
  return execFileSync('node', [path.join(target, SYNC_REL), ...args, '--root', target], { encoding: 'utf8' });
}

// ── summarizeDrift — the PURE report fn ───────────────────────────────────────

test('summarizeDrift: a stale entry → status "drift", naming the doc + moved symbol + synced_to vs current (AC2)', () => {
  const out = sync.summarizeDrift({ stale: [STALE], unwatermarked: [] });
  assert.equal(out.status, 'drift');
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].doc, '.wrxn/wiki/concepts/auth-flow.md', 'the stale doc page');
  assert.equal(out.stale[0].symbol, 'src/auth.ts#login', 'the source symbol that moved');
  assert.equal(out.stale[0].synced_to, 'a1b2c3d4', 'the watermark it was last reconciled at');
  assert.equal(out.stale[0].current, 'e5f6a7b8', 'the current source fingerprint');
});

test('summarizeDrift: an empty stale set → status "synced", no manufactured rows (AC3)', () => {
  const out = sync.summarizeDrift({ stale: [], unwatermarked: [] });
  assert.equal(out.status, 'synced');
  assert.deepEqual(out.stale, [], 'no stale rows invented');
});

test('summarizeDrift: a malformed / non-object response does not throw and reports synced (robustness)', () => {
  assert.equal(sync.summarizeDrift(null).status, 'synced');
  assert.equal(sync.summarizeDrift(undefined).status, 'synced');
  assert.equal(sync.summarizeDrift({}).status, 'synced');
  assert.equal(sync.summarizeDrift({ stale: 'not-an-array' }).status, 'synced');
});

test('summarizeDrift: passes the unwatermarked bucket through (sync-03 AC5 — distinct, not dropped)', () => {
  const uw = { doc: '.wrxn/wiki/concepts/db.md', symbol: 'src/db.ts#connect' };
  const out = sync.summarizeDrift({ stale: [], unwatermarked: [uw] });
  assert.deepEqual(out.unwatermarked, [uw], 'the unwatermarked bucket survives');
});

// ── driftFromDoor — the IO shell, with an injected transport ──────────────────

test('driftFromDoor: a warm door returning a stale set → "drift"; pins the recon_drift POST contract (AC2)', async () => {
  const root = installRoot('wrxn-sync-warm-');
  writeEndpoint(root, { pid: process.pid, port: 64101 });
  let seen;
  const transport = async (args) => {
    seen = args;
    return { statusCode: 200, body: driftBody({ stale: [STALE] }) };
  };
  const out = await sync.driftFromDoor(root, { transport });
  assert.equal(out.status, 'drift');
  assert.equal(out.stale[0].symbol, 'src/auth.ts#login');
  // cross-repo contract pins (sync-03 AC6): the recon_drift door path + the endpoint port.
  assert.equal(seen.path, '/api/tools/recon_drift', 'POSTs the recon_drift serve door');
  assert.equal(seen.port, 64101, 'uses the port from serve-endpoint.json');
});

test('driftFromDoor: a warm door returning an empty stale set → "synced" (AC3)', async () => {
  const root = installRoot('wrxn-sync-clean-');
  writeEndpoint(root, { pid: process.pid, port: 64102 });
  const transport = async () => ({ statusCode: 200, body: driftBody({ stale: [] }) });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'synced');
});

test('driftFromDoor: no warm door (cold) → "unavailable", transport NEVER called (AC5)', async () => {
  const root = installRoot('wrxn-sync-cold-');
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: driftBody() }; };
  const out = await sync.driftFromDoor(root, { transport: spy });
  assert.equal(out.status, 'unavailable');
  assert.equal(called, false, 'a cold door short-circuits before any network call');
});

test('driftFromDoor: a dead-pid endpoint → "unavailable", transport NEVER called (AC5)', async () => {
  const root = installRoot('wrxn-sync-deadpid-');
  writeEndpoint(root, { pid: deadPid(), port: 64103 });
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: driftBody() }; };
  const out = await sync.driftFromDoor(root, { transport: spy });
  assert.equal(out.status, 'unavailable', 'a dead pid means recon serve is not running');
  assert.equal(called, false);
});

test('driftFromDoor: a transport throw (timeout / connection refused) → "unavailable", never throws (AC5)', async () => {
  const root = installRoot('wrxn-sync-throw-');
  writeEndpoint(root, { pid: process.pid, port: 64104 });
  const transport = async () => { throw new Error('drift door timeout'); };
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

test('driftFromDoor: a non-200 response → "unavailable" (AC5)', async () => {
  const root = installRoot('wrxn-sync-503-');
  writeEndpoint(root, { pid: process.pid, port: 64105 });
  const transport = async () => ({ statusCode: 503, body: 'busy' });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

test('driftFromDoor: a malformed JSON body → "unavailable" (AC5)', async () => {
  const root = installRoot('wrxn-sync-badbody-');
  writeEndpoint(root, { pid: process.pid, port: 64106 });
  const transport = async () => ({ statusCode: 200, body: 'not-json{' });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

// ── black-box CLI (the `report` subcommand) ───────────────────────────────────

test('black-box: `report` on an install with no warm door exits 0 with status "unavailable" (AC5 fail-soft)', () => {
  const t = freshInstall('wrxn-sync-bb-cold-');
  const out = JSON.parse(runCli(t, ['report']));
  assert.equal(out.status, 'unavailable', 'no recon serve → drift unavailable, never a crash');
});

// ── self-contained: node stdlib only (no kernel-lib / recon import) — AC5 ──────

test('the sync adapter imports nothing outside the node standard library (AC5 install-portable)', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the adapter has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── manifest / laydown (AC1 + AC4) ────────────────────────────────────────────

test('the sync adapter is classified managed/project in the manifest and laid into a fresh install (AC4)', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === SYNC_REL);
  assert.ok(entry, 'sync.cjs in manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-sync-laid-');
  assert.ok(fs.existsSync(path.join(t, SYNC_REL)), 'sync.cjs laid into the install');
});

test('the sync SKILL.md is managed/project, laid, and user-invocable (AC1)', () => {
  const SKILL_REL = '.claude/skills/sync/SKILL.md';
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === SKILL_REL);
  assert.ok(entry, 'sync SKILL.md in manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-sync-skill-');
  const skillMd = path.join(t, SKILL_REL);
  assert.ok(fs.existsSync(skillMd), 'sync/SKILL.md laid into the install');
  const body = fs.readFileSync(skillMd, 'utf8');
  assert.match(body, /^---/, 'opens with YAML frontmatter');
  assert.match(body, /name:\s*sync/, 'frontmatter names the skill');
  assert.match(body, /user-invocable:\s*true/, 'the skill is user-invocable');
});
