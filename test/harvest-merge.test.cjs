'use strict';

// Tests for the harvest MERGE curation layer (harvest-03 / H3) — the ONE sanctioned hard-delete in the
// whole system: fold N near-dup pages into ONE survivor whose body is provably the union of theirs, then
// delete the absorbed slugs. The skill (LLM) DRAFTS the survivor; `harvest.cjs stage|commit` (deterministic)
// GATES + writes. Same propose→confirm / commit-by-reference spine as sync-06, but the net-new act is a
// multi-page MERGE + delete, not an in-place edit.
//
// Shape mirrors sync.test.cjs / harvest-check.test.cjs: the path-confinement + integrity + secret-scan are
// PURE seams; stage/commit are exercised black-box through the CLI; a tampered/seeded staged.jsonl probes
// the write-boundary re-gate (a record that bypassed `stage`). The destructive delete goes through wiki.cjs's
// new delete-by-reference path (confined to the wiki tiers by construction).
//
// Proposal { survivor:<relpath .wrxn/wiki/<knowledge-tier>/<slug>.md>, description?, body, absorbed:[relpath…] }
//   · survivor = the synthesised union page (a NEW page — additive, refuse-overwrite); stamped merged_from:.
//   · absorbed = the near-dup cluster members folded into it — DELETED on confirm, never the survivor.
// Approval = the survivor path(s) the operator confirms (["…"] | { approved:[…] }); EMPTY = decline (AC3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const HARVEST_REL = '.wrxn/harvest.cjs';
const harvest = require('../payload/.wrxn/harvest.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A full fresh install (lays harvest.cjs + wiki.cjs + the wiki tiers) for the black-box CLI assertions.
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Write a wiki page under a tier with the given frontmatter + body (mirrors harvest-check.test.cjs).
function writePage(root, tier, slug, fm, body) {
  const front = Object.assign({ name: slug, description: `${slug} notes`, tier }, fm || {});
  const lines = ['---'];
  for (const [k, v] of Object.entries(front)) if (v !== null && v !== undefined) lines.push(`${k}: ${v}`);
  lines.push('---', '', body == null ? `# ${slug}\n\nbody of ${slug}` : body, '');
  const dir = path.join(root, '.wrxn', 'wiki', tier);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug}.md`);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

function writeJson(target, name, obj) {
  const p = path.join(target, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function runCli(target, args) {
  return execFileSync('node', [path.join(target, HARVEST_REL), ...args, '--root', target], { encoding: 'utf8' });
}

function stage(target, proposal) {
  return JSON.parse(runCli(target, ['stage', writeJson(target, 'merge-proposal.json', proposal)]));
}

function commit(target, approved) {
  return JSON.parse(runCli(target, ['commit', writeJson(target, 'merge-approved.json', approved)]));
}

// Seed .wrxn/harvest/staged.jsonl directly (simulate a tampered/seeded staging trail for the re-gate probes).
function seedStaged(target, records) {
  const dir = path.join(target, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'staged.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readAudit(target) {
  const f = path.join(target, '.wrxn', 'harvest', 'audit.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function pageExists(target, rel) {
  return fs.existsSync(path.join(target, rel));
}

// A well-formed merge proposal: survivor = a NEW concepts page; absorbed = two existing near-dups.
function mergeProposal(over) {
  return Object.assign(
    {
      survivor: '.wrxn/wiki/concepts/widget-pagination.md',
      description: 'how widget pagination works',
      body: '# Widget pagination\n\nUnion of both pages: the API paginates with cursor + limit, and the UI debounces.',
      absorbed: ['.wrxn/wiki/concepts/alpha.md', '.wrxn/wiki/concepts/beta.md'],
    },
    over || {}
  );
}

// Plant the two near-dup originals the proposal folds together.
function plantCluster(target) {
  writePage(target, 'concepts', 'alpha', {}, '# alpha\n\nwidget pagination via cursor + limit');
  writePage(target, 'concepts', 'beta', {}, '# beta\n\nwidget pagination, the UI debounces requests');
}

// ── PURE: resolveSafeHarvestDoc — confine every target to the 4 knowledge tiers ──

test('resolveSafeHarvestDoc: a concepts/decisions/gotchas/_rules page resolves; sessions/_slots and escapes do NOT', () => {
  const root = '/install/root';
  for (const tier of harvest.HARVEST_TIERS) {
    assert.ok(harvest.resolveSafeHarvestDoc(root, `.wrxn/wiki/${tier}/x.md`), `${tier} is a knowledge tier`);
  }
  // inside .wrxn/wiki but NOT a knowledge tier — the curation scope is tighter than the whole wiki subtree
  assert.equal(harvest.resolveSafeHarvestDoc(root, '.wrxn/wiki/sessions/x.md'), null, 'the retired sessions tier is out of scope');
  assert.equal(harvest.resolveSafeHarvestDoc(root, '.wrxn/wiki/_slots/current-focus.md'), null, 'the focus slot is not a knowledge tier');
  // escapes
  assert.equal(harvest.resolveSafeHarvestDoc(root, '../../etc/evil.md'), null, 'a path escaping the install is refused');
  assert.equal(harvest.resolveSafeHarvestDoc(root, '.wrxn/dream/poison.md'), null, 'inside .wrxn but outside the wiki is refused');
  assert.equal(harvest.resolveSafeHarvestDoc(root, '.wrxn/wiki/concepts/nested/x.md'), null, 'a nested path (not <tier>/<slug>.md) is refused');
  assert.equal(harvest.resolveSafeHarvestDoc(root, '.wrxn/wiki/concepts/x.txt'), null, 'a non-.md target is refused');
  assert.equal(harvest.resolveSafeHarvestDoc(root, ''), null, 'an empty doc is refused');
});

// ── PURE: mergeHash — integrity over (survivor, description, body, absorbed) ─────

test('mergeHash: deterministic, order-independent on absorbed, changes when the body changes', () => {
  const base = { survivor: 's.md', description: 'd', body: 'B', absorbed: ['a.md', 'b.md'] };
  assert.equal(harvest.mergeHash(base), harvest.mergeHash(base), 'same content → same hash');
  assert.equal(
    harvest.mergeHash(base),
    harvest.mergeHash({ survivor: 's.md', description: 'd', body: 'B', absorbed: ['b.md', 'a.md'] }),
    'absorbed order does not change the hash (sorted internally)'
  );
  assert.notEqual(harvest.mergeHash(base), harvest.mergeHash(Object.assign({}, base, { body: 'B2' })), 'body change → different hash');
  assert.notEqual(harvest.mergeHash(base), harvest.mergeHash(Object.assign({}, base, { absorbed: ['a.md'] })), 'absorbed change → different hash');
});

// ── PURE: secretScan (reused from dream/sync) + composeSurvivor (the merged_from stamp) ──

test('secretScan: flags an AWS key, passes clean prose', () => {
  assert.equal(harvest.secretScan('# Notes\n\nthe key is AKIAIOSFODNN7EXAMPLE'), 'contains_secret');
  assert.equal(harvest.secretScan('# Notes\n\nplain merged prose'), null);
});

// ── PURE: descriptionProblem — the survivor frontmatter write-channel sanitiser (Fix1) ──

test('descriptionProblem: rejects a newline + a colon (frontmatter-injection guard); passes clean prose / empty', () => {
  assert.equal(harvest.descriptionProblem('how widget pagination works'), null, 'a clean one-line description passes');
  assert.equal(harvest.descriptionProblem(''), null, 'an empty description is allowed (description is optional)');
  assert.equal(harvest.descriptionProblem('legit\nimportance: 1.0'), 'malformed_description', 'a newline injects an extra frontmatter key');
  assert.equal(harvest.descriptionProblem('has a: colon'), 'malformed_description', 'a colon (YAML mapping ambiguity) is refused — decay\'s discipline');
});

test('composeSurvivor: the survivor page carries merged_from provenance + name/tier and the body', () => {
  const page = harvest.composeSurvivor({ tier: 'concepts', slug: 'widget-pagination', description: 'desc', body: '# Widget\n\nunion', mergedFrom: ['alpha', 'beta'] });
  assert.match(page, /^merged_from: \[alpha, beta\]$/m, 'provenance lands on the survivor (the merged_from stamp)');
  assert.match(page, /^name: widget-pagination$/m);
  assert.match(page, /^tier: concepts$/m);
  assert.match(page, /^description: desc$/m);
  assert.match(page, /# Widget\n\nunion/, 'the synthesised body is the page content');
  assert.doesNotMatch(page, /superseded_by:/, 'superseded_by is H4 (non-destructive) — merge stamps merged_from only');
});

// ── AC1: stage records the proposal by-reference; the pages are UNTOUCHED at stage ──

test('stage (AC1): records the proposal by-reference under .wrxn/harvest (non-.md); the cluster pages are UNCHANGED at stage', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-');
  plantCluster(t);
  const alphaBefore = fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/alpha.md'), 'utf8');
  const betaBefore = fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/beta.md'), 'utf8');

  const out = stage(t, mergeProposal());
  assert.equal(out.staged, 1, 'one merge proposal staged');

  const dir = path.join(t, '.wrxn', 'harvest');
  const staged = path.join(dir, 'staged.jsonl');
  assert.ok(fs.existsSync(staged), 'staged.jsonl created');
  // recon walks all of .wrxn and prose-ingests *.md → the staging trail MUST stay non-markdown (mirror dream/sync)
  assert.ok(fs.readdirSync(dir).every((f) => !f.endsWith('.md')), `no .md under .wrxn/harvest (got ${fs.readdirSync(dir).join(', ')})`);
  // the SURVIVOR has NOT been written and the absorbed are byte-identical — stage never mutates a knowledge page
  assert.ok(!pageExists(t, '.wrxn/wiki/concepts/widget-pagination.md'), 'the survivor is not written at stage time');
  assert.equal(fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/alpha.md'), 'utf8'), alphaBefore, 'alpha untouched at stage');
  assert.equal(fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/beta.md'), 'utf8'), betaBefore, 'beta untouched at stage');
});

test('stage (AC1): a survivor body containing a secret is REFUSED before staging', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-secret-');
  plantCluster(t);
  let err;
  try { runCli(t, ['stage', writeJson(t, 'p.json', mergeProposal({ body: '# Widget\n\ntoken AKIAIOSFODNN7EXAMPLE leaked' }))]); } catch (e) { err = e; }
  assert.ok(err, 'stage exited non-zero on a secret');
  assert.match(String(err.stderr || ''), /credential|secret/i);
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'harvest', 'staged.jsonl')), 'nothing staged');
});

test('stage: an absorbed target escaping the knowledge tiers is REFUSED at stage', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-escape-');
  plantCluster(t);
  let err;
  try { runCli(t, ['stage', writeJson(t, 'p.json', mergeProposal({ absorbed: ['../../etc/passwd.md'] }))]); } catch (e) { err = e; }
  assert.ok(err, 'stage refused an out-of-tier absorbed target');
  assert.match(String(err.stderr || ''), /tier|escape|wiki|knowledge/i);
});

test('stage: the survivor cannot also be an absorbed (delete) target', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-selfabsorb-');
  plantCluster(t);
  let err;
  try {
    const surv = '.wrxn/wiki/concepts/widget-pagination.md';
    runCli(t, ['stage', writeJson(t, 'p.json', mergeProposal({ survivor: surv, absorbed: [surv] }))]);
  } catch (e) { err = e; }
  assert.ok(err, 'stage refused a survivor that is also an absorbed target');
});

test('stage: an empty absorbed list is REFUSED (a merge folds at least one page)', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-empty-');
  let err;
  try { runCli(t, ['stage', writeJson(t, 'p.json', mergeProposal({ absorbed: [] }))]); } catch (e) { err = e; }
  assert.ok(err, 'stage refused an empty absorbed list');
});

test('stage (Fix1): a survivor description containing a newline OR a colon is REFUSED (frontmatter-injection guard)', () => {
  const t = freshInstall('wrxn-harvest-merge-stage-desc-');
  plantCluster(t);
  // a newline injects an arbitrary extra frontmatter key into the survivor (the medium-severity vector)
  let errNl;
  try { runCli(t, ['stage', writeJson(t, 'p1.json', mergeProposal({ description: 'legit\nimportance: 1.0' }))]); } catch (e) { errNl = e; }
  assert.ok(errNl, 'stage refused a newline in the description');
  assert.match(String(errNl.stderr || ''), /description.*(newline|colon|injection)/i);
  // a colon alone is also refused — the same write-channel discipline decay's annotationValueProblem applies
  let errColon;
  try { runCli(t, ['stage', writeJson(t, 'p2.json', mergeProposal({ description: 'has a: colon' }))]); } catch (e) { errColon = e; }
  assert.ok(errColon, 'stage refused a colon in the description');
  // nothing was staged by either rejected attempt
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'harvest', 'staged.jsonl')), 'no proposal was staged');
});

// ── AC2 + AC4 + AC5: the headline DEMO — commit writes the survivor (merged_from) BEFORE deleting the absorbed ──

test('DEMO (AC2/AC4/AC5): 2 near-dups → stage → commit → 1 survivor (merged_from), the 2 originals deleted, a bystander untouched, audit recorded', () => {
  const t = freshInstall('wrxn-harvest-merge-demo-');
  plantCluster(t);
  // a near-dup NEIGHBOUR that is NOT in the cluster — proves a delete only targets the staged absorbed members (AC4)
  writePage(t, 'concepts', 'gamma', {}, '# gamma\n\nUNRELATED kubernetes networking notes');

  const sOut = stage(t, mergeProposal());
  assert.equal(sOut.staged, 1);
  // AC4: staging did NOT delete anything — both originals still present after stage
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md') && pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'staging is non-destructive');

  const out = commit(t, ['.wrxn/wiki/concepts/widget-pagination.md']);
  assert.equal(out.merged.length, 1, 'the approved merge was committed');

  // the survivor exists, stamped merged_from with the absorbed slugs (provenance on the SURVIVOR — AC2)
  const survFile = path.join(t, '.wrxn/wiki/concepts/widget-pagination.md');
  assert.ok(fs.existsSync(survFile), 'the survivor page was written');
  const surv = fs.readFileSync(survFile, 'utf8');
  assert.match(surv, /^merged_from: \[alpha, beta\]$/m, 'merged_from provenance stamped on the survivor (sorted absorbed slugs)');
  assert.match(surv, /Union of both pages/, 'the synthesised union body is the survivor content (AC5)');
  assert.doesNotMatch(surv, /superseded_by:/, 'merge does not write superseded_by (that is H4)');

  // the 2 originals are DELETED (the one sanctioned hard-delete) ...
  assert.ok(!pageExists(t, '.wrxn/wiki/concepts/alpha.md'), 'absorbed alpha deleted');
  assert.ok(!pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'absorbed beta deleted');
  // ... and the bystander is UNTOUCHED — a delete only targets staged cluster members (AC4)
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/gamma.md'), 'a non-absorbed neighbour is never deleted');

  // audit: a stage event + a commit event recorded under .wrxn/harvest/audit.jsonl
  const audit = readAudit(t);
  assert.ok(audit.some((a) => a.op === 'stage'), 'the stage event was audited');
  const committed = audit.find((a) => a.op === 'commit');
  assert.ok(committed, 'the commit event was audited');
  assert.deepEqual(committed.merged, ['.wrxn/wiki/concepts/widget-pagination.md'], 'the audit names the committed survivor');
});

// ── AC4: survivor-written-BEFORE-delete — no delete ever happens without a successful survivor write ──

test('AC4 ordering: when the survivor write is refused (survivor path already exists), NO absorbed page is deleted', () => {
  const t = freshInstall('wrxn-harvest-merge-order-');
  plantCluster(t);
  // pre-create the survivor path → the additive refuse-overwrite write boundary will skip the merge
  writePage(t, 'concepts', 'widget-pagination', {}, '# existing\n\na curated page already lives at the survivor slug');
  stage(t, mergeProposal());

  const out = commit(t, ['.wrxn/wiki/concepts/widget-pagination.md']);
  assert.equal(out.merged.length, 0, 'the merge did not commit');
  assert.equal(out.skipped[0].reason, 'survivor_exists', 'refused because the survivor write would overwrite a curated page');
  // the proof of ordering: because the survivor write was refused FIRST, the absorbed are STILL present
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md'), 'no delete happened without a successful survivor write (alpha intact)');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'no delete happened without a successful survivor write (beta intact)');
  // the pre-existing curated page is byte-identical (never clobbered)
  assert.match(fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/widget-pagination.md'), 'utf8'), /a curated page already lives/, 'the existing page was not overwritten');
});

// ── AC3: decline (empty approval) → every page unchanged, nothing deleted ────────

test('AC3 decline: an empty approval leaves every page intact and deletes nothing', () => {
  const t = freshInstall('wrxn-harvest-merge-decline-');
  plantCluster(t);
  const alphaBefore = fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/alpha.md'), 'utf8');
  const betaBefore = fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/beta.md'), 'utf8');
  stage(t, mergeProposal());

  const out = commit(t, { approved: [] }); // the operator declines
  assert.equal(out.merged.length, 0, 'nothing committed on decline');
  assert.ok(!pageExists(t, '.wrxn/wiki/concepts/widget-pagination.md'), 'no survivor written on decline');
  assert.equal(fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/alpha.md'), 'utf8'), alphaBefore, 'alpha intact on decline');
  assert.equal(fs.readFileSync(path.join(t, '.wrxn/wiki/concepts/beta.md'), 'utf8'), betaBefore, 'beta intact on decline');
});

// ── AC2 write-boundary re-gate: a tampered / secret-laden / out-of-tier staged record cannot write OR delete ──

test('AC2 tamper: a staged proposal whose body was altered after staging (hash mismatch) cannot write or delete', () => {
  const t = freshInstall('wrxn-harvest-merge-tamper-');
  plantCluster(t);
  const survRel = '.wrxn/wiki/concepts/widget-pagination.md';
  const absorbed = ['.wrxn/wiki/concepts/alpha.md', '.wrxn/wiki/concepts/beta.md'];
  // the hash binds the ORIGINAL drafted body; the stored body was swapped for injected content afterward
  const honest = harvest.mergeHash({ survivor: survRel, description: '', body: '# Widget\n\nORIGINAL synthesised union.', absorbed });
  seedStaged(t, [{ ts: 'x', op: 'stage', survivor: survRel, tier: 'concepts', slug: 'widget-pagination', description: '', body: '# Widget\n\nTAMPERED injected content.', absorbed, hash: honest }]);

  const out = commit(t, [survRel]);
  assert.equal(out.merged.length, 0, 'the tampered proposal was blocked at the write boundary');
  assert.equal(out.skipped[0].reason, 'integrity_mismatch');
  assert.ok(!pageExists(t, survRel), 'no survivor written');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md') && pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'no absorbed deleted');
});

test('AC2 secret re-scan: a seeded staged record carrying a secret (valid hash) is re-scanned and refused — no write, no delete', () => {
  const t = freshInstall('wrxn-harvest-merge-confirm-secret-');
  plantCluster(t);
  const survRel = '.wrxn/wiki/concepts/widget-pagination.md';
  const absorbed = ['.wrxn/wiki/concepts/alpha.md', '.wrxn/wiki/concepts/beta.md'];
  const body = '# Widget\n\ntoken AKIAIOSFODNN7EXAMPLE slipped into the survivor';
  seedStaged(t, [{ ts: 'x', op: 'stage', survivor: survRel, tier: 'concepts', slug: 'widget-pagination', description: '', body, absorbed, hash: harvest.mergeHash({ survivor: survRel, description: '', body, absorbed }) }]);

  const out = commit(t, [survRel]);
  assert.equal(out.merged.length, 0, 're-scan at the write boundary blocked the secret');
  assert.equal(out.skipped[0].reason, 'contains_secret');
  assert.ok(!pageExists(t, survRel), 'no survivor written');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md') && pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'no absorbed deleted');
});

test('AC2/AC4 path-confine: a seeded staged record whose absorbed target escapes the knowledge tiers (valid hash) is refused — no write, no delete', () => {
  const t = freshInstall('wrxn-harvest-merge-confirm-escape-');
  plantCluster(t);
  // a frontmatter-bearing victim OUTSIDE the knowledge tiers (in .wrxn/dream) — the merge must NOT delete it
  const victimRel = '.wrxn/dream/keep.md';
  fs.mkdirSync(path.join(t, '.wrxn', 'dream'), { recursive: true });
  fs.writeFileSync(path.join(t, victimRel), '# keep\n\nmust survive');
  const survRel = '.wrxn/wiki/concepts/widget-pagination.md';
  const absorbed = ['.wrxn/wiki/concepts/alpha.md', victimRel]; // one legit + one escaping target
  const body = '# Widget\n\nclean union';
  // hash is computed HONESTLY over the malicious record so integrity PASSES — proving path-confinement is an INDEPENDENT gate
  seedStaged(t, [{ ts: 'x', op: 'stage', survivor: survRel, tier: 'concepts', slug: 'widget-pagination', description: '', body, absorbed, hash: harvest.mergeHash({ survivor: survRel, description: '', body, absorbed }) }]);

  const out = commit(t, [survRel]);
  assert.equal(out.merged.length, 0, 'the out-of-tier absorbed target blocked the whole merge (atomic refusal)');
  assert.equal(out.skipped[0].reason, 'unsafe_absorbed');
  assert.ok(!pageExists(t, survRel), 'no survivor written when any target is unsafe');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md'), 'the legit absorbed page was NOT deleted (atomic refusal)');
  assert.equal(fs.readFileSync(path.join(t, victimRel), 'utf8'), '# keep\n\nmust survive', 'the out-of-tier victim is byte-identical');
});

test('AC2 frontmatter-injection (Fix1): a staged record whose description injects a frontmatter line (VALID hash) is refused at commit — no write, no delete', () => {
  const t = freshInstall('wrxn-harvest-merge-confirm-desc-inject-');
  plantCluster(t);
  const survRel = '.wrxn/wiki/concepts/widget-pagination.md';
  const absorbed = ['.wrxn/wiki/concepts/alpha.md', '.wrxn/wiki/concepts/beta.md'];
  const body = '# Widget\n\nclean union body';
  // the description injects an importance: line — harvest never stamps importance:, so the injected value
  // would be the sole importance source on the merged page (a decay-weighted-recall poisoning amplifier)
  const description = 'legit desc\nimportance: 1.0';
  // honest hash over the malicious record so integrity PASSES — proving the description guard is an INDEPENDENT gate
  seedStaged(t, [{ ts: 'x', op: 'stage', survivor: survRel, tier: 'concepts', slug: 'widget-pagination', description, body, absorbed, hash: harvest.mergeHash({ survivor: survRel, description, body, absorbed }) }]);

  const out = commit(t, [survRel]);
  assert.equal(out.merged.length, 0, 'the injected-description proposal was blocked at the write boundary');
  assert.equal(out.skipped[0].reason, 'malformed_description');
  assert.ok(!pageExists(t, survRel), 'no survivor written');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md') && pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'no absorbed deleted');
});

test('commit: approving a survivor that was never staged is skipped (not_staged), nothing changes', () => {
  const t = freshInstall('wrxn-harvest-merge-notstaged-');
  plantCluster(t);
  const out = commit(t, ['.wrxn/wiki/concepts/widget-pagination.md']);
  assert.equal(out.merged.length, 0);
  assert.equal(out.skipped[0].reason, 'not_staged');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/alpha.md') && pageExists(t, '.wrxn/wiki/concepts/beta.md'), 'nothing deleted');
});

// ── self-contained: node stdlib only (no kernel-lib / recon import) ──────────────

test('the harvest adapter still imports nothing outside the node standard library after the merge extension', () => {
  const src = fs.readFileSync(path.join(PKG_ROOT, 'payload', HARVEST_REL), 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});
