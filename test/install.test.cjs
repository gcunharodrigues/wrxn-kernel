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
  fs.writeFileSync(bad, JSON.stringify({ version: '1', files: [{ path: '../escape.md', class: 'managed' }] }));
  assert.throws(() => loadManifest(bad), /repo-relative/);
});

// ── init engine: lay + classify ──────────────────────────────────────────────

test('init lays the full payload and classifies each laid file', () => {
  const target = tmp('wrxn-init-');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  assert.equal(report.profile, 'project');
  assert.equal(report.laid.length, PAYLOAD_PATHS.length);
  assert.equal(report.skipped.length, 0);

  for (const rel of PAYLOAD_PATHS) {
    assert.ok(fs.existsSync(path.join(target, rel)), `${rel} not laid`);
  }
  // every laid file carries its class
  for (const f of report.laid) {
    assert.ok(['managed', 'seeded', 'state'].includes(f.class), `${f.path} unclassified in report`);
  }
  // receipt records the install
  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.kernelVersion, MANIFEST.version);
  assert.equal(receipt.profile, 'project');
  assert.equal(receipt.files.length, PAYLOAD_PATHS.length);
});

// ── idempotency ───────────────────────────────────────────────────────────────

test('re-running init is a no-op (idempotent)', () => {
  const target = tmp('wrxn-idem-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const second = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });

  assert.equal(second.laid.length, 0, 'second run laid nothing');
  assert.equal(second.skipped.length, PAYLOAD_PATHS.length, 'second run skipped everything');
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

  // install the tarball into a throwaway project (zero deps → offline-safe)
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }));
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', tgz], { cwd: proj });

  const installedBin = path.join(proj, 'node_modules', 'wrxn', 'bin', 'wrxn.cjs');
  assert.ok(fs.existsSync(installedBin), 'bin shipped in the tarball');

  const pkgVersion = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
  const out = execFileSync('node', [installedBin, '--version'], { encoding: 'utf8' }).trim();
  assert.equal(out, pkgVersion);

  // and init from the installed copy lays the payload e2e
  const installTarget = path.join(work, 'target');
  fs.mkdirSync(installTarget);
  execFileSync('node', [installedBin, 'init', '--project', '--root', installTarget], { encoding: 'utf8' });
  for (const rel of PAYLOAD_PATHS) {
    assert.ok(fs.existsSync(path.join(installTarget, rel)), `${rel} not laid from tarball install`);
  }
});
