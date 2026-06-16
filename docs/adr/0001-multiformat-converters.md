# ADR 0001 — Multi-format file→Markdown converters

- **Status:** Accepted (2026-06-16)
- **Context:** `multiformat-distill` PRD §5 (decision H). The kernel's distillation ingest loop
  (`wrxn ingest`, slice 06) turns a dropped source file (PDF/DOCX/HTML/PPTX/XLSX/TXT) into Markdown
  that a local LLM summarizes and splits into wiki pages. This ADR records the converter decision —
  the kernel's first ADR; `docs/adr/` is created here.
- **Decision drivers (priority order):** (1) offline / no-API / no-cloud [hard]; (2) license permits
  bundling + commercial use [hard]; (3) PDF + DOCX quality matter most; (4) Node consumer (CommonJS) —
  subprocess or pure-JS both acceptable (recon already shells to native deps).

## Decision

A **per-format converter chain**, empirically validated by a bake-off on real operator files
(`WRXN-OS/.scratch/recon-prose-analyzer/conversion-test/` — a 600 KB PDF, a DOCX, an HTML doc):

| Format | Converter | Bake-off evidence |
|---|---|---|
| HTML | **markitdown** | 46 headings / 71 table-rows preserved, ~1.4 s |
| DOCX | **markitdown** | clean spaced text (structure = source's) |
| TXT | pass-through (zero-dep) / markitdown | trivial |
| PPTX / XLSX | **markitdown** | per research [1] |
| **PDF** | **docling (GPU or CPU)** | markitdown GLUED words (`Currentapproachesto…`, unusable); docling: 39 headings, 41 clean table-rows, correct spacing, OCR |

- **Primary: Microsoft `markitdown`** (subprocess) — MIT, fully offline (cloud strictly opt-in), light
  (no torch, no model downloads), the single tool covering the whole office/web/text matrix, designed
  for LLM ingestion. Invocation: `markitdown <file>` → Markdown on stdout (ENOENT ⇒ not installed).
- **PDF escalation: IBM `docling`** (subprocess, opt-in tier) — MIT, fully offline, SOTA layout +
  TableFormer (~93.6% table accuracy) + native OCR. Heavy (torch + GB weights). Invocation:
  `docling <src> --to md --output <dir>` (writes `<basename>.md`; no Markdown on stdout — read it back).
- **No-Python floor: pure-JS in-process chain** (all MIT/BSD/Apache, bundle-safe, lazy-required) used
  when Python / markitdown is absent (ENOENT-degrade): turndown(+gfm) for HTML, mammoth→turndown for
  DOCX, unpdf for PDF (text-only), SheetJS for XLSX, officeParser for PPTX. TXT is always a zero-dep
  pass-through.

**Rejected:** LlamaParse (cloud/API-only), marker (GPL-3 + weights free only under a revenue cap),
pymupdf4llm (AGPL viral / paid Artifex), unstructured (emits JSON elements, weak OSS quality, heavy),
pandoc (cannot *read* PDF; GPL — never vendor; OK only as a separate-binary subprocess fallback).

## The Pascal / CPU gotcha (validated — load-bearing)

docling **auto-grabs the GPU**. A modern `torch` build (cu13x, 2.12) ships **no `sm_61` (Pascal)
kernel**, so on a GTX 1070 it crashes with *"no kernel image is available for execution on the
device"*. Two validated fixes:

1. **`torch==2.6.0+cu118`** — runs on `sm_61` via **PTX JIT** (the wheel has no native `sm_61` cubin;
   driver 580 JIT-compiles the PTX at runtime; ~22.5 s, correct output).
2. **Force CPU** — `--device cpu` + `CUDA_VISIBLE_DEVICES=""` (slower but always correct).

The converter primitive (`lib/convert.cjs`) implements fix (2) as an **automatic fallback**: it lets
docling pick the device (GPU/auto) on the first attempt; on an arch-incompat/crash (stderr matching a
CUDA/kernel-image signature, or a fatal signal) it **retries on CPU** rather than hard-failing.
`wrxn convert --cpu` forces CPU from the first attempt (skipping the GPU probe).

## Consequences

- **`lib/convert.cjs`** exposes `convert(srcPath) → Promise<markdown>` with the routing above, plus the
  CLI `wrxn convert <file> [--cpu]`. The spawn boundary is **injected** (default `defaultRun` =
  `spawnSync`), so routing, ENOENT-degrade, and the CPU fallback are unit-tested with no real binary;
  the real converts are integration/QA-gated.
- **External precondition:** the primary path needs Python ≥3.10 (`pip install 'markitdown[all]'`;
  `pip install docling` for the PDF tier). Absent that, the kernel degrades to the pure-JS floor
  (lazy-required; not a hard npm dependency — the installer tarball stays lean).
- **License hygiene:** only MIT/BSD/Apache tools are ever bundled or required; GPL/AGPL tools
  (pandoc / pymupdf4llm / marker) are never vendored.

## Sources

PRD `.scratch/multiformat-distill/00-prd.md` §5 · research report
`docs/research/2026-06-16-file-to-markdown-conversion/report.md` (cited [1]–[33]).
