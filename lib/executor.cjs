'use strict';

// WRXN builder-executor dispatch harness (wrxn-kernel-18).
// The kernel ships the executor CONTRACT, not a live LLM: buildDispatchSpec turns a ready-for-agent
// issue into the structured order a thin builder subagent follows (read the tdd skill, build red→green
// tdd-first, run isolated, NEVER push), and validateReport enforces the structured return + the
// boundary gates on whatever the subagent reports back. The first of the executor family (the rest —
// reviewer / security / qa-walker / researcher / devops — build on this pattern in wrxn-kernel-19).
//
// Pure data transforms (no I/O); the CLI (bin/wrxn.cjs dispatch) reads/writes files around them.

// The build skill the subagent MUST read+follow (never paraphrase — the skill text IS the loop).
const BUILD_SKILL = '.claude/skills/tdd/SKILL.md';

// The structured report a builder returns. Every field is required so a partial/garbled return is
// caught rather than silently accepted.
const REPORT_REQUIRED = ['issueId', 'status', 'redTest', 'greenCommit', 'typesClean', 'pushed', 'summary'];
const REPORT_STATUSES = ['completed', 'blocked'];

/**
 * Parse a ready-for-agent issue markdown into { id, title, labels, whatToBuild, acceptanceCriteria }.
 * Tolerant: missing sections yield empty values rather than throwing.
 */
function parseIssue(issueText) {
  const text = String(issueText || '');
  const fm = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : '';

  const scalar = (key) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };

  const labelsRaw = scalar('labels');
  const labels = labelsRaw
    ? labelsRaw.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // The acceptance-criteria checkboxes — ONLY the bullets under the "## Acceptance criteria" heading,
  // stopping at the next heading so "## Blocked by" bullets never leak in.
  const acceptanceCriteria = [];
  const lines = text.split('\n');
  let inAC = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inAC = /^##\s+acceptance criteria/i.test(line);
      continue;
    }
    if (inAC) {
      const m = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)$/);
      if (m) acceptanceCriteria.push(m[1].trim());
    }
  }

  const whatMatch = text.match(/##\s+What to build\s*\n+([\s\S]*?)(?:\n##\s|\n*$)/i);
  const whatToBuild = whatMatch ? whatMatch[1].trim() : '';

  return { id: scalar('id'), title: scalar('title'), labels, whatToBuild, acceptanceCriteria };
}

/**
 * Build the dispatch spec for a builder executor from an issue. The spec is the complete, self-
 * contained order the subagent follows — it points at the real skill file (read+follow, not a
 * paraphrase), carries the ACs, declares isolation, and states the boundary constraints.
 */
function buildDispatchSpec(issueText) {
  const issue = parseIssue(issueText);
  return {
    executor: 'builder',
    issue: { id: issue.id, title: issue.title },
    skill: BUILD_SKILL,
    procedure: [
      `Read ${BUILD_SKILL} FIRST, then follow it — it IS your build loop (never paraphrase it).`,
      'Build the slice test-first: write a failing (red) test, make it pass (green) with the minimal change, keep types clean.',
      'Commit locally with a conventional message referencing the issue id.',
      'Return the structured report described by reportSchema.',
    ],
    acceptanceCriteria: issue.acceptanceCriteria,
    isolation: 'fresh-context',
    constraints: [
      'Do NOT run git push — integration to the trunk is operator/devops-only (boundary gate).',
      'Do NOT edit managed files without the managed-confirm token.',
      'A review marker (review-<id>.md) is required downstream before this work is pushed.',
    ],
    reportSchema: { required: [...REPORT_REQUIRED], statuses: [...REPORT_STATUSES] },
  };
}

/**
 * Validate a builder's structured report against the contract + the boundary gates.
 * Returns { ok, errors }. A `completed` report must record the full tdd evidence (red test, a green
 * commit ref, types clean); ANY report claiming a push is a boundary violation. A `blocked` report is
 * valid without build evidence (an executor that escalated rather than built).
 */
function validateReport(report) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['report is not an object'] };
  }

  for (const key of REPORT_REQUIRED) {
    if (!(key in report)) errors.push(`missing field: ${key}`);
  }

  if ('status' in report && !REPORT_STATUSES.includes(report.status)) {
    errors.push(`invalid status: ${report.status} (one of ${REPORT_STATUSES.join(', ')})`);
  }

  // Boundary gate — an executor can NEVER push (integration is devops-only). Checked regardless of status.
  if (report.pushed === true) {
    errors.push('boundary violation: executor must not push (pushed=true)');
  }

  // Completion contract — full tdd evidence required only when the executor claims it finished.
  if (report.status === 'completed') {
    if (report.redTest !== true) errors.push('completed report must record a red test (redTest=true)');
    if (typeof report.greenCommit !== 'string' || !report.greenCommit.trim()) {
      errors.push('completed report must record a green commit (greenCommit sha/ref)');
    }
    if (report.typesClean !== true) errors.push('completed report must record types clean (typesClean=true)');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { parseIssue, buildDispatchSpec, validateReport, BUILD_SKILL, REPORT_REQUIRED, REPORT_STATUSES };
