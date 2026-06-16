'use strict';

// Converter primitive (multiformat-distill-05) — convert(srcPath) → Markdown, per-format routing.
//
// Decision (ADR 0001 / PRD §5, empirically baked off): markitdown is the primary subprocess for the
// office/web matrix (html/docx/pptx/xlsx); txt is a zero-dep pass-through; PDF escalates to docling
// (SOTA tables + OCR), which auto-grabs the GPU and CRASHES on arch-incompat (the GTX-1070/Pascal
// sm_61 trap — torch cu13x ships no sm_61 kernel) → we force CPU on that crash. When Python /
// markitdown is absent (ENOENT) we degrade to the pure-JS floor (turndown / mammoth / unpdf / SheetJS).
//
// The spawn boundary is INJECTED, mirroring lib/connect.cjs's injectable `invoke`: convert(src,{run})
// takes a converter runner so routing, ENOENT-degrade, and the CPU fallback are unit-testable WITHOUT
// any real binary. defaultRun does the real spawnSync — that is what makes the integration check
// "validated by invocation". convert is async only so the pure-JS floor (mammoth/unpdf are async)
// can be wired in completely; the primary subprocess path is plain blocking spawnSync.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Extension → logical format. (.htm folds into html.)
const FORMATS = {
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.txt': 'txt',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.pdf': 'pdf',
};

// markitdown is the primary subprocess for these (txt = pass-through, pdf = docling).
const MARKITDOWN_FORMATS = new Set(['html', 'docx', 'pptx', 'xlsx']);

// CUDA / arch-incompat crash signatures — the Pascal sm_61 trap and friends. docling auto-grabs the
// GPU; a torch build with no matching SM kernel dies with "no kernel image is available...".
const ARCH_CRASH_RE = /no kernel image|kernel image is available|sm_\d+|CUDA error|CUDA_ERROR|device-side assert|out of memory/i;

const SPAWN_OPTS = { encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024 };

// ── the injected boundary's real implementation ────────────────────────────────

/**
 * Run a converter subprocess and normalize its result to { ok, markdown } | { ok:false, error }.
 * error.code is 'ENOENT' (not installed → degrade), 'CRASH' (arch-incompat → CPU retry), or 'EXIT'.
 */
function defaultRun(tool, srcPath, { device } = {}) {
  if (tool === 'markitdown') {
    const r = spawnSync('markitdown', [srcPath], SPAWN_OPTS);
    return normalize(r);
  }
  if (tool === 'docling') {
    // docling writes <basename>.md into an --output dir (no markdown on stdout); read it back.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-docling-'));
    try {
      const args = [srcPath, '--to', 'md', '--output', outDir];
      const opts = { ...SPAWN_OPTS };
      if (device === 'cpu') {
        args.push('--device', 'cpu');
        opts.env = { ...process.env, CUDA_VISIBLE_DEVICES: '' };
      }
      const r = spawnSync('docling', args, opts);
      if (r.error) return { ok: false, error: classifyError(r.error) };
      if (r.status !== 0 || r.signal) {
        const stderr = r.stderr || '';
        const code = ARCH_CRASH_RE.test(stderr) || r.signal ? 'CRASH' : 'EXIT';
        return { ok: false, error: { code, status: r.status, signal: r.signal, message: stderr.trim() } };
      }
      return { ok: true, markdown: readDoclingOutput(outDir, srcPath) };
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  throw new Error(`unknown converter tool: ${tool}`);
}

function normalize(r) {
  if (r.error) return { ok: false, error: classifyError(r.error) };
  if (r.status !== 0 || r.signal) {
    return { ok: false, error: { code: 'EXIT', status: r.status, signal: r.signal, message: (r.stderr || '').trim() } };
  }
  return { ok: true, markdown: r.stdout };
}

function classifyError(err) {
  return { code: err.code || 'ERR', message: err.message || String(err) };
}

function readDoclingOutput(outDir, srcPath) {
  const base = path.basename(srcPath, path.extname(srcPath));
  const preferred = path.join(outDir, `${base}.md`);
  if (fs.existsSync(preferred)) return fs.readFileSync(preferred, 'utf8');
  // Fall back to the first .md docling produced (naming can vary by version).
  const md = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.md'));
  if (!md) throw new Error(`docling produced no markdown in ${outDir}`);
  return fs.readFileSync(path.join(outDir, md), 'utf8');
}

// ── the pure-JS floor (no-Python degrade) ───────────────────────────────────────

function lazy(mod) {
  try {
    return require(mod);
  } catch {
    throw new Error(
      `pure-JS floor needs "${mod}" but it is not installed, and the primary converter is absent. ` +
      `Install the primary path (pip install 'markitdown[all]' / docling) or the floor (npm i ${mod}).`
    );
  }
}

/** The no-Python in-process floor (research §2: turndown / mammoth / unpdf / SheetJS). Async. */
async function defaultFloor(fmt, srcPath) {
  if (fmt === 'txt') return fs.readFileSync(srcPath, 'utf8');
  if (fmt === 'html') {
    const Turndown = lazy('turndown');
    const td = new Turndown();
    try {
      const { gfm } = require('turndown-plugin-gfm');
      td.use(gfm);
    } catch { /* gfm tables are a nice-to-have, not required */ }
    return td.turndown(fs.readFileSync(srcPath, 'utf8'));
  }
  if (fmt === 'docx') {
    const mammoth = lazy('mammoth');
    const Turndown = lazy('turndown');
    const { value: html } = await mammoth.convertToHtml({ path: srcPath });
    return new Turndown().turndown(html);
  }
  if (fmt === 'pdf') {
    const { extractText, getDocumentProxy } = lazy('unpdf');
    const buf = new Uint8Array(fs.readFileSync(srcPath));
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (fmt === 'xlsx') {
    const XLSX = lazy('xlsx');
    const wb = XLSX.readFile(srcPath);
    return wb.SheetNames.map((n) => `## ${n}\n\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join('\n\n');
  }
  if (fmt === 'pptx') {
    const officeParser = lazy('officeparser');
    return await officeParser.parseOfficeAsync(srcPath);
  }
  throw new Error(`no pure-JS floor for format "${fmt}"`);
}

// ── the primitive ───────────────────────────────────────────────────────────────

/**
 * Convert a source file to Markdown via per-format routing.
 * @param {string} srcPath
 * @param {{ run?: Function, floor?: Function, gpu?: boolean }} [opts]
 *   run   — injectable converter boundary (default: defaultRun, the real spawnSync).
 *   floor — injectable pure-JS floor (default: defaultFloor).
 *   gpu   — false forces docling onto CPU from the first attempt (skips the GPU probe/crash).
 * @returns {Promise<string>} the markdown.
 */
async function convert(srcPath, { run = defaultRun, floor = defaultFloor, gpu } = {}) {
  const ext = path.extname(srcPath).toLowerCase();
  const fmt = FORMATS[ext];
  if (!fmt) {
    throw new Error(`wrxn convert: unsupported format "${ext || '(none)'}" — supported: ${Object.keys(FORMATS).join(', ')}`);
  }

  // txt is already plain text — pass it through (zero-dep, always works).
  if (fmt === 'txt') {
    return fs.readFileSync(srcPath, 'utf8');
  }

  if (fmt === 'pdf') {
    return convertPdf(srcPath, { run, floor, gpu });
  }

  // markitdown-primary formats (html/docx/pptx/xlsx).
  const r = run('markitdown', srcPath);
  if (r.ok) return r.markdown;
  if (r.error && r.error.code === 'ENOENT') {
    return floor(fmt, srcPath); // markitdown absent → degrade to the pure-JS floor
  }
  throw new Error(`wrxn convert: markitdown failed on ${path.basename(srcPath)} — ${r.error.message || r.error.code}`);
}

/** PDF tier: docling (GPU/auto) → CPU on an arch-crash → pure-JS floor if docling is absent. */
async function convertPdf(srcPath, { run, floor, gpu }) {
  const firstDevice = gpu === false ? 'cpu' : undefined; // undefined = let docling pick (GPU/auto)
  const r = run('docling', srcPath, { device: firstDevice });
  if (r.ok) return r.markdown;
  if (r.error && r.error.code === 'ENOENT') {
    return floor('pdf', srcPath); // no docling → unpdf floor
  }
  if (r.error && r.error.code === 'CRASH' && firstDevice !== 'cpu') {
    // arch-incompat / GPU crash → force CPU (CUDA_VISIBLE_DEVICES='' + --device cpu).
    const cpu = run('docling', srcPath, { device: 'cpu' });
    if (cpu.ok) return cpu.markdown;
    if (cpu.error && cpu.error.code === 'ENOENT') return floor('pdf', srcPath);
    throw new Error(`wrxn convert: docling failed on the CPU fallback for ${path.basename(srcPath)} — ${cpu.error.message || cpu.error.code}`);
  }
  throw new Error(`wrxn convert: docling failed on ${path.basename(srcPath)} — ${r.error.message || r.error.code}`);
}

module.exports = {
  convert,
  defaultRun,
  defaultFloor,
  FORMATS,
  MARKITDOWN_FORMATS,
  ARCH_CRASH_RE,
};
