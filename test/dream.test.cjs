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
const { stampImportance } = require('../payload/.wrxn/dream.cjs'); // the pure decay-weight stamp (harvest-10)

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

// ── set-focus: the _slots focus slot + the lone update-exception (dream-04) ────
// The focus slot is the project's durable STANDING focus — NOT a knowledge proposal. set-focus
// creates AND overwrites _slots/current-focus.md (the lone exception to additive + dedup-skip), goes
// through wiki.cjs (the indirection contract), and is DISJOINT from the continuity baton.

function setFocus(t, focus) {
  return JSON.parse(dream(t, ['set-focus', writeJson(t, 'focus.json', focus)]));
}

test('set-focus creates _slots/current-focus.md, and a LATER set-focus UPDATES it in place', () => {
  const t = freshInstall('dream-focus-');
  const page = path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md');
  setFocus(t, { title: 'Current focus', body: '# Current focus\n\nShip dream-04: the focus slot.' });
  assert.ok(fs.existsSync(page), 'focus slot created as a real .md under .wrxn/wiki/_slots');
  assert.match(fs.readFileSync(page, 'utf8'), /Ship dream-04/);

  // a LATER set-focus OVERWRITES the same path in place — the lone update-exception
  setFocus(t, { title: 'Current focus', body: '# Current focus\n\nNow onto dream-05: the handoff nudge.' });
  const txt = fs.readFileSync(page, 'utf8');
  assert.match(txt, /dream-05/, 'slot updated to the new standing focus');
  assert.doesNotMatch(txt, /dream-04/, 'the prior focus is overwritten in place, not appended');
});

test('set-focus writes the slot via wiki.cjs as an indexable .md the wiki query can recall', () => {
  const t = freshInstall('dream-focus-md-');
  const marker = 'WQZX-distinctive-focus-marker';
  setFocus(t, { body: `# Current focus\n\n${marker}` });
  const res = JSON.parse(wiki(t, ['query', marker]));
  assert.ok(res.total >= 1, 'the focus slot is a queryable wiki page (recon prose-ingests it)');
  assert.equal(res.hits[0].tier, '_slots');
});

test('set-focus records the update in the .wrxn/dream audit log (.jsonl)', () => {
  const t = freshInstall('dream-focus-audit-');
  setFocus(t, { body: '# Current focus\n\nfocus body' });
  const audit = fs.readFileSync(path.join(t, '.wrxn', 'dream', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ev = audit.find((e) => e.op === 'set-focus');
  assert.ok(ev, 'a set-focus event is appended to the audit log');
  assert.match(ev.file, /_slots\/current-focus\.md$/);
});

test('INVARIANT: the slot updates while every OTHER tier stays additive + dedup-skip', () => {
  const t = freshInstall('dream-focus-invariant-');
  // a dream proposal for 'use-pino' is staged BEFORE any curated page exists
  const dup = validProposal({ slug: 'use-pino', title: 'Use pino', body: '# Pino\n\nWOULD-CLOBBER if written.' });
  stage(t, [dup]);
  // a curated knowledge page with the same slug is then laid by hand
  wiki(t, ['write-page', 'decisions', 'use-pino', '--description', 'Use pino', '--body', 'CURATED original']);

  // committing the staged slug is re-gate dedup-SKIPPED (additive — never clobbers a knowledge page)
  const out = commit(t, ['use-pino']);
  assert.equal(out.written.length, 0, 'the duplicate knowledge page is not written');
  assert.equal(out.skipped[0].reason, 'duplicate_existing_path');
  assert.match(fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'use-pino.md'), 'utf8'), /CURATED original/, 'knowledge tier NOT clobbered');

  // …but the focus slot DOES overwrite in place across two set-focus calls
  setFocus(t, { body: '# Current focus\n\nfocus v1' });
  setFocus(t, { body: '# Current focus\n\nfocus v2' });
  const slot = fs.readFileSync(path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md'), 'utf8');
  assert.match(slot, /focus v2/);
  assert.doesNotMatch(slot, /focus v1/, 'the slot is the LONE updatable page');
});

test('CONTINUITY DOCTRINE: set-focus never reads or writes the handoff baton (disjoint paths)', () => {
  const t = freshInstall('dream-focus-baton-');
  // pre-seed the deliberate handoff baton (single writer = the handoff skill) with a distinctive marker
  const baton = path.join(t, '.wrxn', 'continuity', 'latest.md');
  fs.mkdirSync(path.dirname(baton), { recursive: true });
  const batonMarker = 'BATON-ONLY-marker-must-survive';
  fs.writeFileSync(baton, `# Handoff\n\n${batonMarker}\n`);

  const focusMarker = 'FOCUS-ONLY-marker';
  setFocus(t, { body: `# Current focus\n\n${focusMarker}` });

  // the baton is untouched (set-focus never WROTE it) and never absorbed the focus content
  const batonTxt = fs.readFileSync(baton, 'utf8');
  assert.match(batonTxt, new RegExp(batonMarker), 'baton content survives — set-focus did not write it');
  assert.doesNotMatch(batonTxt, new RegExp(focusMarker), 'the focus was not written into the baton');
  // the focus slot carries ONLY its own marker (set-focus never READ/copied the baton)
  const slotTxt = fs.readFileSync(path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md'), 'utf8');
  assert.match(slotTxt, new RegExp(focusMarker));
  assert.doesNotMatch(slotTxt, new RegExp(batonMarker), 'the slot did not absorb the baton (disjoint paths + writers)');
});

// ── set-focus is gated too (dream-review #4, security M1): negative filters + secret-scan ──

test('SECURITY (M1): set-focus refuses a focus body containing a credential (slot not written)', () => {
  const t = freshInstall('dream-focus-secret-');
  const page = path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md');
  let err;
  try {
    dream(t, ['set-focus', writeJson(t, 'focus.json', { body: '# Current focus\n\nrotate AKIAIOSFODNN7EXAMPLE before Friday.' })]);
  } catch (e) { err = e; }
  assert.ok(err, 'set-focus exited non-zero');
  assert.match(String(err.stderr || ''), /contains_secret|credential/i);
  assert.ok(!fs.existsSync(page), 'the focus slot was not written');
});

test('SECURITY (M1): set-focus refuses a focus body that trips a negative filter (slot not written)', () => {
  const t = freshInstall('dream-focus-neg-');
  const page = path.join(t, '.wrxn', 'wiki', '_slots', 'current-focus.md');
  let err;
  try {
    dream(t, ['set-focus', writeJson(t, 'focus.json', { body: '# Current focus\n\nthe recon tool is broken and does not work.' })]);
  } catch (e) { err = e; }
  assert.ok(err, 'set-focus exited non-zero');
  assert.match(String(err.stderr || ''), /negative_filter|negative filter/i);
  assert.ok(!fs.existsSync(page), 'the focus slot was not written');
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
