'use strict';

// R3 — wrxn installs + wires recon-wrxn (recon-wrxn-03).
// Covers: the pinned dependency (AC-1), the laid .mcp.json wiring + brownfield merge (AC-2),
// the .recon-wrxn.json config matching initConfig with NO index.outputDir (AC-3, hard No-Invention),
// the idempotent .recon-wrxn/ gitignore line (AC-4), the non-empty adopt-hint (AC-6), and the
// receipt recording the new files (AC-7).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init, RECEIPT } = require('../lib/install.cjs');

const RECON_VERSION = '6.0.0-wrxn.1';

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// ── AC-1: wrxn pins recon-wrxn at a known version and the lockfile resolved it ──

test('package.json pins recon-wrxn at the known version', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies, 'package.json declares dependencies');
  assert.equal(pkg.dependencies['recon-wrxn'], RECON_VERSION, 'recon-wrxn pinned at the known version');
});

test('the lockfile resolved recon-wrxn (npm install ran)', () => {
  const lockPath = path.join(PKG_ROOT, 'package-lock.json');
  assert.ok(fs.existsSync(lockPath), 'package-lock.json exists (npm install ran)');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const resolved = (lock.packages && lock.packages['node_modules/recon-wrxn'])
    || (lock.dependencies && lock.dependencies['recon-wrxn']);
  assert.ok(resolved, 'recon-wrxn resolved in the lockfile');
  assert.equal(resolved.version, RECON_VERSION, 'lockfile pins the same version');
});
