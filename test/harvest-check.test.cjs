'use strict';

// Tests for the harvest health-check adapter (harvest-02 / H2) — the auto, REPORT-ONLY curation-debt
// detector, layer 1 of harvest. `harvest.cjs check [--root]` scans the 4 knowledge tiers and writes a
// durable structured report (`.wrxn/harvest/<ts>.jsonl`), one record per finding, classified:
//   · near_dup        — clusters of pages over a MEASURED semantic-similarity threshold (recon hybrid
//                        similarity over the warm serve door), connected-component-deduped.
//   · decay_candidate — orphaned (its `derived_from:` source file is gone) OR superseded (carries a
//                        `superseded_by:` forward-link). Both are LOCAL scans (no door).
//   · malformed       — bad frontmatter (the existing wiki-lint signal).
//
// Seams mirror sync.cjs / recall-surface.cjs: the gate predicates + clusterer are PURE; nearDupFromDoor
// and check() are IO shells with an INJECTED transport (tests never touch the network); the CLI is
// exercised black-box. REPORT-ONLY: check never edits/deletes/annotates a knowledge page; the knowledge
// tiers are byte-identical after a run. Fail-soft: a cold/unreachable door degrades near-dup to
// "unavailable" while malformed + orphaned still run; check never throws / never blocks (exit 0).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const HARVEST_REL = '.wrxn/harvest.cjs';
const HARVEST = path.join(PKG_ROOT, 'payload', HARVEST_REL);
const harvest = require('../payload/.wrxn/harvest.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A bare install root carrying the wrxn.install.json the adapter's root resolution walks up to find.
function installRoot(prefix) {
  const root = tmp(prefix);
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify({ version: '0.0.0' }));
  return root;
}

// A full fresh install (for the manifest/laydown + black-box CLI assertions).
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Write a wiki page under a tier with the given frontmatter + body. `fm` overrides default keys; a key
// set to null is omitted (to model a malformed page).
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

// Write the recon-wrxn serve-door discovery file, chmod 0600 (the adapter refuses a loose/planted file).
function writeEndpoint(root, body) {
  const dir = path.join(root, '.recon-wrxn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'serve-endpoint.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  fs.chmodSync(file, 0o600);
  return file;
}

// A guaranteed-dead pid (spawnSync reaps it before returning).
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// A recon_find prose hit (the brain-recall per-hit shape recall-surface reads): Page/Section type, a
// file path, a dense cosine in semanticScore, and the BM25+semantic provenance.
function phit(file, semanticScore, over) {
  return Object.assign(
    { id: file, name: path.basename(file, '.md'), type: 'Page', file, line: 1, score: 0.02, sources: ['bm25', 'semantic'], bm25Score: 5, semanticScore },
    over
  );
}

function runCli(target, args) {
  return execFileSync('node', [path.join(target, HARVEST_REL), ...args, '--root', target], { encoding: 'utf8' });
}

// Read the single .jsonl report check wrote, parsed into records.
function readReport(root) {
  const dir = path.join(root, '.wrxn', 'harvest');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `exactly one report written (got ${files.join(', ')})`);
  const txt = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// A snapshot of every knowledge page's bytes — for the report-only (byte-identical) assertion.
function snapshotWiki(root) {
  const snap = {};
  for (const tier of ['concepts', 'decisions', 'gotchas', '_rules', 'sessions']) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) snap[`${tier}/${n}`] = fs.readFileSync(path.join(dir, n), 'utf8');
  }
  return snap;
}

// ── PURE: lintPage (the malformed signal, reused from wiki-lint) ────────────────

test('lintPage: flags no-frontmatter / unterminated / missing-key; passes a well-formed page', () => {
  assert.equal(harvest.lintPage('# just a body\n\nno frontmatter'), 'no frontmatter');
  assert.equal(harvest.lintPage('---\nname: x\ndescription: y\ntier: concepts\n# never closed'), 'unterminated frontmatter');
  assert.match(harvest.lintPage('---\nname: x\n---\n\nbody'), /missing/);
  assert.equal(harvest.lintPage('---\nname: x\ndescription: y\ntier: concepts\n---\n\nbody'), null);
});

// ── PURE: nearDupQualifies (semanticScore >= threshold AND the dense arm present) ─

test('nearDupQualifies: >= threshold with the semantic arm present qualifies; just below does not', () => {
  const T = harvest.NEAR_DUP_THRESHOLD;
  assert.equal(harvest.nearDupQualifies(phit('a.md', T)), true, 'the threshold is inclusive');
  assert.equal(harvest.nearDupQualifies(phit('a.md', T - 0.01)), false, 'just below the threshold is not a near-dup');
});

test('nearDupQualifies: a high cosine WITHOUT "semantic" in sources does not qualify (producer-drift defense)', () => {
  assert.equal(harvest.nearDupQualifies(phit('a.md', 0.99, { sources: ['bm25'] })), false, 'a stray cosine with no dense arm is not trusted');
});

test('nearDupQualifies: the fused RRF score is NOT the gate (ADR 0002 — rank-based, not a magnitude)', () => {
  // A huge fused `score` cannot make a sub-threshold cosine a near-dup.
  assert.equal(harvest.nearDupQualifies(phit('a.md', 0.30, { score: 0.99 })), false);
});

// ── PURE: clusterNearDups (connected components, deduped, size >= 2) ─────────────

test('clusterNearDups: an A-B and the reverse B-A edge collapse into ONE pair cluster (no double-report)', () => {
  const clusters = harvest.clusterNearDups([
    { a: '.wrxn/wiki/concepts/a.md', b: '.wrxn/wiki/concepts/b.md', score: 0.92 },
    { a: '.wrxn/wiki/concepts/b.md', b: '.wrxn/wiki/concepts/a.md', score: 0.91 },
  ]);
  assert.equal(clusters.length, 1, 'the symmetric pair is one cluster, not two');
  assert.deepEqual(clusters[0].members, ['.wrxn/wiki/concepts/a.md', '.wrxn/wiki/concepts/b.md']);
  assert.equal(clusters[0].score, 0.92, 'the cluster carries the strongest edge similarity');
});

test('clusterNearDups: A-B-C transitive edges form ONE cluster of three (connected component)', () => {
  const clusters = harvest.clusterNearDups([
    { a: 'x/a.md', b: 'x/b.md', score: 0.9 },
    { a: 'x/b.md', b: 'x/c.md', score: 0.88 },
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members, ['x/a.md', 'x/b.md', 'x/c.md']);
});

test('clusterNearDups: no edges → no clusters (a singleton is never a cluster)', () => {
  assert.deepEqual(harvest.clusterNearDups([]), []);
});

// ── PURE: scanLocal (malformed + orphaned + superseded — all local, no door) ─────

test('scanLocal: orphaned = a page whose derived_from source FILE is gone; an existing source is NOT orphaned', () => {
  const root = installRoot('wrxn-harvest-orphan-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'real.ts'), 'export const x = 1;');
  writePage(root, 'concepts', 'gone', { derived_from: 'src/missing.ts#sym' }, '# gone\n\nderived from a deleted source');
  writePage(root, 'concepts', 'kept', { derived_from: 'src/real.ts#x' }, '# kept\n\nderived from a live source');
  const { decay } = harvest.scanLocal(root);
  const orphaned = decay.filter((d) => d.subtype === 'orphaned');
  assert.equal(orphaned.length, 1, 'only the page with a missing source is orphaned');
  assert.equal(orphaned[0].slug, 'gone');
  assert.equal(orphaned[0].path, '.wrxn/wiki/concepts/gone.md');
  assert.equal(orphaned[0].missing_source, 'src/missing.ts', 'records the missing source (anchor stripped) for the downstream proposal');
});

test('scanLocal (Fix2): a page carrying superseded_by: is RESOLVED (the desired end state) — NOT a decay_candidate', () => {
  const root = installRoot('wrxn-harvest-superseded-');
  writePage(root, 'decisions', 'old', { superseded_by: 'decisions/new.md' }, '# old\n\nreplaced');
  const { decay } = harvest.scanLocal(root);
  // a superseded_by: forward-link IS the curated end state (PRD US3: forward-linked, not deleted) — re-
  // flagging it as debt would nudge harvest forever over a fully-curated tree (harvest-05 AC2/AC8).
  assert.equal(decay.length, 0, 'a superseded_by: page is resolved, never re-emitted as a decay_candidate');
});

test('scanLocal (Fix2): an orphaned page already carrying stale: is RESOLVED — not re-emitted; a still-un-annotated orphan IS', () => {
  const root = installRoot('wrxn-harvest-annotated-orphan-');
  // orphaned (derived_from source gone) AND already annotated stale: → the decay was already actioned
  writePage(root, 'concepts', 'done', { derived_from: 'src/gone.ts', stale: 'src/gone.ts' }, '# done\n\nalready curated');
  // a still-pending orphan (no stale: yet) → MUST still be detected (the debt signal is not broken)
  writePage(root, 'concepts', 'pending', { derived_from: 'src/also-gone.ts' }, '# pending\n\nnot yet curated');
  const { decay } = harvest.scanLocal(root);
  assert.ok(!decay.some((d) => d.slug === 'done'), 'an already-stale orphan is not a decay_candidate (resolved)');
  const pending = decay.filter((d) => d.slug === 'pending');
  assert.equal(pending.length, 1, 'a still-un-annotated orphan IS still detected');
  assert.equal(pending[0].subtype, 'orphaned');
});

test('scanLocal: malformed pages are flagged with their slug/path/tier and a reason', () => {
  const root = installRoot('wrxn-harvest-malformed-');
  writePage(root, 'gotchas', 'good', {}, '# good\n\nfine');
  writePage(root, 'gotchas', 'bad', { description: null, tier: null }, '# bad\n\nmissing keys');
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', 'gotchas', 'nofm.md'), '# no frontmatter at all\n\nbody');
  const { malformed } = harvest.scanLocal(root);
  const slugs = malformed.map((m) => m.slug).sort();
  assert.deepEqual(slugs, ['bad', 'nofm'], 'both malformed pages flagged, the well-formed one is not');
  assert.ok(malformed.every((m) => m.path && m.tier === 'gotchas' && m.reason), 'each carries path/tier/reason');
});

test('scanLocal AC3: the retired sessions tier is NEVER scanned, even when present', () => {
  const root = installRoot('wrxn-harvest-sessions-');
  // a malformed + an orphaned page planted in sessions — neither may appear in the report
  fs.mkdirSync(path.join(root, '.wrxn', 'wiki', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', 'sessions', 'broken.md'), '# no frontmatter');
  writePage(root, 'sessions', 'orphan-sess', { derived_from: 'src/gone.ts' }, '# orphan-sess\n\nx');
  const { malformed, decay } = harvest.scanLocal(root);
  assert.equal(malformed.length, 0, 'no sessions page is linted');
  assert.equal(decay.length, 0, 'no sessions page is scanned for decay');
});

test('scanLocal: scans _rules (a harvest tier), distinct from wiki-lint which omits it', () => {
  const root = installRoot('wrxn-harvest-rules-');
  fs.mkdirSync(path.join(root, '.wrxn', 'wiki', '_rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', '_rules', 'broken.md'), '# no frontmatter rule');
  const { malformed } = harvest.scanLocal(root);
  assert.equal(malformed.length, 1, 'a malformed _rules page IS reported (the 4th harvest tier)');
  assert.equal(malformed[0].tier, '_rules');
});

// ── IO shell: nearDupFromDoor (injected transport) ──────────────────────────────

test('nearDupFromDoor: a warm door + a near-dup pair → ONE cluster; pins the recon_find POST contract', async () => {
  const root = installRoot('wrxn-harvest-nd-warm-');
  writeEndpoint(root, { pid: process.pid, port: 41001 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nDUPMARK shared duplicate topic about widget pagination');
  writePage(root, 'concepts', 'beta', {}, '# beta\n\nDUPMARK shared duplicate topic about widget pagination');
  writePage(root, 'concepts', 'gamma', {}, '# gamma\n\nUNIQUE unrelated content about kubernetes networking');
  let seenPath, seenPort;
  const transport = async ({ port, path: p, body }) => {
    seenPath = p; seenPort = port;
    const T = harvest.NEAR_DUP_THRESHOLD;
    if ((body.query || '').includes('DUPMARK')) {
      return { statusCode: 200, body: JSON.stringify({ hits: [phit('.wrxn/wiki/concepts/alpha.md', T + 0.07), phit('.wrxn/wiki/concepts/beta.md', T + 0.06)] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ hits: [] }) };
  };
  const out = await harvest.nearDupFromDoor(root, { transport });
  assert.equal(out.status, 'ok');
  assert.equal(out.clusters.length, 1, 'alpha+beta cluster; gamma (no DUPMARK) does not');
  assert.deepEqual(out.clusters[0].members, ['.wrxn/wiki/concepts/alpha.md', '.wrxn/wiki/concepts/beta.md']);
  assert.equal(seenPath, '/api/tools/recon_find', 'POSTs the recon_find door');
  assert.equal(seenPort, 41001, 'uses the port from serve-endpoint.json');
});

test('nearDupFromDoor: a sub-threshold neighbour is NOT clustered (the measured threshold is enforced)', async () => {
  const root = installRoot('wrxn-harvest-nd-subthresh-');
  writeEndpoint(root, { pid: process.pid, port: 41002 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nNEARMARK content');
  writePage(root, 'concepts', 'beta', {}, '# beta\n\nNEARMARK content');
  const T = harvest.NEAR_DUP_THRESHOLD;
  const transport = async () => ({ statusCode: 200, body: JSON.stringify({ hits: [phit('.wrxn/wiki/concepts/alpha.md', T - 0.05), phit('.wrxn/wiki/concepts/beta.md', T - 0.05)] }) });
  const out = await harvest.nearDupFromDoor(root, { transport });
  assert.equal(out.status, 'ok');
  assert.equal(out.clusters.length, 0, 'merely-related (sub-threshold) pages are not near-dups');
});

test('nearDupFromDoor AC3/scope: a door hit OUTSIDE the 4 harvest tiers (e.g. sessions / .scratch) is never clustered', async () => {
  const root = installRoot('wrxn-harvest-nd-scope-');
  writeEndpoint(root, { pid: process.pid, port: 41003 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nDUPMARK widget pagination');
  const T = harvest.NEAR_DUP_THRESHOLD;
  // the door returns a high-scoring sessions-tier page AND a .scratch page — both out of curation scope
  const transport = async ({ body }) => {
    if ((body.query || '').includes('DUPMARK')) {
      return { statusCode: 200, body: JSON.stringify({ hits: [
        phit('.wrxn/wiki/sessions/some-session.md', T + 0.1),
        phit('.scratch/notes/draft.md', T + 0.1),
      ] }) };
    }
    return { statusCode: 200, body: JSON.stringify({ hits: [] }) };
  };
  const out = await harvest.nearDupFromDoor(root, { transport });
  assert.equal(out.clusters.length, 0, 'only pages under the 4 harvest tiers may form a near-dup cluster');
});

test('nearDupFromDoor: no warm door (cold) → status "unavailable", transport NEVER called (AC4)', async () => {
  const root = installRoot('wrxn-harvest-nd-cold-');
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nbody');
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: '{"hits":[]}' }; };
  const out = await harvest.nearDupFromDoor(root, { transport: spy });
  assert.equal(out.status, 'unavailable');
  assert.equal(called, false, 'a cold door short-circuits before any network call');
});

test('nearDupFromDoor: a dead-pid endpoint → "unavailable" (AC4)', async () => {
  const root = installRoot('wrxn-harvest-nd-deadpid-');
  writeEndpoint(root, { pid: deadPid(), port: 41004 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nbody');
  const out = await harvest.nearDupFromDoor(root, { transport: async () => ({ statusCode: 200, body: '{"hits":[]}' }) });
  assert.equal(out.status, 'unavailable');
});

test('nearDupFromDoor: a per-page query that throws / non-200 contributes no edges, never throws (AC4 fail-soft)', async () => {
  const root = installRoot('wrxn-harvest-nd-flaky-');
  writeEndpoint(root, { pid: process.pid, port: 41005 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nbody');
  writePage(root, 'concepts', 'beta', {}, '# beta\n\nbody');
  const out = await harvest.nearDupFromDoor(root, { transport: async () => { throw new Error('connection reset'); } });
  assert.equal(out.status, 'ok', 'a warm door whose queries fail still completes (degraded)');
  assert.equal(out.clusters.length, 0, 'no edges gathered → no clusters');
});

// ── check(): the IO orchestrator — scanLocal + nearDupFromDoor + write the jsonl ─

test('check DEMO (AC1/AC5): near-dup pair + orphaned + malformed → one jsonl listing all three, classified', async () => {
  const root = freshInstall('wrxn-harvest-demo-');
  writeEndpoint(root, { pid: process.pid, port: 41010 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nDUPMARK shared duplicate topic');
  writePage(root, 'concepts', 'beta', {}, '# beta\n\nDUPMARK shared duplicate topic');
  writePage(root, 'gotchas', 'orphan', { derived_from: 'src/deleted.ts' }, '# orphan\n\nsource is gone');
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', 'concepts', 'broken.md'), '# malformed, no frontmatter');
  const T = harvest.NEAR_DUP_THRESHOLD;
  const transport = async ({ body }) =>
    (body.query || '').includes('DUPMARK')
      ? { statusCode: 200, body: JSON.stringify({ hits: [phit('.wrxn/wiki/concepts/alpha.md', T + 0.08), phit('.wrxn/wiki/concepts/beta.md', T + 0.07)] }) }
      : { statusCode: 200, body: JSON.stringify({ hits: [] }) };

  const res = await harvest.check(root, { transport });
  const records = readReport(root);
  const byType = (t) => records.filter((r) => r.type === t);

  const nd = byType('near_dup');
  assert.equal(nd.length, 1, 'one near-dup cluster record');
  assert.deepEqual(nd[0].members.map((m) => m.slug).sort(), ['alpha', 'beta'], 'cluster members carry slugs (AC5)');
  assert.ok(nd[0].members.every((m) => m.path && m.tier), 'each member carries path + tier (AC5)');
  assert.ok(typeof nd[0].score === 'number' && nd[0].score >= T, 'the near-dup record carries the similarity score (AC5)');

  const decay = byType('decay_candidate');
  assert.equal(decay.length, 1, 'one decay candidate (the orphaned page)');
  assert.equal(decay[0].subtype, 'orphaned');
  assert.equal(decay[0].slug, 'orphan');

  const mal = byType('malformed');
  assert.equal(mal.length, 1, 'one malformed page');
  assert.equal(mal[0].slug, 'broken');

  assert.match(res.report, /\.wrxn\/harvest\/.*\.jsonl$/, 'the report path is a timestamped jsonl under .wrxn/harvest');
});

test('check AC2: report-only — the knowledge tiers are BYTE-IDENTICAL after a run', async () => {
  const root = freshInstall('wrxn-harvest-readonly-');
  writeEndpoint(root, { pid: process.pid, port: 41011 });
  writePage(root, 'concepts', 'alpha', {}, '# alpha\n\nDUPMARK dup');
  writePage(root, 'concepts', 'beta', {}, '# beta\n\nDUPMARK dup');
  writePage(root, 'gotchas', 'orphan', { derived_from: 'src/gone.ts' }, '# orphan\n\nx');
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', 'concepts', 'broken.md'), '# no frontmatter');
  const before = snapshotWiki(root);
  const T = harvest.NEAR_DUP_THRESHOLD;
  const transport = async ({ body }) =>
    (body.query || '').includes('DUPMARK')
      ? { statusCode: 200, body: JSON.stringify({ hits: [phit('.wrxn/wiki/concepts/alpha.md', T + 0.08), phit('.wrxn/wiki/concepts/beta.md', T + 0.07)] }) }
      : { statusCode: 200, body: JSON.stringify({ hits: [] }) };
  await harvest.check(root, { transport });
  assert.deepEqual(snapshotWiki(root), before, 'no knowledge page was edited, deleted, or annotated');
});

test('check AC2: re-running writes a FRESH report, never mutating a prior one', async () => {
  const root = freshInstall('wrxn-harvest-rerun-');
  writePage(root, 'concepts', 'broken', { description: null }, '# broken'); // a malformed page so a record exists
  await harvest.check(root, {});
  await harvest.check(root, {});
  const files = fs.readdirSync(path.join(root, '.wrxn', 'harvest')).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 2, 'two runs → two distinct timestamped reports');
});

test('check AC4: a cold door degrades near_dup to "unavailable" while malformed + orphaned still run (exit 0)', async () => {
  const root = freshInstall('wrxn-harvest-cold-');
  writePage(root, 'concepts', 'orphan', { derived_from: 'src/gone.ts' }, '# orphan\n\nx');
  fs.writeFileSync(path.join(root, '.wrxn', 'wiki', 'concepts', 'broken.md'), '# no frontmatter');
  // no serve-endpoint.json → cold door
  const res = await harvest.check(root, {});
  const records = readReport(root);
  const nd = records.filter((r) => r.type === 'near_dup');
  assert.equal(nd.length, 1);
  assert.equal(nd[0].status, 'unavailable', 'near-dup degrades to unavailable with a cold door');
  assert.equal(records.filter((r) => r.type === 'decay_candidate').length, 1, 'the orphaned scan still ran');
  assert.equal(records.filter((r) => r.type === 'malformed').length, 1, 'the malformed scan still ran');
  assert.equal(res.summary.nearDupStatus, 'unavailable');
});

test('check (Fix2): after a page is annotated (decay confirm), a re-check no longer lists it → the debt signal goes clean', async () => {
  const root = freshInstall('wrxn-harvest-debt-clean-');
  // the ONLY curation debt in the tree: one orphaned page
  writePage(root, 'concepts', 'orphan', { derived_from: 'src/gone.ts' }, '# orphan\n\nx');

  // first check: the orphan IS a decay_candidate (real, un-curated debt)
  await harvest.check(root, {});
  assert.equal(readReport(root).filter((r) => r.type === 'decay_candidate').length, 1, 'the orphan is flagged before curation');

  // curate it in place exactly as `decay confirm` would — append a stale: frontmatter key
  const file = path.join(root, '.wrxn', 'wiki', 'concepts', 'orphan.md');
  fs.writeFileSync(file, harvest.annotateFrontmatter(fs.readFileSync(file, 'utf8'), 'stale', 'src/gone.ts'));

  // clear the prior report so readReport sees exactly the fresh one
  const dir = path.join(root, '.wrxn', 'harvest');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) fs.rmSync(path.join(dir, f));

  // a fresh check over the now-curated tree lists NO decay_candidate → the handoff debt-gate falls silent
  await harvest.check(root, {});
  assert.equal(readReport(root).filter((r) => r.type === 'decay_candidate').length, 0, 'a fully-curated tree reads clean — no decay debt re-reported');
});

// ── black-box CLI ───────────────────────────────────────────────────────────────

test('black-box: `check` on a fresh install with no warm door exits 0, writes a report (AC4 fail-soft)', () => {
  const t = freshInstall('wrxn-harvest-bb-cold-');
  writePage(t, 'concepts', 'broken', { tier: null }, '# broken'); // a malformed page
  const out = JSON.parse(runCli(t, ['check']));
  assert.equal(out.summary.nearDupStatus, 'unavailable', 'no recon serve → near-dup unavailable, never a crash');
  assert.ok(fs.existsSync(path.join(t, out.report)), 'the jsonl report was written');
  const records = readReport(t);
  assert.ok(records.some((r) => r.type === 'malformed' && r.slug === 'broken'), 'the malformed scan ran via the CLI');
});

test('black-box: an unknown subcommand exits 2', () => {
  const t = freshInstall('wrxn-harvest-bb-unknown-');
  let err;
  try { runCli(t, ['frobnicate']); } catch (e) { err = e; }
  assert.ok(err && err.status === 2, 'a bad subcommand is a non-zero exit');
});

// ── self-contained: node stdlib only (no kernel-lib / recon import) ──────────────

test('the harvest adapter imports nothing outside the node standard library (install-portable)', () => {
  const src = fs.readFileSync(HARVEST, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the adapter has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── manifest / laydown ──────────────────────────────────────────────────────────

test('the harvest adapter is classified managed/project in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === HARVEST_REL);
  assert.ok(entry, 'harvest.cjs in manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-harvest-laid-');
  assert.ok(fs.existsSync(path.join(t, HARVEST_REL)), 'harvest.cjs laid into the install');
});

test('the .wrxn/harvest report dir gitkeep is state/project and laid (mirrors .wrxn/dream)', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.wrxn/harvest/.gitkeep');
  assert.ok(entry, '.wrxn/harvest/.gitkeep in manifest');
  assert.equal(entry.class, 'state');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-harvest-gitkeep-');
  assert.ok(fs.existsSync(path.join(t, '.wrxn', 'harvest', '.gitkeep')), 'the report dir ships');
});

// ════════════════════════════════════════════════════════════════════════════════
// phase-4.5-04 — report hygiene: (1) a STABLE cluster order so an unchanged tree yields a byte-identical
// report every run, and (2) BOUNDED report retention so .wrxn/harvest/ never grows without bound.
// ════════════════════════════════════════════════════════════════════════════════

// ── defect 1: a STABLE, antisymmetric cluster comparator (reproducible ordering) ──

test('compareClusters (phase-4.5-04): equal-leading clusters compare ANTISYMMETRICALLY (stable tiebreak); identical → 0', () => {
  // The old comparator `(a,b) => a.members[0] < b.members[0] ? -1 : 1` returned 1 for BOTH compare(a,b) AND
  // compare(b,a) on an equal leading member — non-antisymmetric, so V8's sort could order tied clusters by
  // input permutation → non-reproducible reports. (Disjoint connected components mean a shared lead can't
  // arise from clusterNearDups today, but the comparator must still be a proper total order — defense in depth.)
  const a = { members: ['shared.md', 'a-extra.md'], score: 0.9 };
  const b = { members: ['shared.md', 'b-extra.md'], score: 0.9 };
  assert.equal(harvest.compareClusters(a, b), -harvest.compareClusters(b, a), 'antisymmetric on an equal leading member');
  assert.notEqual(harvest.compareClusters(a, b), 0, 'a stable secondary key breaks the tie deterministically (never ambiguous)');
  // a proper total order returns 0 for two truly-identical clusters (the terminal tiebreak)
  assert.equal(
    harvest.compareClusters({ members: ['x.md', 'y.md'], score: 0.9 }, { members: ['x.md', 'y.md'], score: 0.9 }),
    0,
    'identical clusters compare equal'
  );
  // distinct leading members still order lexically by the first member (unchanged primary behaviour)
  assert.equal(harvest.compareClusters({ members: ['a.md'], score: 0.5 }, { members: ['b.md'], score: 0.5 }), -1, 'distinct leads order by the first member');
});

test('clusterNearDups (phase-4.5-04): re-clustering the SAME edges (shuffled) yields a byte-identical order', () => {
  const edges = [
    { a: 'x/m.md', b: 'x/n.md', score: 0.91 },
    { a: 'x/a.md', b: 'x/b.md', score: 0.93 },
    { a: 'x/p.md', b: 'x/q.md', score: 0.88 },
  ];
  const first = harvest.clusterNearDups(edges);
  const second = harvest.clusterNearDups([edges[2], edges[0], edges[1]]); // same set, different input order
  assert.deepEqual(second, first, 'same input → same output: cluster ordering is reproducible across runs');
  assert.deepEqual(first.map((c) => c.members[0]), ['x/a.md', 'x/m.md', 'x/p.md'], 'clusters are ordered by their lexically-first member');
});

// ── defect 2: bounded report retention ──

// Plant `count` fake timestamped <ts>.jsonl reports (ISO-derived names — lexical = chronological).
function plantReports(dir, count) {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const ts = `2026-06-18T${String(i).padStart(2, '0')}-00-00-000Z`;
    fs.writeFileSync(path.join(dir, `${ts}.jsonl`), '{}\n');
  }
}

test('pruneReports (phase-4.5-04): keeps the N most-recent reports, deletes the older prefix', () => {
  const root = installRoot('wrxn-harvest-prune-');
  const dir = path.join(root, '.wrxn', 'harvest');
  plantReports(dir, 12);
  harvest.pruneReports(dir, 5);
  const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  assert.deepEqual(
    kept,
    [
      '2026-06-18T07-00-00-000Z.jsonl', '2026-06-18T08-00-00-000Z.jsonl', '2026-06-18T09-00-00-000Z.jsonl',
      '2026-06-18T10-00-00-000Z.jsonl', '2026-06-18T11-00-00-000Z.jsonl',
    ],
    'only the 5 most-recent (lexically-largest) timestamps survive; the 7 oldest are pruned'
  );
});

test('pruneReports (phase-4.5-04): NEVER prunes the fixed-name state files (staged/audit/decay-staged/.gitkeep)', () => {
  const root = installRoot('wrxn-harvest-prune-fixed-');
  const dir = path.join(root, '.wrxn', 'harvest');
  plantReports(dir, 8);
  const FIXED = ['staged.jsonl', 'audit.jsonl', 'decay-staged.jsonl', '.gitkeep'];
  for (const f of FIXED) fs.writeFileSync(path.join(dir, f), 'x');
  harvest.pruneReports(dir, 3);
  const remaining = new Set(fs.readdirSync(dir));
  for (const f of FIXED) assert.ok(remaining.has(f), `${f} is a durable state file — never a retention target`);
  assert.equal([...remaining].filter((f) => /^\d{4}-/.test(f)).length, 3, 'only the <ts>.jsonl reports were bounded');
});

test('pruneReports (phase-4.5-04 review): never prunes the just-written report even when a same-ms `-N` name sorts first', () => {
  const root = installRoot('wrxn-harvest-prune-protect-');
  const dir = path.join(root, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  // Same-millisecond collision: the fresh report is the `-1` suffix, which collates BEFORE its base sibling,
  // so a blind oldest-prefix prune (keep=1) would delete the fresh report. `protect` must save it.
  const base = '2026-06-18T12-00-00-000Z.jsonl';
  const fresh = '2026-06-18T12-00-00-000Z-1.jsonl';
  fs.writeFileSync(path.join(dir, base), '{}\n');
  fs.writeFileSync(path.join(dir, fresh), '{}\n');
  harvest.pruneReports(dir, 1, fresh);
  const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.deepEqual(remaining, [fresh], 'the just-written report survives; its older same-ms sibling is pruned to honor keep=1');
});

test('pruneReports (phase-4.5-04): fail-soft on an absent dir (never throws)', () => {
  assert.doesNotThrow(() => harvest.pruneReports(path.join(installRoot('wrxn-harvest-prune-nodir-'), '.wrxn', 'harvest', 'nope'), 5));
});

test('reportRetention (phase-4.5-04): a sane default; the WRXN_HARVEST_RETAIN env override is honored (clamped >= 1)', () => {
  const saved = process.env.WRXN_HARVEST_RETAIN;
  try {
    delete process.env.WRXN_HARVEST_RETAIN;
    assert.ok(Number.isInteger(harvest.REPORT_RETAIN_DEFAULT) && harvest.REPORT_RETAIN_DEFAULT >= 1, 'the default is a sane positive integer');
    assert.equal(harvest.reportRetention(), harvest.REPORT_RETAIN_DEFAULT, 'no env → the sane default');
    process.env.WRXN_HARVEST_RETAIN = '7';
    assert.equal(harvest.reportRetention(), 7, 'a valid env override wins');
    process.env.WRXN_HARVEST_RETAIN = '0';
    assert.equal(harvest.reportRetention(), harvest.REPORT_RETAIN_DEFAULT, 'a < 1 value is rejected (never prune away the fresh report)');
    process.env.WRXN_HARVEST_RETAIN = 'garbage';
    assert.equal(harvest.reportRetention(), harvest.REPORT_RETAIN_DEFAULT, 'a non-numeric value falls back to the default');
  } finally {
    if (saved === undefined) delete process.env.WRXN_HARVEST_RETAIN;
    else process.env.WRXN_HARVEST_RETAIN = saved;
  }
});

test('check (phase-4.5-04): many runs bound the report dir to the retention default (state files untouched)', async () => {
  const root = freshInstall('wrxn-harvest-retain-');
  writePage(root, 'concepts', 'broken', { description: null }, '# broken'); // a malformed page → a record every run
  const N = harvest.REPORT_RETAIN_DEFAULT;
  const dir = path.join(root, '.wrxn', 'harvest');
  // a durable state file coexisting with the reports must survive the cap
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), '{"op":"x"}\n');
  for (let i = 0; i < N + 6; i++) await harvest.check(root, {});
  const reports = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.jsonl$/.test(f));
  assert.equal(reports.length, N, `the report dir is bounded to the retention default (${N})`);
  assert.ok(fs.existsSync(path.join(dir, 'audit.jsonl')), 'the durable audit log is never a retention target');
});
