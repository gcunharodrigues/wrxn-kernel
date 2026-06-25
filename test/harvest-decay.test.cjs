'use strict';

// Tests for the harvest DECAY / SUPERSESSION curation layer (harvest-04 / H4) — the NON-destructive
// curation op: ANNOTATE a superseded or orphaned page so Recall + the operator know its status, WITHOUT
// ever deleting it (provenance survives — Letta eviction-not-delete). Distinct from merge (H3, the ONLY
// delete) and from sync drift (a doc out of sync with code).
//
// Shape mirrors harvest-merge.test.cjs: the path-confinement + integrity + secret-scan are PURE seams;
// `decay propose` / `decay confirm` are exercised black-box through the CLI; a seeded/tampered
// decay-staged.jsonl probes the write-boundary re-gate (a record that bypassed `propose`). The net-new
// act is an IN-PLACE frontmatter annotation (the sync restampDoc spirit), NOT a delete and NOT a body edit.
//
// Two annotation kinds (AC1):
//   · stale: <missing-source-path>   — an orphaned page whose `derived_from:` source FILE is gone (auto-
//                                       derived from H2's scanLocal — mechanical, no judgment).
//   · superseded_by: <path>          — a page replaced by another (a skill/operator JUDGMENT, drafted into
//                                       a proposal file; auto-scan cannot invent the replacement).
// Approval = the page path(s) the operator confirms (["…"] | { approved:[…] }); EMPTY = decline (AC3).

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
const fake = require('./helpers/fake-secrets.cjs'); // runtime-assembled secret-shaped fixtures (#70)

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Write a wiki page under a tier with the given frontmatter + body (mirrors harvest-merge.test.cjs).
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

// `decay propose [proposal.json]` — proposal file is OPTIONAL (absent → auto-scan orphaned → stale only).
function decayPropose(target, proposal) {
  const args = ['decay', 'propose'];
  if (proposal !== undefined && proposal !== null) args.push(writeJson(target, 'decay-proposal.json', proposal));
  return JSON.parse(runCli(target, args));
}

function decayConfirm(target, approved) {
  return JSON.parse(runCli(target, ['decay', 'confirm', writeJson(target, 'decay-approved.json', approved)]));
}

// Seed .wrxn/harvest/decay-staged.jsonl directly (simulate a tampered/seeded staging trail for the re-gate probes).
function seedDecayStaged(target, records) {
  const dir = path.join(target, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'decay-staged.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readAudit(target) {
  const f = path.join(target, '.wrxn', 'harvest', 'audit.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function pageExists(target, rel) {
  return fs.existsSync(path.join(target, rel));
}

function read(target, rel) {
  return fs.readFileSync(path.join(target, rel), 'utf8');
}

// The body = everything after the frontmatter fence (the part decay must NEVER touch).
function bodyOf(content) {
  return String(content).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

// ── PURE: annotateFrontmatter — append a key, preserve all other frontmatter + the body VERBATIM ──

test('annotateFrontmatter: appends key:value, preserves the other frontmatter + the body byte-for-byte', () => {
  const content = '---\nname: foo\ntier: concepts\nderived_from: src/x.ts\n---\n\n# foo\n\nbody line one\nbody line two\n';
  const next = harvest.annotateFrontmatter(content, 'stale', 'src/x.ts');
  assert.match(next, /^stale: src\/x\.ts$/m, 'the annotation key was appended into the frontmatter');
  assert.match(next, /^name: foo$/m, 'name preserved');
  assert.match(next, /^tier: concepts$/m, 'tier preserved');
  assert.match(next, /^derived_from: src\/x\.ts$/m, 'derived_from preserved');
  assert.equal(bodyOf(next), bodyOf(content), 'the body is byte-identical (decay never edits the body)');
});

test('annotateFrontmatter: a page with no frontmatter fence returns null (cannot annotate)', () => {
  assert.equal(harvest.annotateFrontmatter('# no frontmatter\n\njust body', 'stale', 'x'), null);
});

// ── PURE: hasFrontmatterKey — the idempotency probe (AC5) ──

test('hasFrontmatterKey: true when the key already exists, false otherwise', () => {
  const annotated = '---\nname: foo\ntier: concepts\nstale: src/x.ts\n---\n\nbody';
  const plain = '---\nname: foo\ntier: concepts\n---\n\nbody';
  assert.equal(harvest.hasFrontmatterKey(annotated, 'stale'), true);
  assert.equal(harvest.hasFrontmatterKey(plain, 'stale'), false);
  assert.equal(harvest.hasFrontmatterKey(plain, 'superseded_by'), false);
});

// ── PURE: annotationValueProblem — the write-channel sanitiser (value lands verbatim in frontmatter) ──

test('annotationValueProblem: rejects newline-injection, a secret, empty, oversize; passes a clean path', () => {
  assert.equal(harvest.annotationValueProblem('src/old.ts'), null, 'a clean POSIX path passes');
  assert.equal(harvest.annotationValueProblem('.wrxn/wiki/concepts/new.md'), null, 'a wiki page path passes');
  assert.equal(harvest.annotationValueProblem('a\nstale_injected: evil'), 'malformed_value', 'a newline (frontmatter injection) is refused');
  assert.equal(harvest.annotationValueProblem('a: b'), 'malformed_value', 'a colon (YAML mapping ambiguity) is refused');
  assert.equal(harvest.annotationValueProblem(''), 'malformed_value', 'empty is refused');
  assert.equal(harvest.annotationValueProblem('x'.repeat(500)), 'malformed_value', 'oversize is refused');
  assert.equal(harvest.annotationValueProblem(fake.aws()), 'contains_secret', 'a credential in the value is refused');
});

// ── PURE: decayHash — integrity over (page, key, value) ──

test('decayHash: deterministic; changes when page/key/value changes', () => {
  const base = { page: 'p.md', key: 'stale', value: 'src/x.ts' };
  assert.equal(harvest.decayHash(base), harvest.decayHash(base), 'same content → same hash');
  assert.notEqual(harvest.decayHash(base), harvest.decayHash({ page: 'q.md', key: 'stale', value: 'src/x.ts' }), 'page change → different hash');
  assert.notEqual(harvest.decayHash(base), harvest.decayHash({ page: 'p.md', key: 'superseded_by', value: 'src/x.ts' }), 'key change → different hash');
  assert.notEqual(harvest.decayHash(base), harvest.decayHash({ page: 'p.md', key: 'stale', value: 'src/y.ts' }), 'value change → different hash');
});

// ── PURE: reinforcedSet — read the coalesced recency sidecar within the window (AC4) ──

test('reinforcedSet: within-window keys included, stale excluded, malformed-date skipped; absent/corrupt sidecar → empty', () => {
  const root = tmp('wrxn-decay-reinf-');
  const now = new Date('2026-06-17T12:00:00Z');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.wrxn', 'reinforce.json'),
    JSON.stringify({
      'concepts/recent.md': '2026-06-10', // 7 days ago — within the 30-day window
      'concepts/edge.md': dayStr(new Date('2026-05-18T00:00:00Z')), // exactly 30 days ago — inclusive
      'concepts/old.md': '2026-01-01', // far outside the window
      'concepts/bad.md': 'not-a-date', // malformed value → skipped
    })
  );
  const set = harvest.reinforcedSet(root, now);
  assert.ok(set.has('concepts/recent.md'), 'a page surfaced within the window is reinforced');
  assert.ok(set.has('concepts/edge.md'), 'the window boundary is inclusive');
  assert.ok(!set.has('concepts/old.md'), 'a long-un-surfaced page is NOT reinforced (decay-eligible)');
  assert.ok(!set.has('concepts/bad.md'), 'a malformed date is ignored');

  // absent sidecar → empty (graceful)
  const root2 = tmp('wrxn-decay-reinf-absent-');
  assert.equal(harvest.reinforcedSet(root2, now).size, 0, 'absent sidecar → nothing reinforced');
  // corrupt sidecar → empty (graceful, never throws)
  const root3 = tmp('wrxn-decay-reinf-corrupt-');
  fs.mkdirSync(path.join(root3, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(root3, '.wrxn', 'reinforce.json'), '{ not json');
  assert.equal(harvest.reinforcedSet(root3, now).size, 0, 'corrupt sidecar → nothing reinforced');
});

// ── DEMO (AC1 + AC2 + AC3): orphaned → auto-propose stale → confirm → annotated, NOT deleted, body untouched ──

test('DEMO (AC1/AC2): an orphaned page → decay propose auto-stages stale → confirm annotates the frontmatter, body untouched, NOT deleted', () => {
  const t = freshInstall('wrxn-harvest-decay-demo-');
  // an orphaned page: its derived_from source FILE does not exist on disk
  writePage(t, 'concepts', 'orphan-page', { derived_from: 'src/gone.ts' }, '# orphan-page\n\nthe one true body\nsecond line');
  // a healthy bystander whose derived_from source DOES exist — must never be proposed/touched
  fs.mkdirSync(path.join(t, 'src'), { recursive: true });
  fs.writeFileSync(path.join(t, 'src', 'live.ts'), 'export const ok = 1;\n');
  writePage(t, 'concepts', 'healthy', { derived_from: 'src/live.ts' }, '# healthy\n\nstill backed by code');

  const before = read(t, '.wrxn/wiki/concepts/orphan-page.md');

  // propose (auto-scan): a stale proposal for the orphaned page, with a reason; pages UNTOUCHED at propose
  const prop = decayPropose(t);
  const staleProp = prop.staged.find((s) => s.page === '.wrxn/wiki/concepts/orphan-page.md');
  assert.ok(staleProp, 'the orphaned page was auto-proposed');
  assert.equal(staleProp.key, 'stale', 'the annotation is stale (orphaned → stale)');
  assert.equal(staleProp.value, 'src/gone.ts', 'the stale value is the missing derived_from source');
  assert.ok(staleProp.reason && /missing/i.test(staleProp.reason), 'the proposal carries a human-readable reason');
  assert.ok(!prop.staged.some((s) => s.page.endsWith('healthy.md')), 'a healthy page is never proposed');
  assert.equal(read(t, '.wrxn/wiki/concepts/orphan-page.md'), before, 'the page is byte-identical at propose time (non-destructive propose)');

  // confirm: the page gains the stale: frontmatter, the body is untouched, and it is NOT deleted
  const out = decayConfirm(t, ['.wrxn/wiki/concepts/orphan-page.md']);
  assert.equal(out.annotated.length, 1, 'one page annotated');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/orphan-page.md'), 'the page is NOT deleted (decay only annotates)');
  const after = read(t, '.wrxn/wiki/concepts/orphan-page.md');
  assert.match(after, /^stale: src\/gone\.ts$/m, 'the page gained the stale: annotation');
  assert.match(after, /^name: orphan-page$/m, 'name frontmatter preserved');
  assert.match(after, /^derived_from: src\/gone\.ts$/m, 'derived_from frontmatter preserved');
  assert.equal(bodyOf(after), bodyOf(before), 'the page BODY is byte-identical (decay never rewrites the body)');

  // the healthy bystander is byte-identical
  assert.doesNotMatch(read(t, '.wrxn/wiki/concepts/healthy.md'), /^stale:/m, 'the healthy page was never annotated');

  // audit recorded both phases
  const audit = readAudit(t);
  assert.ok(audit.some((a) => a.op === 'decay-propose'), 'the propose phase was audited');
  assert.ok(audit.some((a) => a.op === 'decay-confirm'), 'the confirm phase was audited');
});

// ── AC2 supersession: a skill-drafted superseded_by judgment → confirm annotates ──

test('AC2 supersession: a skill-drafted superseded_by proposal → confirm writes the forward-link, body untouched, NOT deleted', () => {
  const t = freshInstall('wrxn-harvest-decay-super-');
  writePage(t, 'concepts', 'old-way', {}, '# old-way\n\nthe deprecated approach');
  writePage(t, 'concepts', 'new-way', {}, '# new-way\n\nthe current approach');
  const before = read(t, '.wrxn/wiki/concepts/old-way.md');

  const prop = decayPropose(t, {
    page: '.wrxn/wiki/concepts/old-way.md',
    key: 'superseded_by',
    value: '.wrxn/wiki/concepts/new-way.md',
    reason: 'replaced by the new-way page after the redesign',
  });
  assert.equal(prop.staged.length, 1, 'the supersession was staged');
  assert.equal(prop.staged[0].key, 'superseded_by');

  const out = decayConfirm(t, ['.wrxn/wiki/concepts/old-way.md']);
  assert.equal(out.annotated.length, 1);
  const after = read(t, '.wrxn/wiki/concepts/old-way.md');
  assert.match(after, /^superseded_by: \.wrxn\/wiki\/concepts\/new-way\.md$/m, 'the forward-link was written');
  assert.equal(bodyOf(after), bodyOf(before), 'body untouched');
  assert.ok(pageExists(t, '.wrxn/wiki/concepts/old-way.md'), 'the superseded page is NOT deleted');
});

// ── AC3 decline: an empty approval leaves every page unchanged, nothing annotated ──

test('AC3 decline: an empty approval annotates nothing and every page stays byte-identical', () => {
  const t = freshInstall('wrxn-harvest-decay-decline-');
  writePage(t, 'concepts', 'orphan-page', { derived_from: 'src/gone.ts' }, '# orphan-page\n\nbody');
  const before = read(t, '.wrxn/wiki/concepts/orphan-page.md');
  decayPropose(t);

  const out = decayConfirm(t, { approved: [] }); // the operator declines
  assert.equal(out.annotated.length, 0, 'nothing annotated on decline');
  assert.equal(read(t, '.wrxn/wiki/concepts/orphan-page.md'), before, 'the page is byte-identical on decline');
});

// ── AC4: a reinforced (recently-surfaced) page is EXCLUDED from decay candidacy ──

test('AC4 reinforced-exclusion: an orphaned-but-reinforced page is never proposed; a non-reinforced orphan IS', () => {
  const t = freshInstall('wrxn-harvest-decay-reinforced-');
  // both pages are orphaned (their derived_from source is gone) — equal on the decay signal
  writePage(t, 'concepts', 'orphan-live', { derived_from: 'src/gone.ts' }, '# orphan-live\n\nbody');
  writePage(t, 'concepts', 'orphan-cold', { derived_from: 'src/gone.ts' }, '# orphan-cold\n\nbody');
  // orphan-live was surfaced TODAY (well within the 30-day window) → live knowledge, must be excluded.
  // orphan-cold's last surfacing is far outside the window → still decay-eligible.
  fs.writeFileSync(
    path.join(t, '.wrxn', 'reinforce.json'),
    JSON.stringify({
      'concepts/orphan-live.md': dayStr(new Date()),
      'concepts/orphan-cold.md': '2020-01-01',
    })
  );

  const prop = decayPropose(t);
  const pages = prop.staged.map((s) => s.page);
  assert.ok(!pages.includes('.wrxn/wiki/concepts/orphan-live.md'), 'the reinforced page is NOT a decay candidate (live knowledge is never flagged stale)');
  assert.ok(pages.includes('.wrxn/wiki/concepts/orphan-cold.md'), 'a non-reinforced orphan IS proposed');
});

// ── AC4 re-check at the write boundary: a page reinforced in the propose→confirm window is skipped ──

test('AC4 (Fix3): a page reinforced AFTER propose but before confirm is skipped at confirm (live knowledge never flagged)', () => {
  const t = freshInstall('wrxn-harvest-decay-reinf-confirm-');
  const pageRel = '.wrxn/wiki/concepts/orphan-page.md';
  writePage(t, 'concepts', 'orphan-page', { derived_from: 'src/gone.ts' }, '# orphan-page\n\nbody');
  const before = read(t, pageRel);

  // propose with NO reinforce.json yet → the orphan IS staged (it is not reinforced at propose time)
  const prop = decayPropose(t);
  assert.ok(prop.staged.some((s) => s.page === pageRel), 'the orphan was staged at propose (not yet reinforced)');

  // the page is surfaced by Recall in the propose→confirm window → it becomes reinforced (live knowledge)
  fs.writeFileSync(
    path.join(t, '.wrxn', 'reinforce.json'),
    JSON.stringify({ 'concepts/orphan-page.md': dayStr(new Date()) })
  );

  // confirm must RE-READ the reinforced set and skip the now-live page (AC4 re-validated at the write boundary)
  const out = decayConfirm(t, [pageRel]);
  assert.equal(out.annotated.length, 0, 'the now-reinforced page is not annotated at confirm');
  assert.equal(out.skipped[0].reason, 'reinforced', 'skipped because it became live knowledge in the propose→confirm window');
  assert.equal(read(t, pageRel), before, 'the page is byte-identical (no write)');
});

// ── AC5 idempotency (propose): an already-annotated page is not re-proposed ──

test('AC5 idempotency (propose): a page already carrying stale: is skipped, not re-proposed', () => {
  const t = freshInstall('wrxn-harvest-decay-idem-propose-');
  writePage(t, 'concepts', 'already', { derived_from: 'src/gone.ts', stale: 'src/gone.ts' }, '# already\n\nbody');
  const prop = decayPropose(t);
  assert.ok(!prop.staged.some((s) => s.page.endsWith('already.md')), 'an already-annotated page is not re-proposed');
});

// ── AC5 idempotency (confirm): a seeded staged record for an already-annotated page is a no-op (no churn, no dup key) ──

test('AC5 idempotency (confirm): re-annotating an already-stale page writes nothing — no duplicate key, byte-identical', () => {
  const t = freshInstall('wrxn-harvest-decay-idem-confirm-');
  const pageRel = '.wrxn/wiki/concepts/already.md';
  writePage(t, 'concepts', 'already', { stale: 'src/gone.ts' }, '# already\n\nbody');
  const before = read(t, pageRel);
  // a record that bypassed propose (e.g. staged before the page was annotated) — the write boundary must no-op it
  seedDecayStaged(t, [{ ts: 'x', op: 'decay-propose', page: pageRel, tier: 'concepts', slug: 'already', key: 'stale', value: 'src/gone.ts', reason: 'r', hash: harvest.decayHash({ page: pageRel, key: 'stale', value: 'src/gone.ts' }) }]);

  const out = decayConfirm(t, [pageRel]);
  assert.equal(out.annotated.length, 0, 'nothing written — the key already exists');
  assert.equal(out.skipped[0].reason, 'already_annotated');
  assert.equal(read(t, pageRel), before, 'the page is byte-identical (no churn, no duplicate key)');
  assert.equal((read(t, pageRel).match(/^stale:/gm) || []).length, 1, 'exactly one stale: key (no duplicate)');
});

// ── AC2 write-boundary re-gate: tamper / secret / path-escape are refused — no write ──

test('AC2 tamper: a seeded staged record whose value was altered after staging (hash mismatch) is refused — no write', () => {
  const t = freshInstall('wrxn-harvest-decay-tamper-');
  const pageRel = '.wrxn/wiki/concepts/victim.md';
  writePage(t, 'concepts', 'victim', { derived_from: 'src/gone.ts' }, '# victim\n\nbody');
  const before = read(t, pageRel);
  // the hash binds the ORIGINAL value; the stored value was swapped afterward
  const honest = harvest.decayHash({ page: pageRel, key: 'stale', value: 'src/gone.ts' });
  seedDecayStaged(t, [{ ts: 'x', op: 'decay-propose', page: pageRel, tier: 'concepts', slug: 'victim', key: 'stale', value: 'src/TAMPERED.ts', reason: 'r', hash: honest }]);

  const out = decayConfirm(t, [pageRel]);
  assert.equal(out.annotated.length, 0, 'the tampered record was blocked at the write boundary');
  assert.equal(out.skipped[0].reason, 'integrity_mismatch');
  assert.equal(read(t, pageRel), before, 'the page is byte-identical (no write)');
});

test('AC2 secret re-scan: a seeded staged record carrying a secret value (valid hash) is refused — no write', () => {
  const t = freshInstall('wrxn-harvest-decay-secret-');
  const pageRel = '.wrxn/wiki/concepts/victim.md';
  writePage(t, 'concepts', 'victim', {}, '# victim\n\nbody');
  const before = read(t, pageRel);
  const value = fake.aws();
  seedDecayStaged(t, [{ ts: 'x', op: 'decay-propose', page: pageRel, tier: 'concepts', slug: 'victim', key: 'stale', value, reason: 'r', hash: harvest.decayHash({ page: pageRel, key: 'stale', value }) }]);

  const out = decayConfirm(t, [pageRel]);
  assert.equal(out.annotated.length, 0, 're-scan at the write boundary blocked the secret');
  assert.equal(out.skipped[0].reason, 'contains_secret');
  assert.equal(read(t, pageRel), before, 'the page is byte-identical (no write)');
});

test('AC2 path-confine: a seeded staged record whose page escapes the knowledge tiers (valid hash) is refused — the victim is untouched', () => {
  const t = freshInstall('wrxn-harvest-decay-escape-');
  // a frontmatter-bearing victim OUTSIDE the knowledge tiers (in .wrxn/dream) — decay must NOT annotate it
  const victimRel = '.wrxn/dream/keep.md';
  fs.mkdirSync(path.join(t, '.wrxn', 'dream'), { recursive: true });
  fs.writeFileSync(path.join(t, victimRel), '---\nname: keep\ntier: concepts\n---\n\nmust survive untouched');
  const before = read(t, victimRel);
  const value = 'src/gone.ts';
  // honest hash → proves path-confinement is an INDEPENDENT gate from integrity
  seedDecayStaged(t, [{ ts: 'x', op: 'decay-propose', page: victimRel, tier: 'concepts', slug: 'keep', key: 'stale', value, reason: 'r', hash: harvest.decayHash({ page: victimRel, key: 'stale', value }) }]);

  const out = decayConfirm(t, [victimRel]);
  assert.equal(out.annotated.length, 0, 'the out-of-tier page was refused at the write boundary');
  assert.equal(out.skipped[0].reason, 'unsafe_page');
  assert.equal(read(t, victimRel), before, 'the out-of-tier victim is byte-identical (no annotation written)');
});
