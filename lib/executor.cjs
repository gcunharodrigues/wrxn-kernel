'use strict';

// WRXN executor dispatch harness (wrxn-kernel-18 builder + wrxn-kernel-19 the remaining five).
// The kernel ships the executor CONTRACT, not a live LLM: buildDispatchSpec turns a ready-for-agent
// issue into the structured order a thin subagent of a given TYPE follows (which skill/instructions,
// which artifact, isolation, the boundary gates), and validateReport enforces the structured return +
// the boundary gates on whatever the subagent reports back. The push gate is type-aware: of the six
// executors only `devops` may pass it. The live LLM execution is out of scope — the harness is the
// proven contract.
//
// Pure data transforms (no I/O); the CLI (bin/wrxn.cjs dispatch) reads/writes files around them.

const BUILD_SKILL = '.claude/skills/tdd/SKILL.md';

// The builder keeps the rich tdd report contract (wrxn-kernel-18); the other five report a generic
// type-specific `artifact` + the common boundary fields.
const BUILDER_REQUIRED = ['issueId', 'status', 'redTest', 'greenCommit', 'typesClean', 'pushed', 'summary'];
const GENERIC_REQUIRED = ['issueId', 'status', 'artifact', 'pushed', 'summary'];
const STATUSES = ['completed', 'blocked'];

// The executor registry — one entry per type. `skill: null` means the loop is a GLOBAL slash-skill
// with no local file (code-review / security-review / the devops push), so the spec carries explicit
// `instructions` instead (the subagent has no Skill tool — it cannot /invoke). `canPush` gates the
// push: only devops may report pushed=true.
const EXECUTORS = {
  builder: {
    skill: BUILD_SKILL,
    artifact: 'green-commit',
    canPush: false,
    isolation: 'fresh-context',
    required: BUILDER_REQUIRED,
    procedure: [
      `Read ${BUILD_SKILL} FIRST, then follow it — it IS your build loop (never paraphrase it).`,
      'Build the slice test-first: write a failing (red) test, make it pass (green) with the minimal change, keep types clean.',
      'Commit locally with a conventional message referencing the issue id.',
      'Return the structured report described by reportSchema.',
    ],
  },
  reviewer: {
    skill: null, // /code-review is a global slash-skill — no local file to read
    instructions: [
      'You are a fresh-eyes code reviewer. /code-review is a global slash-skill with no local file, and',
      'subagents have no Skill tool — follow these instructions directly: review the diff against the',
      'PRD / issue contracts, verify every claim against ALL sources before flagging, and separate',
      'blocking from non-blocking findings. Write the review marker review-<id>.md.',
    ],
    artifact: 'review-marker',
    canPush: false,
    isolation: 'fresh-context',
    required: GENERIC_REQUIRED,
  },
  security: {
    skill: null, // /security-review is a global slash-skill — no local file
    instructions: [
      'You are a defensive security reviewer. /security-review is a global slash-skill with no local',
      'file — follow these instructions directly: scan the diff for injection, path traversal, authz /',
      'secret handling, and fail-open/closed posture; report PASS / PASS-WITH-FINDINGS / FAIL with evidence.',
    ],
    artifact: 'security-report',
    canPush: false,
    isolation: 'fresh-context',
    required: GENERIC_REQUIRED,
  },
  'qa-walker': {
    skill: '.claude/skills/qa-walk/SKILL.md',
    artifact: 'walk-findings',
    canPush: false,
    isolation: 'fresh-context',
    required: GENERIC_REQUIRED,
  },
  researcher: {
    skill: '.claude/skills/tech-search/SKILL.md',
    artifact: 'research-summary',
    canPush: false,
    isolation: 'fresh-context',
    required: GENERIC_REQUIRED,
  },
  devops: {
    skill: null, // the integration / promote executor — instructions; the ONLY type that may push
    instructions: [
      'You are the devops integration executor — the ONLY executor authorized to promote a track to the',
      'trunk. Verify the track is reviewed + security-passed + qa-walked and you are on the reviewed branch,',
      'then promote with ONE command: `wrxn ship --title "<conventional PR title>"` — it pushes the branch,',
      'opens a PR, and arms auto-merge (`gh pr merge --auto --squash`). No env flag, no settings file, no',
      'GitHub clicks. Confirm auto-merge is armed; the server-enforced CI ruleset then merges to the trunk',
      'the instant CI is green. This is the single promote path through the push gate.',
    ],
    artifact: 'authorized-push',
    canPush: true,
    isolation: 'attended',
    required: GENERIC_REQUIRED,
  },
};

const EXECUTOR_TYPES = Object.keys(EXECUTORS);

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

  // Only the bullets under "## Acceptance criteria", stopping at the next heading so "## Blocked by"
  // bullets never leak in.
  const acceptanceCriteria = [];
  let inAC = false;
  for (const line of text.split('\n')) {
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

/** The procedure for a non-builder executor: read the skill (or follow instructions), then produce the artifact. */
function deriveProcedure(def) {
  const head = def.skill
    ? [`Read ${def.skill} FIRST, then follow it — it IS your loop (never paraphrase it).`]
    : def.instructions.slice();
  return [...head, `Produce your artifact: ${def.artifact}.`, 'Return the structured report described by reportSchema.'];
}

/** Boundary constraints for an executor — type-aware on the push gate. */
function constraintsFor(def) {
  if (def.canPush) {
    return [
      'You are the ONLY executor authorized to push (the push gate passes for devops alone).',
      'Push only AFTER verifying the review marker (review-<id>.md) + a green suite.',
      'Do NOT edit managed files without the managed-confirm token.',
    ];
  }
  return [
    'Do NOT run git push — only the devops executor may (boundary gate; integration is devops-only).',
    'Do NOT edit managed files without the managed-confirm token.',
    'A review marker (review-<id>.md) is required downstream before this work is pushed.',
  ];
}

/**
 * Build the dispatch spec for an executor of `executorType` (default 'builder') from an issue. The
 * spec is the complete, self-contained order the subagent follows: which skill to read+follow (or
 * the explicit instructions for a global-only skill), the issue ACs, isolation, the boundary
 * constraints, and the structured reportSchema.
 */
function buildDispatchSpec(issueText, executorType = 'builder') {
  const def = EXECUTORS[executorType];
  if (!def) throw new Error(`unknown executor type: ${executorType} (one of ${EXECUTOR_TYPES.join(', ')})`);
  const issue = parseIssue(issueText);
  return {
    executor: executorType,
    issue: { id: issue.id, title: issue.title },
    skill: def.skill,
    ...(def.skill ? {} : { instructions: def.instructions.slice() }),
    procedure: def.procedure ? def.procedure.slice() : deriveProcedure(def),
    artifact: def.artifact,
    acceptanceCriteria: issue.acceptanceCriteria,
    isolation: def.isolation,
    constraints: constraintsFor(def),
    reportSchema: { required: [...def.required], statuses: [...STATUSES] },
  };
}

/**
 * Validate an executor's structured report against the contract + the boundary gates for its type.
 * Returns { ok, errors }. The push gate is type-aware: a report claiming pushed=true is a boundary
 * violation for every type EXCEPT devops. A `completed` builder report must carry full tdd evidence;
 * a `completed` generic report must carry a non-empty artifact; a `completed` devops report must
 * record the authorized push (pushed=true). A `blocked` report is valid without evidence.
 */
function validateReport(report, executorType = 'builder') {
  const def = EXECUTORS[executorType];
  if (!def) return { ok: false, errors: [`unknown executor type: ${executorType}`] };

  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, errors: ['report is not an object'] };
  }

  for (const key of def.required) {
    if (!(key in report)) errors.push(`missing field: ${key}`);
  }
  if ('status' in report && !STATUSES.includes(report.status)) {
    errors.push(`invalid status: ${report.status} (one of ${STATUSES.join(', ')})`);
  }

  // Boundary push gate — only devops may report a push.
  if (report.pushed === true && !def.canPush) {
    errors.push(`boundary violation: the ${executorType} executor must not push (pushed=true)`);
  }

  // Completion contract (per type) — checked only when the executor claims it finished.
  if (report.status === 'completed') {
    if (executorType === 'builder') {
      if (report.redTest !== true) errors.push('completed builder report must record a red test (redTest=true)');
      if (typeof report.greenCommit !== 'string' || !report.greenCommit.trim()) {
        errors.push('completed builder report must record a green commit (greenCommit sha/ref)');
      }
      if (report.typesClean !== true) errors.push('completed builder report must record types clean (typesClean=true)');
    } else {
      if (typeof report.artifact !== 'string' || !report.artifact.trim()) {
        errors.push(`completed ${executorType} report must record a non-empty artifact (${def.artifact})`);
      }
      if (def.canPush && report.pushed !== true) {
        errors.push('completed devops report must record the authorized push (pushed=true) — it is the push path');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  parseIssue,
  buildDispatchSpec,
  validateReport,
  BUILD_SKILL,
  EXECUTORS,
  EXECUTOR_TYPES,
  STATUSES,
};
