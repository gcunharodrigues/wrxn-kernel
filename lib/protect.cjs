'use strict';

// WRXN protect — the server-side hard gate (gate-redesign gate-02).
//
// A client-side hook can never be hard enforcement (it gates one tool surface, not the repository).
// The only control that survives every bypass — human terminal, IDE, MCP, API, `--no-verify`, the
// 2026-06-19 settings.local.json disarm bug — is a SERVER-SIDE GitHub branch ruleset. This module
// builds and applies the `wrxn-main-gate` ruleset on a repo's `origin`: block direct push to the
// default branch, require a PR (0 approvals — a solo account auto-merges its own PR), require the
// `wrxn-ci` status check, require the branch up to date (race-safety), and NO bypass actor.
//
// Application is idempotent (create-or-update BY NAME — re-run = no-op) and fail-soft (no `gh`, not a
// repo admin, no remote, or any non-zero exit → a clear message and exit 0, never a throw, so it can
// never break `wrxn update` on a remote-less install). REUSE of lib/connect.cjs's injectable-invoker
// shape: an injected `invoker` makes unit tests deterministic; the real `spawnSync gh`/`git` runs only
// when no invoker is injected (the CLI layer) — that is what makes the application "validated by
// invocation". The ruleset is repo-agnostic via `~DEFAULT_BRANCH`, so the SAME spec protects any
// default-main repo (the kernel, every install, and the recon-wrxn sibling — gate-06).
//
// lib/protect.cjs is package code (invoked via bin/wrxn.cjs), NOT payload — no manifest entry,
// consistent with lib/connect.cjs / lib/ship.cjs / lib/executor.cjs / lib/onboard.cjs.

const { spawnSync } = require('child_process');

const RULESET_NAME = 'wrxn-main-gate';
const DEFAULT_CHECK = 'wrxn-ci';

/**
 * Build the `wrxn-main-gate` GitHub repository-ruleset payload. PURE — a fresh, independent object
 * each call, no side effects. The authoritative payload (gate-02 API contract): block direct push to
 * the default branch, require a PR with 0 approvals, require `requiredCheck` strict (up-to-date), no
 * bypass actor. `~DEFAULT_BRANCH` keeps it repo-agnostic (no hard-coded `main`).
 * @param {{ requiredCheck?: string }} [opts]
 * @returns {object} the ruleset payload for POST/PUT `/repos/{slug}/rulesets`
 */
function buildRulesetSpec({ requiredCheck = DEFAULT_CHECK } = {}) {
  return {
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: requiredCheck }],
        },
      },
    ],
  };
}

/**
 * The real command invoker — a single spawnSync (mirrors lib/ship.cjs / lib/connect.cjs defaultInvoke).
 * Captures stdout (needed to parse the ruleset list) and passes a body on stdin (the create/update).
 * The CLI layer wires this implicitly (no injected invoker) — that is what makes the apply real.
 * @returns {{ ok:boolean, status:number|null, stdout:string, stderr:string }}
 */
function defaultInvoke({ cmd, args, input }) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: input || undefined });
  if (r.error) {
    return { ok: false, status: null, stdout: '', stderr: r.error.code || r.error.message };
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** A fail-soft skip result — a logged-elsewhere reason, never a throw, so it never breaks `wrxn update`. */
function softSkip(reason) {
  return { ok: false, action: 'skipped', reason };
}

/** One-line failure detail from an invoker result (status + first stderr line). */
function detailOf(r) {
  const status = r.status == null ? 'no exit (command not found?)' : `exit ${r.status}`;
  const err = String(r.stderr || '').trim().split('\n')[0];
  return err ? `${status}: ${err}` : status;
}

/**
 * Apply the `wrxn-main-gate` ruleset to `slug`'s repo via `gh api`. Idempotent (list → create-or-update
 * BY NAME, so a re-run converges to a no-op) and fail-soft (no gh / not admin / no remote / any
 * non-zero exit → a skipped result carrying a clear reason; NEVER throws). The invoker is injectable so
 * unit tests are deterministic; the CLI layer uses the real `gh` spawn.
 * @param {{ invoker?:Function, slug?:string, requiredCheck?:string }} [opts]
 * @returns {{ ok:boolean, action:'created'|'updated'|'skipped', slug?:string, name?:string, detail?:string, reason?:string }}
 */
function applyProtection({ invoker, slug, requiredCheck = DEFAULT_CHECK } = {}) {
  const run = invoker || defaultInvoke;

  if (!slug || typeof slug !== 'string' || slug.trim() === '') {
    return softSkip('no origin remote — the wrxn-main-gate ruleset is not applied (a remote-less install is unprotected here; protection lands when it gains a GitHub origin)');
  }

  // 1. list existing rulesets — the idempotency lookup (find one named wrxn-main-gate).
  const list = run({ cmd: 'gh', args: ['api', `/repos/${slug}/rulesets`] });
  if (!list.ok) {
    return softSkip(`could not list rulesets on ${slug} (${detailOf(list)}) — is gh installed, authenticated, and admin on the repo? skipping (exit 0)`);
  }
  let rulesets;
  try {
    rulesets = JSON.parse(list.stdout || '[]');
  } catch {
    return softSkip(`unexpected gh output listing rulesets on ${slug} — skipping`);
  }
  const existing = Array.isArray(rulesets) ? rulesets.find((r) => r && r.name === RULESET_NAME) : null;
  const body = JSON.stringify(buildRulesetSpec({ requiredCheck }));

  // 2. update in place (PUT to the existing id) if present, else create (POST) — re-run = no-op.
  if (existing) {
    const put = run({ cmd: 'gh', args: ['api', '--method', 'PUT', `/repos/${slug}/rulesets/${existing.id}`, '--input', '-'], input: body });
    if (!put.ok) {
      return softSkip(`could not update the ${RULESET_NAME} ruleset on ${slug} (${detailOf(put)}) — skipping`);
    }
    return { ok: true, action: 'updated', slug, name: RULESET_NAME, detail: `${RULESET_NAME} updated on ${slug}` };
  }
  const post = run({ cmd: 'gh', args: ['api', '--method', 'POST', `/repos/${slug}/rulesets`, '--input', '-'], input: body });
  if (!post.ok) {
    return softSkip(`could not create the ${RULESET_NAME} ruleset on ${slug} (${detailOf(post)}) — is the token a repo admin? skipping`);
  }
  return { ok: true, action: 'created', slug, name: RULESET_NAME, detail: `${RULESET_NAME} created on ${slug}` };
}

/** A well-formed GitHub `owner/repo` slug: owner starts alphanumeric, repo is alnum/`.`/`_`/`-`. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * Parse an `owner/repo` slug from a git remote URL (ssh `git@host:owner/repo.git`, https
 * `https://host/owner/repo.git`, with or without the `.git` suffix / a trailing slash) or a bare
 * `owner/repo`. The captured slug is then VALIDATED against the GitHub owner/repo grammar (gate-02
 * LOW-1, defense-in-depth): `..` traversal, spaces, `;`, `$()`, backticks, and `--flag`-looking text
 * are rejected → null, so a malformed remote fail-soft-skips instead of reaching `gh` as data. Returns
 * null when no well-formed slug can be read — protection then fail-soft-skips.
 */
function parseSlug(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const m = s.match(/(?:^|[:/])([^/:]+\/[^/:]+?)(?:\.git)?\/?$/);
  const slug = m ? m[1] : null;
  return slug && SLUG_RE.test(slug) ? slug : null;
}

/**
 * Derive the `owner/repo` slug of a repo's `origin` remote. Injectable git invoker for tests; the
 * real `git` spawn runs at the CLI/update/migration layer. Returns null on no origin / parse failure
 * (→ applyProtection soft-skips) — never throws.
 */
function originSlug(root, { invoker } = {}) {
  const run = invoker || defaultInvoke;
  const r = run({ cmd: 'git', args: ['-C', root, 'remote', 'get-url', 'origin'] });
  if (!r.ok) return null;
  return parseSlug(r.stdout);
}

/**
 * Derive the origin slug of the install at `root` and apply the ruleset to it. The single entry point
 * the CLI (`wrxn protect`), `wrxn update`, and migration 005 share. Repo-agnostic (the slug is read
 * from origin, so it works for the kernel, any install, and recon-wrxn) and fail-soft end-to-end (a
 * remote-less root → applyProtection's no-remote skip; never throws). Both invokers are injectable.
 * @param {string} root install/repo root
 * @param {{ gitInvoker?:Function, ghInvoker?:Function, requiredCheck?:string }} [opts]
 */
function protectOrigin(root, { gitInvoker, ghInvoker, requiredCheck } = {}) {
  const slug = originSlug(root, { invoker: gitInvoker });
  return applyProtection({ slug, invoker: ghInvoker, requiredCheck });
}

module.exports = {
  RULESET_NAME,
  DEFAULT_CHECK,
  buildRulesetSpec,
  defaultInvoke,
  applyProtection,
  parseSlug,
  originSlug,
  protectOrigin,
};
