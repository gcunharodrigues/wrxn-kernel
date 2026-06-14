'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const ADAPTER = '.wrxn/wiki.cjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Lay a fresh install and return its root + the adapter's absolute path.
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return { target, adapter: path.join(target, ADAPTER) };
}

// Run the adapter as the real install would (separate process), rooted at the install.
function runAdapter(target, args) {
  return execFileSync('node', [path.join(target, ADAPTER), ...args, '--root', target], {
    encoding: 'utf8',
  });
}

// ── AC-1: write-page then query/recall find it; empty tiers don't crash ───────

test('write-page creates a markdown file in the right tier', () => {
  const { target } = freshInstall('wrxn-wiki-write-');
  const out = JSON.parse(runAdapter(target, ['write-page', 'concepts', 'memory-tiers', '--body', 'the wiki has four tiers']));
  assert.equal(out.tier, 'concepts');
  const page = path.join(target, '.wrxn', 'wiki', 'concepts', 'memory-tiers.md');
  assert.ok(fs.existsSync(page), 'page laid in concepts tier');
  assert.match(fs.readFileSync(page, 'utf8'), /the wiki has four tiers/);
});

test('query finds a written page', () => {
  const { target } = freshInstall('wrxn-wiki-query-');
  runAdapter(target, ['write-page', 'gotchas', 'lock-bug', '--body', 'stale brain lock blocks the gate']);
  const res = JSON.parse(runAdapter(target, ['query', 'stale brain lock']));
  assert.ok(res.total >= 1, 'query found the page');
  assert.equal(res.hits[0].tier, 'gotchas');
  assert.match(res.hits[0].file, /gotchas\/lock-bug\.md$/);
});

test('recall is an alias of query and finds the written page', () => {
  const { target } = freshInstall('wrxn-wiki-recall-');
  runAdapter(target, ['write-page', 'decisions', 'use-trunk', '--body', 'we chose trunk-with-gates']);
  const res = JSON.parse(runAdapter(target, ['recall', 'trunk-with-gates']));
  assert.ok(res.total >= 1, 'recall found the page');
  assert.equal(res.hits[0].tier, 'decisions');
});

test('query over an empty wiki returns cleanly (no crash, zero hits)', () => {
  const { target } = freshInstall('wrxn-wiki-empty-');
  const res = JSON.parse(runAdapter(target, ['query', 'anything at all']));
  assert.equal(res.total, 0);
  assert.deepEqual(res.hits, []);
});

test('recall over an empty wiki returns cleanly (no crash, zero hits)', () => {
  const { target } = freshInstall('wrxn-wiki-empty-recall-');
  const res = JSON.parse(runAdapter(target, ['recall', 'anything at all']));
  assert.equal(res.total, 0);
  assert.deepEqual(res.hits, []);
});

test('write-page refuses to overwrite an existing page', () => {
  const { target } = freshInstall('wrxn-wiki-overwrite-');
  runAdapter(target, ['write-page', 'concepts', 'dup', '--body', 'first']);
  assert.throws(
    () => runAdapter(target, ['write-page', 'concepts', 'dup', '--body', 'second']),
    /refusing to overwrite/
  );
});

test('write-page rejects an unknown tier', () => {
  const { target } = freshInstall('wrxn-wiki-badtier-');
  assert.throws(() => runAdapter(target, ['write-page', 'nope', 'x', '--body', 'y']), /unknown tier/);
});

// ── AC-3: the wiki tiers are classified `state` ───────────────────────────────

test('every wiki tier .gitkeep is classified state in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const tiers = ['concepts', 'decisions', 'gotchas', 'sessions'];
  for (const t of tiers) {
    const entry = manifest.files.find((f) => f.path === `.wrxn/wiki/${t}/.gitkeep`);
    assert.ok(entry, `.wrxn/wiki/${t}/.gitkeep missing from manifest`);
    assert.equal(entry.class, 'state', `${t} tier must be state`);
  }
});

test('the laid receipt classifies the wiki tiers as state', () => {
  const { target } = freshInstall('wrxn-wiki-receipt-');
  const receipt = JSON.parse(fs.readFileSync(path.join(target, 'wrxn.install.json'), 'utf8'));
  const gitkeep = receipt.files.find((f) => f.path === '.wrxn/wiki/concepts/.gitkeep');
  assert.ok(gitkeep, 'wiki tier gitkeep in receipt');
  assert.equal(gitkeep.class, 'state');
});

test('the adapter is classified managed in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === ADAPTER);
  assert.ok(entry, 'adapter in manifest');
  assert.equal(entry.class, 'managed');
});

// ── AC-2: .recon-wrxn.json is laid (seeded); optional live recon-wrxn index+query ──

test('.recon-wrxn.json is laid into a fresh install and is valid JSON', () => {
  const { target } = freshInstall('wrxn-recon-');
  const reconPath = path.join(target, '.recon-wrxn.json');
  assert.ok(fs.existsSync(reconPath), '.recon-wrxn.json laid');
  const cfg = JSON.parse(fs.readFileSync(reconPath, 'utf8'));
  assert.ok(Array.isArray(cfg.ignore), '.recon-wrxn.json has an ignore array');
});

test('.recon-wrxn.json is classified seeded in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.recon-wrxn.json');
  assert.ok(entry, '.recon-wrxn.json in manifest');
  assert.equal(entry.class, 'seeded');
});

function reconAvailable() {
  try {
    execFileSync('recon-wrxn', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('recon-wrxn (if installed) indexes the install and answers a symbol query', () => {
  const { target } = freshInstall('wrxn-recon-live-');
  if (!reconAvailable()) {
    // External binary not in the test environment — do NOT fail the suite on it.
    console.log('# SKIP recon-wrxn live index+query — `recon-wrxn` binary not in PATH');
    return;
  }
  // Give recon-wrxn a symbol to find: the adapter ships a known function name. The binary may be
  // present but non-functional (e.g. native deps unbuilt under --ignore-scripts) — an operational
  // failure of an OPTIONAL external tool must SKIP, never redden the suite (real functional
  // verification is the qa-walk stage's job, with a fully-built recon-wrxn).
  let out;
  try {
    execFileSync('recon-wrxn', ['index', '--force'], { cwd: target, stdio: 'ignore' });
    out = execFileSync('recon-wrxn', ['find', 'findInstallRoot'], { cwd: target, encoding: 'utf8' });
  } catch (err) {
    console.log(`# SKIP recon-wrxn live index+query — binary present but not functional: ${err.message.split('\n')[0]}`);
    return;
  }
  assert.match(out, /findInstallRoot/, 'recon-wrxn found the adapter symbol');
});
