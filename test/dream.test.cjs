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
  const out = JSON.parse(dream(t, ['commit', writeJson(t, 'approved.json', { proposals: [a, b] })]));

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
  // the middle proposal's page already exists (laid through the wiki adapter)
  wiki(t, ['write-page', 'decisions', 'mid', '--description', 'Mid', '--body', 'pre-existing curated page']);

  const first = validProposal({ kind: 'decision', tier: 'decisions', slug: 'first', title: 'First', body: '# First\n\nfirst decision.' });
  const mid = validProposal({ kind: 'decision', tier: 'decisions', slug: 'mid', title: 'Mid', body: '# Mid\n\nWOULD-CLOBBER if written.' });
  const third = validProposal({ kind: 'decision', tier: 'decisions', slug: 'third', title: 'Third', body: '# Third\n\nthird decision.' });

  const out = JSON.parse(dream(t, ['commit', writeJson(t, 'approved.json', { proposals: [first, mid, third] })]));

  // the batch did NOT abort: the two non-colliding pages are written, the middle is skipped
  assert.deepEqual(out.written.map((w) => w.slug).sort(), ['first', 'third']);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].slug, 'mid');
  assert.equal(out.skipped[0].reason, 'skipped-existing');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'first.md')), 'first written despite the mid collision');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'third.md')), 'third written despite the mid collision');
  // the pre-existing curated page is NOT clobbered
  assert.match(fs.readFileSync(path.join(t, '.wrxn', 'wiki', 'decisions', 'mid.md'), 'utf8'), /pre-existing curated page/);
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
  const out = JSON.parse(dream(t, ['commit', writeJson(t, 'approved.json', { proposals: [validRule()] })]));
  assert.equal(out.written.length, 1);
  assert.equal(out.skipped.length, 0);
  const page = path.join(t, '.wrxn', 'wiki', '_rules', 'always-rebase-before-merge.md');
  assert.ok(fs.existsSync(page), 'rule page written under .wrxn/wiki/_rules as a real .md');
  assert.match(fs.readFileSync(page, 'utf8'), /rebase feature branches onto main/);
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
  // a curated knowledge page already exists
  wiki(t, ['write-page', 'decisions', 'use-pino', '--description', 'Use pino', '--body', 'CURATED original']);

  // a dream commit of the SAME slug is dedup-SKIPPED (additive — never clobbers a knowledge page)
  const dup = validProposal({ slug: 'use-pino', title: 'Use pino', body: '# Pino\n\nWOULD-CLOBBER if written.' });
  const out = JSON.parse(dream(t, ['commit', writeJson(t, 'approved.json', { proposals: [dup] })]));
  assert.equal(out.written.length, 0, 'the duplicate knowledge page is not written');
  assert.equal(out.skipped[0].reason, 'skipped-existing');
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

test('the knowledge gate does NOT gain _slots — a proposal targeting _slots is unsupported_tier', () => {
  const t = freshInstall('dream-slots-gate-');
  const v = checkOne(t, validProposal({ kind: 'concept', tier: '_slots', slug: 'current-focus', title: 'x', body: '# x\n\ny' }));
  assert.equal(v.reason, 'unsupported_tier');
});
