'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MANIFEST = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
const PAYLOAD_PATHS = MANIFEST.files.map((f) => f.path);
// A default (project) install lays only the project-profile subset (the profile split lives in
// profile.test.cjs); these assertions therefore measure against the project subset.
const PROJECT_PATHS = MANIFEST.files.filter((f) => f.profile === 'project').map((f) => f.path);

// ── Manifest contract ───────────────────────────────────────────────────────

test('manifest classifies every payload file into a valid class', () => {
  for (const entry of MANIFEST.files) {
    assert.ok(['managed', 'seeded', 'state'].includes(entry.class), `${entry.path} → ${entry.class}`);
  }
  // all three classes are represented, so init exercises each path
  const classes = new Set(MANIFEST.files.map((f) => f.class));
  assert.deepEqual([...classes].sort(), ['managed', 'seeded', 'state']);
});

test('every manifest file exists in the package payload', () => {
  for (const rel of PAYLOAD_PATHS) {
    assert.ok(fs.existsSync(path.join(PKG_ROOT, 'payload', rel)), `payload/${rel} missing`);
  }
});

test('loadManifest rejects an unclassifiable class', () => {
  const dir = tmp('wrxn-badmanifest-');
  const bad = path.join(dir, 'manifest.json');
  fs.writeFileSync(bad, JSON.stringify({ version: '1', files: [{ path: 'a.md', class: 'mystery' }] }));
  assert.throws(() => loadManifest(bad), /unclassifiable class "mystery"/);
});

test('loadManifest rejects an absolute or escaping path', () => {
  const dir = tmp('wrxn-badpath-');
  const bad = path.join(dir, 'manifest.json');
  fs.writeFileSync(bad, JSON.stringify({ version: '1', files: [{ path: '../escape.md', class: 'managed', profile: 'project' }] }));
  assert.throws(() => loadManifest(bad), /repo-relative/);
});

// ── init engine: lay + classify ──────────────────────────────────────────────

test('init lays the full payload and classifies each laid file', () => {
  const target = tmp('wrxn-init-');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  assert.equal(report.profile, 'project');
  assert.equal(report.laid.length, PROJECT_PATHS.length);
  assert.equal(report.skipped.length, 0);

  for (const rel of PROJECT_PATHS) {
    assert.ok(fs.existsSync(path.join(target, rel)), `${rel} not laid`);
  }
  // every laid file carries its class
  for (const f of report.laid) {
    assert.ok(['managed', 'seeded', 'state'].includes(f.class), `${f.path} unclassified in report`);
  }
  // receipt records the install at the package release version
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.kernelVersion, pkgVersion);
  assert.equal(receipt.profile, 'project');
  assert.equal(receipt.files.length, PROJECT_PATHS.length);
});

// ── secret hygiene: the gemini-fallback key lives in a gitignored .env ──────────
// The memory-synth fallback reads GEMINI_API_KEY from `<install>/.env` and documents it as the
// install's "gitignored .env". init must make that true so an operator who commits cannot leak the
// key (idempotent, alongside .recon-wrxn/ and .wrxn/reinforce.json).

test('init gitignores .env so the gemini-fallback key is never committed', () => {
  const target = tmp('wrxn-env-gi-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /^\.env$/m, '.env is gitignored after init');

  // idempotent: a second init does not duplicate the line
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const lines = fs.readFileSync(path.join(target, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === '.env');
  assert.equal(lines.length, 1, '.env appears exactly once');
});

// ── synth-handoff-fix-01 AC5: the synth outcome log is install state — gitignored, never shipped ──
// memory-synth.cjs appends one outcome line per synth run to `.wrxn/continuity/.synth.log`. That is
// install runtime state: init must gitignore it so it is never committed, and it must NOT be a payload
// manifest entry (it is generated at runtime, not shipped).

test('init gitignores the synth log so it is never committed', () => {
  const target = tmp('wrxn-synthlog-gi-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /^\.wrxn\/continuity\/\.synth\.log$/m, 'the synth log path is gitignored after init');

  // idempotent: a second init does not duplicate the line
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const lines = fs.readFileSync(path.join(target, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === '.wrxn/continuity/.synth.log');
  assert.equal(lines.length, 1, 'the synth-log ignore line appears exactly once');
});

test('the synth log is NOT a payload manifest entry (install state, never shipped)', () => {
  assert.ok(!PAYLOAD_PATHS.includes('.wrxn/continuity/.synth.log'), 'the synth log must never be a shipped payload file');
});

// ── idempotency ───────────────────────────────────────────────────────────────

test('re-running init is a no-op (idempotent)', () => {
  const target = tmp('wrxn-idem-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const second = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  assert.equal(second.laid.length, 0, 'second run laid nothing');
  assert.equal(second.skipped.length, PROJECT_PATHS.length, 'second run skipped everything');
});

test('init never overwrites an existing seeded file', () => {
  const target = tmp('wrxn-seeded-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  const seeded = MANIFEST.files.find((f) => f.class === 'seeded');
  const seededPath = path.join(target, seeded.path);
  fs.writeFileSync(seededPath, 'OPERATOR EDIT — must survive\n');

  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.equal(fs.readFileSync(seededPath, 'utf8'), 'OPERATOR EDIT — must survive\n');
});

// ── footgun guard: an explicit but empty --root must not fall through to cwd ──

test('init rejects an empty --root instead of silently using cwd', () => {
  const bin = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
  const cwd = tmp('wrxn-emptyroot-');
  let threw = false;
  try {
    // empty-string --root (the $T-expanded-to-empty footgun) must error, lay nothing
    execFileSync('node', [bin, 'init', '--project', '--root', ''], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 2, 'exit code 2 on empty --root');
    assert.match(String(err.stderr), /--root/);
  }
  assert.ok(threw, 'init with empty --root must exit non-zero');
  // and it must not have laid the payload into cwd
  assert.equal(fs.existsSync(path.join(cwd, '.claude', 'constitution.md')), false, 'nothing laid into cwd');
});

// ── packed-tarball proof (the AC1 path) ───────────────────────────────────────

test('npx <pkg> --version answers from a packed tarball install', () => {
  const work = tmp('wrxn-pack-');
  // pack the real package into the temp work dir
  const tgzName = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  }).trim().split('\n').pop();
  const tgz = path.join(work, tgzName);
  assert.ok(fs.existsSync(tgz), 'tarball produced');

  // install the tarball into a throwaway project. wrxn now pins recon-wrxn (a real dependency with
  // heavy native modules), so this resolves it over the registry — but --ignore-scripts skips the
  // native compile (this e2e only proves wrxn's bin + payload laydown, not recon-wrxn at runtime).
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }));
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', tgz], { cwd: proj });

  const pkgName = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).name;
  const installedBin = path.join(proj, 'node_modules', ...pkgName.split('/'), 'bin', 'wrxn.cjs');
  assert.ok(fs.existsSync(installedBin), 'bin shipped in the tarball');

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  const out = execFileSync('node', [installedBin, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(out, pkgVersion);

  // and init from the installed copy lays the payload e2e
  const installTarget = path.join(work, 'target');
  fs.mkdirSync(installTarget);
  execFileSync('node', [installedBin, 'init', '--project', '--root', installTarget], { encoding: 'utf8' });
  for (const rel of PROJECT_PATHS) {
    assert.ok(fs.existsSync(path.join(installTarget, rel)), `${rel} not laid from tarball install`);
  }

  // recon-wrxn wiring laid e2e (R3): the MCP config, the config file, and the gitignore entry
  const mcp = JSON.parse(fs.readFileSync(path.join(installTarget, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers['recon-wrxn'], '.mcp.json wires the recon-wrxn server');
  assert.ok(fs.existsSync(path.join(installTarget, '.recon-wrxn.json')), '.recon-wrxn.json laid');
  assert.match(fs.readFileSync(path.join(installTarget, '.gitignore'), 'utf8'), /^\.recon-wrxn\/$/m, '.recon-wrxn/ gitignored');
  // the receipt records the new managed files
  const receipt = JSON.parse(fs.readFileSync(path.join(installTarget, RECEIPT), 'utf8'));
  const recorded = receipt.files.map((f) => f.path);
  assert.ok(recorded.includes('.mcp.json') && recorded.includes('.recon-wrxn.json'), 'receipt records recon-wrxn files');
});
