'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const { compareVersions } = require('../lib/semver.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// Build a throwaway kernel package at `version`, with optional migration files.
// migrations: [{ file, body }] where body is the .cjs source exporting { id, version, up }.
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

function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A migration that writes a marker file into the install (observable behavior).
const markerMigration = (id, version, marker) => ({
  file: `${id}-${marker}.cjs`,
  body: `module.exports = { id: '${id}', version: '${version}', up(ctx) {
    require('fs').writeFileSync(require('path').join(ctx.target, '${marker}'), '${id}\\n');
  } };`,
});

test('an update runs a pending migration exactly once and records it', () => {
  const work = tmp('wrxn-mig-once-');
  const target = path.join(work, 'install'); fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1');
  const vB = fakePkg(work, '0.2.0', [markerMigration('001', '0.2.0', 'migrated.txt')]);

  init({ pkgRoot: vA, target });
  const report = update({ pkgRoot: vB, target });

  assert.ok(fs.existsSync(path.join(target, 'migrated.txt')), 'migration ran');
  assert.deepEqual(report.migrationsRan, ['001']);
  assert.ok(receiptOf(target).migrationsApplied.includes('001'));

  // re-update at the same version: migration must NOT run again (delete the marker, re-update)
  fs.unlinkSync(path.join(target, 'migrated.txt'));
  const second = update({ pkgRoot: vB, target });
  assert.deepEqual(second.migrationsRan, [], 're-update is a no-op for applied migrations');
  assert.equal(fs.existsSync(path.join(target, 'migrated.txt')), false, 'applied migration did not re-run');
});

test('pending migrations run in id order', () => {
  const work = tmp('wrxn-mig-order-');
  const target = path.join(work, 'install'); fs.mkdirSync(target);
  init({ pkgRoot: fakePkg(work, '0.0.1'), target });

  // 002 appends to a log; 001 creates it — order is asserted by the file contents
  const m001 = { file: '001-a.cjs', body: `module.exports = { id:'001', version:'0.2.0', up(ctx){ require('fs').appendFileSync(require('path').join(ctx.target,'seq.log'),'001\\n'); } };` };
  const m002 = { file: '002-b.cjs', body: `module.exports = { id:'002', version:'0.2.0', up(ctx){ require('fs').appendFileSync(require('path').join(ctx.target,'seq.log'),'002\\n'); } };` };
  const vB = fakePkg(work, '0.2.0', [m002, m001]); // deliberately listed out of order

  const report = update({ pkgRoot: vB, target });
  assert.deepEqual(report.migrationsRan, ['001', '002']);
  assert.equal(fs.readFileSync(path.join(target, 'seq.log'), 'utf8'), '001\n002\n');
});

test('a failing migration halts cleanly, records nothing for it, and resumes after a fix', () => {
  const work = tmp('wrxn-mig-resume-');
  const target = path.join(work, 'install'); fs.mkdirSync(target);
  init({ pkgRoot: fakePkg(work, '0.0.1'), target });

  // the migration throws unless a `fix.flag` file exists in the install
  const flaky = { file: '001-flaky.cjs', body: `module.exports = { id:'001', version:'0.2.0', up(ctx){
    const fs=require('fs'), p=require('path');
    if(!fs.existsSync(p.join(ctx.target,'fix.flag'))) throw new Error('not fixed yet');
    fs.writeFileSync(p.join(ctx.target,'done.txt'),'ok\\n');
  } };` };
  const vB = fakePkg(work, '0.2.0', [flaky]);

  // first update: migration fails → update throws, nothing recorded for 001
  assert.throws(() => update({ pkgRoot: vB, target }), /migration.*001|not fixed/i);
  assert.ok(!(receiptOf(target).migrationsApplied || []).includes('001'), '001 NOT marked applied after failure');
  assert.equal(fs.existsSync(path.join(target, 'done.txt')), false);

  // fix the cause, re-update: 001 resumes and completes
  fs.writeFileSync(path.join(target, 'fix.flag'), '');
  const report = update({ pkgRoot: vB, target });
  assert.deepEqual(report.migrationsRan, ['001']);
  assert.ok(fs.existsSync(path.join(target, 'done.txt')));
  assert.ok(receiptOf(target).migrationsApplied.includes('001'));
});

test('a migration above the target version does not run yet', () => {
  const work = tmp('wrxn-mig-future-');
  const target = path.join(work, 'install'); fs.mkdirSync(target);
  init({ pkgRoot: fakePkg(work, '0.0.1'), target });
  // package is 0.2.0 but the migration is tagged for 0.3.0 → not eligible on a 0.2.0 update
  const future = markerMigration('001', '0.3.0', 'future.txt');
  const report = update({ pkgRoot: fakePkg(work, '0.2.0', [future]), target });
  assert.deepEqual(report.migrationsRan, []);
  assert.equal(fs.existsSync(path.join(target, 'future.txt')), false);
});

// ── no inert migrations: every migration targets a released version (foundation-honesty-06) ──
//
// migrate runs a migration only once the install's reached version (the package version) is >=
// the migration's version. A migration tagged for a version the package has NOT reached is inert:
// it ships but never runs (the exact trap that left 002's seeded-honesty fix a silent no-op while
// package.json lagged at 0.2.0). This pins every migration at or below package.json's version so a
// shipped migration can never be gated on an unreleased version.

test('every migration targets a version <= the package version (no inert migration)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  const migDir = path.join(PKG_ROOT, 'migrations');
  const files = fs.readdirSync(migDir).filter((f) => f.endsWith('.cjs'));
  assert.ok(files.length > 0, 'there are migrations to check');
  for (const file of files) {
    const mig = require(path.join(migDir, file));
    assert.ok(
      compareVersions(mig.version, pkg.version) <= 0,
      `migration ${file} targets ${mig.version} > package ${pkg.version} — it will never run on a real update`
    );
  }
});
