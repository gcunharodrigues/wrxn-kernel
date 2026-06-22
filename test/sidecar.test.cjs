'use strict';

// Tests for the shared coalesced-sidecar helper (S1 / kernel #12). recall-surface.cjs's reinforce
// writer is refactored onto this; the per-session surfaced-log reuses it. The helper must be
// SELF-CONTAINED (node stdlib only — it ships inside installs alongside the hooks), COALESCED
// (read → mutate → rewrite-not-append, writing only when the map actually changes, never growing),
// FAIL-OPEN (any fault leaves the caller unchanged and never throws), and SECRET-SAFE (it never
// writes a value that looks like a secret). Black-box over the exported function.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const SIDECAR = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'sidecar.cjs');
const sidecar = require('../payload/.claude/hooks/sidecar.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const { init } = require('../lib/install.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── coalesce: read → mutate → rewrite-not-append, write only on change ───────────────

test('coalesceSidecar: a mutate that sets a key writes the rewritten map (created if absent)', () => {
  const dir = tmp('wrxn-sidecar-create-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    map['a'] = '1';
    return true; // signal the map changed
  });
  assert.equal(wrote, true, 'a changed map is written');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: '1' }, 'the rewritten map is on disk');
});

test('coalesceSidecar: mutate sees the existing map; an unchanged map is a no-op (byte-identical, no write)', () => {
  const dir = tmp('wrxn-sidecar-coalesce-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ a: '1' }, null, 2) + '\n');
  const before = fs.readFileSync(file);
  let saw;
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    saw = { ...map };
    return false; // caller decided nothing changed
  });
  assert.deepEqual(saw, { a: '1' }, 'mutate receives the existing on-disk map');
  assert.equal(wrote, false, 'an unchanged map is not written');
  assert.ok(before.equals(fs.readFileSync(file)), 'the file is left byte-identical (coalesced, no growth)');
});

// ── fail-open: never throw, never clobber ────────────────────────────────────────────

test('coalesceSidecar: a malformed existing sidecar → no write, no throw, left untouched (never clobbered)', () => {
  const dir = tmp('wrxn-sidecar-corrupt-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json{ broken');
  let called = false;
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { called = true; map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'a corrupt sidecar is not overwritten');
  assert.equal(called, false, 'mutate is never invoked over an unparseable file');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json{ broken', 'the corrupt sidecar is left byte-for-byte');
});

test('coalesceSidecar: an existing JSON array (not a map) → no write, no throw, left untouched', () => {
  const dir = tmp('wrxn-sidecar-array-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[1,2,3]');
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'a non-object sidecar is skipped, not clobbered');
  assert.equal(fs.readFileSync(file, 'utf8'), '[1,2,3]', 'left untouched');
});

test('coalesceSidecar: an unwritable path (a dir where the file should be) → false, no throw', () => {
  const dir = tmp('wrxn-sidecar-unwritable-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(file, { recursive: true }); // the file PATH is a directory → read/write raise EISDIR
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'the write fault is swallowed (best-effort)');
});

// ── secret-scan: a secret value is never written ─────────────────────────────────────

test('coalesceSidecar: a mutate that injects a secret-shaped value is NOT written (no-secret guarantee)', () => {
  const dir = tmp('wrxn-sidecar-secret-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => {
      map['leak'] = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // an npm token shape (36 base62 chars)
      return true;
    });
  });
  assert.equal(wrote, false, 'a map carrying a secret value is refused, not written');
  assert.equal(fs.existsSync(file), false, 'no sidecar file is created when a secret would be written');
});

test('coalesceSidecar: a clean map writes even when a sibling secret-free value resembles a path', () => {
  // Guard against an over-broad scanner: ordinary wiki-rel paths / dates must still write fine.
  const dir = tmp('wrxn-sidecar-clean-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    map['concepts/some-page.md'] = '2026-06-22';
    return true;
  });
  assert.equal(wrote, true, 'a secret-free map writes normally');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'concepts/some-page.md': '2026-06-22' });
});

// ── self-contained: node stdlib only (it ships into installs alongside the hooks) ────

test('the sidecar helper imports nothing outside the node standard library', () => {
  const src = fs.readFileSync(SIDECAR, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the helper has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── shipping: the sibling is managed payload, laid into installs (recall-surface requires it) ──

test('the sidecar helper is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/sidecar.cjs');
  assert.ok(entry, 'sidecar.cjs is classified in the manifest (the installer refuses any unmanifested payload file)');
  assert.equal(entry.class, 'managed', 'kernel-owned hook code → managed');
  const target = tmp('wrxn-sidecar-laid-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(
    fs.existsSync(path.join(target, '.claude', 'hooks', 'sidecar.cjs')),
    'the sibling helper is laid alongside recall-surface.cjs so the require resolves in installs'
  );
});
