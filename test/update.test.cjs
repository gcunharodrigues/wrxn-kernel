'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// Build a throwaway kernel "package" at a given version, optionally mutating a managed file,
// so an update can be exercised vX → vY without touching the real package.
function fakePkg(work, version, managedConstitution) {
  const dir = path.join(work, 'pkg-' + version);
  fs.cpSync(path.join(PKG_ROOT, 'payload'), path.join(dir, 'payload'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wrxn', version }));
  if (managedConstitution) {
    fs.writeFileSync(path.join(dir, 'payload', '.claude', 'constitution.md'), managedConstitution);
  }
  return dir;
}

const SEEDED = '.claude/constitution.local.md';
const MANAGED = '.claude/constitution.md';
const STATE_DIR = '.wrxn/wiki';

test('update replaces managed files with the new version', () => {
  const work = tmp('wrxn-up-managed-');
  const target = path.join(work, 'install');
  fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1');
  const vB = fakePkg(work, '0.0.2', 'VERSION B CONSTITUTION\n');

  init({ pkgRoot: vA, target });
  const report = update({ pkgRoot: vB, target });

  assert.equal(fs.readFileSync(path.join(target, MANAGED), 'utf8'), 'VERSION B CONSTITUTION\n');
  assert.equal(report.from, '0.0.1');
  assert.equal(report.to, '0.0.2');
  assert.ok(report.updated.some((f) => f.path === MANAGED && f.class === 'managed'));
});

test('update never touches a mutated seeded file', () => {
  const work = tmp('wrxn-up-seeded-');
  const target = path.join(work, 'install');
  fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1');
  const vB = fakePkg(work, '0.0.2', 'VERSION B CONSTITUTION\n');

  init({ pkgRoot: vA, target });
  fs.writeFileSync(path.join(target, SEEDED), 'OPERATOR-OWNED\n');
  update({ pkgRoot: vB, target });

  assert.equal(fs.readFileSync(path.join(target, SEEDED), 'utf8'), 'OPERATOR-OWNED\n');
});

test('update never touches state (wiki) contents', () => {
  const work = tmp('wrxn-up-state-');
  const target = path.join(work, 'install');
  fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1');
  const vB = fakePkg(work, '0.0.2', 'VERSION B CONSTITUTION\n');

  init({ pkgRoot: vA, target });
  const note = path.join(target, STATE_DIR, 'my-note.md');
  fs.writeFileSync(note, 'PROJECT MEMORY\n');
  update({ pkgRoot: vB, target });

  assert.ok(fs.existsSync(note), 'state file survives update');
  assert.equal(fs.readFileSync(note, 'utf8'), 'PROJECT MEMORY\n');
});

test('update refuses a downgrade and changes nothing', () => {
  const work = tmp('wrxn-up-downgrade-');
  const target = path.join(work, 'install');
  fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1', 'OLD\n');
  const vB = fakePkg(work, '0.0.2', 'NEW\n');

  init({ pkgRoot: vB, target }); // installed at the newer version
  assert.throws(() => update({ pkgRoot: vA, target }), /downgrade/i);
  // managed file untouched by the refused downgrade
  assert.equal(fs.readFileSync(path.join(target, MANAGED), 'utf8'), 'NEW\n');
});

test('update pins and reports the new version in the receipt', () => {
  const work = tmp('wrxn-up-version-');
  const target = path.join(work, 'install');
  fs.mkdirSync(target);
  const vA = fakePkg(work, '0.0.1');
  const vB = fakePkg(work, '0.1.0', 'VB\n');

  init({ pkgRoot: vA, target });
  update({ pkgRoot: vB, target });

  const receipt = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
  assert.equal(receipt.kernelVersion, '0.1.0');
});

test('update refuses to run on a dir that is not a wrxn install', () => {
  const work = tmp('wrxn-up-noinstall-');
  const target = path.join(work, 'empty');
  fs.mkdirSync(target);
  const vB = fakePkg(work, '0.0.2');
  assert.throws(() => update({ pkgRoot: vB, target }), /not a wrxn install/i);
});
