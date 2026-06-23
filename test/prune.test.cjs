'use strict';

// Tests for the shared rolling-prune helper (C1 / kernel #34) — the first retention policy in the
// system. A single utility bounds every append-only `*.jsonl` log under a dir by AGE and COUNT, wired
// into the session-end hook across .wrxn/{dream,sync,harvest}. It must be:
//   · CORRECT  — trim oldest-first to maxRecords; drop records older than maxAgeDays (by each record's ts)
//   · CORRUPT-SAFE — a file with ANY unparseable line is left BYTE-INTACT (never deleted or truncated)
//   · SAFE NO-OP — an empty/missing dir does nothing
//   · PURE-CORE — the trim/age math is a deterministic function with the clock INJECTED (no Date.now)
//   · FAIL-OPEN — any fault is swallowed; it never throws into session shutdown
//   · SELF-CONTAINED — node stdlib only (it ships into installs alongside the hooks)
// Black-box over the exported functions, over real temp jsonl files, with an injected clock.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const PKG_ROOT = path.join(__dirname, '..');
const PRUNE = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'prune.cjs');
const { prune, retain, MAX_AGE_DAYS, MAX_RECORDS, LOG_DIRS } = require('../payload/.claude/hooks/prune.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const { init } = require('../lib/install.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
// Write a jsonl log (compact, one record per line — exactly as dream/sync append it).
function writeLog(dir, name, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function readLog(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); // content fingerprint

// ── AC: trims a jsonl log oldest-first down to maxRecords ────────────────────────────

test('prune trims a jsonl log oldest-first down to maxRecords', () => {
  const dir = tmp('wrxn-prune-count-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  // 6 fresh records (all within age), maxRecords 4 → the 2 oldest (front) drop, newest 4 kept in order.
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ ts: iso(now - (6 - i) * 1000), op: 'stage', n: i });
  writeLog(dir, 'audit.jsonl', recs);
  prune(dir, { maxRecords: 4, maxAgeDays: 9999, now });
  const kept = readLog(path.join(dir, 'audit.jsonl'));
  assert.equal(kept.length, 4, 'trimmed to maxRecords');
  assert.deepEqual(kept.map((r) => r.n), [2, 3, 4, 5], 'oldest-first: 2 oldest dropped, newest 4 kept in order');
});

// ── AC: records older than maxAgeDays are dropped (by each record's ts), clock injected ──

test('prune drops records older than maxAgeDays (by ts), against the injected clock', () => {
  const dir = tmp('wrxn-prune-age-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  const recs = [
    { ts: iso(now - 100 * DAY), op: 'stage', n: 'old-100d' }, // beyond 90d → drop
    { ts: iso(now - 91 * DAY), op: 'stage', n: 'old-91d' },   // beyond 90d → drop
    { ts: iso(now - 89 * DAY), op: 'stage', n: 'fresh-89d' }, // within 90d → keep
    { ts: iso(now - 1 * DAY), op: 'stage', n: 'fresh-1d' },   // within 90d → keep
  ];
  writeLog(dir, 'staged.jsonl', recs);
  prune(dir, { maxAgeDays: 90, maxRecords: 9999, now });
  const kept = readLog(path.join(dir, 'staged.jsonl'));
  assert.deepEqual(kept.map((r) => r.n), ['fresh-89d', 'fresh-1d'], 'only records within the age window survive');
});

// ── AC: a corrupt / unparseable jsonl file is left BYTE-INTACT (never deleted or truncated) ──

test('prune leaves a file with ANY unparseable line byte-intact (never truncated/deleted)', () => {
  const dir = tmp('wrxn-prune-corrupt-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  // a file that WOULD be over both bounds, but one line is broken JSON → the whole file must be untouched.
  const file = path.join(dir, 'audit.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const corrupt = [
    JSON.stringify({ ts: iso(now - 500 * DAY), op: 'stage', n: 0 }), // ancient + over count, would drop
    '{ this is not valid json',
    JSON.stringify({ ts: iso(now - 1 * DAY), op: 'stage', n: 1 }),
  ].join('\n') + '\n';
  fs.writeFileSync(file, corrupt);
  const res = prune(dir, { maxAgeDays: 1, maxRecords: 1, now });
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'a file with a corrupt line is left byte-for-byte');
  assert.equal(res.rewritten, 0, 'no rewrite happened on the corrupt file');
  assert.ok(fs.existsSync(file), 'the file is never deleted');
});

test('prune isolates files: one corrupt log never blocks a sibling clean log from being pruned', () => {
  const dir = tmp('wrxn-prune-isolate-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), 'broken{not json\n'); // corrupt sibling → must stay intact
  const fresh = [];
  for (let i = 0; i < 5; i++) fresh.push({ ts: iso(now - (5 - i) * 1000), op: 'stage', n: i });
  writeLog(dir, 'staged.jsonl', fresh);
  prune(dir, { maxRecords: 2, maxAgeDays: 9999, now });
  assert.equal(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8'), 'broken{not json\n', 'corrupt sibling untouched');
  assert.deepEqual(readLog(path.join(dir, 'staged.jsonl')).map((r) => r.n), [3, 4], 'the clean sibling is still pruned');
});

// ── AC: an empty or missing directory is a safe no-op ────────────────────────────────

test('prune is a safe no-op on a missing directory (never throws, nothing created)', () => {
  const dir = path.join(tmp('wrxn-prune-missing-'), 'does', 'not', 'exist');
  let res;
  assert.doesNotThrow(() => { res = prune(dir, { now: Date.parse('2026-06-22T00:00:00Z') }); });
  assert.deepEqual(res, { scanned: 0, rewritten: 0 }, 'missing dir → nothing scanned, nothing rewritten');
  assert.equal(fs.existsSync(dir), false, 'the missing dir is not created');
});

test('prune is a safe no-op on an empty directory', () => {
  const dir = tmp('wrxn-prune-empty-');
  let res;
  assert.doesNotThrow(() => { res = prune(dir, { now: Date.parse('2026-06-22T00:00:00Z') }); });
  assert.deepEqual(res, { scanned: 0, rewritten: 0 }, 'empty dir → no-op');
});

// ── AC: fail-open — any fault leaves the logs unaffected and never throws ─────────────

test('prune never throws on garbage inputs (fail-open)', () => {
  assert.doesNotThrow(() => prune(undefined));
  assert.doesNotThrow(() => prune(null, null));
  assert.doesNotThrow(() => prune(12345, { maxRecords: 'nope', maxAgeDays: {}, now: 'soon' }));
});

// ── AC: the trim/age core is a PURE, DETERMINISTIC function with the clock INJECTED ──

test('retain is pure and deterministic — same inputs (incl. injected now) → same output', () => {
  const now = Date.parse('2026-06-22T00:00:00Z');
  const recs = [
    { ts: iso(now - 200 * DAY), n: 'a' },
    { ts: iso(now - 10 * DAY), n: 'b' },
    { ts: iso(now - 1 * DAY), n: 'c' },
  ];
  const a = retain(recs, { maxAgeDays: 90, maxRecords: 99, now });
  const b = retain(recs, { maxAgeDays: 90, maxRecords: 99, now });
  assert.deepEqual(a.map((r) => r.n), ['b', 'c'], 'ages by the INJECTED clock, not wall time');
  assert.deepEqual(a, b, 'deterministic: identical inputs → identical output');
});

test('retain keeps records that have no datable ts (never drop what we cannot date)', () => {
  const now = Date.parse('2026-06-22T00:00:00Z');
  const recs = [{ n: 'no-ts' }, { ts: 'garbage', n: 'bad-ts' }, { ts: iso(now - 1 * DAY), n: 'ok' }];
  const kept = retain(recs, { maxAgeDays: 1, maxRecords: 99, now });
  assert.deepEqual(kept.map((r) => r.n), ['no-ts', 'bad-ts', 'ok'], 'undatable records survive the age filter');
});

test('the pure core carries NO direct Date.now() (clock is injected)', () => {
  const src = fs.readFileSync(PRUNE, 'utf8');
  const m = src.match(/function retain\([\s\S]*?\n}/);
  assert.ok(m, 'retain is defined');
  assert.equal(/Date\.now\s*\(/.test(m[0]), false, 'retain reads no wall clock — the clock is injected');
});

// ── AC: named constants (not magic numbers) ──────────────────────────────────────────

test('retention bounds are exported named constants with sane defaults', () => {
  assert.equal(typeof MAX_AGE_DAYS, 'number', 'MAX_AGE_DAYS is a named constant');
  assert.equal(typeof MAX_RECORDS, 'number', 'MAX_RECORDS is a named constant');
  assert.ok(MAX_AGE_DAYS > 0 && MAX_RECORDS > 0, 'the bounds are positive');
  assert.deepEqual(LOG_DIRS, ['.wrxn/dream', '.wrxn/sync', '.wrxn/harvest'], 'the three append-only log dirs');
});

// ── shipping: managed payload, self-contained, laid into installs (session-end requires it) ──

test('the prune helper imports nothing outside the node standard library', () => {
  const src = fs.readFileSync(PRUNE, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the helper has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

test('the prune helper is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/prune.cjs');
  assert.ok(entry, 'prune.cjs is classified in the manifest (the installer lays only manifested payload files)');
  assert.equal(entry.class, 'managed', 'kernel-owned hook code → managed');
  const target = tmp('wrxn-prune-laid-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(
    fs.existsSync(path.join(target, '.claude', 'hooks', 'prune.cjs')),
    'the helper is laid alongside session-end-reward.cjs so its require resolves in installs'
  );
});

// ── AC: wired into the session-end hook, runs across dream/, sync/, harvest/ ──────────

test('the session-end hook prunes every log dir (dream/, sync/, harvest/) end-to-end', () => {
  const target = tmp('wrxn-prune-wiring-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  const realNow = Date.now();
  // In each of the three log dirs: 2 ancient records (well beyond MAX_AGE_DAYS) + 1 fresh record.
  // The real Date.now() runs the hook, so dating relative to it keeps the test correct at any run date.
  const seed = (rel, name) => {
    const dir = path.join(target, rel);
    writeLog(dir, name, [
      { ts: iso(realNow - 200 * DAY), op: 'stage', n: 'ancient-a' },
      { ts: iso(realNow - 150 * DAY), op: 'stage', n: 'ancient-b' },
      { ts: iso(realNow - 1 * DAY), op: 'stage', n: 'fresh' },
    ]);
    return path.join(dir, name);
  };
  const files = {
    dream: seed('.wrxn/dream', 'audit.jsonl'),
    sync: seed('.wrxn/sync', 'staged.jsonl'),
    harvest: seed('.wrxn/harvest', 'staged.jsonl'),
  };
  // Run the REAL session-end hook the way the harness does: SessionEnd event on stdin, install on disk.
  execFileSync('node', [path.join(target, '.claude', 'hooks', 'session-end-reward.cjs')], {
    input: JSON.stringify({ session_id: 'prune-wiring', cwd: target }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  for (const [where, file] of Object.entries(files)) {
    assert.deepEqual(readLog(file).map((r) => r.n), ['fresh'], `${where}/ pruned to the fresh record only`);
  }
});

// ── AC: symlink-safe — a destructive rewrite never follows a symlink out of the log dir ──

test('prune does NOT follow a *.jsonl symlink out of the log dir (the outside target is untouched)', (t) => {
  const dir = tmp('wrxn-prune-symlink-file-');
  const outDir = tmp('wrxn-prune-outside-file-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  // An OUTSIDE log, over both bounds — it WOULD be trimmed if prune ever wrote through the link.
  const outside = path.join(outDir, 'secret.jsonl');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ ts: iso(now - (6 - i) * 1000), op: 'stage', n: i });
  writeLog(outDir, 'secret.jsonl', recs);
  const before = sha(outside);
  // Plant a *.jsonl SYMLINK inside the swept log dir, pointing at the outside file.
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, 'evil.jsonl');
  try {
    fs.symlinkSync(outside, link);
  } catch {
    t.skip('symlinks not supported on this platform');
    return;
  }
  const res = prune(dir, { maxRecords: 4, maxAgeDays: 9999, now });
  assert.equal(sha(outside), before, 'the outside target is byte-for-byte untouched — the symlink was not followed');
  assert.equal(res.rewritten, 0, 'the planted symlink is skipped, never rewritten');
});

test('prune does NOT descend into a symlinked log DIR (outside files are untouched)', (t) => {
  const realOut = tmp('wrxn-prune-realdir-'); // a REAL dir of REAL logs, OUTSIDE the install
  const now = Date.parse('2026-06-22T00:00:00Z');
  const outFile = path.join(realOut, 'staged.jsonl');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ ts: iso(now - (6 - i) * 1000), op: 'stage', n: i });
  writeLog(realOut, 'staged.jsonl', recs);
  const before = sha(outFile);
  // The swept log path is itself a SYMLINK to the outside dir.
  const base = tmp('wrxn-prune-symdir-');
  const linkDir = path.join(base, 'dream');
  try {
    fs.symlinkSync(realOut, linkDir, 'dir');
  } catch {
    t.skip('symlinks not supported on this platform');
    return;
  }
  const res = prune(linkDir, { maxRecords: 4, maxAgeDays: 9999, now });
  assert.equal(sha(outFile), before, 'a symlinked log dir is not descended — the outside files are untouched');
  assert.equal(res.rewritten, 0, 'nothing is rewritten through a symlinked log dir');
});

// ── AC: atomic rewrite — a torn write (crash/ENOSPC) never damages the live log ──

test('prune rewrite is atomic — a torn write leaves the original log byte-intact (temp+rename)', () => {
  const dir = tmp('wrxn-prune-atomic-fail-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ ts: iso(now - (6 - i) * 1000), op: 'stage', n: i });
  const file = path.join(dir, 'audit.jsonl');
  writeLog(dir, 'audit.jsonl', recs); // over maxRecords → a rewrite WILL be attempted
  const original = sha(file);
  // Simulate a crash/ENOSPC PARTWAY through the write: truncate-then-throw — exactly the tear a direct
  // writeFileSync(file) suffers. An atomic temp+rename writes the TEMP (not the live log), so the
  // original is never touched, the rename never runs, and the partial temp is cleaned up.
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, data, ...rest) => {
    realWrite.call(fs, p, String(data).slice(0, 8), ...rest); // partial (torn) write
    throw new Error('simulated ENOSPC mid-write');
  };
  let res;
  try {
    assert.doesNotThrow(() => { res = prune(dir, { maxRecords: 2, maxAgeDays: 9999, now }); }, 'fail-open: a write fault never throws');
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(sha(file), original, 'the live log is byte-intact after a torn write — atomic temp+rename, never an in-place truncate');
  assert.equal(res.rewritten, 0, 'a failed rewrite is not counted as rewritten');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit.jsonl'], 'the partial temp is cleaned up — none left behind');
});

test('prune rewrite leaves no temp behind on success — the original is replaced via rename', () => {
  const dir = tmp('wrxn-prune-atomic-ok-');
  const now = Date.parse('2026-06-22T00:00:00Z');
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push({ ts: iso(now - (6 - i) * 1000), op: 'stage', n: i });
  writeLog(dir, 'audit.jsonl', recs);
  const res = prune(dir, { maxRecords: 4, maxAgeDays: 9999, now });
  assert.equal(res.rewritten, 1, 'the over-bound log is rewritten');
  assert.deepEqual(readLog(path.join(dir, 'audit.jsonl')).map((r) => r.n), [2, 3, 4, 5], 'content is correct after the atomic rewrite');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['audit.jsonl'], 'no sibling temp file is left behind — the temp was renamed over the original');
});
