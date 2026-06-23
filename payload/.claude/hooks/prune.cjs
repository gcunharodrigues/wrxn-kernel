'use strict';

// WRXN shared rolling-prune for append-only jsonl logs (kernel #34 / C1) — the first retention policy
// in the system. The dream/sync/harvest consolidation trails (.wrxn/{dream,sync,harvest}/*.jsonl) are
// append-only and otherwise grow unbounded; this one mechanism (not four) bounds every such log by AGE
// and COUNT, wired into the session-end hook.
//
// SPLIT (mirrors the codebase: pure math + IO shell, like reward's deriveSignal/gitFactsSince):
//   · retain(records, opts) — PURE, DETERMINISTIC: given parsed records in append order, return the
//     survivors. The clock is INJECTED (opts.now) — there is no Date.now() in the core.
//   · prune(dir, opts)      — IO shell: read each *.jsonl file in `dir`, and IFF every non-empty line
//     parses, rewrite it with retain()'s survivors. The clock defaults to Date.now() HERE, then flows
//     into the pure core.
//
// CORRUPT-SAFE: a file with ANY unparseable line is left BYTE-INTACT (never deleted or truncated) — we
// never drop a line we cannot understand. SAFE NO-OP on an empty/missing dir. FAIL-OPEN: every fault is
// swallowed so a retention fault can never break session shutdown — it never throws.
//
// Self-contained: ships into installs alongside the hooks — node stdlib ONLY (fs / path), NO kernel-lib
// or recon import (exactly like the sidecar helper it sits beside).

const fs = require('fs');
const path = require('path');

// Retention bounds — NAMED CONSTANTS, not magic numbers. These trails are operational breadcrumbs for
// memory consolidation; the DURABLE knowledge lives in the wiki pages, so old breadcrumbs decay fast.
const MAX_AGE_DAYS = 90; // one quarter of history — the primary bound; older audit entries have little value
const MAX_RECORDS = 500; // hard per-file ceiling — the safety net against pathological (runaway-append) growth
const MS_PER_DAY = 86400000;

// The install-relative log dirs the session-end hook sweeps for WITHIN-FILE record bounding. `.wrxn/events`
// (the S2/#35 metadata-grade event source) is included so a long session's per-session *.jsonl is bounded
// by age + count like the rest; whole STALE event FILES are GC'd separately by pruneFiles (below).
const LOG_DIRS = ['.wrxn/dream', '.wrxn/sync', '.wrxn/harvest', '.wrxn/events'];

// Coerce an injected clock (ms-epoch number or a Date) to ms. Anything else → NaN (no clock).
function clockMs(now) {
  if (Number.isFinite(now)) return now;
  if (now instanceof Date) return now.getTime();
  return NaN;
}

/**
 * PURE: given parsed records in append (chronological) order, return the survivors.
 * AGE-DROP: a record whose `ts` parses to a time older than `now - maxAgeDays` is dropped. A record with
 *   NO datable `ts` is NEVER aged out (conservative — we never drop what we cannot date). The clock is
 *   INJECTED via `now` (ms-epoch or Date); there is no Date.now() in this core. With no clock, age is skipped.
 * COUNT-TRIM oldest-first: of what remains, keep the newest `maxRecords` (append order ⇒ newest = tail).
 * @param {object[]} records
 * @param {{maxAgeDays?:number, maxRecords?:number, now?:number|Date}} [opts]
 * @returns {object[]}
 */
function retain(records, { maxAgeDays = MAX_AGE_DAYS, maxRecords = MAX_RECORDS, now } = {}) {
  let kept = Array.isArray(records) ? records : [];
  const clock = clockMs(now);
  if (Number.isFinite(maxAgeDays) && maxAgeDays > 0 && Number.isFinite(clock)) {
    const cutoff = clock - maxAgeDays * MS_PER_DAY;
    kept = kept.filter((r) => {
      const t = r && typeof r === 'object' ? Date.parse(r.ts) : NaN;
      return Number.isNaN(t) ? true : t >= cutoff; // undatable → keep; datable → keep iff within window
    });
  }
  if (Number.isFinite(maxRecords) && maxRecords >= 0 && kept.length > maxRecords) {
    kept = kept.slice(kept.length - maxRecords); // drop from the front (oldest) — keep the newest N
  }
  return kept;
}

// Monotonic disambiguator for the atomic-rewrite temp name — no wall clock needed in the IO shell.
let tmpSeq = 0;

// Prune one jsonl file. Returns true iff it was rewritten. CORRUPT-SAFE: if any non-empty line fails to
// parse, return false and leave the file byte-intact (never truncate on parse failure). A re-serialized
// survivor is byte-faithful to a compact jsonl line (JSON.stringify(JSON.parse(x)) preserves key order).
function pruneFile(file, opts) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // unreadable (e.g. a directory at this path) → leave it
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue; // blank / trailing newline — not a record, not corruption
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      return false; // a corrupt line → leave the WHOLE file byte-intact
    }
    records.push(rec);
  }
  const survivors = retain(records, opts);
  if (survivors.length === records.length) return false; // nothing dropped → coalesced no-op (no rewrite)
  const body = survivors.length ? survivors.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
  // ATOMIC REWRITE: write survivors to a sibling temp, then rename it OVER the original. A torn write
  // (crash / ENOSPC) can only damage the temp — the live log is replaced in ONE atomic step, or not at
  // all. On any failure the original survives byte-intact (fail-open) and the partial temp is removed.
  const tmpFile = `${file}.${process.pid}.${tmpSeq++}.tmp`; // same dir ⇒ rename is atomic (one filesystem)
  try {
    fs.writeFileSync(tmpFile, body);
    fs.renameSync(tmpFile, file);
  } catch {
    try { fs.unlinkSync(tmpFile); } catch { /* nothing to clean up */ }
    return false; // rewrite failed → leave the original untouched
  }
  return true;
}

/**
 * IO shell: prune every `*.jsonl` log file directly under `dir`. The clock defaults to Date.now() here,
 * then flows into the pure core. SAFE NO-OP on a missing/unreadable/empty dir. FAIL-OPEN: never throws —
 * one bad file never aborts the sweep, and any unexpected fault is swallowed.
 * @param {string} dir
 * @param {{maxAgeDays?:number, maxRecords?:number, now?:number}} [opts]
 * @returns {{scanned:number, rewritten:number}}
 */
function prune(dir, opts) {
  const out = { scanned: 0, rewritten: 0 };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    // Resolve the clock HERE (the shell) — defaulting to Date.now() — then inject it into the pure core.
    const now = Number.isFinite(clockMs(o.now)) ? clockMs(o.now) : Date.now();
    const ropts = { maxAgeDays: o.maxAgeDays, maxRecords: o.maxRecords, now };
    // SYMLINK-SAFE (dir): refuse to descend into anything that is not a REAL directory. lstat does NOT
    // follow the link, so a symlinked log path (e.g. .wrxn/dream → /outside) is a no-op — never swept.
    let dirStat;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return out; // missing / unreadable dir → no-op
    }
    if (!dirStat.isDirectory()) return out; // a symlink (or non-dir) at the log path → do not descend
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out; // unreadable dir → no-op
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const file = path.join(dir, name);
        // SYMLINK-SAFE (entry): lstat does NOT follow the link, so we process ONLY a regular file. A
        // planted *.jsonl symlink (or a sub-dir / special file) is skipped — this destructive rewrite can
        // never follow a link out of the log dir to trim a file outside it.
        if (!fs.lstatSync(file).isFile()) continue;
        out.scanned++;
        if (pruneFile(file, ropts)) out.rewritten++;
      } catch {
        /* one bad file never aborts the sweep */
      }
    }
  } catch {
    /* fail-open: retention must never throw into session shutdown */
  }
  return out;
}

// ── WHOLE-FILE GC (S2 / #35) ─────────────────────────────────────────────────────────
//
// The event source writes one file PER SESSION, so the FILES accumulate even though retain bounds the
// records WITHIN each file. pruneFiles GCs whole *.jsonl files; retainFiles is its PURE core (same split
// as retain/prune: the clock is INJECTED, no Date.now() here).

const MAX_FILES = 200; // per-dir whole-file ceiling — the safety net (mirrors MAX_RECORDS) against unbounded per-session files

/**
 * PURE: given file descriptors {name, mtimeMs, size}, return the survivors (the files to KEEP).
 * EMPTY-DROP: a size-0 file (e.g. one the within-file prune drained to nothing) is dropped — it carries
 *   no records. AGE-DROP: a file whose mtime is older than `now - maxAgeDays` is dropped; a file with NO
 *   datable mtime is NEVER aged out (conservative). The clock is INJECTED via `now`; with no clock, age
 *   is skipped. COUNT-TRIM: of what remains, keep the newest `maxFiles` by mtime.
 * @param {{name:string, mtimeMs:number, size:number}[]} files
 * @param {{maxAgeDays?:number, maxFiles?:number, now?:number|Date}} [opts]
 * @returns {object[]}
 */
function retainFiles(files, { maxAgeDays = MAX_AGE_DAYS, maxFiles = MAX_FILES, now } = {}) {
  let kept = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.name === 'string');
  kept = kept.filter((f) => !(Number.isFinite(f.size) && f.size === 0)); // empty file → no records → drop
  const clock = clockMs(now);
  if (Number.isFinite(maxAgeDays) && maxAgeDays > 0 && Number.isFinite(clock)) {
    const cutoff = clock - maxAgeDays * MS_PER_DAY;
    kept = kept.filter((f) => {
      const t = Number(f.mtimeMs);
      return Number.isFinite(t) ? t >= cutoff : true; // undatable mtime → keep
    });
  }
  if (Number.isFinite(maxFiles) && maxFiles >= 0 && kept.length > maxFiles) {
    kept = [...kept].sort((a, b) => Number(b.mtimeMs) - Number(a.mtimeMs)).slice(0, maxFiles); // newest-first, keep N
  }
  return kept;
}

/**
 * IO shell: delete whole stale `*.jsonl` files directly under `dir` (the non-survivors of retainFiles).
 * The clock defaults to Date.now() here, then flows into the pure core. SYMLINK-SAFE exactly like prune:
 * lstat refuses a symlinked dir (no descend) and processes ONLY regular files (a planted *.jsonl symlink
 * is skipped, never deleted/followed). SAFE NO-OP on a missing/empty dir. FAIL-OPEN: never throws — one
 * bad entry never aborts the sweep.
 * @param {string} dir
 * @param {{maxAgeDays?:number, maxFiles?:number, now?:number}} [opts]
 * @returns {{scanned:number, deleted:number}}
 */
function pruneFiles(dir, opts) {
  const out = { scanned: 0, deleted: 0 };
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const now = Number.isFinite(clockMs(o.now)) ? clockMs(o.now) : Date.now();
    let dirStat;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return out; // missing / unreadable dir → no-op
    }
    if (!dirStat.isDirectory()) return out; // a symlink (or non-dir) at the event-dir path → do not descend
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    const descriptors = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue; // never touch the .gitkeep sentinel or anything non-jsonl
      try {
        const st = fs.lstatSync(path.join(dir, name)); // lstat → never follow a symlink
        if (!st.isFile()) continue; // a planted symlink / sub-dir / special file → skip
        out.scanned++;
        descriptors.push({ name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* one bad entry never aborts the sweep */
      }
    }
    const survivors = new Set(retainFiles(descriptors, { maxAgeDays: o.maxAgeDays, maxFiles: o.maxFiles, now }).map((f) => f.name));
    for (const d of descriptors) {
      if (survivors.has(d.name)) continue;
      try {
        fs.unlinkSync(path.join(dir, d.name));
        out.deleted++;
      } catch {
        /* best-effort: a failed unlink never aborts the sweep */
      }
    }
  } catch {
    /* fail-open: whole-file GC must never throw into session shutdown */
  }
  return out;
}

module.exports = { prune, pruneFiles, retain, retainFiles, MAX_AGE_DAYS, MAX_RECORDS, MAX_FILES, LOG_DIRS };
