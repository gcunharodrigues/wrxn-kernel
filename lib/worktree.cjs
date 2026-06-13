'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Worktree engine — the ephemeral-track face of the worktree lifecycle (PRD US14).
 *
 * One module providing the git plumbing + safety checks an orchestrator needs to run AFK
 * parallel tracks: a disjoint-file gate (refuse overlapping splits), create-track, integrate-back,
 * and a safe prune that NEVER deletes unmerged work. Named durable worktrees (US15) are a later
 * issue (17) that reuses this same plumbing.
 *
 * All git access shells out via execFileSync; a non-zero git exit becomes a thrown Error so the
 * caller can surface it (and, for prune, so unmerged work is preserved rather than force-dropped).
 */

// Two faces of the one lifecycle module share this engine, distinguished by branch prefix:
//   track/  — ephemeral AFK tracks (default; temp path, auto-pruned at integrate).
//   wt/     — named durable HITL worktrees (createNamedWorktree; persistent path, operator-pruned).
const BRANCH_PREFIX = 'track/';
const NAMED_PREFIX = 'wt/';

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts }).trim();
}

function branchName(name, prefix = BRANCH_PREFIX) {
  return prefix + name;
}

/**
 * Refuse an overlapping track split (the File List Intersection Matrix — AC-2).
 * @param {Array<{name:string, files:string[]}>} tracks
 * @returns {{ ok: true, pairs: Array<[string,string]> }}
 * @throws if any two tracks share a file (the shared paths are named in the error).
 */
function verifyDisjoint(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = new Set(list[i].files || []);
      const overlap = (list[j].files || []).filter((f) => a.has(f));
      if (overlap.length) {
        throw new Error(
          `tracks "${list[i].name}" and "${list[j].name}" both touch: ${overlap.join(', ')} — ` +
          `split is not disjoint (assign each shared file to ONE track or serialize)`
        );
      }
      pairs.push([list[i].name, list[j].name]);
    }
  }
  return { ok: true, pairs };
}

/** Default EPHEMERAL worktree location — OS temp dir (auto-pruned at integrate), keyed by repo + name. */
function defaultPath(repo, name) {
  return path.join(os.tmpdir(), 'wrxn-worktrees', path.basename(path.resolve(repo)), name);
}

/** Default NAMED-DURABLE location — a persistent sibling dir of the repo, so it survives session close. */
function durablePath(repo, name) {
  const resolved = path.resolve(repo);
  return path.join(path.dirname(resolved), path.basename(resolved) + '.worktrees', name);
}

/**
 * Create a worktree on a fresh `<prefix><name>` branch off `base` (AC-1 creation). The default
 * prefix is the ephemeral `track/`; the named face passes `wt/` + a durable path.
 * @param {string} repo  the install/repo root
 * @param {string} name  the worktree name (the branch becomes <prefix><name>)
 * @param {{base?:string, path?:string, prefix?:string}} [opts]
 * @returns {{ name:string, branch:string, path:string, base:string }}
 */
function createWorktree(repo, name, opts = {}) {
  const base = opts.base || 'main';
  const prefix = opts.prefix || BRANCH_PREFIX;
  const wtPath = path.resolve(opts.path || defaultPath(repo, name));
  const branch = branchName(name, prefix);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repo, ['worktree', 'add', wtPath, '-b', branch, base]);
  return { name, branch, path: wtPath, base };
}

/**
 * Create a NAMED DURABLE worktree (the HITL face — PRD US15). Same engine as createWorktree, but on
 * a `wt/<name>` branch at a persistent path so the operator can live in it across sessions and
 * integrate/prune it on command (prune still refuses unmerged work via the shared pruneWorktree).
 * @returns {{ name:string, branch:string, path:string, base:string }}
 */
function createNamedWorktree(repo, name, opts = {}) {
  const wtPath = path.resolve(opts.path || durablePath(repo, name));
  return createWorktree(repo, name, { base: opts.base, path: wtPath, prefix: NAMED_PREFIX });
}

/** Parse `git worktree list --porcelain` into [{path, head, branch}] (branch is the short ref). */
function listWorktrees(repo) {
  const out = git(repo, ['worktree', 'list', '--porcelain']);
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null };
      entries.push(cur);
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

/** Resolve the on-disk path of the worktree holding <prefix><name>, or null. */
function resolveWorktreePath(repo, name, prefix = BRANCH_PREFIX) {
  const branch = branchName(name, prefix);
  const hit = listWorktrees(repo).find((w) => w.branch === branch);
  return hit ? hit.path : null;
}

/**
 * Status of a worktree (the named-face listing surface — AC-1 "listed with status"):
 * clean/dirty (uncommitted changes) + ahead/behind commit counts vs `base`.
 * @returns {{ name, branch, path, clean, ahead, behind }}
 */
function worktreeStatus(repo, name, opts = {}) {
  const prefix = opts.prefix || BRANCH_PREFIX;
  const base = opts.base || 'main';
  const branch = branchName(name, prefix);
  const wtPath = resolveWorktreePath(repo, name, prefix);
  const dirty = wtPath ? git(wtPath, ['status', '--porcelain']) : '';
  const ahead = Number(git(repo, ['rev-list', '--count', `${base}..${branch}`]) || 0);
  const behind = Number(git(repo, ['rev-list', '--count', `${branch}..${base}`]) || 0);
  return { name, branch, path: wtPath, clean: dirty === '', ahead, behind };
}

/**
 * Integrate a track back into base, then auto-prune (AC-1 integrate + AC-3 prune).
 * Assumes the PRIMARY worktree is on a clean `base` (the AFK orchestrator flow): a dirty/conflicting
 * tree makes the checkout/merge throw (fail-closed), preserving the track.
 * Merges track/<name> into base in the primary worktree, removes the track worktree, and deletes
 * the branch with the SAFE `-d` (which only succeeds because the merge just made it merged). A merge
 * conflict throws and leaves everything in place (nothing is pruned — the work is preserved).
 * @returns {{ name, branch, base, merged:true }}
 */
function integrateWorktree(repo, name, opts = {}) {
  const base = opts.base || 'main';
  const prefix = opts.prefix || BRANCH_PREFIX;
  const branch = branchName(name, prefix);
  const wtPath = resolveWorktreePath(repo, name, prefix);

  // Bring base into the primary worktree and merge the track in. A conflict / non-zero exit throws.
  git(repo, ['checkout', base]);
  try {
    git(repo, ['merge', '--no-ff', '-m', `integrate ${branch}`, branch]);
  } catch (err) {
    // Abort a half-done merge so the repo is left clean; the track branch + worktree survive.
    try { git(repo, ['merge', '--abort']); } catch { /* nothing to abort */ }
    throw new Error(`integrate ${branch} failed (merge conflict?) — track preserved: ${err.message}`);
  }

  if (wtPath) git(repo, ['worktree', 'remove', '--force', wtPath]);
  git(repo, ['worktree', 'prune']);
  git(repo, ['branch', '-d', branch]); // safe delete: branch is now merged into base
  return { name, branch, base, merged: true };
}

/**
 * Prune an ephemeral worktree + its branch. SAFETY (AC-4): a branch with unmerged commits is
 * NEVER deleted unless `force` is set — `git branch -d` refuses the unmerged delete, and we surface
 * that as a thrown Error with the worktree left intact. `force` (operator override) uses -D + --force.
 */
function pruneWorktree(repo, name, opts = {}) {
  const base = opts.base || 'main';
  const prefix = opts.prefix || BRANCH_PREFIX;
  const branch = branchName(name, prefix);
  const wtPath = resolveWorktreePath(repo, name, prefix);
  const force = !!opts.force;

  // SAFETY PROBE FIRST (AC-4): commits on the branch but not in base = unmerged work. Decide BEFORE
  // touching anything so a refusal leaves the worktree AND the branch fully intact. (`git branch -d`
  // alone is the wrong gate: a still-checked-out branch fails it for being checked-out, not unmerged.)
  if (!force) {
    const unmerged = git(repo, ['rev-list', `${base}..${branch}`]);
    if (unmerged) {
      throw new Error(`refusing to prune "${branch}": it has unmerged commits (integrate it, or use force to discard)`);
    }
  }

  // Safe (or forced): remove the worktree FIRST (frees the branch checkout), then delete the branch.
  if (wtPath) {
    try { git(repo, ['worktree', 'remove', '--force', wtPath]); } catch { /* already gone */ }
  }
  git(repo, ['worktree', 'prune']);
  try {
    git(repo, ['branch', force ? '-D' : '-d', branch]);
  } catch (err) {
    if (!force) throw new Error(`could not delete "${branch}": ${err.message}`);
  }
  return { name, branch, pruned: true, forced: force };
}

module.exports = {
  verifyDisjoint,
  createWorktree,
  createNamedWorktree,
  worktreeStatus,
  listWorktrees,
  resolveWorktreePath,
  integrateWorktree,
  pruneWorktree,
  BRANCH_PREFIX,
  NAMED_PREFIX,
};
