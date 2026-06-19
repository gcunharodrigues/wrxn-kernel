'use strict';

// gate-redesign gate-02 — `wrxn update` applies the wrxn-main-gate ruleset idempotently after laying
// files (and running migrations), and is FAIL-SOFT: a remote-less install just skips it, never breaking
// the update. The gh/git invokers are injected so this never issues a real mutating `gh api`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
// gh stand-in: the list call returns `rulesets`; a `--method` call is the create/update.
function fakeGh({ rulesets = [] } = {}) {
  const calls = [];
  const invoker = (step) => {
    calls.push(step);
    if (!step.args.includes('--method')) return { ok: true, status: 0, stdout: JSON.stringify(rulesets) };
    return { ok: true, status: 0, stdout: JSON.stringify({ id: 999, name: 'wrxn-main-gate' }) };
  };
  return { invoker, calls };
}
// git stand-in answering `remote get-url origin`.
function fakeGit(url, { ok = true } = {}) {
  return ({ args }) => (args.includes('get-url')
    ? (ok ? { ok: true, status: 0, stdout: url + '\n' } : { ok: false, status: 2, stdout: '' })
    : { ok: false, stdout: '' });
}

test('update is fail-soft on a remote-less install — protection skipped, update still succeeds', () => {
  const target = tmp('wrxn-upd-protect-noremote-');
  init({ pkgRoot: PKG_ROOT, target });
  execFileSync('git', ['init', '-q', target]); // a real repo with NO origin → deterministic no-remote

  let report;
  assert.doesNotThrow(() => { report = update({ pkgRoot: PKG_ROOT, target }); });
  assert.ok(report.protection, 'update surfaces a protection result');
  assert.equal(report.protection.ok, false);
  assert.equal(report.protection.action, 'skipped');
  assert.ok(Array.isArray(report.migrationsRan), 'migrations still ran — protection did not break update');
});

test('update applies the wrxn-main-gate ruleset when the install has a github origin (created)', () => {
  const target = tmp('wrxn-upd-protect-create-');
  init({ pkgRoot: PKG_ROOT, target });
  const gh = fakeGh({ rulesets: [] });
  const report = update({
    pkgRoot: PKG_ROOT,
    target,
    gitInvoker: fakeGit('git@github.com:gcunharodrigues/wrxn-kernel.git'),
    ghInvoker: gh.invoker,
  });
  assert.equal(report.protection.action, 'created');
  assert.equal(report.protection.slug, 'gcunharodrigues/wrxn-kernel');
});

test('update on an already-protected repo is a no-op (PUT in place, no duplicate create)', () => {
  const target = tmp('wrxn-upd-protect-idem-');
  init({ pkgRoot: PKG_ROOT, target });
  const gh = fakeGh({ rulesets: [{ id: 5, name: 'wrxn-main-gate' }] });
  const report = update({
    pkgRoot: PKG_ROOT,
    target,
    gitInvoker: fakeGit('git@github.com:gcunharodrigues/wrxn-kernel.git'),
    ghInvoker: gh.invoker,
  });
  assert.equal(report.protection.action, 'updated', 'idempotent: updates in place, never re-creates');
  assert.ok(!gh.calls.some((c) => c.args.includes('POST')), 'no duplicate create on a protected repo');
});
