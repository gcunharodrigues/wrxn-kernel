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
const WRXN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');
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

// ── MED-1: `wrxn update` must SURFACE the protection outcome (a silent skip recreates the exact
// "silent no-op gate" defect this epic exists to kill). Process-level CLI tests of the real handler;
// execFileSync throws on a non-zero exit, so returning stdout IS the exit-0 (fail-soft) proof. ──

test('CLI: wrxn update surfaces a protection SKIP on a no-remote install (MED-1; exit 0, fail-soft)', () => {
  const target = tmp('wrxn-upd-protect-cli-skip-');
  init({ pkgRoot: PKG_ROOT, target });
  execFileSync('git', ['init', '-q', target]); // a real repo with NO origin → protection soft-skips
  const out = execFileSync('node', [WRXN, 'update', '--root', target], { encoding: 'utf8' });
  assert.match(out, /protection/i, 'the update output surfaces the protection outcome — not silent');
  assert.match(out, /skip/i, 'the soft-skip is announced (operator learns the gate did not apply)');
});

test('CLI: wrxn update surfaces protection APPLIED when origin is a github repo (MED-1; exit 0)', () => {
  const target = tmp('wrxn-upd-protect-cli-apply-');
  init({ pkgRoot: PKG_ROOT, target });
  execFileSync('git', ['init', '-q', target]);
  execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'git@github.com:fake-owner/fake-repo.git']);
  // A stub `gh` on PATH intercepts the apply — NO real mutating `gh api` is ever issued (the list call
  // returns `[]`, the --method create returns ok). This exercises the real CLI's applied-print path.
  const stubDir = tmp('wrxn-stub-gh-');
  const ghStub = path.join(stubDir, 'gh');
  fs.writeFileSync(ghStub, '#!/bin/sh\ncase "$*" in\n  *--method*) echo "{}" ;;\n  *) echo "[]" ;;\nesac\nexit 0\n');
  fs.chmodSync(ghStub, 0o755);
  const out = execFileSync('node', [WRXN, 'update', '--root', target], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  assert.match(out, /protection/i, 'the applied outcome is surfaced on the primary delivery path');
  assert.match(out, /wrxn-main-gate|created|updated/i, 'names the ruleset action that landed');
  assert.doesNotMatch(out, /protection skipped/i, 'an applied gate is not reported as skipped');
});
