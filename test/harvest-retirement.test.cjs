'use strict';

// harvest-01 — retirement of the session-capture subsystem (payload shape assertions).
// The mechanical session-capture layer (session-end episodic writer + session-history turn-trail
// recorder + the sessions wiki tier they fed) is retired: the handoff baton + dream consolidation are
// the close-out moment now. These tests pin the PAYLOAD end state — the two hooks no longer ship, the
// settings.json is unwired (synapse-engine + the rest intact), the manifest entries are gone, the
// sessions tier is retired, and the CONTEXT.md `Capture` glossary term is dropped. (The migration that
// sweeps an EXISTING install lives in retire-session-capture-migration.test.cjs.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const PAYLOAD = path.join(PKG_ROOT, 'payload');
const HOOKS = path.join(PAYLOAD, '.claude', 'hooks');
const SETTINGS = path.join(PAYLOAD, '.claude', 'settings.json');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Every regular file under payload/, repo-relative — used by the "no writer" content scan.
function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p);
  }
  return out;
}

function settings() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

// Flatten every hook command string across all events in the payload settings.json.
function hookCommands() {
  const cmds = [];
  for (const groups of Object.values(settings().hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type === 'command') cmds.push(hook.command);
      }
    }
  }
  return cmds;
}

// ── AC1: the two hooks no longer ship, settings unwired, manifest entries dropped ──

test('AC1 payload no longer ships session-end.cjs or session-history.cjs', () => {
  assert.equal(fs.existsSync(path.join(HOOKS, 'session-end.cjs')), false, 'session-end.cjs removed from payload');
  assert.equal(fs.existsSync(path.join(HOOKS, 'session-history.cjs')), false, 'session-history.cjs removed from payload');
  // the surviving start hook is untouched (retired 2, trimmed 1)
  assert.equal(fs.existsSync(path.join(HOOKS, 'session-start.cjs')), true, 'session-start.cjs kept');
});

// harvest-01's true invariant is that the RETIRED session-end episodic writer is gone — not that the
// SessionEnd event can never exist again. auto-memory-03 re-occupies SessionEnd with the auto-handoff
// synth spawn hook (memory-synth-spawn.cjs), which is a different, deliberate writer. So: no
// session-end.cjs on SessionEnd; the new synth spawn hook is allowed.
test('AC1 settings.json does not wire the retired session-end writer on SessionEnd', () => {
  const sessionEnd = JSON.stringify((settings().hooks || {}).SessionEnd || []);
  assert.ok(!sessionEnd.includes('session-end.cjs'), 'the retired session-end.cjs is not wired on SessionEnd');
});

test('AC1 settings.json unwires session-history from the UserPromptSubmit chain, keeping synapse-engine + the rest', () => {
  const cmds = hookCommands();
  assert.ok(!cmds.some((c) => c.includes('session-history.cjs')), 'session-history.cjs unwired');
  assert.ok(!cmds.some((c) => c.includes('session-end.cjs')), 'session-end.cjs unwired');
  // the rest of the UserPromptSubmit chain is intact
  assert.ok(cmds.some((c) => c.includes('synapse-engine.cjs')), 'synapse-engine still wired');
  assert.ok(cmds.some((c) => c.includes('reference-detect.cjs')), 'reference-detect still wired');
  assert.ok(cmds.some((c) => c.includes('recall-surface.cjs')), 'recall-surface still wired');
});

test('AC1 manifest drops the two hook entries, keeps session-start', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const paths = manifest.files.map((f) => f.path);
  assert.ok(!paths.includes('.claude/hooks/session-end.cjs'), 'session-end manifest entry dropped');
  assert.ok(!paths.includes('.claude/hooks/session-history.cjs'), 'session-history manifest entry dropped');
  assert.ok(paths.includes('.claude/hooks/session-start.cjs'), 'session-start manifest entry kept');
});

// ── AC2: the sessions wiki tier is retired ────────────────────────────────────

test('AC2 the sessions tier gitkeep is gone from payload and manifest', () => {
  assert.equal(fs.existsSync(path.join(PAYLOAD, '.wrxn', 'wiki', 'sessions', '.gitkeep')), false, 'payload gitkeep removed');
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const paths = manifest.files.map((f) => f.path);
  assert.ok(!paths.includes('.wrxn/wiki/sessions/.gitkeep'), 'sessions gitkeep manifest entry dropped');
  // the other semantic tiers survive
  for (const t of ['concepts', 'decisions', 'gotchas']) {
    assert.ok(paths.includes(`.wrxn/wiki/${t}/.gitkeep`), `${t} tier survives`);
  }
});

test('AC2 a fresh init lays no sessions tier', () => {
  const target = tmp('wrxn-harvest-init-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', 'sessions')), false, 'no sessions tier created on init');
  // the surviving tiers are laid
  assert.ok(fs.existsSync(path.join(target, '.wrxn', 'wiki', 'concepts')), 'concepts tier laid');
});

test('AC2 no payload code writes the sessions tier (the episodic writer signature is gone)', () => {
  // the path-join write signature `'wiki', 'sessions'` lived only in session-end + the session-start
  // fallback; a read-side TIERS array carries `'gotchas', 'sessions'`, which this does NOT match.
  const re = /wiki['"]\s*,\s*['"]sessions/;
  const offenders = walk(PAYLOAD).filter((p) => re.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(offenders, [], `no payload file constructs a sessions-tier write path: ${offenders.join(', ')}`);
});

// ── AC5: the Capture glossary term is retired ─────────────────────────────────

test('AC5 CONTEXT.md no longer carries the Capture glossary term or a session-end reference', () => {
  const ctx = fs.readFileSync(path.join(PKG_ROOT, 'CONTEXT.md'), 'utf8');
  assert.doesNotMatch(ctx, /\*\*Capture\*\*/, 'the **Capture** glossary term is retired');
  assert.doesNotMatch(ctx, /session-end/, 'no dangling session-end reference');
  // the surrounding glossary survives (sanity: we trimmed, not gutted)
  assert.match(ctx, /\*\*Consolidation\*\*/, 'Consolidation term survives');
  assert.match(ctx, /\*\*dream\*\*/, 'dream term survives');
});
