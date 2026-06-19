'use strict';

// Pure flow-status aggregator (wrxn-kernel flow-05).
// flowStatus(issues, artifacts) reconstructs each slice's gate progress from durable artifacts —
// no separate mutable state, no I/O, no time-of-day logic. The CLI (bin/wrxn.cjs flow status)
// wraps this with the actual file reads and git log detection.

// The four pipeline gates in order: build (green commit) → review (marker) → security → qa (walk).
const GATES = ['build', 'review', 'security', 'qa'];

/**
 * Map one issue's artifact entry to gate booleans.
 * A gate is done only when its artifact field is a non-empty truthy string — never a false pass.
 */
function gatesFor(artifact) {
  const a = artifact || {};
  return {
    build:    !!(a.greenCommit    && typeof a.greenCommit === 'string'    && a.greenCommit.trim()),
    review:   !!(a.reviewMarker   && typeof a.reviewMarker === 'string'   && a.reviewMarker.trim()),
    security: !!(a.securityReport && typeof a.securityReport === 'string' && a.securityReport.trim()),
    qa:       !!(a.walkFindings   && typeof a.walkFindings === 'string'   && a.walkFindings.trim()),
  };
}

/**
 * Derive one slice's overall state from its gate booleans and whether it still has an
 * UNRESOLVED blocker (a listed dependency whose own slice is not yet fully done).
 *
 * done        — all four gates done (wins over any listed blocker: completion is never masked)
 * queued      — an unresolved blocker, or no gates done at all
 * stalled     — build done but review not done (stuck at the first critical handoff, never reviewed)
 * in-progress — any other partial completion (review done, or build+review but security/qa pending)
 */
function sliceState(gates, hasUnresolvedBlocker) {
  const { build, review, security, qa } = gates;
  if (build && review && security && qa) return 'done';
  if (hasUnresolvedBlocker) return 'queued';
  if (!build && !review && !security && !qa) return 'queued';
  if (build && !review) return 'stalled';
  return 'in-progress';
}

/**
 * flowStatus(issues, artifacts) → per-issue board array.
 *
 * issues    — Array<{ id: string, title?: string, blockedBy?: string[] }>
 * artifacts — { [id: string]: { greenCommit?, reviewMarker?, securityReport?, walkFindings? } }
 *
 * Returns Array<{ id, title, gates: { build, review, security, qa }, state }> where each gate
 * value is 'done'|'pending' and state is 'done'|'in-progress'|'queued'|'stalled'.
 */
function flowStatus(issues, artifacts) {
  const arts = artifacts || {};
  const list = issues || [];

  // First pass: each slice's gate booleans + the set of fully-done slice ids (all four gates).
  const gatesById = new Map();
  const doneIds = new Set();
  for (const issue of list) {
    const g = gatesFor(arts[issue.id]);
    gatesById.set(issue.id, g);
    if (g.build && g.review && g.security && g.qa) doneIds.add(issue.id);
  }

  // Second pass: resolve each slice's state. A blocker is RESOLVED once its own slice is fully done;
  // a slice is queued only when it still lists an UNRESOLVED blocker (or has no gate progress).
  return list.map((issue) => {
    const id = issue.id;
    const g = gatesById.get(id);
    const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
    const hasUnresolvedBlocker = blockedBy.some((b) => !doneIds.has(b));
    const state = sliceState(g, hasUnresolvedBlocker);
    return {
      id,
      title: issue.title || '',
      gates: {
        build:    g.build    ? 'done' : 'pending',
        review:   g.review   ? 'done' : 'pending',
        security: g.security ? 'done' : 'pending',
        qa:       g.qa       ? 'done' : 'pending',
      },
      state,
    };
  });
}

module.exports = { flowStatus, GATES };
