'use strict';

// WRXN executor dispatch harness (wrxn-kernel-18 builder + wrxn-kernel-19 the remaining five).
// The kernel ships the executor CONTRACT, not a live LLM: buildDispatchSpec turns a ready-for-agent
// issue into the structured order a thin subagent of a given TYPE follows (which skill/instructions,
// which artifact, isolation, the boundary gates), and validateReport enforces the structured return +
// the boundary gates on whatever the subagent reports back. The push gate is type-aware: of the six
// executors only `devops` may pass it. The live LLM execution is out of scope — the harness is the
// proven contract.
//
// Pure data transforms (no I/O of their own); the CLI (bin/wrxn.cjs dispatch) reads/writes files around
// them. S5 adds retrievePriorKnowledge — an async retrieval orchestrator whose recon_find door is an
// INJECTED dependency (the CLI wires the real lib/brain.cjs door), so the module itself stays I/O-free.

const BUILD_SKILL = '.claude/skills/tdd/SKILL.md';

// The builder keeps the rich tdd report contract (wrxn-kernel-18); the other five report a generic
// type-specific `artifact` + the common boundary fields.
const BUILDER_REQUIRED = ['issueId', 'status', 'redTest', 'greenCommit', 'typesClean', 'pushed', 'summary'];
const GENERIC_REQUIRED = ['issueId', 'status', 'artifact', 'pushed', 'summary'];
const STATUSES = ['completed', 'blocked'];

// S5 dispatch-RAG (#24): the dispatch shell may inject prior knowledge recalled from the Brain so an
// executor starts warm. Capped to a small top-N — a builder wants a few high-signal references, not a
// digest. The same cap seeds the shell's recon_find limit (single source of truth).
const PRIOR_KNOWLEDGE_CAP = 5;
const PRIOR_KNOWLEDGE_NOTE =
  'Relevant prior knowledge recalled from your Brain for this issue — read it before re-deriving or re-asking the operator.';

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

// ── S5 dispatch-RAG: render injected prior knowledge into a capped section (PURE) ────────────────────
//
// The dispatch shell retrieves prose knowledge from the warm Brain (a recon_find seeded by the issue's
// referenced symbols) and injects it here. Each item is a recon prose hit ({ name, file }) OR a
// pre-rendered string; this normalizes every item to one clean line ("<title> — <path>"), dedups, and
// caps at PRIOR_KNOWLEDGE_CAP. TOTAL + defensive: a non-array / empty / all-junk input → [] (the no-op:
// buildDispatchSpec then omits the section, keeping the spec byte-identical to pre-S5). PURE — no I/O.
function priorKnowledgeLine(item) {
  if (typeof item === 'string') return item.replace(/\s+/g, ' ').trim();
  if (item && typeof item === 'object') {
    const name = String(item.name || '').replace(/\s+/g, ' ').trim();
    const file = String(item.file || '').trim();
    if (name && file) return `${name} — ${file}`;
    return name || file || '';
  }
  return '';
}

function renderPriorKnowledge(priorKnowledge) {
  const list = Array.isArray(priorKnowledge) ? priorKnowledge : [];
  const seen = new Set();
  const items = [];
  for (const it of list) {
    const line = priorKnowledgeLine(it);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    items.push(line);
    if (items.length >= PRIOR_KNOWLEDGE_CAP) break;
  }
  return items;
}

// ── S5 dispatch-RAG: seed a recon_find query from the issue's referenced symbols (PURE) ──────────────
//
// The dispatch shell needs a structural seed for the Brain. This REUSES slice F's buildStructuralQuery
// IDEA — basename-if-path, tokenize on non-alphanumerics, dedup case-insensitively, cap — but keyed off
// the ISSUE's referenced symbols rather than the session .touched paths. The "referenced symbols/paths"
// are the issue's single-token backtick code spans (function names, identifiers, file paths); multi-word
// backtick prose phrases are dropped (not symbols → stop-word noise). No backtick symbol → '' (the no-op
// seed: the shell then injects nothing). This transform is DUPLICATED from the payload hook
// recall-surface.cjs (buildStructuralQuery) ON PURPOSE — that hook is self-contained node-stdlib-only and
// cannot be imported by package code (the same cross-install-boundary trade lib/brain.cjs documents for
// the discovery contract). PURE — no I/O. (basename via lastIndexOf keeps this module dependency-free.)
const MAX_QUERY_CHARS = 512; // recon_find seed budget (mirrors recall-surface)

function buildIssueQuery(issueText) {
  const text = String(issueText || '');
  const spans = text.match(/`([^`\n]+)`/g) || [];
  const seen = new Set();
  const tokens = [];
  for (const span of spans) {
    const raw = span.slice(1, -1).trim();
    if (!raw || /\s/.test(raw)) continue; // a referenced symbol/path is a single token, never a prose phrase
    const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw; // a path reduces to its basename
    const bare = base.replace(/\.[^.]+$/, ''); // strip a trailing extension (lib/executor.cjs → executor)
    for (const t of bare.split(/[^A-Za-z0-9]+/)) {
      const tok = t.trim();
      if (!tok) continue;
      const key = tok.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(tok);
    }
  }
  return tokens.join(' ').slice(0, MAX_QUERY_CHARS);
}

/**
 * Build the dispatch spec for an executor of `executorType` (default 'builder') from an issue. The
 * spec is the complete, self-contained order the subagent follows: which skill to read+follow (or
 * the explicit instructions for a global-only skill), the issue ACs, isolation, the boundary
 * constraints, and the structured reportSchema. `priorKnowledge` (optional, injected by the dispatch
 * shell) is rendered as a capped "Relevant prior knowledge" section ONLY when non-empty — with nothing
 * injected the spec is byte-identical to pre-S5 (AC-2). Stays PURE (no I/O).
 */
function buildDispatchSpec(issueText, executorType = 'builder', priorKnowledge = []) {
  const def = EXECUTORS[executorType];
  if (!def) throw new Error(`unknown executor type: ${executorType} (one of ${EXECUTOR_TYPES.join(', ')})`);
  const issue = parseIssue(issueText);
  const priorItems = renderPriorKnowledge(priorKnowledge);
  return {
    executor: executorType,
    issue: { id: issue.id, title: issue.title },
    skill: def.skill,
    ...(def.skill ? {} : { instructions: def.instructions.slice() }),
    procedure: def.procedure ? def.procedure.slice() : deriveProcedure(def),
    artifact: def.artifact,
    acceptanceCriteria: issue.acceptanceCriteria,
    // Present ONLY when the shell injected knowledge — with none, the spec is byte-identical to pre-S5.
    ...(priorItems.length ? { priorKnowledge: { note: PRIOR_KNOWLEDGE_NOTE, items: priorItems } } : {}),
    isolation: def.isolation,
    constraints: constraintsFor(def),
    reportSchema: { required: [...def.required], statuses: [...STATUSES] },
  };
}

// ── S5 dispatch-RAG: the retrieval orchestrator (IO injected; the impure shell wires the real door) ──
//
// Policy layer between the issue and the warm Brain: seed → find → cap, FAIL-OPEN. `find(seed) -> hits`
// is INJECTED (the IO seam, like brain.query's transport): bin/wrxn.cjs wires it to lib/brain.cjs
// (recon_find with type:'prose', so the hits are already prose-filtered) — keeping this unit-testable
// with no live recon. No referenced symbols → empty seed → the door is never queried → []. Any fault
// (unreachable door, non-200, malformed body) → [] — dispatch then proceeds exactly as today
// (byte-identical spec). The cap is PRIOR_KNOWLEDGE_CAP (also the shell's recon_find limit);
// renderPriorKnowledge re-caps defensively. Never throws.
async function retrievePriorKnowledge(issueText, { find } = {}) {
  if (typeof find !== 'function') return [];
  const seed = buildIssueQuery(issueText);
  if (!seed) return []; // no referenced symbols → nothing to retrieve (fail-open)
  let hits;
  try {
    hits = await find(seed);
  } catch {
    return []; // unreachable recon / non-200 / malformed → fail-open
  }
  if (!Array.isArray(hits) || !hits.length) return []; // empty Brain → nothing injected
  return hits.slice(0, PRIOR_KNOWLEDGE_CAP);
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
  PRIOR_KNOWLEDGE_CAP,
  buildIssueQuery,
  retrievePriorKnowledge,
};
