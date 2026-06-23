'use strict';

// Tests for the builder-executor dispatch harness (wrxn-kernel-18).
// The kernel ships the executor CONTRACT deterministically: buildDispatchSpec turns a ready-for-agent
// issue into the structured order a thin builder subagent follows (read the tdd skill, build red→green,
// stay isolated, never push); validateReport enforces the structured return + the boundary gates. The
// live LLM execution is out of scope here — the harness is what this proves.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const PKG_ROOT = path.join(__dirname, '..');
const { parseIssue, buildDispatchSpec, validateReport } = require('../lib/executor.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

const FIXTURE_ISSUE = [
  '---',
  'id: wrxn-kernel-99',
  'title: "Fixture: add a greeting helper"',
  'status: open',
  'labels: [ready-for-agent]',
  '---',
  '',
  '## What to build',
  '',
  'A greet(name) helper that returns "hello, <name>".',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] greet("world") returns "hello, world"',
  '- [ ] greet("") throws on empty input',
  '',
  '## Blocked by',
  '',
  '- wrxn-kernel-08',
  '',
].join('\n');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function goodReport() {
  return {
    issueId: 'wrxn-kernel-99',
    status: 'completed',
    redTest: true,
    greenCommit: 'abc1234',
    typesClean: true,
    pushed: false,
    summary: 'greet helper built tdd-first',
  };
}

// ── parseIssue ────────────────────────────────────────────────────────────────

test('parseIssue extracts id, title and the acceptance criteria', () => {
  const issue = parseIssue(FIXTURE_ISSUE);
  assert.equal(issue.id, 'wrxn-kernel-99');
  assert.match(issue.title, /greeting helper/);
  assert.equal(issue.acceptanceCriteria.length, 2, 'both ACs parsed');
  assert.match(issue.acceptanceCriteria[0], /hello, world/);
  // The "## Blocked by" bullets must NOT leak into the ACs.
  assert.ok(!issue.acceptanceCriteria.some((a) => /wrxn-kernel-08/.test(a)), 'blocked-by not captured as an AC');
});

// ── buildDispatchSpec (AC-1 tdd order, AC-2 isolation, AC-3 boundary) ─────────

test('buildDispatchSpec orders the tdd skill, isolation and the boundary constraints', () => {
  const spec = buildDispatchSpec(FIXTURE_ISSUE);
  assert.match(spec.skill, /tdd\/SKILL\.md$/, 'points at the real tdd skill file');
  assert.equal(spec.issue.id, 'wrxn-kernel-99');
  assert.ok(spec.acceptanceCriteria.length === 2, 'ACs carried into the spec');
  assert.match(spec.isolation, /fresh/i, 'runs isolated / fresh context (AC-2)');
  const procedure = spec.procedure.join(' ').toLowerCase();
  assert.ok(/red/.test(procedure) && /green/.test(procedure), 'procedure orders red→green tdd (AC-1)');
  const constraints = spec.constraints.join(' ').toLowerCase();
  assert.match(constraints, /push/, 'a no-push boundary constraint (AC-3)');
  assert.match(constraints, /review marker|review-/, 'review-marker-required-downstream constraint (AC-3)');
  assert.ok(Array.isArray(spec.reportSchema.required) && spec.reportSchema.required.includes('greenCommit'),
    'declares the structured report schema (AC-2)');
});

// ── devops promotes via `wrxn ship`, not the retired env-flag dance (gate-redesign gate-04) ──
// The WRXN_ACTIVE_AGENT / settings.local.json gate was proven a live no-op (2026-06-19 audit F1):
// CC injects the env additively and a file "revert" never unsets it, so the documented dance
// degraded to permanent-allow. It is replaced by `wrxn ship` (push the branch → open a PR → arm
// auto-merge); the server-side CI ruleset is the authority. The devops dispatch spec must carry the
// new model with NO trace of the retired dance.

test('devops dispatch spec promotes via `wrxn ship`, with NO WRXN_ACTIVE_AGENT / settings.local.json dance', () => {
  const spec = buildDispatchSpec(FIXTURE_ISSUE, 'devops');
  const guidance = JSON.stringify(spec);
  assert.match(guidance, /wrxn ship/, 'promotes via the `wrxn ship` command (PR + auto-merge)');
  assert.doesNotMatch(guidance, /WRXN_ACTIVE_AGENT/, 'the retired env-flag must be gone (audit F1: a live no-op)');
  assert.doesNotMatch(guidance, /settings\.local\.json/, 'the settings.local.json dance must be gone');
  assert.doesNotMatch(guidance, /AIOX_ACTIVE_AGENT/, 'no legacy variable name');
  // devops is still the single push path — the spec must mark it the authorized pusher.
  assert.equal(spec.executor, 'devops');
  assert.match(JSON.stringify(spec.constraints).toLowerCase(), /push/, 'devops carries the push-path constraints');
});

// ── S5 dispatch-RAG (#24): buildDispatchSpec injects relevant prior knowledge ──
// Every AFK executor starts warm instead of cold. buildDispatchSpec stays PURE: it gains an optional
// injected `priorKnowledge` arg and renders it as a capped "Relevant prior knowledge" section; with
// nothing injected the spec is byte-identical to today. The retrieval (a recon_find query seeded by
// the issue's symbols, prose-filtered + capped) is the impure shell's job — exercised below via
// retrievePriorKnowledge (IO injected) and the CLI integration test (a fake warm door).

const {
  buildIssueQuery,
  retrievePriorKnowledge,
  PRIOR_KNOWLEDGE_CAP,
} = require('../lib/executor.cjs');

test('buildDispatchSpec renders a capped "Relevant prior knowledge" section when priorKnowledge is injected (AC-1)', () => {
  const knowledge = [
    { name: 'recall-surface door race', file: '.wrxn/wiki/sessions/2026-06-19.md' },
    { name: 'dispatch harness', file: '.wrxn/wiki/concepts/dispatch.md' },
  ];
  const spec = buildDispatchSpec(FIXTURE_ISSUE, 'builder', knowledge);
  assert.ok(spec.priorKnowledge, 'a priorKnowledge section is present when knowledge is injected');
  assert.match(JSON.stringify(spec.priorKnowledge), /relevant prior knowledge/i, 'the section is labelled "Relevant prior knowledge"');
  assert.ok(Array.isArray(spec.priorKnowledge.items), 'it carries an items list');
  assert.ok(spec.priorKnowledge.items.length <= PRIOR_KNOWLEDGE_CAP, 'capped to the small top-N');
  const rendered = spec.priorKnowledge.items.join('\n');
  assert.match(rendered, /recall-surface door race/, 'a hit name surfaces');
  assert.match(rendered, /sessions\/2026-06-19\.md/, 'with its source path so the agent can open it');
});

test('buildDispatchSpec is BYTE-IDENTICAL to today when nothing is injected (AC-2 no-op lock)', () => {
  // The cornerstone guarantee: an empty / absent injection adds NO key and changes NO bytes. Both the
  // two-arg call (today's call site) and an explicit empty injection must equal the same pre-S5 shape.
  const PRE_S5_KEYS = ['executor', 'issue', 'skill', 'procedure', 'artifact', 'acceptanceCriteria', 'isolation', 'constraints', 'reportSchema'];
  const noArg = buildDispatchSpec(FIXTURE_ISSUE);
  const emptyArg = buildDispatchSpec(FIXTURE_ISSUE, 'builder', []);
  assert.ok(!('priorKnowledge' in noArg), 'no priorKnowledge key when the arg is omitted');
  assert.ok(!('priorKnowledge' in emptyArg), 'no priorKnowledge key when the arg is []');
  assert.deepEqual(Object.keys(noArg), PRE_S5_KEYS, 'the spec key set is exactly the pre-S5 set');
  assert.equal(JSON.stringify(noArg, null, 2), JSON.stringify(emptyArg, null, 2), 'empty injection ≡ no injection, byte for byte');
});

test('buildDispatchSpec omits the section for an all-junk injection (defensive no-op)', () => {
  const spec = buildDispatchSpec(FIXTURE_ISSUE, 'builder', [null, 42, {}, { name: '', file: '' }, '  ']);
  assert.ok(!('priorKnowledge' in spec), 'unusable items render nothing → no section, spec unchanged');
});

test('buildDispatchSpec caps the injected section at the top-N (AC-1)', () => {
  const many = Array.from({ length: PRIOR_KNOWLEDGE_CAP + 4 }, (_, i) => ({ name: `page ${i}`, file: `.wrxn/wiki/concepts/p${i}.md` }));
  const spec = buildDispatchSpec(FIXTURE_ISSUE, 'builder', many);
  assert.equal(spec.priorKnowledge.items.length, PRIOR_KNOWLEDGE_CAP, 'never more than the cap surfaces');
});

// ── S5: the dispatch shell's seed builder — issue symbols → a recon_find query (PURE) ────────────────
// Reuses slice F's structural-query idea (basename, tokenize on non-alphanumerics, dedup, cap) keyed off
// the issue's REFERENCED SYMBOLS — the single-token backtick code spans (function names, paths) — rather
// than the session .touched paths. Multi-word backtick prose phrases are dropped: they are not symbols
// and would inject stop-word noise into the seed.

test("buildIssueQuery seeds a recon_find query from the issue's backtick symbols/paths (AC-3)", () => {
  const issue = [
    '## What to build',
    'Extend `buildDispatchSpec` so the `dispatch` shell queries `recon_find`.',
    'The `recon_find` door is reused. Touch `lib/executor.cjs` and `bin/wrxn.cjs`.',
    'Reuse the `.touched` idea. `Relevant prior knowledge` must NOT seed the query.',
  ].join('\n');
  const seed = buildIssueQuery(issue);
  const tokens = seed.split(' ');
  assert.ok(tokens.includes('buildDispatchSpec'), 'a symbol span seeds verbatim (no camel-split, mirrors slice F)');
  assert.ok(tokens.includes('recon') && tokens.includes('find'), 'recon_find tokenizes on non-alphanumerics');
  assert.ok(tokens.includes('executor'), 'a path span reduces to its basename (lib/executor.cjs → executor)');
  assert.ok(tokens.includes('wrxn'), 'bin/wrxn.cjs → wrxn');
  assert.equal(tokens.filter((t) => t === 'recon').length, 1, 'a symbol referenced twice appears once (deduped)');
  assert.ok(!/relevant|knowledge/i.test(seed), 'a multi-word prose phrase in backticks does NOT seed the query');
});

test('buildIssueQuery returns the empty (no-op) seed when the issue references no symbols', () => {
  assert.equal(buildIssueQuery('## What to build\n\nplain prose, no code spans at all.'), '', 'no backtick symbols → empty seed');
  assert.equal(buildIssueQuery(''), '', 'empty issue → empty seed');
  assert.equal(buildIssueQuery(null), '', 'non-string → empty seed');
});

// ── S5: retrievePriorKnowledge — the IO-injected retrieval orchestrator (seed → find → cap, fail-open) ─
// The dispatch shell's policy layer: build the seed from the issue symbols, call the injected `find`
// (the warm-Brain recon_find — wired to lib/brain.cjs in bin, prose-filtered there), cap to top-N, and
// FAIL OPEN on any fault. No live recon needed — `find` is injected (mirrors brain.query's transport seam).

test('retrievePriorKnowledge seeds find with the issue query and caps the result to the top-N (AC-3)', async () => {
  const issue = '## What to build\n\nExtend `buildDispatchSpec` in `lib/executor.cjs`.';
  let calledWith = null;
  const find = async (seed) => {
    calledWith = seed;
    return Array.from({ length: PRIOR_KNOWLEDGE_CAP + 3 }, (_, i) => ({ name: `p${i}`, type: 'Page', file: `.wrxn/wiki/concepts/p${i}.md` }));
  };
  const pk = await retrievePriorKnowledge(issue, { find });
  assert.equal(calledWith, buildIssueQuery(issue), 'find is called with the issue-symbol seed');
  assert.ok(calledWith.includes('buildDispatchSpec') && calledWith.includes('executor'), 'the seed carries the issue symbols');
  assert.equal(pk.length, PRIOR_KNOWLEDGE_CAP, 'the retrieved set is capped to the top-N');
});

test('retrievePriorKnowledge FAILS OPEN: an unreachable door (find throws) → [] (AC-4)', async () => {
  let pk;
  await assert.doesNotReject(async () => {
    pk = await retrievePriorKnowledge('Touch `lib/executor.cjs`.', { find: async () => { throw new Error('Brain is not warm'); } });
  }, 'a door fault never makes dispatch throw');
  assert.deepEqual(pk, [], 'nothing is injected when recon is unreachable');
});

test('retrievePriorKnowledge: an empty Brain (find returns []) injects nothing (AC-4)', async () => {
  const pk = await retrievePriorKnowledge('Touch `lib/executor.cjs`.', { find: async () => [] });
  assert.deepEqual(pk, [], 'an empty result set → no prior knowledge');
});

test('retrievePriorKnowledge: an issue with NO referenced symbols never queries the door → [] (AC-4)', async () => {
  let called = false;
  const pk = await retrievePriorKnowledge('plain prose, no code spans', { find: async () => { called = true; return [{ name: 'x', file: 'y' }]; } });
  assert.equal(called, false, 'no symbols → no seed → the door is never queried');
  assert.deepEqual(pk, [], 'and nothing is injected');
});

// ── validateReport (AC-2 structured, AC-1 completion, AC-3 boundary) ──────────

test('validateReport accepts a well-formed completion report', () => {
  const r = validateReport(goodReport());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReport REJECTS a report that claims a push (boundary gate, AC-3)', () => {
  const r = validateReport({ ...goodReport(), pushed: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /push/i.test(e)), 'flags the boundary violation');
});

test('validateReport REJECTS a completion missing the green commit / red test / types (AC-1)', () => {
  assert.equal(validateReport({ ...goodReport(), greenCommit: '' }).ok, false, 'no green commit');
  assert.equal(validateReport({ ...goodReport(), redTest: false }).ok, false, 'no red test');
  assert.equal(validateReport({ ...goodReport(), typesClean: false }).ok, false, 'types not clean');
});

test('validateReport accepts a blocked report without a green commit', () => {
  const r = validateReport({
    issueId: 'wrxn-kernel-99', status: 'blocked', redTest: false, greenCommit: '',
    typesClean: false, pushed: false, summary: 'blocked: ambiguous AC, escalating',
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateReport rejects a non-object / missing fields', () => {
  assert.equal(validateReport(null).ok, false);
  assert.equal(validateReport({}).ok, false);
});

// ── CLI (CLI-First) ───────────────────────────────────────────────────────────

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [WRXN, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('CLI: wrxn dispatch <issue> prints a valid JSON dispatch spec', () => {
  const d = tmp('wrxn-exec-cli-');
  const issuePath = path.join(d, 'issue.md');
  fs.writeFileSync(issuePath, FIXTURE_ISSUE);
  const { code, stdout } = runCli(['dispatch', issuePath]);
  assert.equal(code, 0);
  const spec = JSON.parse(stdout);
  assert.equal(spec.issue.id, 'wrxn-kernel-99');
  assert.match(spec.skill, /tdd/);
});

test('CLI: wrxn dispatch --check-report exits 0 on a good report, non-zero on a push violation', () => {
  const d = tmp('wrxn-exec-check-');
  const good = path.join(d, 'good.json');
  const bad = path.join(d, 'bad.json');
  fs.writeFileSync(good, JSON.stringify(goodReport()));
  fs.writeFileSync(bad, JSON.stringify({ ...goodReport(), pushed: true }));

  assert.equal(runCli(['dispatch', '--check-report', good]).code, 0);
  const badRun = runCli(['dispatch', '--check-report', bad]);
  assert.notEqual(badRun.code, 0);
  assert.match(badRun.stderr, /push/i);
});

// ── CLI integration (S5 dispatch-RAG, #24): the shell queries the warm Brain and injects knowledge ───
// Proves the FULL shell path end-to-end against a FAKE warm door (a loopback recon_find server + a
// serve-endpoint.json the child discovers): bin/wrxn.cjs seeds recon_find from the issue symbols (via
// lib/brain.cjs), prose-filters + caps, and renders the section. The door runs IN-PROCESS, so the child
// must be spawned ASYNC (a sync child would block the event loop and the door could never answer). The
// fail-open path uses a sync child: with NO door the printed spec is byte-identical to today.

// An issue that REFERENCES symbols (backtick spans) so buildIssueQuery yields a non-empty seed.
const SYMBOL_ISSUE = [
  '---', 'id: wrxn-kernel-99', 'title: "add a greet helper"', 'labels: [ready-for-agent]', '---', '',
  '## What to build', '', 'Add a `greet` helper in `lib/greet.cjs`.', '',
  '## Acceptance criteria', '', '- [ ] `greet("world")` returns a greeting', '',
].join('\n');

function startFakeDoor(onFind) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const out = onFind(req.url, parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return server;
}

function writeServeEndpoint(dir, port) {
  fs.mkdirSync(path.join(dir, '.recon-wrxn'), { recursive: true });
  const file = path.join(dir, '.recon-wrxn', 'serve-endpoint.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port }));
  fs.chmodSync(file, 0o600); // endpointTrusted refuses a group/world-writable discovery file
}

test('CLI: wrxn dispatch injects a capped "Relevant prior knowledge" section from the warm Brain (AC-3)', async () => {
  const dir = tmp('wrxn-s5-cli-');
  const issuePath = path.join(dir, 'issue.md');
  fs.writeFileSync(issuePath, SYMBOL_ISSUE);

  let seenQuery = null;
  let seenLimit = null;
  const server = startFakeDoor((_url, parsed) => {
    seenQuery = parsed.query;
    seenLimit = parsed.limit;
    return { result: '', hits: [
      { name: 'greeting conventions', type: 'Page', file: '.wrxn/wiki/concepts/greeting.md' },
      { name: 'edge cases for greet', type: 'Section', file: '.wrxn/wiki/concepts/greeting.md', line: 12 },
      { name: 'a code symbol', type: 'Function', file: 'lib/greet.cjs', line: 3 }, // NOT prose → must be dropped
    ] };
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeServeEndpoint(dir, server.address().port);
  try {
    const { stdout } = await execFileP('node', [WRXN, 'dispatch', issuePath], {
      encoding: 'utf8', cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    const spec = JSON.parse(stdout);
    assert.ok(spec.priorKnowledge, 'the spec carries a prior-knowledge section retrieved from the door');
    assert.match(JSON.stringify(spec.priorKnowledge), /relevant prior knowledge/i, 'labelled');
    const rendered = spec.priorKnowledge.items.join('\n');
    assert.match(rendered, /greeting conventions/, 'a prose hit surfaces');
    assert.ok(!/a code symbol/.test(rendered), 'a non-prose (code) hit is filtered out (prose-only, AC-3)');
    assert.ok(spec.priorKnowledge.items.length <= 5, 'capped to the small top-N');
    assert.ok(seenQuery && /greet/i.test(seenQuery), 'the door was seeded from the issue symbols (recon_find query)');
    assert.equal(seenLimit, 5, 'the recon_find request is capped to the top-N limit');
  } finally {
    server.close();
  }
});

test('CLI: wrxn dispatch is byte-identical (no priorKnowledge) when the Brain is not warm (AC-4 fail-open)', () => {
  const dir = tmp('wrxn-s5-nodoor-');
  const issuePath = path.join(dir, 'issue.md');
  fs.writeFileSync(issuePath, SYMBOL_ISSUE); // has symbols, but there is NO warm door to query
  const { code, stdout } = runCli(['dispatch', issuePath], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.equal(code, 0, 'dispatch never blocks on an unreachable Brain');
  const spec = JSON.parse(stdout);
  assert.ok(!('priorKnowledge' in spec), 'no warm door → no prior-knowledge section (fail-open)');
  assert.match(spec.skill, /tdd/, 'and the dispatch spec is produced exactly as today');
});
