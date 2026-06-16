'use strict';

// Tests for the distillation ingest harness (multiformat-distill-06).
// Deterministic core — TWO boundaries are INJECTED (mirrors lib/convert.cjs's injectable spawn):
//   - convert(src) → markdown          (slice 05; stubbed so no real binary is spawned)
//   - distill(markdown, ctx) → pages   (the LLM step; stubbed so no live model is needed)
// so the harness behaviour — convert → place raw → stamp `derived_from` provenance → ADDITIVE-ONLY
// guard (never clobber an existing wiki page) → idempotent re-run — is proven WITHOUT an LLM.
// The distillation PROMPT (the `ingest` skill) and its output QUALITY are deferred to the QA-walk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { ingest } = require('../lib/ingest.cjs');
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-ingest-'));
}

function srcIn(root, name, body = 'raw body') {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
  return p;
}

// an injectable convert that records its input and returns fixed markdown
function convertStub(md = '# converted\n\nbody') {
  const calls = [];
  const convert = async (src) => { calls.push(src); return md; };
  return { convert, calls };
}

// an injectable distill boundary that records the markdown it saw and returns canned pages
function distillStub(result) {
  const calls = [];
  const distill = async (markdown, ctx) => { calls.push({ markdown, ctx }); return result; };
  return { distill, calls };
}

const PAGES = {
  summary: { slug: 'paper-summary', title: 'Paper Summary', description: 'overview', body: 'the gist' },
  notes: [
    { slug: 'paper-method', title: 'Method', description: 'how', body: 'method detail' },
    { slug: 'paper-results', title: 'Results', description: 'what', body: 'results detail' },
  ],
};

// ── AC: summary + ≥1 note page, each stamped derived_from ────────────────────────

test('ingest writes a summary page + N note pages, each stamped derived_from', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  const { convert } = convertStub();
  const { distill } = distillStub(PAGES);

  const report = await ingest(src, { root, convert, distill });

  const concepts = path.join(root, '.wrxn', 'wiki', 'concepts');
  for (const slug of ['paper-summary', 'paper-method', 'paper-results']) {
    const page = path.join(concepts, `${slug}.md`);
    assert.ok(fs.existsSync(page), `${slug}.md not written`);
    const body = fs.readFileSync(page, 'utf8');
    assert.match(body, /^---/, `${slug} missing frontmatter`);
    assert.match(body, /derived_from: \.wrxn\/raw\/paper\.txt/, `${slug} missing derived_from provenance`);
  }
  assert.equal(report.written.length, 3);
});

// ── AC: raw source placed/kept under .wrxn/raw/ ──────────────────────────────────

test('the raw source is placed under .wrxn/raw/', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt', 'ORIGINAL BYTES');
  await ingest(src, { root, convert: convertStub().convert, distill: distillStub(PAGES).distill });

  const raw = path.join(root, '.wrxn', 'raw', 'paper.txt');
  assert.ok(fs.existsSync(raw), 'raw copy not placed');
  assert.equal(fs.readFileSync(raw, 'utf8'), 'ORIGINAL BYTES');
});

// ── the convert boundary is real-injectable: distill sees its output ─────────────

test('distill receives the converted markdown (convert boundary is injected)', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  const { convert, calls: cCalls } = convertStub('# MY MARKDOWN');
  const { distill, calls: dCalls } = distillStub(PAGES);

  await ingest(src, { root, convert, distill });

  assert.equal(cCalls.length, 1, 'convert called once');
  assert.equal(dCalls.length, 1, 'distill called once');
  assert.equal(dCalls[0].markdown, '# MY MARKDOWN', 'distill saw the converted markdown');
});

// ── AC: additive-only — refuses to overwrite an existing wiki page ───────────────

test('additive-only: an existing wiki page is never clobbered (skipped, content preserved)', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  const concepts = path.join(root, '.wrxn', 'wiki', 'concepts');
  fs.mkdirSync(concepts, { recursive: true });
  const collision = path.join(concepts, 'paper-summary.md');
  fs.writeFileSync(collision, 'HUMAN-AUTHORED — DO NOT CLOBBER');

  const report = await ingest(src, { root, convert: convertStub().convert, distill: distillStub(PAGES).distill });

  assert.equal(fs.readFileSync(collision, 'utf8'), 'HUMAN-AUTHORED — DO NOT CLOBBER', 'existing page was clobbered');
  assert.ok(report.skipped.some((p) => p.endsWith('paper-summary.md')), 'collision not reported as skipped');
  // the non-colliding notes still land (additive)
  assert.ok(fs.existsSync(path.join(concepts, 'paper-method.md')), 'a non-colliding note failed to land');
});

// ── AC: re-running ingest on the same source is safe (idempotent) ────────────────

test('re-running ingest is idempotent — no clobber, no throw', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  const first = await ingest(src, { root, convert: convertStub().convert, distill: distillStub(PAGES).distill });
  assert.equal(first.written.length, 3);

  const page = path.join(root, '.wrxn', 'wiki', 'concepts', 'paper-summary.md');
  const before = fs.readFileSync(page, 'utf8');

  const second = await ingest(src, { root, convert: convertStub().convert, distill: distillStub(PAGES).distill });
  assert.equal(second.written.length, 0, 'second run wrote nothing');
  assert.equal(second.skipped.length, 3, 'second run skipped all 3 pages');
  assert.equal(fs.readFileSync(page, 'utf8'), before, 'a page changed on re-run');
});

// ── guards on the distillation contract ──────────────────────────────────────────

test('a distillation with no summary throws', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  await assert.rejects(
    () => ingest(src, { root, convert: convertStub().convert, distill: distillStub({ notes: PAGES.notes }).distill }),
    /summary/i
  );
});

test('a non-kebab slug is rejected', async () => {
  const root = tmpRoot();
  const src = srcIn(root, 'paper.txt');
  const bad = { summary: { slug: 'Bad Slug', body: 'x' }, notes: [] };
  await assert.rejects(
    () => ingest(src, { root, convert: convertStub().convert, distill: distillStub(bad).distill }),
    /slug/i
  );
});

// ── CLI: wrxn ingest <file> --distillation <json> (real convert txt path) ─────────

test('CLI: wrxn ingest <txt> --distillation writes pages', () => {
  const root = tmpRoot();
  const src = srcIn(root, 'note.txt', '# Title\n\nbody\n');
  const distFile = path.join(root, 'dist.json');
  fs.writeFileSync(distFile, JSON.stringify(PAGES));

  const out = execFileSync('node', [WRXN, 'ingest', src, '--root', root, '--distillation', distFile], { encoding: 'utf8' });
  assert.match(out, /paper-summary\.md/);

  const page = path.join(root, '.wrxn', 'wiki', 'concepts', 'paper-summary.md');
  assert.ok(fs.existsSync(page));
  assert.match(fs.readFileSync(page, 'utf8'), /derived_from: \.wrxn\/raw\/note\.txt/);
});

test('CLI: wrxn ingest with no file exits 2', () => {
  assert.throws(() => execFileSync('node', [WRXN, 'ingest'], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2);
});

test('CLI: wrxn ingest without a distillation points to the ingest skill and exits 2', () => {
  const root = tmpRoot();
  const src = srcIn(root, 'note.txt', 'hi\n');
  assert.throws(
    () => execFileSync('node', [WRXN, 'ingest', src, '--root', root], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2 && /ingest skill|distillation/i.test(String(err.stderr))
  );
});
