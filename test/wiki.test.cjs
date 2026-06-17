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

// ── single-H1 fix (qa-finding dream-06): write-page must not stack a second H1 ──
// The dream gate mandates a proposal body open with its own "# Title" H1; write-page used to ALWAYS
// prepend "# <slug>" too, so every dream-committed page rendered TWO stacked H1s. write-page now
// prepends "# <slug>" ONLY when the body does not already open with an H1 (backward-compatible: a
// heading-less or empty body still gets "# <slug>" exactly as before).

test('write-page: a body that already opens with an H1 does not get a stacked # <slug> heading', () => {
  const { target } = freshInstall('wrxn-wiki-onehead-');
  runAdapter(target, ['write-page', 'concepts', 'cache-layer-design', '--body', '# My Title\n\nstuff']);
  const txt = fs.readFileSync(path.join(target, '.wrxn', 'wiki', 'concepts', 'cache-layer-design.md'), 'utf8');
  const h1s = txt.match(/^# .*/gm) || [];
  assert.equal(h1s.length, 1, `exactly one H1 (got ${h1s.length}: ${JSON.stringify(h1s)})`);
  assert.equal(h1s[0], '# My Title', "the body's own H1 is the sole H1");
  assert.doesNotMatch(txt, /^# cache-layer-design$/m, 'the slug heading is NOT prepended when the body has its own H1');
});

test('write-page: a heading-less body still gets the # <slug> heading (backward-compat)', () => {
  const { target } = freshInstall('wrxn-wiki-slughead-');
  runAdapter(target, ['write-page', 'concepts', 'memory-tiers', '--body', 'the wiki has four tiers']);
  const txt = fs.readFileSync(path.join(target, '.wrxn', 'wiki', 'concepts', 'memory-tiers.md'), 'utf8');
  assert.match(txt, /^# memory-tiers$/m, 'a heading-less body still gets the slug H1 (unchanged behavior)');
  const h1s = txt.match(/^# .*/gm) || [];
  assert.equal(h1s.length, 1, 'exactly one H1 — the prepended slug heading');
});

test('write-page: an empty body still gets the # <slug> heading (backward-compat)', () => {
  const { target } = freshInstall('wrxn-wiki-emptybody-');
  runAdapter(target, ['write-page', 'gotchas', 'placeholder']);
  const txt = fs.readFileSync(path.join(target, '.wrxn', 'wiki', 'gotchas', 'placeholder.md'), 'utf8');
  assert.match(txt, /^# placeholder$/m, 'an empty body still gets the slug heading (unchanged behavior)');
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

// ── _rules tier (dream-03): the machine-written tier the dream adapter targets ──

test('write-page creates a page in the _rules tier and query finds it', () => {
  const { target } = freshInstall('wrxn-wiki-rules-');
  const out = JSON.parse(runAdapter(target, ['write-page', '_rules', 'always-rebase-before-merge', '--body', 'always rebase onto main before merging']));
  assert.equal(out.tier, '_rules');
  const page = path.join(target, '.wrxn', 'wiki', '_rules', 'always-rebase-before-merge.md');
  assert.ok(fs.existsSync(page), 'page laid in the _rules tier');
  const res = JSON.parse(runAdapter(target, ['query', 'always rebase onto main']));
  assert.ok(res.total >= 1, 'query found the _rules page');
  assert.equal(res.hits[0].tier, '_rules');
  assert.match(res.hits[0].file, /_rules\/always-rebase-before-merge\.md$/);
});

test('.wrxn/wiki/_rules/.gitkeep is classified state in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.wrxn/wiki/_rules/.gitkeep');
  assert.ok(entry, '.wrxn/wiki/_rules/.gitkeep in manifest');
  assert.equal(entry.class, 'state');
});

test('the laid receipt classifies the _rules tier gitkeep as state', () => {
  const { target } = freshInstall('wrxn-wiki-rules-receipt-');
  const receipt = JSON.parse(fs.readFileSync(path.join(target, 'wrxn.install.json'), 'utf8'));
  const gitkeep = receipt.files.find((f) => f.path === '.wrxn/wiki/_rules/.gitkeep');
  assert.ok(gitkeep, '_rules tier gitkeep in receipt');
  assert.equal(gitkeep.class, 'state');
});

// ── _slots tier + the force-overwrite exception (dream-04) ────────────────────
// `_slots/current-focus.md` is the durable standing-focus page — the LONE wiki page that may be
// overwritten, and only via `write-page --force`. Every other tier stays create-only / refuse-overwrite.

test('write-page creates a page in the _slots tier and query finds it', () => {
  const { target } = freshInstall('wrxn-wiki-slots-');
  const out = JSON.parse(runAdapter(target, ['write-page', '_slots', 'current-focus', '--body', 'shipping the dream slice']));
  assert.equal(out.tier, '_slots');
  const page = path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md');
  assert.ok(fs.existsSync(page), 'page laid in the _slots tier');
  const res = JSON.parse(runAdapter(target, ['query', 'shipping the dream slice']));
  assert.ok(res.total >= 1, 'query found the _slots page');
  assert.equal(res.hits[0].tier, '_slots');
});

test('write-page --force overwrites the focus slot in place (create then update)', () => {
  const { target } = freshInstall('wrxn-wiki-force-');
  runAdapter(target, ['write-page', '_slots', 'current-focus', '--body', 'FIRST focus statement']);
  runAdapter(target, ['write-page', '_slots', 'current-focus', '--force', '--body', 'SECOND focus statement']);
  const txt = fs.readFileSync(path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md'), 'utf8');
  assert.match(txt, /SECOND focus statement/, 'force overwrote with the new content');
  assert.doesNotMatch(txt, /FIRST focus statement/, 'the prior content is gone (overwritten in place, not appended)');
});

test('write-page --force is refused for any tier other than _slots (the lone update-exception)', () => {
  const { target } = freshInstall('wrxn-wiki-force-guard-');
  runAdapter(target, ['write-page', 'concepts', 'pinned', '--body', 'curated original']);
  assert.throws(
    () => runAdapter(target, ['write-page', 'concepts', 'pinned', '--force', '--body', 'would clobber']),
    /only permitted for the _slots/
  );
  // the curated knowledge page is intact — --force cannot touch it
  assert.match(fs.readFileSync(path.join(target, '.wrxn', 'wiki', 'concepts', 'pinned.md'), 'utf8'), /curated original/);
});

test('write-page --force is refused for a non-current-focus slug even inside _slots (path-scoped, not tier-scoped) [dream-qa-07]', () => {
  const { target } = freshInstall('wrxn-wiki-force-slug-');
  assert.throws(
    () => runAdapter(target, ['write-page', '_slots', 'probe-slot', '--force', '--body', 'forged slot']),
    /only permitted for the _slots\/current-focus/
  );
  // no forged page was laid in the _slots tier
  assert.ok(
    !fs.existsSync(path.join(target, '.wrxn', 'wiki', '_slots', 'probe-slot.md')),
    'a forged _slots slug must not be created via --force'
  );
});

test('.wrxn/wiki/_slots/.gitkeep is classified state in the manifest', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.wrxn/wiki/_slots/.gitkeep');
  assert.ok(entry, '.wrxn/wiki/_slots/.gitkeep in manifest');
  assert.equal(entry.class, 'state');
});

test('the laid receipt classifies the _slots tier gitkeep as state', () => {
  const { target } = freshInstall('wrxn-wiki-slots-receipt-');
  const receipt = JSON.parse(fs.readFileSync(path.join(target, 'wrxn.install.json'), 'utf8'));
  const gitkeep = receipt.files.find((f) => f.path === '.wrxn/wiki/_slots/.gitkeep');
  assert.ok(gitkeep, '_slots tier gitkeep in receipt');
  assert.equal(gitkeep.class, 'state');
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
