'use strict';

// wrxn release — one-command deliberate release (PRD #101 / issue #102).
//
// Collapses the manual 4-step chore(release) dance into one command: compute the bump, apply
// `npm version <bump> --no-git-tag-version`, commit `chore(release): <pkg> X.Y.Z` on
// `chore/release-X.Y.Z`, then DELEGATE push → PR(base main) → arm-auto-merge to the existing
// `wrxn ship` path. It does NOT publish or tag — CD owns that on merge (ADR 0010).
//
// REUSE > CREATE: the bump is computed by lib/release.cjs's `shouldRelease` (the release-check
// type-gate; its previously-vestigial `bump` is now consumed); the push/PR/arm is the existing
// lib/ship.cjs `ship`. New code is only the thin orchestration + guards.
//
// Side effects go through an INJECTED `deps` boundary (readState / applyBump / commit / ship),
// defaulting to the real git/npm/gh impls — so the whole flow is unit-testable with NO live push.
// This mirrors lib/ship.cjs's injected invoker, finer-grained per the tdd skill's mocking.md
// ("SDK-style boundary functions over one generic fetcher": each boundary returns one shape).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { shouldRelease, parseLog } = require('./release.cjs');
const ship = require('./ship.cjs');

const BUMPS = ['major', 'minor', 'patch'];
const TRUNK = 'main';
const DEFAULT_BASE = 'main';

function refusal(reason) {
  return { ok: false, refused: true, reason };
}

/**
 * Decide the release bump. PURE. An explicit level wins; otherwise it is auto-computed from the
 * conventional commits since the last tag (REUSE lib/release.cjs's release-check classifier — its
 * once-vestigial `bump` output is now consumed). No level AND nothing releasable → refuse.
 * @returns {{ bump:string, source:'explicit'|'auto' } | { refuse:true, reason:string }}
 * @throws on an unknown explicit level (a malformed release is never runnable).
 */
function decideBump({ arg, commits, lastTag } = {}) {
  if (arg != null && arg !== '') {
    if (!BUMPS.includes(arg)) throw new Error(`unknown release level "${arg}" — expected ${BUMPS.join(' | ')}`);
    return { bump: arg, source: 'explicit' };
  }
  const { release, bump } = shouldRelease(commits || []);
  if (!release) return { refuse: true, reason: `nothing to release since ${lastTag || 'the last release'}` };
  return { bump, source: 'auto' };
}

/**
 * The branch + PR title a release commits and ships, derived from the package name and the
 * post-bump version. PURE. Version is passed through verbatim so prerelease tags (recon-wrxn's
 * `6.0.0-wrxn.N`) survive — npm version is the authority on the new version, not this helper.
 * @returns {{ branch:string, title:string }}
 * @throws when name or version is missing.
 */
function releaseSpec({ name, version } = {}) {
  if (!name || !version) throw new Error('releaseSpec requires a package name and version');
  return {
    branch: `chore/release-${version}`,
    title: `chore(release): ${name} ${version}`,
  };
}

/**
 * Cut a deliberate release. Guards (each refuses loud, non-zero, NO mutation) → bump decision →
 * npm version → commit → delegate to ship. Side effects run through the injected `deps` boundary.
 * @returns {{ ok:true, ... } | { ok:false, refused?:true, reason?:string, step?:string, detail?:string }}
 */
function cutRelease({ arg, base = DEFAULT_BASE, root, deps } = {}) {
  const d = deps || realDeps(root || process.cwd());
  const state = d.readState();
  // ── guards ──
  if (state.branch !== TRUNK) return refusal(`not on ${TRUNK} (on "${state.branch}") — release is cut from ${TRUNK}`);
  if (state.dirty) return refusal('the working tree is dirty — commit or stash before releasing');
  if (state.behind > 0) return refusal(`behind origin/${TRUNK} by ${state.behind} — pull before releasing`);
  // ── bump decision (explicit arg wins; else auto from commits since the tag; else refuse) ──
  let decision;
  try {
    decision = decideBump({ arg, commits: state.commits, lastTag: state.lastTag });
  } catch (err) {
    return refusal(err.message);
  }
  if (decision.refuse) return refusal(decision.reason);
  // ── mutate: npm version (the version authority) → commit chore(release) → delegate to ship ──
  const applied = d.applyBump(decision.bump);
  if (!applied.ok) return { ok: false, step: 'npm-version', detail: applied.detail };
  const spec = releaseSpec({ name: state.name, version: applied.newVersion });
  const committed = d.commit({ branch: spec.branch, title: spec.title });
  if (!committed.ok) return { ok: false, step: 'commit', detail: committed.detail };
  const shipped = d.ship({ branch: spec.branch, title: spec.title, base });
  if (!shipped.ok) return { ok: false, step: 'ship', failed: shipped.failed, detail: shipped.detail, branch: spec.branch };
  return {
    ok: true,
    bump: decision.bump,
    source: decision.source,
    version: applied.newVersion,
    branch: spec.branch,
    title: spec.title,
    base,
  };
}

/**
 * The real side-effect boundary (the CLI layer wires this — what makes the release "validated by
 * invocation"). Each method is one SDK-style operation over the cwd repo, repo-agnostic (reads the
 * package.json + git in `root`, so the SAME command releases wrxn-kernel and recon-wrxn):
 *   readState — current branch, dirty, behind origin/main, last tag, commits since it, pkg name/version
 *   applyBump — `npm version <bump> --no-git-tag-version`; npm is the version authority (returns it)
 *   commit    — branch chore/release-X.Y.Z, stage package.json (+ lockfile if present), commit
 *   ship      — REUSE lib/ship.cjs (push → PR base main → arm auto-merge); NOT reimplemented here
 */
function realDeps(root) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
  return {
    readState() {
      let branch = '';
      try { branch = git('branch', '--show-current'); } catch { branch = ''; }
      let dirty = false;
      try { dirty = git('status', '--porcelain') !== ''; } catch { dirty = false; }
      // Best-effort fetch so "behind" reflects the real remote; never block on a fetch failure
      // (offline / no remote) — the server-side require-up-to-date ruleset is the hard gate.
      try { execFileSync('git', ['-C', root, 'fetch', 'origin', TRUNK, '--quiet'], { stdio: 'ignore' }); } catch { /* offline / no remote */ }
      let behind = 0;
      try { behind = parseInt(git('rev-list', '--count', `HEAD..origin/${TRUNK}`), 10) || 0; } catch { behind = 0; }
      let lastTag = '';
      try { lastTag = git('describe', '--tags', '--abbrev=0'); } catch { lastTag = ''; }
      let commits = [];
      try { commits = parseLog(git('log', '--format=%B%x00', lastTag ? `${lastTag}..HEAD` : 'HEAD')); } catch { commits = []; }
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return { branch, dirty, behind, lastTag, commits, name: pkg.name, version: pkg.version };
    },
    applyBump(bump) {
      try {
        execFileSync('npm', ['version', bump, '--no-git-tag-version'], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return { ok: true, newVersion: pkg.version };
      } catch (err) {
        return { ok: false, detail: `npm version ${bump} failed: ${err.message}` };
      }
    },
    commit({ branch, title }) {
      try {
        git('checkout', '-b', branch);
        const files = ['package.json'];
        if (fs.existsSync(path.join(root, 'package-lock.json'))) files.push('package-lock.json');
        git('add', '--', ...files);
        git('commit', '-m', title);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: `commit failed: ${err.message}` };
      }
    },
    ship({ branch, title, base }) {
      return ship.ship({ branch, title, base }); // real defaultInvoke (git push + gh)
    },
  };
}

module.exports = { decideBump, releaseSpec, cutRelease, realDeps, BUMPS, DEFAULT_BASE };
