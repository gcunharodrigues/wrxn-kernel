'use strict';

// R4 — recon → recon-wrxn update migration (recon-wrxn-04).
// Covers the migration module 001 (dir rename / config rename / stale recon key removal /
// gitignore fix / vendor drop / no-op / idempotent / resumable-recorded) AND the N2 fix in
// lib/update.cjs (managed .mcp.json is MERGED on update, not clobbered, preserving operator servers).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

const MIGRATION_FILE = '001-recon-to-recon-wrxn.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A throwaway kernel package at `version`, carrying the supplied migration files.
function fakePkg(work, version, migrations) {
  const dir = path.join(work, 'pkg-' + version + '-' + Math.floor(version.length * 7 + (migrations ? migrations.length : 0)));
  fs.cpSync(path.join(PKG_ROOT, 'payload'), path.join(dir, 'payload'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wrxn', version }));
  if (migrations) {
    const mdir = path.join(dir, 'migrations');
    fs.mkdirSync(mdir, { recursive: true });
    for (const m of migrations) fs.writeFileSync(path.join(mdir, m.file), m.body);
  }
  return dir;
}

// Build a pre-R3 ("legacy") install on disk: the .recon/ index dir + sentinel, the legacy
// .recon.json config (with distinctive operator content), an operator .mcp.json holding the stale
// `recon` server plus the operator's own `my-tool`, a .gitignore with the stale `.recon/` line, and
// the vendored legacy recon. `withReceipt` adds a pre-0.2.0 receipt so `update()` will accept it.
function legacyFixture(work, withReceipt) {
  const target = fs.mkdtempSync(path.join(work, 'legacy-'));
  fs.mkdirSync(path.join(target, '.recon'), { recursive: true });
  fs.writeFileSync(path.join(target, '.recon', 'index.db'), 'INDEX-SENTINEL\n');
  fs.writeFileSync(
    path.join(target, '.recon.json'),
    JSON.stringify({ projects: ['/legacy/proj'], embeddings: false, watch: true, ignore: ['tmp'] }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(target, '.mcp.json'),
    JSON.stringify({ mcpServers: {
      recon: { command: 'npx', args: ['-y', 'recon-aiox', 'serve'] },
      'my-tool': { command: 'my-tool', args: ['serve'] },
    } }, null, 2) + '\n',
  );
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.recon/\ndist/\n');
  fs.mkdirSync(path.join(target, 'vendor', 'recon-aiox'), { recursive: true });
  fs.writeFileSync(path.join(target, 'vendor', 'recon-aiox', 'pkg.js'), '// legacy\n');
  if (withReceipt) {
    fs.writeFileSync(
      path.join(target, RECEIPT),
      JSON.stringify({ kernelVersion: '0.1.0', profile: 'project', installs: [] }, null, 2) + '\n',
    );
  }
  return target;
}

// ── Migration in isolation (require the REAL shipped module, call up() against a fixture) ──

test('migration metadata: id 001 ships with version 0.2.0', () => {
  assert.equal(migration.id, '001');
  assert.equal(migration.version, '0.2.0');
  assert.equal(typeof migration.up, 'function');
});

test('migration rebrands a legacy install: dir + config rename, stale recon key, gitignore, vendor', () => {
  const work = tmp('wrxn-r4-direct-');
  const target = legacyFixture(work, false);
  // simulate Part 1's merge having already added the recon-wrxn server (the migration only DELETES recon)
  const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  mcp.mcpServers['recon-wrxn'] = { command: 'npx', args: ['-y', 'recon-wrxn@6.0.0-wrxn.1', 'serve'] };
  fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

  migration.up({ target, fromVersion: '0.1.0', toVersion: '0.2.0' });

  // 1. index dir renamed, sentinel (the costly index) preserved
  assert.equal(fs.existsSync(path.join(target, '.recon')), false, '.recon/ gone');
  assert.ok(fs.existsSync(path.join(target, '.recon-wrxn')), '.recon-wrxn/ present');
  assert.equal(fs.readFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'utf8'), 'INDEX-SENTINEL\n', 'index preserved');
  // 2. config renamed, content unchanged
  assert.equal(fs.existsSync(path.join(target, '.recon.json')), false, '.recon.json gone');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(target, '.recon-wrxn.json'), 'utf8')),
    { projects: ['/legacy/proj'], embeddings: false, watch: true, ignore: ['tmp'] },
    'config content unchanged',
  );
  // 3. .mcp.json: stale recon removed, others untouched
  const m2 = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  assert.equal('recon' in m2.mcpServers, false, 'stale recon key removed');
  assert.ok(m2.mcpServers['my-tool'], 'operator server kept');
  assert.ok(m2.mcpServers['recon-wrxn'], 'recon-wrxn kept');
  // 4. gitignore: .recon/ → .recon-wrxn/, operator lines intact, no duplicate
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /^\.recon-wrxn\/$/m, '.recon-wrxn/ present');
  assert.equal(/^\.recon\/$/m.test(gi), false, '.recon/ line gone');
  assert.match(gi, /node_modules\//, 'operator lines preserved');
  assert.match(gi, /dist\//, 'operator lines preserved');
  assert.equal(gi.split('\n').filter((l) => l.trim() === '.recon-wrxn/').length, 1, 'no duplicate ignore line');
  // 5. vendored legacy recon removed
  assert.equal(fs.existsSync(path.join(target, 'vendor', 'recon-aiox')), false, 'vendor/recon-aiox removed');
});

test('migration is a complete no-op when .recon/ is absent (fresh installs unaffected)', () => {
  const work = tmp('wrxn-r4-noop-');
  const target = fs.mkdtempSync(path.join(work, 'fresh-'));
  fs.writeFileSync(path.join(target, '.recon-wrxn.json'), '{"projects":[]}\n');
  fs.writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n.recon-wrxn/\n');
  const before = fs.readdirSync(target).sort();
  const giBefore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');

  migration.up({ target });

  assert.deepEqual(fs.readdirSync(target).sort(), before, 'no files created or removed');
  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), giBefore, 'gitignore untouched');
  assert.equal(fs.existsSync(path.join(target, '.recon-wrxn')), false, 'no index dir created');
});

test('migration is idempotent — a second run makes no change', () => {
  const work = tmp('wrxn-r4-idem-');
  const target = legacyFixture(work, false);
  migration.up({ target });
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  const idx = fs.readFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'utf8');

  migration.up({ target }); // .recon/ already renamed away → no-op

  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), gi, 'gitignore unchanged on 2nd run');
  assert.equal(fs.readFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'utf8'), idx, 'index intact on 2nd run');
  assert.equal(fs.existsSync(path.join(target, '.recon')), false, '.recon/ still gone');
});

test('migration never crashes on a malformed .mcp.json (leaves it untouched)', () => {
  const work = tmp('wrxn-r4-badmcp-');
  const target = legacyFixture(work, false);
  fs.writeFileSync(path.join(target, '.mcp.json'), '{ this is not json');
  assert.doesNotThrow(() => migration.up({ target }));
  assert.equal(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'), '{ this is not json', 'malformed file left as-is');
  // the rest of the migration still ran
  assert.ok(fs.existsSync(path.join(target, '.recon-wrxn')), '.recon-wrxn/ still created');
});

test('migration removes the legacy .recon/ even when .recon-wrxn/ already exists (no stale residue)', () => {
  // edge: the operator ran the recon-wrxn binary (creating .recon-wrxn/) before `wrxn update`. The
  // legacy .recon/ is a disposable cache superseded by .recon-wrxn/ — it must NOT be left behind, or
  // it lingers no-longer-gitignored and the run-once migration never reclaims it.
  const work = tmp('wrxn-r4-bothdirs-');
  const target = legacyFixture(work, false);
  fs.mkdirSync(path.join(target, '.recon-wrxn'), { recursive: true });
  fs.writeFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'FRESH-INDEX\n');

  migration.up({ target });

  assert.equal(fs.existsSync(path.join(target, '.recon')), false, 'stale .recon/ removed, not left behind');
  assert.equal(fs.readFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'utf8'), 'FRESH-INDEX\n', 'existing .recon-wrxn/ left authoritative');
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.equal(/^\.recon\/$/m.test(gi), false, '.recon/ line dropped');
  assert.equal(gi.split('\n').filter((l) => l.trim() === '.recon-wrxn/').length, 1, 'exactly one .recon-wrxn/ ignore line');
});

test('gitignore rewrite collapses multiple stale .recon/ lines to a single .recon-wrxn/', () => {
  const work = tmp('wrxn-r4-gidup-');
  const target = legacyFixture(work, false);
  fs.writeFileSync(path.join(target, '.gitignore'), '.recon/\nnode_modules/\n.recon/\n');

  migration.up({ target });

  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.equal(gi.split('\n').filter((l) => l.trim() === '.recon-wrxn/').length, 1, 'no duplicate .recon-wrxn/ line');
  assert.equal(/^\.recon\/$/m.test(gi), false, 'all stale .recon/ lines gone');
  assert.match(gi, /node_modules\//, 'operator line preserved');
});

// ── End-to-end through wrxn update (Part 1 merge + the migration, recorded + resumable) ──

test('wrxn update migrates a legacy install end-to-end and records it (resumable)', () => {
  const work = tmp('wrxn-r4-e2e-');
  const target = legacyFixture(work, true);
  const pkg = fakePkg(work, '0.2.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);

  const report = update({ pkgRoot: pkg, target });

  // recorded + resumable
  assert.ok(report.migrationsRan.includes('001'), 'report.migrationsRan includes 001');
  assert.ok(receiptOf(target).migrationsApplied.includes('001'), 'receipt records 001 applied');

  // full final state (the walkable demo shape)
  assert.equal(fs.existsSync(path.join(target, '.recon')), false, '.recon/ gone');
  assert.equal(fs.readFileSync(path.join(target, '.recon-wrxn', 'index.db'), 'utf8'), 'INDEX-SENTINEL\n', 'index preserved');
  assert.equal(fs.existsSync(path.join(target, '.recon.json')), false, '.recon.json gone');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(target, '.recon-wrxn.json'), 'utf8')),
    { projects: ['/legacy/proj'], embeddings: false, watch: true, ignore: ['tmp'] },
    'operator config content preserved through the rename',
  );
  const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  assert.equal('recon' in mcp.mcpServers, false, 'stale recon server removed by the migration');
  assert.ok(mcp.mcpServers['my-tool'], 'operator MCP server survived the managed update (N2)');
  assert.ok(mcp.mcpServers['recon-wrxn'], 'recon-wrxn merged in on update');
  const gi = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.match(gi, /^\.recon-wrxn\/$/m, '.recon-wrxn/ ignored');
  assert.equal(/^\.recon\/$/m.test(gi), false, '.recon/ line gone');
  assert.equal(fs.existsSync(path.join(target, 'vendor', 'recon-aiox')), false, 'vendor/recon-aiox removed');

  // re-update at the same version: the migration does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.deepEqual(second.migrationsRan, [], 're-update does not re-run the applied migration');
});

// ── N2 in isolation: managed .mcp.json is MERGED on update, not clobbered ──

test('N2: update merges .mcp.json — operator servers survive, recon-wrxn refreshed', () => {
  const work = tmp('wrxn-r4-n2-merge-');
  const target = fs.mkdtempSync(path.join(work, 'install-'));
  // a normal (non-legacy) install: receipt + an operator .mcp.json with their own server
  fs.writeFileSync(path.join(target, RECEIPT), JSON.stringify({ kernelVersion: '0.1.0', profile: 'project', installs: [] }, null, 2) + '\n');
  fs.writeFileSync(
    path.join(target, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'my-tool': { command: 'my-tool', args: ['serve'] } } }, null, 2) + '\n',
  );
  const pkg = fakePkg(work, '0.2.0');

  update({ pkgRoot: pkg, target });

  const mcp = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers['my-tool'], { command: 'my-tool', args: ['serve'] }, 'operator server NOT clobbered');
  assert.ok(mcp.mcpServers['recon-wrxn'], 'recon-wrxn present/refreshed after update');
});

test('N2: update does not crash on a malformed operator .mcp.json (preserved untouched)', () => {
  const work = tmp('wrxn-r4-n2-bad-');
  const target = fs.mkdtempSync(path.join(work, 'install-'));
  fs.writeFileSync(path.join(target, RECEIPT), JSON.stringify({ kernelVersion: '0.1.0', profile: 'project', installs: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(target, '.mcp.json'), '{ not valid json');
  const pkg = fakePkg(work, '0.2.0');

  assert.doesNotThrow(() => update({ pkgRoot: pkg, target }));
  assert.equal(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8'), '{ not valid json', 'malformed operator file preserved untouched');
});
