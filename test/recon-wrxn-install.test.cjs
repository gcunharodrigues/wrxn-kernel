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

const RECON_VERSION = '6.0.0-wrxn.2';

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

// ── AC-4: .recon-wrxn/ is gitignored (create or append, idempotent) ─────────────

test('init creates .gitignore with the .recon-wrxn/ index dir ignored', () => {
  const target = tmp('wrxn-gi-create-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /^\.recon-wrxn\/$/m, '.recon-wrxn/ line present');
});

test('init appends to an existing .gitignore without losing operator lines', () => {
  const target = tmp('wrxn-gi-append-');
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\ndist/\n');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /node_modules\//, 'operator lines preserved');
  assert.match(gi, /dist\//, 'operator lines preserved');
  assert.match(gi, /^\.recon-wrxn\/$/m, '.recon-wrxn/ appended');
});

test('the .recon-wrxn/ gitignore line is idempotent across re-init (no duplicate)', () => {
  const target = tmp('wrxn-gi-idem-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  const count = gi.split('\n').filter((l) => l.trim() === '.recon-wrxn/').length;
  assert.equal(count, 1, 'exactly one .recon-wrxn/ line after re-init');
});

// ── AC-5: NO synchronous index at init (serve auto-indexes lazily) ──────────────

test('init does NOT build the .recon-wrxn/ index (lazy: serve indexes on first use)', () => {
  const target = tmp('wrxn-noindex-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.equal(fs.existsSync(path.join(target, '.recon-wrxn')), false, 'no index dir created at init');
});

// ── AC-6: a non-empty repo gets an adopt-hint; an empty repo does not ───────────

test('init on a non-empty repo returns an adopt-hint to prime the index', () => {
  const target = tmp('wrxn-hint-nonempty-');
  fs.mkdirSync(path.join(target, 'src'));
  fs.writeFileSync(path.join(target, 'src', 'app.js'), 'console.log(1);\n');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(report.adoptHint, 'adopt-hint present on a non-empty repo');
  assert.match(report.adoptHint, /recon-wrxn index/, 'hint tells the user to run recon-wrxn index');
});

test('init on an empty repo returns no adopt-hint', () => {
  const target = tmp('wrxn-hint-empty-');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(!report.adoptHint, 'no adopt-hint on an empty repo');
});

test('the CLI prints the adopt-hint on a non-empty repo', () => {
  const { execFileSync } = require('child_process');
  const target = tmp('wrxn-hint-cli-');
  fs.mkdirSync(path.join(target, 'src'));
  fs.writeFileSync(path.join(target, 'src', 'app.js'), 'console.log(1);\n');
  const bin = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
  const out = execFileSync('node', [bin, 'init', '--project', '--root', target], { encoding: 'utf8' });
  assert.match(out, /recon-wrxn index/, 'CLI surfaces the adopt-hint');
});

// ── AC-9: code-intel-push hook points at recon-wrxn (mcp__recon-wrxn__*) ────────

test('code-intel-push nudge references recon-wrxn and the mcp__recon-wrxn__* namespace', () => {
  const { execFileSync } = require('child_process');
  const target = tmp('wrxn-intel-ns-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const hook = path.join(target, '.claude', 'hooks', 'code-intel-push.cjs');
  const event = { session_id: 's1', tool_input: { file_path: path.join(target, 'lib', 'thing.js') } };
  const out = execFileSync('node', [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  const env = out.trim() ? JSON.parse(out) : {};
  const c = env.hookSpecificOutput && env.hookSpecificOutput.additionalContext;
  assert.ok(c, 'a code-intel nudge is injected on first touch');
  assert.match(c, /recon-wrxn/, 'nudge names recon-wrxn');
  assert.match(c, /mcp__recon-wrxn__/, 'nudge references the recon-wrxn MCP namespace');
  assert.equal(/mcp__recon__[^w]/.test(c), false, 'no stale mcp__recon__ (non-wrxn) namespace');
});
