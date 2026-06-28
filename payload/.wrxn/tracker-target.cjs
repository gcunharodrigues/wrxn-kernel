'use strict';

// WRXN cross-repo tracker targeting — the ONE shared resolver behind `to-prd --repo`,
// `to-issues --repo`, and `triage --repo` (PRD #114 / issue #115). It closes the cross-repo seam ADR
// 0009 only documented (refs #81 AC#4): from a workspace-install session, `--repo owner/repo` lets the
// HITL skills spec / slice / triage a sibling GitHub repo (the kernel, recon-wrxn) onto that repo's
// GitHub tracker — without leaving the four-phase pipeline or hand-filing past the adherence guard.
//
// Self-contained: this ships INTO an install and MUST NOT import the kernel lib (node stdlib only).
// The seam mirrors lib/release-cut.cjs: the decision is a PURE core (resolveTarget — parse / validate /
// select-mechanism), and the gh create/label/close side-effects run through an INJECTED `gh` boundary,
// so the decision + emitted spec are unit-testable with NO live gh.

// owner/repo: a GitHub-legal ALLOWLIST, not a slash/space blocklist — this is the security chokepoint.
// The skill wirings steer the agent to hand-compose `gh -R owner/repo` Bash, so the validator is the one
// place that must reject anything that could change the meaning of that command. Allow ONLY what GitHub
// itself permits: owner = alphanumerics + hyphens but NOT a leading hyphen (a leading `-` would let `gh`
// read the whole value as a flag — argument injection); repo = alphanumerics + `.` `_` `-`. This refuses
// every shell metacharacter (`;` `$()` backtick `|` `&` `>`), embedded whitespace, a trailing slash, an
// extra path segment, and an empty value by construction — all must refuse loud BEFORE any publish.
// (Reviewer/security convergent finding — FIX 1.)
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

// The shared wrxn triage label vocab — the states already carried on the kernel and recon-wrxn. A label
// means the same thing across repos; there is NO per-target label config (YAGNI for GitHub siblings).
// gh fails loud if a target lacks one of these (free remote validation) — publishIssue never swallows it.
const TRIAGE_LABELS = ['ready-for-agent', 'backlog', 'epic'];

/**
 * Resolve the tracker target for an invocation. PURE — the whole cross-repo decision, no side effect.
 *   - `--repo` ABSENT (rawRepo nullish) → the install's configured default tracker (today's local-md
 *     `.scratch/` path, unchanged). `defaultConfig` IS that default descriptor; the kernel default is
 *     local-md (reconfiguring the default is out of scope — the override is per-invocation).
 *   - `--repo owner/repo` (valid) → `{ mechanism:'github', repo, ghBaseArgs:['-R', repo] }`. GitHub by
 *     construction; NO git-remote inference — tracker TYPE is a config choice, not derivable from a remote
 *     (the install proves it: GitHub remote, local-md tracker).
 *   - `--repo` PRESENT but malformed / empty / whitespace / trailing → THROW a loud, user-facing Error
 *     BEFORE any side-effect, so a bad invocation never half-files (US-5).
 * @param {string|undefined|null} rawRepo  the raw `--repo` value (absent ⇒ nullish)
 * @param {{mechanism:string}} [defaultConfig]  the install's default tracker descriptor (local-md today)
 * @returns {{mechanism:'local'}|{mechanism:'github',repo:string,ghBaseArgs:string[]}}
 */
function resolveTarget(rawRepo, defaultConfig = { mechanism: 'local' }) {
  if (rawRepo == null) return defaultConfig; // --repo omitted → the configured default tracker
  if (typeof rawRepo !== 'string' || !OWNER_REPO.test(rawRepo)) {
    throw new Error(
      `--repo must be "owner/repo" (got ${JSON.stringify(rawRepo)}) — e.g. gcunharodrigues/wrxn-kernel`,
    );
  }
  return { mechanism: 'github', repo: rawRepo, ghBaseArgs: ['-R', rawRepo] };
}

/**
 * Publish an issue onto a resolved GitHub target, applying ONE label drawn from the shared wrxn vocab.
 * The `gh` runner is an INJECTED boundary (it executes the built argv) — mirroring release-cut's injected
 * `deps`, so this is unit-testable with no live gh and the emitted spec is asserted over a fake. Guards
 * refuse LOUD before the boundary (a non-github target, or an off-vocab label → no silent mis-label); a
 * gh failure (e.g. the target repo lacks the label) is NOT swallowed — it propagates so a mis-labeled or
 * unfiled issue never lands silently (US-6, US-7).
 * @param {{target:object,title:string,body:string,label:string}} spec
 * @param {(argv:string[])=>any} gh  the injected gh runner (the real impl shells `gh` with these args)
 * @returns whatever the gh runner returns
 */
function publishIssue({ target, title, body, label } = {}, gh) {
  if (!target || target.mechanism !== 'github') {
    throw new Error(`publishIssue targets a github tracker (got mechanism "${target && target.mechanism}")`);
  }
  if (!TRIAGE_LABELS.includes(label)) {
    throw new Error(`label "${label}" is off the shared wrxn vocab — expected one of ${TRIAGE_LABELS.join(' | ')}`);
  }
  if (typeof gh !== 'function') throw new Error('publishIssue requires an injected gh runner');
  const argv = ['issue', 'create', ...target.ghBaseArgs, '--title', title, '--body', body, '--label', label];
  return gh(argv); // the side-effect lives at the boundary; a gh failure propagates loud (no swallow)
}

module.exports = { resolveTarget, publishIssue, TRIAGE_LABELS, OWNER_REPO };
