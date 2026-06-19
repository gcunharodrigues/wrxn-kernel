'use strict';

// gate-redesign gate-02 — migration 005 applies the wrxn-main-gate ruleset on EXISTING installs (the
// first application: a fresh install gets it from `wrxn update`'s protect step, but a pre-0.11.0 install
// never ran that step). Defensive/idempotent like migrations/003: a no-remote install is a no-op, it
// never throws on a non-applicable install. Covered in isolation (metadata, delegation, no-remote
// no-op) AND end-to-end through `wrxn update` (the runner contract: recorded + resumable).
// No real mutating `gh api` is ever issued — a no-remote target derives no slug and short-circuits.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const protect = require('../lib/protect.cjs');

const MIGRATION_FILE = '005-protect-main-gate.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A throwaway kernel package at `version`, carrying the supplied migration files (mirrors 003's test).
// Also copies lib/ because migration 005 requires ../lib/protect.cjs — the real published package ships
// lib/ alongside migrations/ (package.json `files`), so the fakePkg must too for a faithful simulation.
function fakePkg(work, version, migrations) {
  const dir = path.join(work, 'pkg-' + version);
  fs.cpSync(path.join(PKG_ROOT, 'payload'), path.join(dir, 'payload'), { recursive: true });
  fs.cpSync(path.join(PKG_ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wrxn', version }));
  const mdir = path.join(dir, 'migrations');
  fs.mkdirSync(mdir, { recursive: true });
  for (const m of migrations) fs.writeFileSync(path.join(mdir, m.file), m.body);
  return dir;
}

// ── metadata + delegation (isolation) ──────────────────────────────────────────

test('migration metadata: id 005 ships with version 0.11.0', () => {
  assert.equal(migration.id, '005');
  assert.equal(migration.version, '0.11.0');
  assert.equal(typeof migration.up, 'function');
});

test('migration 005 delegates to protectOrigin against the install root', () => {
  const orig = protect.protectOrigin;
  const seen = [];
  protect.protectOrigin = (root) => { seen.push(root); return { ok: true, action: 'created' }; };
  try {
    migration.up({ target: '/some/install/root' });
  } finally {
    protect.protectOrigin = orig;
  }
  assert.deepEqual(seen, ['/some/install/root'], 'up() applies protection to its own install root');
});

test('a no-remote install is a no-op — up() does not throw and writes nothing', () => {
  const target = tmp('wrxn-gate-mig-noremote-');
  execFileSync('git', ['init', '-q', target]); // a real repo with NO origin → deterministic no-remote
  const before = fs.readdirSync(target).sort();

  assert.doesNotThrow(() => migration.up({ target }));

  assert.deepEqual(fs.readdirSync(target).sort(), before, 'no files created/modified on a no-remote install');
});

// ── end-to-end through wrxn update (the runner contract: recorded + resumable) ──

test('wrxn update runs + records 005 on a stale install, and does not re-run it (resumable)', () => {
  const work = tmp('wrxn-gate-mig-e2e-');
  const target = fs.mkdtempSync(path.join(work, 'legacy-'));
  execFileSync('git', ['init', '-q', target]); // no origin → 005 + update's protect step both skip (no gh)
  // a pre-0.11.0 install: a minimal receipt the runner advances to 0.11.0
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.10.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );

  const pkg = fakePkg(work, '0.11.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  assert.ok(report.migrationsRan.includes('005'), 'report.migrationsRan includes 005');
  assert.ok(receiptOf(target).migrationsApplied.includes('005'), 'receipt records 005 applied');
  // no-remote → the gate application is a no-op, but the migration is still recorded as run
  assert.equal(report.protection.action, 'skipped', 'remote-less install: protection soft-skips');

  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('005'), false, 're-update does not re-run the applied 005');
});
