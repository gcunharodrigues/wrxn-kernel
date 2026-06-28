'use strict';

// Tests for `wrxn release` — the one-command deliberate release (PRD #101, slice A / issue #102).
// Collapses the manual 4-step chore(release) dance into one command: compute bump → npm version →
// commit chore(release) on chore/release-X.Y.Z → delegate push/PR/arm to the `wrxn ship` path.
//
// The lib/ module boundary is the seam (mirrors test/ship.test.cjs + test/release.test.cjs):
//   - decideBump / releaseSpec are PURE → unit-tested directly.
//   - cutRelease orchestrates side effects through an INJECTED `deps` boundary (readState / applyBump /
//     commit / ship) — every guard refusal and the emitted ship-spec are asserted over fakes, with NO
//     live push (the ship delegation is faked). The CLI is exercised NON-DESTRUCTIVELY (guard refusals
//     only — never reaching a branch/commit/push).
// Prior art: test/ship.test.cjs (injected boundary, non-destructive CLI), test/release.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const rc = require('../lib/release-cut.cjs');
const WRXN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');

// ── decideBump is PURE: explicit arg wins ──────────────────────────────────────

test('decideBump uses the explicit level when given', () => {
  assert.deepEqual(rc.decideBump({ arg: 'minor' }), { bump: 'minor', source: 'explicit' });
});

test('decideBump auto-computes the bump from commits since the last tag when no level is given', () => {
  // REUSE lib/release.cjs shouldRelease: feat → minor, fix → patch, highest wins.
  assert.deepEqual(
    rc.decideBump({ commits: ['fix: a', 'feat: b', 'docs: c'], lastTag: 'v1.2.3' }),
    { bump: 'minor', source: 'auto' }
  );
});

test('decideBump REFUSES (no mutation) when no level is given and nothing is releasable — names the last tag', () => {
  const d = rc.decideBump({ commits: ['chore: tidy', 'docs: x'], lastTag: 'v1.2.3' });
  assert.equal(d.refuse, true);
  assert.match(d.reason, /nothing to release since v1\.2\.3/);
});

test('decideBump THROWS on an unknown explicit level (a malformed release is never runnable)', () => {
  assert.throws(() => rc.decideBump({ arg: 'huge' }), /unknown release level "huge"/);
});

// ── releaseSpec is PURE: post-bump pkg name+version → the release branch + chore(release) title ──

test('releaseSpec derives the chore/release-X.Y.Z branch and the chore(release): <pkg> X.Y.Z title', () => {
  assert.deepEqual(
    rc.releaseSpec({ name: '@gcunharodrigues/wrxn', version: '0.21.0' }),
    { branch: 'chore/release-0.21.0', title: 'chore(release): @gcunharodrigues/wrxn 0.21.0' }
  );
});

test('releaseSpec keeps a prerelease version verbatim (repo-agnostic — recon-wrxn ships 6.0.0-wrxn.N)', () => {
  assert.deepEqual(
    rc.releaseSpec({ name: 'recon-wrxn', version: '6.0.0-wrxn.10' }),
    { branch: 'chore/release-6.0.0-wrxn.10', title: 'chore(release): recon-wrxn 6.0.0-wrxn.10' }
  );
});

// ── cutRelease orchestrates through an INJECTED `deps` boundary (no live git/npm/push) ──

// A clean release-ready state: on main, clean tree, up to date, with a releasable feat since the tag.
function cleanState(over = {}) {
  return { branch: 'main', dirty: false, behind: 0, lastTag: 'v1.0.0', commits: ['feat: a thing'], name: 'pkg', version: '1.0.0', ...over };
}

// Recording fake deps. `over` lets a test override one boundary's return (e.g. a failing applyBump).
function fakeDeps(state, over = {}) {
  const calls = { applyBump: [], commit: [], ship: [] };
  return {
    calls,
    readState: () => state,
    applyBump: (bump) => { calls.applyBump.push(bump); return over.applyBump ? over.applyBump(bump) : { ok: true, newVersion: '1.1.0' }; },
    commit: (spec) => { calls.commit.push(spec); return over.commit ? over.commit(spec) : { ok: true }; },
    ship: (spec) => { calls.ship.push(spec); return over.ship ? over.ship(spec) : { ok: true, steps: [{ step: 'push', ok: true }] }; },
  };
}

const NO_MUTATION = { applyBump: [], commit: [], ship: [] };

test('cutRelease REFUSES (no mutation) when not on main', () => {
  const d = fakeDeps(cleanState({ branch: 'feature/x' }));
  const res = rc.cutRelease({ arg: 'minor', deps: d });
  assert.equal(res.refused, true);
  assert.match(res.reason, /not on main/);
  assert.deepEqual(d.calls, NO_MUTATION, 'a refused release mutates nothing');
});

test('cutRelease REFUSES (no mutation) when the working tree is dirty', () => {
  const d = fakeDeps(cleanState({ dirty: true }));
  const res = rc.cutRelease({ arg: 'minor', deps: d });
  assert.equal(res.refused, true);
  assert.match(res.reason, /dirty/i);
  assert.deepEqual(d.calls, NO_MUTATION);
});

test('cutRelease REFUSES (no mutation) when behind origin/main', () => {
  const d = fakeDeps(cleanState({ behind: 3 }));
  const res = rc.cutRelease({ arg: 'minor', deps: d });
  assert.equal(res.refused, true);
  assert.match(res.reason, /behind origin\/main/);
  assert.deepEqual(d.calls, NO_MUTATION);
});

test('cutRelease REFUSES (no mutation) when no level is given and nothing is releasable since the tag', () => {
  const d = fakeDeps(cleanState({ commits: ['chore: tidy', 'docs: x'], lastTag: 'v2.3.4' }));
  const res = rc.cutRelease({ deps: d }); // no arg
  assert.equal(res.refused, true);
  assert.match(res.reason, /nothing to release since v2\.3\.4/);
  assert.deepEqual(d.calls, NO_MUTATION);
});

test('cutRelease REFUSES (no mutation) on an unknown explicit level', () => {
  const d = fakeDeps(cleanState());
  const res = rc.cutRelease({ arg: 'enormous', deps: d });
  assert.equal(res.refused, true);
  assert.match(res.reason, /unknown release level "enormous"/);
  assert.deepEqual(d.calls, NO_MUTATION);
});

test('cutRelease (happy path) bumps, commits, then DELEGATES the exact spec to ship — base main', () => {
  // npm version is the version authority: applyBump returns the new version, which drives the
  // chore/release branch + chore(release) title that get committed and shipped.
  const d = fakeDeps(cleanState({ name: '@gcunharodrigues/wrxn', version: '0.20.0' }), {
    applyBump: () => ({ ok: true, newVersion: '0.21.0' }),
  });
  const res = rc.cutRelease({ arg: 'minor', deps: d });

  assert.equal(res.ok, true);
  assert.equal(res.version, '0.21.0');
  assert.equal(res.bump, 'minor');
  assert.equal(res.source, 'explicit');

  // npm version applied the chosen bump
  assert.deepEqual(d.calls.applyBump, ['minor']);
  // committed on the derived branch with the chore(release) title
  assert.deepEqual(d.calls.commit, [{ branch: 'chore/release-0.21.0', title: 'chore(release): @gcunharodrigues/wrxn 0.21.0' }]);
  // delegated to ship with the SAME branch/title and base main (push/PR/arm is ship's job — not reimplemented)
  assert.deepEqual(d.calls.ship, [{ branch: 'chore/release-0.21.0', title: 'chore(release): @gcunharodrigues/wrxn 0.21.0', base: 'main' }]);
});

test('cutRelease auto-bumps (no arg) from the commits and ships the computed version', () => {
  const d = fakeDeps(cleanState({ name: 'recon-wrxn', version: '6.0.0-wrxn.9', commits: ['fix: a patch'], lastTag: 'v6.0.0-wrxn.9' }), {
    applyBump: () => ({ ok: true, newVersion: '6.0.0-wrxn.10' }),
  });
  const res = rc.cutRelease({ deps: d }); // no arg → auto
  assert.equal(res.ok, true);
  assert.equal(res.source, 'auto');
  assert.equal(res.bump, 'patch');
  assert.deepEqual(d.calls.applyBump, ['patch']);
  assert.deepEqual(d.calls.ship, [{ branch: 'chore/release-6.0.0-wrxn.10', title: 'chore(release): recon-wrxn 6.0.0-wrxn.10', base: 'main' }]);
});

test('cutRelease STOPS if npm version fails — never commits or ships', () => {
  const d = fakeDeps(cleanState(), { applyBump: () => ({ ok: false, detail: 'npm version blew up' }) });
  const res = rc.cutRelease({ arg: 'patch', deps: d });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'npm-version');
  assert.deepEqual(d.calls.applyBump, ['patch']);
  assert.deepEqual(d.calls.commit, [], 'a failed bump never commits');
  assert.deepEqual(d.calls.ship, [], 'a failed bump never ships');
});

test('cutRelease STOPS if the commit fails — never ships', () => {
  const d = fakeDeps(cleanState(), {
    applyBump: () => ({ ok: true, newVersion: '1.1.0' }),
    commit: () => ({ ok: false, detail: 'commit rejected' }),
  });
  const res = rc.cutRelease({ arg: 'minor', deps: d });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'commit');
  assert.deepEqual(d.calls.ship, [], 'a failed commit never ships');
});

test('cutRelease surfaces a ship failure (push/PR/arm halted by ship — not reimplemented here)', () => {
  const d = fakeDeps(cleanState(), {
    applyBump: () => ({ ok: true, newVersion: '1.1.0' }),
    ship: () => ({ ok: false, failed: 'push', detail: 'push rejected' }),
  });
  const res = rc.cutRelease({ arg: 'minor', deps: d });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'ship');
  assert.equal(res.failed, 'push');
});

// ── CLI surface (CLI-First) — exercised NON-DESTRUCTIVELY: only guard refusals, which return BEFORE
// any npm version / branch / commit / push. Real bin + real realDeps over a throwaway repo. No push. ──

// A throwaway git repo on `main` with a committed package.json (clean tree, no remote → behind 0).
function gitRepo(prefix, pkgName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName || 'fixture-pkg', version: '1.0.0' }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: base');
  git('branch', '-M', 'main'); // deterministic trunk name across git versions
  return { dir, git };
}

function runRelease(dir, argv) {
  try {
    const stdout = execFileSync('node', [WRXN, 'release', ...argv, '--root', dir], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

test('CLI: wrxn release on a non-main branch refuses loud, exits non-zero, and creates NO branch', () => {
  const repo = gitRepo('wrxn-rel-notmain-');
  repo.git('checkout', '-q', '-b', 'feature/x');
  const r = runRelease(repo.dir, ['minor']);
  assert.notEqual(r.status, 0, 'a refused release exits non-zero');
  assert.match(r.stderr, /not on main/, 'refusal names the guard');
  assert.equal(repo.git('branch', '--list', 'chore/release-*'), '', 'no release branch was created (no mutation)');
});

test('CLI: wrxn release with an unknown level refuses loud and creates NO branch', () => {
  const repo = gitRepo('wrxn-rel-badarg-');
  const r = runRelease(repo.dir, ['enormous']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown release level "enormous"/);
  assert.equal(repo.git('branch', '--list', 'chore/release-*'), '', 'no release branch was created (no mutation)');
});

// ── #111: gitignoring acceptance/ scratch keeps the dirty-guard from tripping on the AFK pipeline's
// per-slice markers, WITHOUT weakening it for real uncommitted work. The guard logic (readState) is
// unchanged — the kernel's OWN root .gitignore does the work, so this drives the fix through the REAL
// shipped .gitignore (copied into a throwaway repo) and the real readState() seam (mirrors gitRepo). ──

test('readState: gitignored acceptance/ scratch reads CLEAN, but any other untracked path still reads dirty (#111)', () => {
  // Seed a throwaway repo with the kernel's REAL root .gitignore — the production artifact under test.
  const repo = gitRepo('wrxn-rel-acceptance-');
  fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(repo.dir, '.gitignore'));
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'chore: add .gitignore');
  const dirty = () => rc.realDeps(repo.dir).readState().dirty;

  // (1) ONLY acceptance/NNN/ AFK scratch present → gitignored → `git status --porcelain` is empty →
  //     the dirty-guard does NOT refuse the release.
  fs.mkdirSync(path.join(repo.dir, 'acceptance', '111'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, 'acceptance', '111', 'review-111.md'), '# review marker\n');
  assert.equal(dirty(), false, 'acceptance/ scratch must be gitignored so the dirty-guard stays clean');

  // (2) a stray untracked path is STILL dirty — the fix must not blanket-weaken the guard.
  fs.writeFileSync(path.join(repo.dir, 'foo.txt'), 'stray uncommitted work\n');
  assert.equal(dirty(), true, 'the dirty-guard must still fire for non-acceptance untracked work');
});

// ── reconciling docs (structural; mirrors test/release.test.cjs's release.yml checks) ──

const PKG_ROOT = path.join(__dirname, '..');

test('ADR 0010 records the deliberate-release decision and supersedes ADR 0007 pt 4', () => {
  const adr = path.join(PKG_ROOT, 'docs', 'adr', '0010-deliberate-release-not-autobump.md');
  assert.ok(fs.existsSync(adr), 'ADR 0010 missing');
  const body = fs.readFileSync(adr, 'utf8');
  assert.match(body, /supersed\w*\s+ADR 0007/i, 'ADR 0010 does not record it supersedes ADR 0007 pt 4');
  assert.match(body, /wrxn release/, 'ADR 0010 does not name the wrxn release helper');
  assert.match(body, /auto-bump/i, 'ADR 0010 does not contrast against auto-bump-on-merge');
  assert.match(body, /decidePublish|version.{0,12}npm/i, 'ADR 0010 does not explain CD publishes on merge');
});

test('ADR 0007 carries a one-line note that pt 4 is superseded by ADR 0010', () => {
  const body = fs.readFileSync(path.join(PKG_ROOT, 'docs', 'adr', '0007-push-gate-pr-ci-automerge.md'), 'utf8');
  assert.match(body, /supersed\w*\s+by\s+ADR 0010/i, 'ADR 0007 pt 4 is not marked superseded by ADR 0010');
});

test('CONTEXT.md gains the Release glossary term', () => {
  const ctx = fs.readFileSync(path.join(PKG_ROOT, 'CONTEXT.md'), 'utf8');
  assert.match(ctx, /\*\*Release\*\*/, 'no **Release** glossary term');
  assert.match(ctx, /chore\(release\)/, 'the Release term does not define it as a chore(release) PR');
});
