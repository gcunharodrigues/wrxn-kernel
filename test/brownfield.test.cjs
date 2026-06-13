'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// A pre-existing project: real source + git history + a file that CLASHES with a seeded payload path.
function brownfieldRepo(prefix) {
  const dir = tmp(prefix);
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log("existing project code");\n');
  // a file that collides with a SEEDED payload path (.recon.json) — the operator's own version
  fs.writeFileSync(path.join(dir, '.recon.json'), '{"ignore":["operator-custom"]}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'existing work');
  return { dir, git };
}

test('init into an existing codebase succeeds and modifies zero project files', () => {
  const { dir, git } = brownfieldRepo('wrxn-bf-safe-');
  const appBefore = fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8');
  const reconBefore = fs.readFileSync(path.join(dir, '.recon.json'), 'utf8');
  const logBefore = git('log', '--oneline');

  const report = init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });

  // project source is byte-identical, the clashing seeded file is preserved, git history intact
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), appBefore);
  assert.equal(fs.readFileSync(path.join(dir, '.recon.json'), 'utf8'), reconBefore, 'operator .recon.json preserved');
  assert.equal(git('log', '--oneline'), logBefore, 'git history untouched');
  // non-colliding payload IS laid (the kernel installs alongside the existing code)
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'constitution.md')), 'kernel laid alongside');
  assert.equal(report.profile, 'project');
});

test('a brownfield install reports the collisions (existing files that clash with payload paths)', () => {
  const { dir } = brownfieldRepo('wrxn-bf-collide-');
  const report = init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });

  assert.equal(report.brownfield, true);
  const collidedPaths = report.collisions.map((c) => c.path);
  assert.ok(collidedPaths.includes('.recon.json'), 'the clashing .recon.json reported as a collision');
});

test('a clean empty install is NOT flagged brownfield (no collisions)', () => {
  const dir = tmp('wrxn-bf-clean-');
  const report = init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });
  assert.equal(report.brownfield, false);
  assert.deepEqual(report.collisions, []);
});

test('a re-init is not a collision (wrxn-laid files are not the operator\'s)', () => {
  const dir = tmp('wrxn-bf-reinit-');
  init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });
  const second = init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });
  // every path skipped on re-init was laid by the prior wrxn install → not a brownfield collision
  assert.equal(second.brownfield, false);
  assert.deepEqual(second.collisions, []);
});

test('recon config is present in a brownfield install; index covers existing code when recon is available (AC-2)', () => {
  const { dir } = brownfieldRepo('wrxn-bf-recon-');
  init({ pkgRoot: PKG_ROOT, target: dir, profile: 'project' });
  // the recon config drives on-demand indexing of the existing source (operator's .recon.json preserved)
  assert.ok(fs.existsSync(path.join(dir, '.recon.json')), 'recon config present in the install');

  let reconAvailable = true;
  try { execFileSync('recon', ['--version'], { stdio: 'ignore' }); } catch { reconAvailable = false; }
  if (!reconAvailable) {
    console.log('# SKIP recon live index+query over existing code — recon binary not in PATH');
    return;
  }
  execFileSync('recon', ['index'], { cwd: dir, stdio: 'ignore' });
  const out = execFileSync('recon', ['find', 'app'], { cwd: dir, encoding: 'utf8' });
  assert.ok(out.length > 0, 'recon answers a symbol query against the existing code');
});

test('wrxn init reports a brownfield collision via the CLI', () => {
  const { dir } = brownfieldRepo('wrxn-bf-cli-');
  const bin = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
  const out = execFileSync('node', [bin, 'init', '--project', '--root', dir], { encoding: 'utf8' });
  assert.match(out, /brownfield|collision/i);
  assert.match(out, /\.recon\.json/);
});
