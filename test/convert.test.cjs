'use strict';

// Tests for the converter primitive (multiformat-distill-05).
// Deterministic core — the spawn boundary is INJECTED (mirrors lib/connect.cjs's injectable invoke),
// so per-format routing, ENOENT-degrade, and the docling arch-crash → CPU fallback are all proven
// WITHOUT any real binary. The real markitdown/docling converts are integration/QA-gated.
//
// AC (deterministic): per-format routing correct; missing primary (ENOENT) degrades to the next
// entry in that format's chain (the pure-JS floor); docling arch-incompat/crash triggers automatic
// CPU fallback (no hard failure of convert).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const convertLib = require('../lib/convert.cjs');
const { convert } = convertLib;
const WRXN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');

function tmpFile(name, body = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-convert-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
}

// An injectable run boundary that records calls and answers per (tool, device).
// answer(tool, device) → { ok, markdown } | { ok:false, error:{ code, message } }
function runStub(answer) {
  const calls = [];
  const run = (tool, src, opts = {}) => {
    calls.push({ tool, src, device: opts.device });
    return answer(tool, opts.device);
  };
  return { run, calls };
}

// An injectable floor that records the format it was asked to degrade to.
function floorStub() {
  const calls = [];
  const floor = (fmt, src) => {
    calls.push({ fmt, src });
    return `FLOOR:${fmt}`;
  };
  return { floor, calls };
}

const OK = (md) => ({ ok: true, markdown: md });
const ENOENT = { ok: false, error: { code: 'ENOENT', message: 'not installed' } };
const CRASH = { ok: false, error: { code: 'CRASH', status: 1, message: 'CUDA error: no kernel image is available for execution on the device (sm_61)' } };

// ── routing: markitdown-primary formats ────────────────────────────────────────

for (const [file, fmt] of [['a.html', 'html'], ['a.htm', 'html'], ['a.docx', 'docx'], ['a.pptx', 'pptx'], ['a.xlsx', 'xlsx']]) {
  test(`${fmt} routes to markitdown`, async () => {
    const src = tmpFile(file, 'x');
    const { run, calls } = runStub((tool) => (tool === 'markitdown' ? OK(`# ${fmt}`) : ENOENT));
    const md = await convert(src, { run, floor: floorStub().floor });
    assert.equal(md, `# ${fmt}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'markitdown');
  });
}

test('txt is a zero-dep pass-through (no converter spawned)', async () => {
  const src = tmpFile('note.txt', 'hello\nworld\n');
  const { run, calls } = runStub(() => { throw new Error('run must not be called for txt'); });
  const md = await convert(src, { run, floor: floorStub().floor });
  assert.equal(md, 'hello\nworld\n');
  assert.equal(calls.length, 0);
});

test('pdf routes to docling (not markitdown — markitdown glues PDF words)', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  const { run, calls } = runStub((tool) => (tool === 'docling' ? OK('# clean pdf') : ENOENT));
  const md = await convert(src, { run, floor: floorStub().floor });
  assert.equal(md, '# clean pdf');
  assert.equal(calls[0].tool, 'docling');
});

// ── ENOENT → degrade to the next entry in the chain (the pure-JS floor) ─────────

test('markitdown ENOENT degrades to the pure-JS floor for that format', async () => {
  const src = tmpFile('a.docx', 'x');
  const { run } = runStub(() => ENOENT);
  const { floor, calls } = floorStub();
  const md = await convert(src, { run, floor });
  assert.equal(md, 'FLOOR:docx');
  assert.deepEqual(calls.map((c) => c.fmt), ['docx']);
});

test('docling ENOENT degrades to the pure-JS floor (unpdf) for pdf', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  const { run } = runStub(() => ENOENT);
  const { floor, calls } = floorStub();
  const md = await convert(src, { run, floor });
  assert.equal(md, 'FLOOR:pdf');
  assert.deepEqual(calls.map((c) => c.fmt), ['pdf']);
});

// ── docling arch-incompat/crash → automatic CPU fallback ────────────────────────

test('docling GPU arch-crash falls back to CPU (CUDA_VISIBLE_DEVICES="" + --device cpu)', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  // first attempt (GPU, device undefined) crashes; the CPU retry succeeds.
  const { run, calls } = runStub((tool, device) => (device === 'cpu' ? OK('# cpu pdf') : CRASH));
  const md = await convert(src, { run, floor: floorStub().floor });
  assert.equal(md, '# cpu pdf');
  assert.equal(calls.length, 2, 'GPU attempt then CPU retry');
  assert.equal(calls[0].device, undefined, 'first attempt lets docling pick (GPU/auto)');
  assert.equal(calls[1].device, 'cpu', 'retry forces CPU');
});

test('docling CPU crash too (and no floor lib) surfaces a hard error, not a silent pass', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  const { run } = runStub(() => CRASH); // both GPU and CPU crash
  await assert.rejects(() => convert(src, { run, floor: floorStub().floor }), /docling/i);
});

test('docling crash → CPU retry → CPU ENOENT degrades to the floor', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  const { run } = runStub((tool, device) => (device === 'cpu' ? ENOENT : CRASH));
  const { floor, calls } = floorStub();
  const md = await convert(src, { run, floor });
  assert.equal(md, 'FLOOR:pdf');
  assert.deepEqual(calls.map((c) => c.fmt), ['pdf']);
});

test('gpu:false forces CPU on the first docling attempt (no GPU probe)', async () => {
  const src = tmpFile('paper.pdf', '%PDF');
  const { run, calls } = runStub(() => OK('# cpu pdf'));
  const md = await convert(src, { run, floor: floorStub().floor, gpu: false });
  assert.equal(md, '# cpu pdf');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].device, 'cpu');
});

// ── failures that are NOT ENOENT must not silently degrade ──────────────────────

test('a non-ENOENT markitdown failure throws (does not silently hit the floor)', async () => {
  const src = tmpFile('a.html', 'x');
  const { run } = runStub(() => ({ ok: false, error: { code: 'EXIT', status: 2, message: 'boom' } }));
  await assert.rejects(() => convert(src, { run, floor: floorStub().floor }), /markitdown/i);
});

test('an unsupported extension throws', async () => {
  const src = tmpFile('a.zip', 'x');
  await assert.rejects(() => convert(src, { run: runStub(() => OK('x')).run }), /unsupported/i);
});

// ── CLI: wrxn convert <file> prints the markdown (txt path is zero-dep, real) ────

test('CLI: wrxn convert <txt> prints the file content', () => {
  const src = tmpFile('hello.txt', '# Title\n\nbody\n');
  const out = execFileSync('node', [WRXN, 'convert', src], { encoding: 'utf8' });
  assert.match(out, /# Title/);
  assert.match(out, /body/);
});

test('CLI: wrxn convert with no file exits 2', () => {
  assert.throws(() => execFileSync('node', [WRXN, 'convert'], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 2);
});
