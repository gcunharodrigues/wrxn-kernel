'use strict';

const protect = require('../lib/protect.cjs');

/**
 * 005 — apply the wrxn-main-gate ruleset on existing installs (gate-redesign gate-02).
 *
 * The server-side hard gate (block direct push to the default branch, require a PR + the wrxn-ci check,
 * require the branch up-to-date, no bypass actor) replaces the disarmable settings.local.json env-flag
 * gate (ADR 0007). `wrxn update` now applies the ruleset to an install's origin as part of its run, but
 * a pre-0.11.0 install never ran that step — so this migration performs the FIRST application on an
 * existing install once it reaches the release that carries the gate.
 *
 * up() delegates to protect.protectOrigin(ctx.target): derive the install's origin slug and idempotently
 * create-or-update the ruleset via `gh api`. Repo-agnostic (the slug comes from origin, so the SAME
 * logic protects the kernel, every install, and the recon-wrxn sibling) and fail-soft by construction —
 * no gh / not admin / no remote → a skipped result, never a throw. A remote-less install derives no slug
 * and is a pure no-op (no `gh` call). Defensive like 003/004: the try/catch is belt-and-braces so the
 * migration can never fail the runner even if protection somehow threw. `version` 0.11.0 = the release
 * that carries the push-gate redesign (the same release whose `update` gained the protect step).
 */
module.exports = {
  id: '005',
  version: '0.11.0',
  up(ctx) {
    try {
      protect.protectOrigin(ctx.target);
    } catch {
      // protection is fail-soft by design — swallow defensively so the migration never breaks `update`.
    }
  },
};
