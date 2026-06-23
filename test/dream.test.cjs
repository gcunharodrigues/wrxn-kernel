'use strict';

// dream adapter — the install-local Validation gate + audit/commit CLI (issue dream-01).
// Driven exactly as the dream skill (dream-02) will drive it: CLI invocation with --root against a
// temp install root, asserting external behavior (the verdict / the files written), never internals.
// Mirrors wiki.test.cjs (CLI + --root + manifest-class assertions).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const { stampImportance, stampLineage, stampEvidence, resolveEvidence, sha256, resolveRevert } = require('../payload/.wrxn/dream.cjs'); // pure stamp + revert seams

const DREAM = '.wrxn/dream.cjs';
const WIKI = '.wrxn/wiki.cjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Run the dream adapter as the real install would (separate process, rooted at the install).
function dream(target, args, input) {
  const full = [path.join(target, DREAM), ...args, '--root', target];
  return execFileSync('node', full, { encoding: 'utf8', input });
}

// Drive the wiki adapter directly (test setup: lay an existing page; non-recall assertion).
function wiki(target, args) {
  return execFileSync('node', [path.join(target, WIKI), ...args, '--root', target], { encoding: 'utf8' });
}

// Write a JSON file under the install and return its absolute path.
function writeJson(target, name, obj) {
  const p = path.join(target, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A schema-valid proposal (passes every gate check) — overlay fields to craft a single violation.
function validProposal(over) {
  return Object.assign(
    {
      kind: 'decision',
      tier: 'decisions',
      slug: 'adopt-trunk-based-dev',
      title: 'Adopt trunk-based development',
      body: '# Trunk-based development\n\nWe merge small changes straight to main behind required gates.',
      confidence: 0.9,
      rationale: 'Locks the branching policy so future sessions know why the repo is the way it is.',
      evidence: [{ quote: 'we decided to merge to main behind required gates', source: 'turn-12' }],
    },
    over || {}
  );
}

function checkOne(target, proposal) {
  return JSON.parse(dream(target, ['check', writeJson(target, 'p.json', proposal)]));
}

function checkBatch(target, batch) {
  return JSON.parse(dream(target, ['check', writeJson(target, 'b.json', batch)]));
}

// stage a batch (the precondition for commit-by-reference) — returns the parsed stage result.
function stage(target, proposals) {
  return JSON.parse(dream(target, ['stage', writeJson(target, 'batch.json', { proposals })]));
}

// commit BY REFERENCE — approved is the operator-approved SLUG list (["slug-a"] or { approved:[…] }).
function commit(target, approved) {
  return JSON.parse(dream(target, ['commit', writeJson(target, 'approved.json', approved)]));
}

// Write staged.jsonl directly (simulate a tampered/stale audit trail for the re-gate security probes).
function seedStaged(target, records) {
  const dir = path.join(target, '.wrxn', 'dream');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'staged.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ── check: the well-formed accept path + every per-proposal reason code ────────

test('check returns ok:true for a well-formed proposal on a fresh install', () => {
  const t = freshInstall('dream-ok-');
  const v = checkOne(t, validProposal());
  assert.deepEqual(v, { ok: true });
});

test('confidence below 0.75 → confidence_below_threshold', () => {
  const t = freshInstall('dream-conf-');
  assert.equal(checkOne(t, validProposal({ confidence: 0.5 })).reason, 'confidence_below_threshold');
});

test('empty evidence → missing_evidence', () => {
  const t = freshInstall('dream-ev0-');
  assert.equal(checkOne(t, validProposal({ evidence: [] })).reason, 'missing_evidence');
});

test('evidence item with a blank quote → missing_evidence', () => {
  const t = freshInstall('dream-ev1-');
  assert.equal(checkOne(t, validProposal({ evidence: [{ quote: '   ' }] })).reason, 'missing_evidence');
});

test('empty rationale → missing_rationale', () => {
  const t = freshInstall('dream-rat-');
  assert.equal(checkOne(t, validProposal({ rationale: '   ' })).reason, 'missing_rationale');
});

test('body without an H1 → body_missing_h1', () => {
  const t = freshInstall('dream-h1-');
  assert.equal(checkOne(t, validProposal({ body: 'no heading here' })).reason, 'body_missing_h1');
});

test('oversize body → body_too_large', () => {
  const t = freshInstall('dream-big-');
  const body = '# Big\n' + 'x'.repeat(32001);
  assert.equal(checkOne(t, validProposal({ body })).reason, 'body_too_large');
});

test('tier "sessions" is outside the allowlist → unsupported_tier', () => {
  const t = freshInstall('dream-sess-');
  assert.equal(checkOne(t, validProposal({ kind: 'concept', tier: 'sessions' })).reason, 'unsupported_tier');
});

test('a .wrxn/dream audit path as a tier → unsupported_tier', () => {
  const t = freshInstall('dream-audit-tier-');
  assert.equal(checkOne(t, validProposal({ tier: '.wrxn/dream' })).reason, 'unsupported_tier');
});

test('kind disagreeing with a supported tier → kind_tier_mismatch', () => {
  const t = freshInstall('dream-mismatch-');
  assert.equal(checkOne(t, validProposal({ kind: 'concept', tier: 'gotchas' })).reason, 'kind_tier_mismatch');
});

test('duplicate existing path → duplicate_existing_path (page not written)', () => {
  const t = freshInstall('dream-duppath-');
  wiki(t, ['write-page', 'decisions', 'adopt-trunk-based-dev', '--description', 'X', '--body', 'pre-existing']);
  assert.equal(checkOne(t, validProposal()).reason, 'duplicate_existing_path');
});

test('duplicate normalized title (different slug) → duplicate_existing_title', () => {
  const t = freshInstall('dream-duptitle-');
  // lay an existing page whose frontmatter description carries the title we will collide with
  wiki(t, ['write-page', 'decisions', 'some-other-slug', '--description', 'Adopt Trunk-Based Development', '--body', 'x']);
  const v = checkOne(t, validProposal({ slug: 'a-fresh-slug' }));
  assert.equal(v.reason, 'duplicate_existing_title');
});

// ── identity fields: slug + title are gated (dream-review #2) ──────────────────

test('a proposal with no slug → invalid_slug', () => {
  const t = freshInstall('dream-noslug-');
  const p = validProposal();
  delete p.slug;
  assert.equal(checkOne(t, p).reason, 'invalid_slug');
});

test('a non-kebab slug ("Not A Kebab!") → invalid_slug', () => {
  const t = freshInstall('dream-badslug-');
  assert.equal(checkOne(t, validProposal({ slug: 'Not A Kebab!' })).reason, 'invalid_slug');
});

test('a proposal with no title → missing_title', () => {
  const t = freshInstall('dream-notitle-');
  const p = validProposal();
  delete p.title;
  assert.equal(checkOne(t, p).reason, 'missing_title');
});

// ── credential secret-scan in the gate (dream-review #3, security M2) ──────────

test('SECURITY (secret-scan): a body containing an AWS key → contains_secret', () => {
  const t = freshInstall('dream-secret-aws-');
  const v = checkOne(t, validProposal({ body: '# Creds\n\nThe access key is AKIAIOSFODNN7EXAMPLE, keep it safe.' }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'contains_secret');
});

// ── argv flag-injection: a "--"-leading title is gated (dream-review #5, security M3) ──

test('SECURITY (M3): a "--root"-titled proposal is rejected at the gate (invalid_title)', () => {
  const t = freshInstall('dream-flag-gate-');
  assert.equal(checkOne(t, validProposal({ title: '--root' })).reason, 'invalid_title');
});

// ── negative-filter tuning: ordinary decisions are no longer false-positives (dream-review #6) ──

test('filter tuning: "Use Azure Synapse" passes the gate (bare synapse alternation removed)', () => {
  const t = freshInstall('dream-azure-');
  const v = checkOne(t, validProposal({ kind: 'concept', tier: 'concepts', slug: 'use-azure-synapse', title: 'Query via Azure Synapse', body: '# Azure Synapse\n\nWe query the warehouse with Azure Synapse Analytics.' }));
  assert.deepEqual(v, { ok: true });
});

test('filter tuning: "services are registered transient" passes the gate (DI-lifetime false positive removed)', () => {
  const t = freshInstall('dream-di-transient-');
  const v = checkOne(t, validProposal({ kind: 'decision', tier: 'decisions', slug: 'di-transient-lifetime', title: 'Stateless services use a transient lifetime', body: '# DI lifetime\n\nAll stateless services are registered transient in the DI container.' }));
  assert.deepEqual(v, { ok: true });
});

// ── anti-superstition negative filters (each rejects with a negative_filter_* reason) ──

const NEGATIVE = {
  negative_filter_tool_broken: validProposal({
    kind: 'gotcha', tier: 'gotchas', slug: 'recon-broken', title: 'recon is broken',
    body: '# recon is broken\n\nThe recon tool is broken and does not work, avoid it.',
  }),
  negative_filter_transient_failure: validProposal({
    kind: 'gotcha', tier: 'gotchas', slug: 'build-timeout', title: 'Build timed out',
    body: '# Transient build failure\n\nThe build timed out from a network glitch (ECONNREFUSED).',
  }),
  negative_filter_smoke_test: validProposal({
    kind: 'gotcha', tier: 'gotchas', slug: 'smoke-passed', title: 'Smoke test passed',
    body: '# Smoke test\n\nThe smoke test passed on the happy path today.',
  }),
  negative_filter_release_marker: validProposal({
    slug: 'released-v1', title: 'Released v1.2.0',
    body: '# Release\n\nWe published to npm and tagged v1.2.0 today.',
  }),
  negative_filter_one_off: validProposal({
    kind: 'gotcha', tier: 'gotchas', slug: 'typo-fix', title: 'Fixed a typo',
    body: '# Typo fix\n\nFixed a typo in the readme; a one-off chore.',
  }),
  negative_filter_wrxn_self: validProposal({
    kind: 'concept', tier: 'concepts', slug: 'wrxn-routing', title: 'wrxn routing domains',
    body: '# wrxn routing\n\nThe wrxn synapse routing domain maps keywords to rule files.',
  }),
};

for (const [reason, proposal] of Object.entries(NEGATIVE)) {
  test(`anti-superstition: ${reason}`, () => {
    const t = freshInstall(`dream-neg-${reason}-`);
    const v = checkOne(t, proposal);
    assert.equal(v.ok, false);
    assert.equal(v.reason, reason);
    assert.match(v.reason, /^negative_filter_/);
  });
}

// ── run-level: restraint, scoping, the ≤5 cap ─────────────────────────────────

test('restraint: an abstain input ({proposals:[]}) returns abstained and writes nothing', () => {
  const t = freshInstall('dream-restraint-');
  const res = checkBatch(t, { proposals: [] });
  assert.equal(res.abstained, true);
  assert.deepEqual(res.accepted, []);
});

test('restraint: an explicit {abstain:true} returns abstained', () => {
  const t = freshInstall('dream-abstain-');
  assert.equal(checkBatch(t, { abstain: true }).abstained, true);
});

test('scoping: two unrelated insights stay two separate proposals (never merged)', () => {
  const t = freshInstall('dream-scope-');
  const a = validProposal({ kind: 'decision', tier: 'decisions', slug: 'use-pino-logger', title: 'Use pino for logging', body: '# Pino\n\nWe log with pino.' });
  const b = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'cache-ttl-trap', title: 'Cache TTL trap', body: '# Cache TTL\n\nThe cache evicts after a fixed window; warm it first.' });
  const res = checkBatch(t, { proposals: [a, b] });
  assert.equal(res.abstained, false);
  assert.equal(res.accepted.length, 2);
  assert.equal(res.rejected.length, 0);
});

test('the ≤5 cap: a 6-proposal batch accepts 5 and rejects the surplus with max_proposals_exceeded', () => {
  const t = freshInstall('dream-cap-');
  const proposals = [];
  for (let i = 0; i < 6; i++) {
    proposals.push(validProposal({ kind: 'concept', tier: 'concepts', slug: `concept-${i}`, title: `Concept ${i}`, body: `# Concept ${i}\n\nStable note number ${i}.` }));
  }
  const res = checkBatch(t, { proposals });
  assert.equal(res.accepted.length, 5);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].reason, 'max_proposals_exceeded');
});

// ── stage: records the batch under .wrxn/dream as .jsonl, nothing to the wiki ──

test('stage records the validated batch as .jsonl under .wrxn/dream and writes nothing to the wiki', () => {
  const t = freshInstall('dream-stage-');
  const marker = 'ZZQX-distinctive-staged-marker';
  const p = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'staged-gotcha', title: 'Staged gotcha', body: `# Staged gotcha\n\n${marker} body content.` });
  dream(t, ['stage', writeJson(t, 'batch.json', { proposals: [p] })]);

  const dreamDir = path.join(t, '.wrxn', 'dream');
  const staged = path.join(dreamDir, 'staged.jsonl');
  assert.ok(fs.existsSync(staged), 'staged.jsonl exists');
  // CRITICAL: nothing under the audit dir may be .md — recon walks all of .wrxn and prose-ingests *.md.
  const files = fs.readdirSync(dreamDir);
  assert.ok(files.every((f) => !f.endsWith('.md')), `no .md under .wrxn/dream (got ${files.join(', ')})`);
  assert.match(fs.readFileSync(staged, 'utf8'), new RegExp(marker), 'staged proposal body persisted to the .jsonl');

  // nothing written to the wiki tiers at stage time
  const wikiConcepts = path.join(t, '.wrxn', 'wiki', 'gotchas');
  assert.deepEqual(fs.readdirSync(wikiConcepts).filter((f) => f.endsWith('.md')), [], 'no wiki page written by stage');
});

test('NON-RECALL: a staged-but-unapproved proposal is absent from a wiki query/recall', () => {
  const t = freshInstall('dream-nonrecall-');
  const marker = 'YQWX-unapproved-only-in-audit';
  const p = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'unapproved', title: 'Unapproved gotcha', body: `# Unapproved\n\n${marker} should never be recalled.` });
  dream(t, ['stage', writeJson(t, 'batch.json', { proposals: [p] })]);

  // the marker lives only in the non-.md audit file → a wiki query (the recall surface) cannot see it
  const res = JSON.parse(wiki(t, ['query', marker]));
  assert.equal(res.total, 0, 'staged proposal is NOT in the recalled wiki');
});

test('stage on an abstain input writes nothing under .wrxn/dream (only the gitkeep remains)', () => {
  const t = freshInstall('dream-stage-abstain-');
  dream(t, ['stage', writeJson(t, 'batch.json', { proposals: [] })]);
  const files = fs.readdirSync(path.join(t, '.wrxn', 'dream'));
  assert.deepEqual(files, ['.gitkeep'], `abstain stage writes nothing (got ${files.join(', ')})`);
});

// ── commit: additive writes via wiki.cjs + dedup-skip-without-abort ────────────

test('commit writes the approved proposals additively to their tiers via wiki.cjs and logs the outcome', () => {
  const t = freshInstall('dream-commit-');
  const a = validProposal({ kind: 'decision', tier: 'decisions', slug: 'use-pino', title: 'Use pino', body: '# Pino\n\nWe log with pino structured logs.' });
  const b = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'cache-trap', title: 'Cache trap', body: '# Cache trap\n\nWarm the cache before the first request.' });
  stage(t, [a, b]);                                  // stage first — commit is BY REFERENCE (slugs)
  const out = commit(t, ['use-pino', 'cache-trap']); // operator approves the staged slugs

  assert.equal(out.written.length, 2);
  assert.equal(out.skipped.length, 0);
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'use-pino.md')), 'decision page written');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'gotchas', 'cache-trap.md')), 'gotcha page written');
  assert.match(fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'use-pino.md'), 'utf8'), /pino structured logs/);

  const audit = fs.readFileSync(path.join(t, '.wrxn', 'dream', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const commitEvent = audit.find((e) => e.op === 'commit');
  assert.ok(commitEvent, 'a commit event is appended to the .jsonl audit log');
  assert.deepEqual(commitEvent.written.sort(), ['cache-trap', 'use-pino']);
});

test('commit dedup-skips an existing page WITHOUT aborting the rest of the batch', () => {
  const t = freshInstall('dream-commit-skip-');
  const first = validProposal({ kind: 'decision', tier: 'decisions', slug: 'first', title: 'First', body: '# First\n\nfirst decision.' });
  const mid = validProposal({ kind: 'decision', tier: 'decisions', slug: 'mid', title: 'Mid', body: '# Mid\n\nWOULD-CLOBBER if written.' });
  const third = validProposal({ kind: 'decision', tier: 'decisions', slug: 'third', title: 'Third', body: '# Third\n\nthird decision.' });
  stage(t, [first, mid, third]); // all three validate + stage (no page exists yet)

  // the middle proposal's page is then laid by hand — a curated page appears AFTER staging
  wiki(t, ['write-page', 'decisions', 'mid', '--description', 'Mid', '--body', 'pre-existing curated page']);

  const out = commit(t, ['first', 'mid', 'third']);

  // the batch did NOT abort: the two non-colliding pages are written, the middle is re-gate dedup-skipped
  assert.deepEqual(out.written.map((w) => w.slug).sort(), ['first', 'third']);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].slug, 'mid');
  assert.equal(out.skipped[0].reason, 'duplicate_existing_path');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'first.md')), 'first written despite the mid collision');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'third.md')), 'third written despite the mid collision');
  // the pre-existing curated page is NOT clobbered
  assert.match(fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'mid.md'), 'utf8'), /pre-existing curated page/);
});

// ── commit-by-reference re-gate at the write boundary (dream-review #1, the BLOCKING fix) ──

test('SECURITY (re-gate at commit): a gate-REJECTED proposal force-committed by slug is NOT written', () => {
  const t = freshInstall('dream-commit-regate-');
  // a proposal that FAILS the gate (confidence below the floor) reaches staged.jsonl by tamper/stale
  const bad = validProposal({ slug: 'sneaky', title: 'Sneaky', confidence: 0.2, body: '# Sneaky\n\nlow-confidence junk that must never reach recall.' });
  seedStaged(t, [{ ts: 'x', op: 'stage', slug: 'sneaky', tier: 'decisions', proposal: bad }]);

  const out = commit(t, ['sneaky']); // operator force-approves the slug
  assert.equal(out.written.length, 0, 're-gate at the write boundary blocked the bad proposal');
  assert.equal(out.skipped[0].slug, 'sneaky');
  assert.equal(out.skipped[0].reason, 'confidence_below_threshold');
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'sneaky.md')), 'no page written to the recall surface');
});

test('commit ignores an approved slug that is absent from staged.jsonl (not_staged, nothing written)', () => {
  const t = freshInstall('dream-commit-unstaged-');
  const a = validProposal({ kind: 'decision', tier: 'decisions', slug: 'use-pino', title: 'Use pino', body: '# Pino\n\nWe log with pino.' });
  stage(t, [a]);
  const out = commit(t, ['never-staged', 'use-pino']); // approve a slug that was never staged
  assert.equal(out.written.length, 1, 'only the staged slug is written');
  assert.equal(out.written[0].slug, 'use-pino');
  const sk = out.skipped.find((s) => s.slug === 'never-staged');
  assert.ok(sk, 'the unstaged slug is recorded skipped');
  assert.equal(sk.reason, 'not_staged');
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'never-staged.md')));
});

test('SECURITY (M3): a staged proposal with title "--root" does not write outside the wiki', () => {
  const t = freshInstall('dream-flag-commit-');
  // tamper: a "--root"-titled proposal in staged.jsonl (bypassing the stage-time gate)
  const evil = validProposal({ slug: 'evil', title: '--root', body: '# Evil\n\nflag-injection attempt.' });
  seedStaged(t, [{ ts: 'x', op: 'stage', slug: 'evil', tier: 'decisions', proposal: evil }]);

  // run with cwd INSIDE the temp install so any stray relative dir lands here (cleaned up), not the repo
  const out = JSON.parse(execFileSync(
    'node',
    [path.join(t, DREAM), 'commit', writeJson(t, 'approved.json', ['evil']), '--root', t],
    { encoding: 'utf8', cwd: t }
  ));
  assert.equal(out.written.length, 0, 're-gate blocked the --root title');
  assert.equal(out.skipped[0].reason, 'invalid_title');
  assert.ok(!fs.existsSync(path.join(t, '--root')), 'no flag-injected --root directory created');
});

// ── _rules tier + rule kind (dream-03) ────────────────────────────────────────
// A `rule` is an always/never project convention; kind:"rule" MUST target tier:"_rules".
// (The live "_rules page is recalled by the Brain" AC is a qa-walk item — it needs a running
//  `recon serve` over an indexed wiki. Here we unit-test the MECHANICS: a rule commits to a real
//  `_rules/<slug>.md` page under .wrxn/wiki/ so recon's prose ingestion can pick it up.)

function validRule(over) {
  return validProposal(Object.assign(
    {
      kind: 'rule',
      tier: '_rules',
      slug: 'always-rebase-before-merge',
      title: 'Always rebase before merging',
      body: '# Always rebase before merging\n\nThe team agreed to always rebase feature branches onto main before merging.',
      rationale: 'A standing always/never convention future sessions must honor.',
      evidence: [{ quote: 'always rebase before you merge', source: 'turn-7' }],
    },
    over || {}
  ));
}

test('a well-formed rule (kind:"rule" → tier:"_rules") passes check', () => {
  const t = freshInstall('dream-rule-ok-');
  assert.deepEqual(checkOne(t, validRule()), { ok: true });
});

test('a rule proposed to a non-_rules tier → kind_tier_mismatch', () => {
  const t = freshInstall('dream-rule-mismatch-');
  assert.equal(checkOne(t, validRule({ tier: 'decisions' })).reason, 'kind_tier_mismatch');
});

test('a non-rule kind proposed to the _rules tier → kind_tier_mismatch', () => {
  const t = freshInstall('dream-rules-tier-mismatch-');
  assert.equal(checkOne(t, validRule({ kind: 'concept' })).reason, 'kind_tier_mismatch');
});

test('commit writes an approved rule to _rules/<slug>.md via wiki.cjs (indexable .md)', () => {
  const t = freshInstall('dream-rule-commit-');
  stage(t, [validRule()]);
  const out = commit(t, ['always-rebase-before-merge']);
  assert.equal(out.written.length, 1);
  assert.equal(out.skipped.length, 0);
  const page = path.join(t, '.wrxn', 'wiki', '_rules', 'always-rebase-before-merge.md');
  assert.ok(fs.existsSync(page), 'rule page written under .wrxn/wiki/_rules as a real .md');
  assert.match(fs.readFileSync(page, 'utf8'), /rebase feature branches onto main/);
});

// ── single H1 on a committed page (qa-finding dream-06) ───────────────────────
// The gate mandates the proposal body open with its own "# Title" H1; wiki.cjs write-page must NOT
// stack a second "# <slug>" heading on top of it. Every dream-committed page therefore carries
// exactly one H1 — the proposal title — closing qa-06 end-to-end through stage → commit.

test('a committed page has exactly ONE H1 — the proposal title, not a stacked # <slug> (qa-06)', () => {
  const t = freshInstall('dream-one-h1-');
  const p = validProposal({
    kind: 'concept', tier: 'concepts', slug: 'cache-layer-design',
    title: 'Cache layer design', body: '# Cache layer design\n\nThe cache sits in front of the store.',
  });
  stage(t, [p]);
  commit(t, ['cache-layer-design']);
  const txt = fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'cache-layer-design.md'), 'utf8');
  const h1s = txt.match(/^# .*/gm) || [];
  assert.equal(h1s.length, 1, `exactly one H1 on the committed page (got ${h1s.length}: ${JSON.stringify(h1s)})`);
  assert.equal(h1s[0], '# Cache layer design', 'the sole H1 is the proposal title');
  assert.doesNotMatch(txt, /^# cache-layer-design$/m, 'no stacked slug H1 from the template');
});

// ── manifest / receipt classes (mirror wiki.test.cjs) ─────────────────────────

test('the dream adapter is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === DREAM);
  assert.ok(entry, 'dream.cjs in manifest');
  assert.equal(entry.class, 'managed');
  const t = freshInstall('dream-laid-');
  assert.ok(fs.existsSync(path.join(t, DREAM)), 'dream.cjs laid into the install');
});

test('the .wrxn/dream audit dir gitkeep is classified state in the manifest and receipt', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.wrxn/dream/.gitkeep');
  assert.ok(entry, '.wrxn/dream/.gitkeep in manifest');
  assert.equal(entry.class, 'state');
  const t = freshInstall('dream-gitkeep-');
  const receipt = JSON.parse(fs.readFileSync(path.join(t, 'wrxn.install.json'), 'utf8'));
  const r = receipt.files.find((f) => f.path === '.wrxn/dream/.gitkeep');
  assert.ok(r, 'gitkeep in receipt');
  assert.equal(r.class, 'state');
});

// ── set-focus + the _slots focus slot are RETIRED (auto-memory-05) ────────────
// The stale `_slots/current-focus` slot and its `set-focus` op are removed: the auto-handoff baton +
// recalled dream pages now carry "where we are / what's next", so the redundant rot-prone slot is gone.
// `set-focus` is no longer a dream.cjs subcommand (it falls through to usage, exit 2, writes nothing).

test('set-focus is no longer a dream subcommand — it falls through to usage and writes no slot', () => {
  const t = freshInstall('dream-no-setfocus-');
  let err;
  try {
    dream(t, ['set-focus', writeJson(t, 'focus.json', { body: '# Current focus\n\nany body' })]);
  } catch (e) { err = e; }
  assert.ok(err, 'set-focus exits non-zero (unknown subcommand → usage)');
  assert.equal(err.status, 2, 'usage exit code 2');
  assert.match(String(err.stdout || '') + String(err.stderr || ''), /Usage:/, 'prints the usage banner');
  // the usage banner no longer advertises set-focus
  assert.doesNotMatch(String(err.stdout || '') + String(err.stderr || ''), /set-focus/, 'usage no longer lists set-focus');
  // no focus slot is created by the retired op
  assert.equal(
    fs.existsSync(path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md')),
    false,
    'no _slots/current-focus.md is written',
  );
});

test('the knowledge gate does NOT gain _slots — a proposal targeting _slots is unsupported_tier', () => {
  const t = freshInstall('dream-slots-gate-');
  const v = checkOne(t, validProposal({ kind: 'concept', tier: '_slots', slug: 'current-focus', title: 'x', body: '# x\n\ny' }));
  assert.equal(v.reason, 'unsupported_tier');
});

// ── importance: stamp — the decay-weight PRODUCER (harvest-10) ─────────────────
// dream computes a 0–1 per-page score (`confidence`, gate floor 0.75) but never PERSISTED it, so recon
// D1/D3's `recency × importance` collapsed to `recency × tier-prior`. Commit now stamps that score as a
// single `importance:` frontmatter scalar (the restampDoc-style in-place stamp), clamped to [0,1].

test('AC1: commit stamps importance: <dream score> on the written page', () => {
  const t = freshInstall('dream-importance-');
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'imp-concept', title: 'Imp concept', body: '# Imp concept\n\nbody.', confidence: 0.84 });
  stage(t, [p]);
  commit(t, ['imp-concept']);
  const txt = fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'imp-concept.md'), 'utf8');
  assert.match(txt, /^importance: 0.84$/m, 'the committed page carries dream\'s score as importance:');
  assert.equal((txt.match(/^importance:/gm) || []).length, 1, 'exactly one importance line');
});

test('AC3: an out-of-range (>1) confidence is clamped to importance: 1 through the real commit path', () => {
  const t = freshInstall('dream-importance-clamp-');
  // confidence 1.5 still passes the gate (>= 0.75, a number) → reaches the write → clamped at the stamp
  const p = validProposal({ slug: 'over-one', title: 'Over one', body: '# Over\n\nbody.', confidence: 1.5 });
  stage(t, [p]);
  commit(t, ['over-one']);
  const txt = fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'over-one.md'), 'utf8');
  assert.match(txt, /^importance: 1$/m, 'a confidence above 1 is clamped to 1');
});

test('AC2/AC3: the stamp leaves the committed page body + single H1 unchanged (no body churn)', () => {
  const t = freshInstall('dream-importance-body-');
  const body = '# Cache design\n\nThe cache sits in front of the store.\nSecond paragraph stays put.';
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'cache-design', title: 'Cache design', body });
  stage(t, [p]);
  commit(t, ['cache-design']);
  const txt = fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'cache-design.md'), 'utf8');
  assert.match(txt, /^importance: 0.9$/m, 'the stamp is present (validProposal default confidence 0.9)');
  assert.ok(txt.includes(body), 'the proposal body is present verbatim after the stamp (no churn)');
  assert.equal((txt.match(/^# .*/gm) || []).length, 1, 'still exactly one H1 (qa-06 invariant holds)');
});

test('AC2 backward-safe: a pre-existing importance-less page is dedup-skipped, never stamped', () => {
  const t = freshInstall('dream-importance-backward-');
  // stage BEFORE any page exists (so the proposal validates + stages), mirroring the dedup-skip test
  stage(t, [validProposal({ slug: 'legacy', title: 'Legacy', body: '# Legacy\n\nWOULD-CLOBBER' })]);
  // a curated importance-less page is THEN laid by hand at the same slug
  wiki(t, ['write-page', 'decisions', 'legacy', '--description', 'Legacy', '--body', '# Legacy\n\noriginal body']);
  const page = path.join(t, '.wrxn', 'wiki', 'decisions', 'legacy.md');
  const before = fs.readFileSync(page, 'utf8');
  assert.doesNotMatch(before, /^importance:/m, 'the curated page carries no importance: (this slice must not add one)');
  // committing the staged slug is re-gate dedup-SKIPPED → the page is not rewritten/stamped
  const out = commit(t, ['legacy']);
  assert.equal(out.skipped[0].reason, 'duplicate_existing_path');
  assert.equal(fs.readFileSync(page, 'utf8'), before, 'the importance-less page is byte-for-byte untouched (D1 tier-priors it)');
});

test('AC2 (pure): stampImportance updates importance in place on re-stamp — no duplicate key, body unchanged', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\nsource: wiki-cli-write-page\n---\n\n# X\n\nbody line one.\nbody line two.\n';
  const once = stampImportance(page, 0.8);
  assert.match(once, /^importance: 0.8$/m);
  const twice = stampImportance(once, 0.6); // re-stamp the SAME page
  assert.equal((twice.match(/^importance:/gm) || []).length, 1, 'exactly one importance key after re-stamp');
  assert.match(twice, /^importance: 0.6$/m, 'updated in place to the new value');
  assert.ok(twice.includes('# X\n\nbody line one.\nbody line two.'), 'the body is untouched across re-stamps');
});

test('AC4 (pure): the stamp is shape-safe — a malicious score cannot inject frontmatter/newlines', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\nsource: wiki-cli-write-page\n---\n\n# X\n\nbody.\n';
  const out = stampImportance(page, '0.5\nevil: pwned'); // Number("0.5\nevil…") → NaN → clamp → 0
  assert.equal((out.match(/^importance:/gm) || []).length, 1, 'a single importance line, no injected scalar');
  assert.doesNotMatch(out, /evil:/, 'no injected frontmatter key');
  assert.match(out, /^importance: 0$/m, 'a non-numeric score coerces to 0, never a raw string');
  // and an out-of-range numeric is clamped both ways
  assert.match(stampImportance(page, 1.5), /^importance: 1$/m);
  assert.match(stampImportance(page, -0.3), /^importance: 0$/m);
});

// ── --source quote-verification (auto-memory-01) ──────────────────────────────
// The single mechanical control that makes auto-dream safe without a human: when check/commit are
// given a --source transcript blob, every evidence quote must verifiably appear in it (normalized:
// whitespace-collapsed + case-insensitive). A quote NOT in the source → quote_not_in_source. With NO
// --source the path is byte-identical to today (the manual dream skill is a trusted proposer).

// Write a raw text source blob under the install and return its absolute path.
function writeSource(target, name, text) {
  const p = path.join(target, name);
  fs.writeFileSync(p, text);
  return p;
}

// check a single proposal WITH a --source blob (the auto-dream verification path).
function checkOneSource(target, proposal, sourceText) {
  const pf = writeJson(target, 'p.json', proposal);
  const sf = writeSource(target, 'src.txt', sourceText);
  return JSON.parse(dream(target, ['check', pf, '--source', sf]));
}

// commit BY REFERENCE WITH a --source blob (the re-gate at the write boundary, source-verified).
function commitSource(target, approved, sourceText) {
  const af = writeJson(target, 'approved.json', approved);
  const sf = writeSource(target, 'src.txt', sourceText);
  return JSON.parse(dream(target, ['commit', af, '--source', sf]));
}

test('check --source: a proposal whose evidence quote is NOT in the source → quote_not_in_source', () => {
  const t = freshInstall('dream-src-absent-');
  const v = checkOneSource(t, validProposal(), 'a transcript that never mentions that decision at all');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'quote_not_in_source');
});

test('SECURITY (commit --source): a staged proposal whose quote is not in the source is NOT written', () => {
  const t = freshInstall('dream-src-commit-');
  const p = validProposal({ slug: 'halluc', title: 'Hallucinated', body: '# Hallucinated\n\nfabricated memory.', evidence: [{ quote: 'a sentence never spoken in the transcript' }] });
  seedStaged(t, [{ ts: 'x', op: 'stage', slug: 'halluc', tier: 'decisions', proposal: p }]);
  const out = commitSource(t, ['halluc'], 'a transcript that does not contain that sentence');
  assert.equal(out.written.length, 0, 'the hallucinated proposal is blocked at the commit re-gate');
  assert.equal(out.skipped[0].slug, 'halluc');
  assert.equal(out.skipped[0].reason, 'quote_not_in_source');
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'halluc.md')), 'nothing reached the recall surface');
});

test('check --source: every evidence quote substring-matches the source → accepted', () => {
  const t = freshInstall('dream-src-present-');
  const src = 'In turn 12, after debate, we decided to merge to main behind required gates.';
  assert.deepEqual(checkOneSource(t, validProposal(), src), { ok: true });
});

test('no --source: the legacy path is unchanged — a quote in no transcript still passes (trusted proposer)', () => {
  const t = freshInstall('dream-src-legacy-');
  // omitting --source means NO quote-verify: the manual dream skill is a trusted main-agent proposer
  assert.deepEqual(checkOne(t, validProposal({ evidence: [{ quote: 'a quote that appears in no transcript anywhere' }] })), { ok: true });
});

test('check --source: quote matching is whitespace-collapsed + case-insensitive (no false reject)', () => {
  const t = freshInstall('dream-src-normalize-');
  // the source differs from the quote only in CASE + line wraps + indentation — must still match
  const src = 'WE DECIDED to merge\n     to main   behind\n\trequired GATES today.';
  const p = validProposal({ evidence: [{ quote: 'we decided to merge to main behind required gates' }] });
  assert.deepEqual(checkOneSource(t, p, src), { ok: true });
});

test('check --source: a quote present only as scattered words (not contiguous) is rejected → quote_not_in_source', () => {
  const t = freshInstall('dream-src-noncontiguous-');
  // every word of the quote appears in the source but never as the contiguous substantive phrase
  const src = 'we discussed gates. later, required reviews. separately, merge plans for main.';
  const p = validProposal({ evidence: [{ quote: 'we decided to merge to main behind required gates' }] });
  assert.equal(checkOneSource(t, p, src).reason, 'quote_not_in_source');
});

test('check --source composes: a present quote does NOT bypass the confidence floor', () => {
  const t = freshInstall('dream-src-compose-conf-');
  const src = 'we decided to merge to main behind required gates';
  assert.equal(checkOneSource(t, validProposal({ confidence: 0.5 }), src).reason, 'confidence_below_threshold');
});

test('check --source composes: a present quote does NOT bypass the negative filters', () => {
  const t = freshInstall('dream-src-compose-neg-');
  const quote = 'the recon tool is broken';
  const src = `session log: ${quote}, the user noted in frustration.`;
  // the quote is REAL (in source) yet the authored body still trips the anti-superstition filter
  const p = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'recon-broken', title: 'recon note', body: '# recon\n\nThe recon tool is broken and does not work.', evidence: [{ quote }] });
  assert.equal(checkOneSource(t, p, src).reason, 'negative_filter_tool_broken');
});

test('check --source precedence: quote_not_in_source is reported BEFORE a negative-filter trip (documented order)', () => {
  const t = freshInstall('dream-src-precedence-');
  // the body WOULD trip negative_filter_tool_broken, but the quote is absent from the source: quote-verify wins
  const p = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'recon-broken', title: 'recon note', body: '# recon\n\nThe recon tool is broken and does not work.', evidence: [{ quote: 'a quote absent from the source' }] });
  assert.equal(checkOneSource(t, p, 'a transcript with no such quote in it').reason, 'quote_not_in_source');
});

test('check --source (batch): an unverifiable quote is rejected while the verifiable proposal is accepted', () => {
  const t = freshInstall('dream-src-batch-');
  const good = validProposal({ kind: 'concept', tier: 'concepts', slug: 'use-pino', title: 'Use pino', body: '# Pino\n\nWe log with pino.', evidence: [{ quote: 'we will log with pino' }] });
  const bad = validProposal({ kind: 'gotcha', tier: 'gotchas', slug: 'cache-trap', title: 'Cache trap', body: '# Cache trap\n\nWarm the cache.', evidence: [{ quote: 'a fabricated never-said sentence' }] });
  const src = 'in this session we will log with pino for everything.';
  const res = JSON.parse(dream(t, ['check', writeJson(t, 'b.json', { proposals: [good, bad] }), '--source', writeSource(t, 'src.txt', src)]));
  assert.equal(res.accepted.length, 1);
  assert.equal(res.accepted[0].slug, 'use-pino');
  assert.equal(res.rejected.length, 1);
  assert.deepEqual({ slug: res.rejected[0].slug, reason: res.rejected[0].reason }, { slug: 'cache-trap', reason: 'quote_not_in_source' });
});

test('commit --source: a staged proposal whose quote IS in the source is written to the recall surface', () => {
  const t = freshInstall('dream-src-commit-ok-');
  const p = validProposal({ slug: 'verified', title: 'Verified', body: '# Verified\n\nreal memory.', evidence: [{ quote: 'we agreed to ship the verified path' }] });
  seedStaged(t, [{ ts: 'x', op: 'stage', slug: 'verified', tier: 'decisions', proposal: p }]);
  const out = commitSource(t, ['verified'], 'late in the session we agreed to ship the verified path.');
  assert.equal(out.written.length, 1);
  assert.equal(out.written[0].slug, 'verified');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'verified.md')), 'the verified page reaches the wiki');
});

test('SECURITY: check --source with an UNREADABLE source file fails (exit 2) — never silently disables the gate', () => {
  const t = freshInstall('dream-src-missing-');
  let err;
  try {
    dream(t, ['check', writeJson(t, 'p.json', validProposal()), '--source', path.join(t, 'does-not-exist.txt')]);
  } catch (e) { err = e; }
  assert.ok(err, 'check exited non-zero');
  assert.equal(err.status, 2);
  assert.match(String(err.stderr || ''), /--source/);
});

// ── F1 (security MED): the substantive-quote floor (auto-memory-01 follow-up) ───
// A bare substring match is satisfied by a trivially-present quote ("the" is in every transcript), so the
// quote-verify under-delivered the PRD's load-bearing "a hallucination can't poison recall" claim — a
// proposer needed only ANY real word. Each evidence quote must now be a SUBSTANTIVE verbatim span (the
// NORMALIZED quote ≥ 12 chars AND ≥ 3 word-tokens) before its source match counts, else
// quote_not_substantive. The trivial quotes below are deliberately PRESENT in the source, so only the new
// floor (not the presence check) can reject them.

test('check --source (F1): a trivially-present quote ("the") is rejected quote_not_substantive', () => {
  const t = freshInstall('dream-src-trivial-');
  // "the" IS a substring of the source — only the substantive floor (not presence) can reject it
  const p = validProposal({ evidence: [{ quote: 'the' }] });
  const v = checkOneSource(t, p, 'we talked about the cache and the queue at length today.');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'quote_not_substantive');
});

test('check --source (F1): the char floor — a 3-token but <12-char quote ("we go now") → quote_not_substantive', () => {
  const t = freshInstall('dream-src-charfloor-');
  // 3 word-tokens but only 9 normalized chars: present in source, rejected solely by the char floor
  const p = validProposal({ evidence: [{ quote: 'we go now' }] });
  assert.equal(checkOneSource(t, p, 'we go now and circle back later.').reason, 'quote_not_substantive');
});

test('check --source (F1): the token floor — a long single-word quote ("authentication") → quote_not_substantive', () => {
  const t = freshInstall('dream-src-tokenfloor-');
  // 14 chars but a single word-token: present in source, rejected solely by the token floor
  const p = validProposal({ evidence: [{ quote: 'authentication' }] });
  assert.equal(checkOneSource(t, p, 'we discussed authentication at length today.').reason, 'quote_not_substantive');
});

test('check --source (F1): a terse but legitimate multi-word decision quote ("use pino logs") is NOT false-rejected', () => {
  const t = freshInstall('dream-src-terse-ok-');
  // 13 chars + 3 tokens clears the floor — a real short decision quote must still be accepted
  const p = validProposal({ evidence: [{ quote: 'use pino logs' }] });
  assert.deepEqual(checkOneSource(t, p, 'in this session we will use pino logs for everything.'), { ok: true });
});

test('check --source (F1) precedence: a trivial quote that is ALSO absent → quote_not_substantive (substantive floor wins)', () => {
  const t = freshInstall('dream-src-trivial-absent-');
  // "the" is both trivial AND absent from this source; the documented order reports substantive first
  const p = validProposal({ evidence: [{ quote: 'the' }] });
  assert.equal(checkOneSource(t, p, 'a session log lacking that token').reason, 'quote_not_substantive');
});

// ── F2 (security LOW): a value-less --source must fail CLOSED (auto-memory-01 follow-up) ──
// A trailing/value-less `--source` token used to fall through to the no-verify legacy path — a silent
// gate-off. When the caller asks for the gate it must NEVER silently disable: a present-but-valueless
// --source fails exit 2, like an unreadable source.

test('SECURITY (F2): a value-less trailing --source fails closed (exit 2) — never silently disables the gate', () => {
  const t = freshInstall('dream-src-valueless-');
  const pf = writeJson(t, 'p.json', validProposal());
  let err;
  try {
    // --source is the LAST argv token (no value follows). Run cwd INSIDE the install so root resolves.
    execFileSync('node', [path.join(t, DREAM), 'check', pf, '--root', t, '--source'], { encoding: 'utf8', cwd: t });
  } catch (e) { err = e; }
  assert.ok(err, 'check exited non-zero on a value-less --source (did not silently fall to the legacy path)');
  assert.equal(err.status, 2);
  assert.match(String(err.stderr || ''), /--source/);
});

// ── NB-3: pin the documented gate ordering — confidence floor BEFORE quote-verify ──
// The compose-confidence test above uses a PRESENT quote, so it can't tell "confidence before
// quote-verify" from "after". This pins the full precedence: a low-confidence proposal whose quote is
// ABSENT (yet substantive) must report confidence_below_threshold — only possible if confidence is gated
// first. Reorder quote-verify ahead of the confidence floor and this test flips to quote_not_in_source.

test('check --source precedence (NB-3): the confidence floor is checked BEFORE quote-verify', () => {
  const t = freshInstall('dream-src-prec-conf-');
  // low confidence AND a substantive-but-absent quote: confidence is gated first → confidence_below_threshold
  const p = validProposal({ confidence: 0.5, evidence: [{ quote: 'a substantive quote absent from the transcript' }] });
  assert.equal(checkOneSource(t, p, 'a transcript that does not contain that phrase at all').reason, 'confidence_below_threshold');
});

// ── S3 (#22): artifact lineage stamp + dream --revert ─────────────────────────
// Every page dream commits is stamped with three lineage frontmatter keys — origin_session, synth_run,
// proposal_id — through the SAME post-write stamp seam that writes importance:. They are machine-written
// metadata that never touch the prose body. A new `dream --revert <run_id>` reverses exactly the pages a
// given synth_run wrote, cross-checked against the audit log, refusing a page hand-edited since.

// Parse a page's frontmatter into a flat key→value map (last key wins; values trimmed).
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function readPage(target, tier, slug) {
  return fs.readFileSync(path.join(target, '.wrxn', 'wiki', tier, `${slug}.md`), 'utf8');
}

test('AC1: a dream-committed page carries origin_session, synth_run and proposal_id frontmatter', () => {
  const t = freshInstall('dream-lineage-');
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'lin-concept', title: 'Lin concept', body: '# Lin concept\n\nbody.' });
  stage(t, [p]);
  commit(t, ['lin-concept']);
  const fm = frontmatter(readPage(t, 'concepts', 'lin-concept'));
  assert.ok(fm.origin_session, 'origin_session is stamped');
  assert.ok(fm.synth_run, 'synth_run is stamped');
  assert.equal(fm.proposal_id, 'lin-concept', 'proposal_id is the committed slug');
});

test('AC1: origin_session is sourced from CLAUDE_SESSION_ID at the write boundary', () => {
  const t = freshInstall('dream-lineage-session-');
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'sess-concept', title: 'Sess', body: '# Sess\n\nbody.' });
  stage(t, [p]);
  // commit with CLAUDE_SESSION_ID set in the child env — the stamp must capture it
  execFileSync('node', [path.join(t, DREAM), 'commit', writeJson(t, 'approved.json', ['sess-concept']), '--root', t],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: 'sid-2026-xyz' }) });
  assert.equal(frontmatter(readPage(t, 'concepts', 'sess-concept')).origin_session, 'sid-2026-xyz');
});

test('AC1 (no churn): the lineage stamp leaves the committed page body + single H1 unchanged', () => {
  const t = freshInstall('dream-lineage-body-');
  const body = '# Cache design\n\nThe cache sits in front of the store.\nSecond paragraph stays put.';
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'lin-cache', title: 'Cache design', body });
  stage(t, [p]);
  commit(t, ['lin-cache']);
  const txt = readPage(t, 'concepts', 'lin-cache');
  assert.ok(txt.includes(body), 'the proposal body is present verbatim after the lineage stamp (no churn)');
  assert.equal((txt.match(/^# .*/gm) || []).length, 1, 'still exactly one H1');
  // lineage keys live in the frontmatter only — never in the body region after the closing fence
  const afterFence = txt.slice(txt.indexOf('\n---', 3) + 4);
  for (const k of ['origin_session:', 'synth_run:', 'proposal_id:']) {
    assert.ok(!afterFence.includes(k), `${k} is not written into the prose body`);
  }
});

// dream --revert <run_id>
function revert(target, runId) {
  return JSON.parse(dream(target, ['revert', runId]));
}

test('AC4: --revert <run> reverses exactly the pages that run committed (cross-checked with the audit log)', () => {
  const t = freshInstall('dream-revert-');
  // run A commits two pages
  stage(t, [
    validProposal({ kind: 'concept', tier: 'concepts', slug: 'run-a-one', title: 'A1', body: '# A1\n\nbody.' }),
    validProposal({ kind: 'concept', tier: 'concepts', slug: 'run-a-two', title: 'A2', body: '# A2\n\nbody.' }),
  ]);
  const a = commit(t, ['run-a-one', 'run-a-two']);
  // run B commits a third page (a DISTINCT run id — its own commit invocation)
  stage(t, [validProposal({ kind: 'concept', tier: 'concepts', slug: 'run-b-one', title: 'B1', body: '# B1\n\nbody.' })]);
  commit(t, ['run-b-one']);
  assert.notEqual(a.synth_run, undefined, 'commit returns the run id');

  const out = revert(t, a.synth_run);
  assert.deepEqual(out.reverted.sort(), ['run-a-one', 'run-a-two'], 'exactly run A pages reverted');
  // run A pages are gone; run B page survives (only this run is reversed)
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'run-a-one.md')));
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'run-a-two.md')));
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'run-b-one.md')), 'run B page untouched');
});

test('AC5: a page hand-edited since its run wrote it is REFUSED and reported, not clobbered', () => {
  const t = freshInstall('dream-revert-edited-');
  stage(t, [
    validProposal({ kind: 'concept', tier: 'concepts', slug: 'edited-one', title: 'E1', body: '# E1\n\nbody.' }),
    validProposal({ kind: 'concept', tier: 'concepts', slug: 'clean-two', title: 'C2', body: '# C2\n\nbody.' }),
  ]);
  const a = commit(t, ['edited-one', 'clean-two']);
  // hand-edit one page after the run wrote it (content no longer matches the audit hash)
  const editedPath = path.join(t, '.wrxn', 'wiki', 'concepts', 'edited-one.md');
  fs.appendFileSync(editedPath, '\nhand-edited line the operator added later.\n');
  const before = fs.readFileSync(editedPath, 'utf8');

  const out = revert(t, a.synth_run);
  assert.deepEqual(out.refused, [{ slug: 'edited-one', reason: 'hand_edited' }], 'the hand-edited page is refused + reported');
  assert.equal(fs.readFileSync(editedPath, 'utf8'), before, 'the hand-edited page is NOT clobbered (byte-for-byte intact)');
  assert.deepEqual(out.reverted, ['clean-two'], 'the unedited sibling is still reversed');
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'clean-two.md')));
});

test('AC6: an unknown run id is REFUSED and reported (exit 2), nothing deleted', () => {
  const t = freshInstall('dream-revert-unknown-');
  stage(t, [validProposal({ kind: 'concept', tier: 'concepts', slug: 'keep-me', title: 'K', body: '# K\n\nbody.' })]);
  commit(t, ['keep-me']);
  let err;
  try {
    dream(t, ['revert', 'no-such-run-id-12345']);
  } catch (e) { err = e; }
  assert.ok(err, 'revert of an unknown run exits non-zero');
  assert.equal(err.status, 2);
  const out = JSON.parse(String(err.stdout || ''));
  assert.equal(out.reason, 'unknown_run');
  assert.deepEqual(out.reverted, []);
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'keep-me.md')), 'no real page was touched');
});

test('AC7 (pure): stampLineage sets all three keys, is shape-safe, and is deterministic', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\nsource: wiki-cli-write-page\n---\n\n# X\n\nbody one.\nbody two.\n';
  const out = stampLineage(page, { origin_session: 'sid-1', synth_run: '2026-06-22T10:30:00.5Z', proposal_id: 'x' });
  assert.match(out, /^origin_session: sid-1$/m);
  assert.match(out, /^proposal_id: x$/m);
  // a colon in the run id (ISO time) is stripped to a space → still ONE bare scalar, no YAML mapping
  assert.equal((out.match(/^synth_run:/gm) || []).length, 1, 'exactly one synth_run line');
  assert.ok(out.includes('# X\n\nbody one.\nbody two.'), 'the body is untouched');
  assert.equal(stampLineage(page, { origin_session: 'sid-1', synth_run: 'r', proposal_id: 'x' }),
    stampLineage(page, { origin_session: 'sid-1', synth_run: 'r', proposal_id: 'x' }), 'deterministic — same input, same output');
  // injection attempt: a newline in a value cannot smuggle an extra frontmatter key
  const evil = stampLineage(page, { origin_session: 'sid\nimportance: 9.9', synth_run: 'r', proposal_id: 'x' });
  assert.doesNotMatch(evil, /^importance: 9\.9$/m, 'a newline-injected key is neutralised');
  // re-stamp updates in place (no duplicate keys)
  const twice = stampLineage(out, { origin_session: 'sid-2', synth_run: 'r2', proposal_id: 'x' });
  assert.equal((twice.match(/^origin_session:/gm) || []).length, 1, 'no duplicate origin_session on re-stamp');
  assert.match(twice, /^origin_session: sid-2$/m, 'updated in place');
});

test('AC7 (pure): resolveRevert classifies missing / hand-edited / reversible deterministically', () => {
  const content = { tierA: { good: 'PAGE-GOOD-CONTENT', edited: 'PAGE-EDITED-ORIGINAL' } };
  const audit = [
    { op: 'stage' }, // ignored — not a commit event
    { op: 'commit', synth_run: 'run-1', pages: [
      { slug: 'good', tier: 'tierA', hash: sha256('PAGE-GOOD-CONTENT') },     // matches → reversible
      { slug: 'edited', tier: 'tierA', hash: sha256('PAGE-EDITED-ORIGINAL') }, // disk differs → edited
      { slug: 'gone', tier: 'tierA', hash: sha256('whatever') },               // not on disk → missing
    ] },
    { op: 'commit', synth_run: 'run-2', pages: [{ slug: 'other', tier: 'tierA', hash: 'h' }] },
  ];
  const read = (tier, slug) => {
    if (slug === 'edited') return 'PAGE-EDITED-AFTER-HAND-EDIT'; // hash will not match the audit
    return (content[tier] && content[tier][slug]) || null;
  };
  const plan = resolveRevert(audit, 'run-1', read);
  assert.equal(plan.unknown_run, false);
  assert.deepEqual(plan.reversible, [{ slug: 'good', tier: 'tierA' }]);
  assert.deepEqual(plan.edited, [{ slug: 'edited', tier: 'tierA' }]);
  assert.deepEqual(plan.missing, [{ slug: 'gone', tier: 'tierA' }]);
  // an unknown run id → unknown_run, nothing planned (only run-1/run-2 exist)
  assert.equal(resolveRevert(audit, 'run-404', read).unknown_run, true);
});

// ── C3 (#36): forward evidence stamp — evidence:{session,commit,symbols} ─────────
// dream (and harvest) stamp an `evidence:` frontmatter MAPPING computed from FACTS — the session anchor,
// the real git HEAD, the session's `.touched` symbol set — the citation contract recon-wrxn ②'s edge
// resolver reads to draw EVIDENCED_BY / DOCUMENTED_BY. Machine-written frontmatter only: the prose body is
// never touched (consistent with importance/lineage). Fail-open: an unresolvable field is omitted (commit/
// symbols) or a sentinel (session), and the page still writes. The stamp core is pure with git/touched/
// session injected — tested here with no live repo.

test('C3 (pure): stampEvidence writes an evidence: mapping with session/commit/symbols; the body is untouched', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\nsource: wiki-cli-write-page\n---\n\n# X\n\nbody one.\nbody two.\n';
  const out = stampEvidence(page, { session: 'sid-1', commit: 'abc1234', symbols: ['a.js', 'b.js'] });
  assert.match(out, /^evidence:$/m, 'an evidence: mapping key is written');
  assert.match(out, /^  session: sid-1$/m, 'session nested under evidence');
  assert.match(out, /^  commit: abc1234$/m, 'commit nested under evidence');
  assert.match(out, /^  symbols: \[a\.js, b\.js\]$/m, 'symbols nested under evidence as an inline list');
  assert.ok(out.includes('# X\n\nbody one.\nbody two.'), 'the prose body is byte-for-byte untouched (no churn)');
});

test('C3 (pure): stampEvidence is shape-safe (no key injection) and re-stamps in place (no duplicate block)', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\n---\n\n# X\n\nbody.\n';
  // injection attempt: a CR/LF or colon in a value cannot smuggle an extra frontmatter key or nested member
  const evil = stampEvidence(page, { session: 'sid\nimportance: 9.9', commit: 'a:b', symbols: ['ok.js', 'a]b', 'c,d'] });
  assert.doesNotMatch(evil, /^importance: 9\.9$/m, 'a newline-injected top-level key is neutralised');
  assert.equal((evil.match(/^  session:/gm) || []).length, 1, 'session is exactly one nested line (no injected newline)');
  assert.match(evil, /^  commit: a b$/m, 'a colon in commit is collapsed to a space — one bare scalar');
  assert.match(evil, /^  symbols: \[ok\.js, a b, c d\]$/m, 'list-breaking chars in symbols are sanitised');
  // re-stamp updates in place: exactly ONE evidence: block carrying the new values
  const once = stampEvidence(page, { session: 'sid-1', commit: 'aaa', symbols: ['a.js'] });
  const twice = stampEvidence(once, { session: 'sid-2', commit: 'bbb', symbols: ['b.js'] });
  assert.equal((twice.match(/^evidence:$/gm) || []).length, 1, 'no duplicate evidence: block on re-stamp');
  assert.match(twice, /^  session: sid-2$/m, 'session updated in place');
  assert.match(twice, /^  commit: bbb$/m, 'commit updated in place');
  assert.doesNotMatch(twice, /^  commit: aaa$/m, 'the prior commit value is gone');
  assert.ok(twice.includes('# X\n\nbody.'), 'the body is still untouched after re-stamp');
});

test('C3 (pure): stampEvidence fails open — an unresolvable commit/symbols is omitted; session falls back to a sentinel', () => {
  const page = '---\nname: x\ndescription: X\ntier: concepts\n---\n\n# X\n\nbody.\n';
  // no git HEAD (commit null) + empty touched (symbols []) → those keys are omitted; the page still writes
  const out = stampEvidence(page, { session: 'sid-1', commit: null, symbols: [] });
  assert.match(out, /^evidence:$/m, 'the evidence block still writes (fail-open)');
  assert.match(out, /^  session: sid-1$/m, 'session is present');
  assert.doesNotMatch(out, /^  commit:/m, 'an unresolvable commit is omitted (no commit: key)');
  assert.doesNotMatch(out, /^  symbols:/m, 'an empty touched set omits the symbols: key');
  // a missing session falls back to the sentinel so the key is always present + parseable
  const noSession = stampEvidence(page, { commit: 'abc', symbols: ['a.js'] });
  assert.match(noSession, /^  session: unknown$/m, 'session falls back to the unknown sentinel');
});

test('C3 (pure): resolveEvidence gathers session/commit/symbols from injected IO and fails open (no live repo)', () => {
  // happy path — injected HEAD + touched, no real repo needed
  const ev = resolveEvidence({ session: 'sid-1', resolveHead: () => 'cafe1234', touched: ['a.js', 'b.js'] });
  assert.equal(ev.session, 'sid-1');
  assert.equal(ev.commit, 'cafe1234', 'commit is the injected git HEAD');
  assert.deepEqual(ev.symbols, ['a.js', 'b.js'], 'symbols are the injected touched set');
  // fail-open: a git binary that throws → commit null (omitted downstream); never throws
  let failed;
  assert.doesNotThrow(() => {
    failed = resolveEvidence({ session: 'sid-2', resolveHead: () => { throw new Error('not a git repo'); }, touched: [] });
  });
  assert.equal(failed.commit, null, 'an unresolvable HEAD yields commit null (fail-open)');
  assert.deepEqual(failed.symbols, [], 'an empty touched set yields no symbols');
  // a HEAD resolver returning null/empty → commit null
  assert.equal(resolveEvidence({ session: 's', resolveHead: () => null, touched: [] }).commit, null);
});

// Init a real git repo in the install with one commit; return its HEAD (the integration exercises the real
// git path, mirroring session-start's "REAL git HEAD over a real repo" check).
function gitInit(target) {
  execFileSync('git', ['init', '-q'], { cwd: target });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: target });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim();
}

// Parse the nested `evidence:` mapping off a page (the test frontmatter() helper only reads flat keys).
function evidenceOf(text) {
  const lines = String(text).split(/\r?\n/);
  const i = lines.findIndex((l) => /^evidence:/.test(l));
  if (i < 0) return null;
  const out = {};
  for (let j = i + 1; j < lines.length; j++) {
    const kv = /^  ([a-z]+):\s*(.*)$/.exec(lines[j]);
    if (!kv) break;
    out[kv[1]] = kv[2].trim();
  }
  return out;
}

test('C3 AC1/AC2: a dream-committed page carries evidence{session,commit,symbols} from real facts (git HEAD + .touched + session)', () => {
  const t = freshInstall('dream-evidence-');
  const head = gitInit(t);
  // the session's edited set — the .touched list code-intel-push maintains (REUSED, no new persistence path)
  const histDir = path.join(t, '.wrxn', 'history');
  fs.mkdirSync(histDir, { recursive: true });
  fs.writeFileSync(path.join(histDir, 'sid-evi-1.touched'), 'payload/.wrxn/dream.cjs\nsrc/foo.js\n');
  const body = '# Evi concept\n\nthe body that must not churn.';
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'evi-concept', title: 'Evi concept', body });
  stage(t, [p]);
  execFileSync('node', [path.join(t, DREAM), 'commit', writeJson(t, 'approved.json', ['evi-concept']), '--root', t],
    { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: 'sid-evi-1' }) });
  const txt = readPage(t, 'concepts', 'evi-concept');
  const ev = evidenceOf(txt);
  assert.ok(ev, 'the committed page carries an evidence: block');
  assert.equal(ev.session, 'sid-evi-1', 'session is the quote-verified source anchor (the consolidating session id)');
  assert.equal(ev.commit, head, 'commit is the real git HEAD at write time');
  assert.equal(ev.symbols, '[payload/.wrxn/dream.cjs, src/foo.js]', 'symbols is the session .touched set');
  // AC4 no churn: the prose body is verbatim + the evidence keys never leak past the closing fence
  assert.ok(txt.includes(body), 'the prose body is byte-for-byte present (no churn)');
  const afterFence = txt.slice(txt.indexOf('\n---', 3) + 4);
  assert.ok(!afterFence.includes('evidence:'), 'the evidence block is frontmatter-only, never in the body');
});

test('C3 AC5: with no git repo and no .touched, a dream commit still writes the page — commit/symbols omitted, session present (fail-open, never throws)', () => {
  const t = freshInstall('dream-evidence-failopen-'); // NOT a git repo; no .wrxn/history
  const p = validProposal({ kind: 'concept', tier: 'concepts', slug: 'fo-concept', title: 'FO', body: '# FO\n\nbody.' });
  stage(t, [p]);
  assert.doesNotThrow(() => {
    execFileSync('node', [path.join(t, DREAM), 'commit', writeJson(t, 'approved.json', ['fo-concept']), '--root', t],
      { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_SESSION_ID: 'sid-fo' }) });
  }, 'an unresolvable git HEAD / empty touched never throws');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'concepts', 'fo-concept.md')), 'the page still writes');
  const ev = evidenceOf(readPage(t, 'concepts', 'fo-concept'));
  assert.ok(ev, 'the evidence block is present');
  assert.equal(ev.session, 'sid-fo', 'session is present');
  assert.equal(ev.commit, undefined, 'commit is omitted when there is no git HEAD');
  assert.equal(ev.symbols, undefined, 'symbols is omitted when .touched is empty/absent');
});
