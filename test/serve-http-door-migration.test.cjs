'use strict';

// recon-brain-recall-05 — warm-brain HTTP door migration (003).
// The install seed .recon-wrxn.json is SEEDED (operator-owned), so `wrxn update` never overwrites it.
// An install created before this release keeps the door shut forever unless a migration flips it.
// Covers migration 003 in isolation (sets serveHttp:true, preserving operator fields; idempotent;
// missing-file-safe; corrupt-file-safe) AND end-to-end through `wrxn update` (the file-class update
// PRESERVES the present seeded config, so the migration is what opens the door on a stale install).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

const MIGRATION_FILE = '003-serve-http-door.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

const CFG = '.recon-wrxn.json';
// the on-disk config a pre-wrxn.3 install still carries (the door field absent)
const PRE_WRXN3 = { projects: [], embeddings: false, watch: true, ignore: [] };

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}
function writeCfg(target, obj) {
  fs.writeFileSync(path.join(target, CFG), JSON.stringify(obj, null, 2) + '\n');
}
function readCfgRaw(target) {
  return fs.readFileSync(path.join(target, CFG), 'utf8');
}
function readCfg(target) {
  return JSON.parse(readCfgRaw(target));
}

// A throwaway kernel package at `version`, carrying the supplied migration files (mirrors 002's test).
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

// ── Migration in isolation (require the REAL shipped module, call up() against a fixture) ──

test('migration metadata: id 003 ships with version 0.4.0', () => {
  assert.equal(migration.id, '003');
  assert.equal(migration.version, '0.4.0');
  assert.equal(typeof migration.up, 'function');
});

test('(a) a pre-wrxn.3 config gains serveHttp:true', () => {
  const target = tmp('wrxn-door-a-');
  writeCfg(target, PRE_WRXN3);

  migration.up({ target });

  const cfg = readCfg(target);
  assert.equal(cfg.serveHttp, true, 'the door is opened');
  // the migration touches ONLY the door bit — it does not retrofit serveEmbed or any other field
  assert.deepEqual(cfg, { ...PRE_WRXN3, serveHttp: true });
});

test('(b) idempotent — a second run is a byte-identical no-op', () => {
  const target = tmp('wrxn-door-b-');
  writeCfg(target, PRE_WRXN3);

  migration.up({ target });
  const after1 = readCfgRaw(target);

  migration.up({ target }); // serveHttp already true → no rewrite

  assert.equal(readCfgRaw(target), after1, 'config unchanged on the 2nd run');
});

test('(c) operator fields are preserved', () => {
  const target = tmp('wrxn-door-c-');
  writeCfg(target, { projects: ['x'], embeddings: false, watch: true, ignore: ['y'], maxFileSize: 500000 });

  migration.up({ target });

  const cfg = readCfg(target);
  assert.deepEqual(cfg.projects, ['x'], 'projects preserved');
  assert.deepEqual(cfg.ignore, ['y'], 'ignore preserved');
  assert.equal(cfg.maxFileSize, 500000, 'an unrelated operator field preserved');
  assert.equal(cfg.serveHttp, true, 'door opened alongside');
});

test('(c2) an explicit serveHttp:false is honored as the door-open intent and flipped on', () => {
  const target = tmp('wrxn-door-c2-');
  writeCfg(target, { ...PRE_WRXN3, serveHttp: false });

  migration.up({ target });

  assert.equal(readCfg(target).serveHttp, true, 'serveHttp:false is advanced to true');
});

test('(d) a missing config is a no-op — no throw, no file created', () => {
  const target = tmp('wrxn-door-d-');
  const before = fs.readdirSync(target).sort();

  assert.doesNotThrow(() => migration.up({ target }));

  assert.equal(fs.existsSync(path.join(target, CFG)), false, 'no config created');
  assert.deepEqual(fs.readdirSync(target).sort(), before, 'no files created');
});

test('a corrupt/unparseable config is left untouched (never clobbered)', () => {
  const target = tmp('wrxn-door-corrupt-');
  const garbage = '{ not valid json,,, serveHttp';
  fs.writeFileSync(path.join(target, CFG), garbage);

  assert.doesNotThrow(() => migration.up({ target }));

  assert.equal(readCfgRaw(target), garbage, 'the hand-corrupted file is preserved byte-for-byte');
});

// ── End-to-end through wrxn update (the seeded config is preserved → the migration opens the door) ──

test('wrxn update opens the door on a stale install and records 003 (resumable)', () => {
  const work = tmp('wrxn-door-e2e-');
  const target = fs.mkdtempSync(path.join(work, 'legacy-'));
  // a pre-0.4.0 install carrying the door-shut seeded config + a pre-0.4.0 receipt
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.3.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );
  writeCfg(target, { projects: ['my-app'], embeddings: false, watch: true, ignore: ['tmp'] });

  const pkg = fakePkg(work, '0.4.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  // recorded + resumable
  assert.ok(report.migrationsRan.includes('003'), 'report.migrationsRan includes 003');
  assert.ok(receiptOf(target).migrationsApplied.includes('003'), 'receipt records 003 applied');

  // update PRESERVED the seeded config (operator data) → the migration is what opened the door
  const cfg = readCfg(target);
  assert.equal(cfg.serveHttp, true, 'door open after update');
  assert.deepEqual(cfg.projects, ['my-app'], 'operator project survived the update');
  assert.deepEqual(cfg.ignore, ['tmp'], 'operator ignore survived the update');

  // re-update at the same version: 003 does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('003'), false, 're-update does not re-run the applied 003');
});
