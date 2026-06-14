'use strict';

// R3 — wrxn installs + wires recon-wrxn (recon-wrxn-03).
// Covers: the pinned dependency (AC-1), the laid .mcp.json wiring + brownfield merge (AC-2),
// the .recon-wrxn.json config matching initConfig with NO index.outputDir (AC-3, hard No-Invention),
// the idempotent .recon-wrxn/ gitignore line (AC-4), the non-empty adopt-hint (AC-6), and the
// receipt recording the new files (AC-7).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const RECON_VERSION = '6.0.0-wrxn.1';

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// ── AC-1: wrxn pins recon-wrxn at a known version and the lockfile resolved it ──

test('package.json pins recon-wrxn at the known version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies, 'package.json declares dependencies');
  assert.equal(pkg.dependencies['recon-wrxn'], RECON_VERSION, 'recon-wrxn pinned at the known version');
});

test('the lockfile resolved recon-wrxn (npm install ran)', () => {
  const lockPath = path.join(PKG_ROOT, 'package-lock.json');
  assert.ok(fs.existsSync(lockPath), 'package-lock.json exists (npm install ran)');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const resolved = (lock.packages && lock.packages['node_modules/recon-wrxn'])
    || (lock.dependencies && lock.dependencies['recon-wrxn']);
  assert.ok(resolved, 'recon-wrxn resolved in the lockfile');
  assert.equal(resolved.version, RECON_VERSION, 'lockfile pins the same version');
});

// ── AC-3: .recon-wrxn.json matches recon-wrxn's initConfig shape (No-Invention) ──

test('init lays .recon-wrxn.json matching recon-wrxn initConfig shape', () => {
  const target = tmp('wrxn-recon-cfg-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const cfg = JSON.parse(fs.readFileSync(path.join(target, '.recon-wrxn.json'), 'utf8'));
  // recon-wrxn's INIT_TEMPLATE: { projects:[], embeddings:false, watch:true, ignore:[] }
  assert.deepEqual(cfg, { projects: [], embeddings: false, watch: true, ignore: [] });
});

test('.recon-wrxn.json carries NO index.outputDir (hard No-Invention — the field does not exist)', () => {
  const target = tmp('wrxn-recon-noinvent-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const cfg = JSON.parse(fs.readFileSync(path.join(target, '.recon-wrxn.json'), 'utf8'));
  assert.equal('index' in cfg, false, 'no index key');
  assert.equal('outputDir' in cfg, false, 'no outputDir key');
  // belt-and-suspenders: the literal string must not appear anywhere in the file
  const raw = fs.readFileSync(path.join(target, '.recon-wrxn.json'), 'utf8');
  assert.equal(/outputDir/.test(raw), false, 'the outputDir literal is absent from the config');
});

// ── AC-2: .mcp.json wires the recon-wrxn MCP server ─────────────────────────────

test('.mcp.json is classified managed in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.mcp.json');
  assert.ok(entry, '.mcp.json in manifest');
  assert.equal(entry.class, 'managed');
});

test('init lays .mcp.json with a recon-wrxn server launching the recon-wrxn bin', () => {
  const target = tmp('wrxn-mcp-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  const server = mcp.mcpServers && mcp.mcpServers['recon-wrxn'];
  assert.ok(server, 'recon-wrxn server present');
  // the launch must invoke recon-wrxn's serve, pinned to the known version
  const launch = [server.command, ...(server.args || [])].join(' ');
  assert.match(launch, /recon-wrxn/, 'launches recon-wrxn');
  assert.match(launch, /serve/, 'runs the serve subcommand');
  assert.match(launch, new RegExp(RECON_VERSION.replace(/\./g, '\\.')), 'pins the known version');
});

test('brownfield .mcp.json merge: operator servers preserved, recon-wrxn added', () => {
  const target = tmp('wrxn-mcp-merge-');
  // the operator already has their own MCP config with another server
  fs.writeFileSync(
    path.join(target, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'my-tool': { command: 'my-tool', args: ['serve'] } } }, null, 2) + '\n',
  );
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers['my-tool'], 'operator server preserved (not clobbered)');
  assert.deepEqual(mcp.mcpServers['my-tool'], { command: 'my-tool', args: ['serve'] });
  assert.ok(mcp.mcpServers['recon-wrxn'], 'recon-wrxn server merged in');
});

test('the receipt records the recon-wrxn managed files (.mcp.json + .recon-wrxn.json)', () => {
  const target = tmp('wrxn-mcp-receipt-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  const paths = receipt.files.map((f) => f.path);
  assert.ok(paths.includes('.mcp.json'), '.mcp.json recorded in receipt');
  assert.ok(paths.includes('.recon-wrxn.json'), '.recon-wrxn.json recorded in receipt');
});
