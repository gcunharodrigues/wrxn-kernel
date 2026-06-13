'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

const MANIFEST = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
const PROJECT_PATHS = MANIFEST.files.filter((f) => f.profile === 'project').map((f) => f.path);
const WORKSPACE_PATHS = MANIFEST.files.filter((f) => f.profile === 'workspace').map((f) => f.path);

// ── AC-1: every entry carries a profile; loader refuses an unclassifiable one ────

test('every manifest entry carries a project|workspace profile', () => {
  for (const f of MANIFEST.files) {
    assert.ok(['project', 'workspace'].includes(f.profile), `${f.path} → profile ${f.profile}`);
  }
  // the workspace profile is represented (a real superset exists to observe the split)
  assert.ok(WORKSPACE_PATHS.length >= 1, 'at least one workspace-profile file ships');
});

test('loadManifest rejects an entry with a missing or unknown profile', () => {
  const dir = tmp('wrxn-badprofile-');
  const badUnknown = path.join(dir, 'm1.json');
  fs.writeFileSync(badUnknown, JSON.stringify({ version: '1', files: [{ path: 'a.md', class: 'managed', profile: 'galaxy' }] }));
  assert.throws(() => loadManifest(badUnknown), /profile "galaxy"|unclassifiable profile/i);

  const badMissing = path.join(dir, 'm2.json');
  fs.writeFileSync(badMissing, JSON.stringify({ version: '1', files: [{ path: 'a.md', class: 'managed' }] }));
  assert.throws(() => loadManifest(badMissing), /profile/i);
});

// ── AC-2: init lays the right file set per profile; receipt records the profile ──

test('init --project lays only the project subset (no workspace files)', () => {
  const target = tmp('wrxn-prof-proj-');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.equal(report.profile, 'project');
  assert.equal(report.laid.length, PROJECT_PATHS.length);
  for (const rel of WORKSPACE_PATHS) {
    assert.equal(fs.existsSync(path.join(target, rel)), false, `${rel} must NOT be laid for a project install`);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.profile, 'project');
});

test('init --workspace lays project + workspace (the full superset)', () => {
  const target = tmp('wrxn-prof-ws-');
  const report = init({ pkgRoot: PKG_ROOT, target, profile: 'workspace' });
  assert.equal(report.profile, 'workspace');
  assert.equal(report.laid.length, PROJECT_PATHS.length + WORKSPACE_PATHS.length);
  for (const rel of WORKSPACE_PATHS) {
    assert.ok(fs.existsSync(path.join(target, rel)), `${rel} must be laid for a workspace install`);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.profile, 'workspace');
});

// ── AC-3: update respects the install's recorded profile ────────────────────────

test('a project install never gains workspace files on update', () => {
  const target = tmp('wrxn-prof-upd-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  update({ pkgRoot: PKG_ROOT, target }); // same version; the point is the file set, not a bump
  for (const rel of WORKSPACE_PATHS) {
    assert.equal(fs.existsSync(path.join(target, rel)), false, `${rel} must NOT appear on a project-install update`);
  }
});

test('a workspace install keeps its workspace files on update', () => {
  const target = tmp('wrxn-prof-upd-ws-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'workspace' });
  update({ pkgRoot: PKG_ROOT, target });
  for (const rel of WORKSPACE_PATHS) {
    assert.ok(fs.existsSync(path.join(target, rel)), `${rel} must survive a workspace-install update`);
  }
});

// ── AC-5: --workspace is no longer a CLI stub error ─────────────────────────────

test('wrxn init --workspace works via the CLI and lays the workspace superset', () => {
  const bin = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
  const target = tmp('wrxn-prof-cli-');
  const out = execFileSync('node', [bin, 'init', '--workspace', '--root', target], { encoding: 'utf8' });
  assert.match(out, /workspace/);
  for (const rel of WORKSPACE_PATHS) {
    assert.ok(fs.existsSync(path.join(target, rel)), `${rel} laid via CLI workspace install`);
  }
});
