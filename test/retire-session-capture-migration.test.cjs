'use strict';

// harvest-01 — migration 004 (retire-session-capture), the install sweep.
// The new payload no longer SHIPS session-end/session-history, but `wrxn update` overwrites managed
// files in place — it never PRUNES a removed one — so a pre-0.7.0 install keeps the two hooks plus a
// populated sessions tier and orphaned history scratch. Migration 004 sweeps all of it: removes the
// two hook files, unwires them from the install settings.json (drops the SessionEnd event + the
// session-history command from UserPromptSubmit, keeping synapse-engine), removes the sessions tier,
// and reaps orphaned `.wrxn/history/*.trail` / `*.touched`. Idempotent, never throws on a clean
// install. Covered in isolation (call up() against a fixture) AND e2e through `wrxn update`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

const MIGRATION_FILE = '004-retire-session-capture.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A wired-for-capture settings.json exactly as a pre-0.7.0 install carried it.
const WIRED_SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.cjs"' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.cjs"' }] }],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/synapse-engine.cjs"' },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-history.cjs"' },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reference-detect.cjs"' },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/recall-surface.cjs"' },
        ],
      },
    ],
  },
};

// Build a stale install fixture carrying the full retired subsystem: the two hooks, a wired
// settings.json, a populated sessions tier (a dated page + the gitkeep), and orphaned history scratch.
function staleInstall(prefix, settingsObj = WIRED_SETTINGS) {
  const target = tmp(prefix);
  const hooks = path.join(target, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'session-end.cjs'), '// old session-end hook\n');
  fs.writeFileSync(path.join(hooks, 'session-history.cjs'), '// old session-history hook\n');
  fs.writeFileSync(path.join(hooks, 'session-start.cjs'), '// the surviving start hook\n');
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify(settingsObj, null, 2) + '\n');

  const sessions = path.join(target, '.wrxn', 'wiki', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, '.gitkeep'), '');
  fs.writeFileSync(path.join(sessions, '2026-06-10-sid-old.md'), '# an episodic breadcrumb page\n');

  const hist = path.join(target, '.wrxn', 'history');
  fs.mkdirSync(hist, { recursive: true });
  fs.writeFileSync(path.join(hist, '.gitkeep'), '');
  fs.writeFileSync(path.join(hist, 'sid-old.trail'), '2026-06-10\tdid a turn\n');
  fs.writeFileSync(path.join(hist, 'sid-old.touched'), 'lib/install.cjs\n');
  return target;
}

function settingsOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
}
function hookCommands(cfg) {
  const cmds = [];
  for (const groups of Object.values(cfg.hooks || {})) {
    for (const group of groups) for (const h of group.hooks || []) cmds.push(h.command);
  }
  return cmds;
}

// A throwaway kernel package at `version` carrying the supplied migrations (mirrors 002/003 tests).
function fakePkg(work, version, migrations) {
  const dir = path.join(work, 'pkg-' + version);
  fs.cpSync(path.join(PKG_ROOT, 'payload'), path.join(dir, 'payload'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wrxn', version }));
  const mdir = path.join(dir, 'migrations');
  fs.mkdirSync(mdir, { recursive: true });
  for (const m of migrations) fs.writeFileSync(path.join(mdir, m.file), m.body);
  return dir;
}

// ── metadata ──────────────────────────────────────────────────────────────────

test('migration metadata: id 004 ships with version 0.7.0', () => {
  assert.equal(migration.id, '004');
  assert.equal(migration.version, '0.7.0');
  assert.equal(typeof migration.up, 'function');
});

// ── in isolation: up() sweeps a stale install ─────────────────────────────────

test('(a) up() removes the two hooks, the sessions tier, and orphaned history scratch', () => {
  const target = staleInstall('wrxn-retire-a-');
  migration.up({ target });

  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-end.cjs')), false, 'session-end hook removed');
  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-history.cjs')), false, 'session-history hook removed');
  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-start.cjs')), true, 'session-start hook kept');

  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', 'sessions')), false, 'sessions tier swept');

  const hist = path.join(target, '.wrxn', 'history');
  assert.equal(fs.existsSync(path.join(hist, 'sid-old.trail')), false, 'orphaned .trail swept');
  assert.equal(fs.existsSync(path.join(hist, 'sid-old.touched')), false, 'orphaned .touched swept');
  assert.equal(fs.existsSync(hist), true, 'the history dir itself survives (code-intel-push uses it)');
  assert.equal(fs.existsSync(path.join(hist, '.gitkeep')), true, 'history .gitkeep survives');
});

test('(a) up() unwires the hooks from settings.json, keeping synapse-engine + the rest', () => {
  const target = staleInstall('wrxn-retire-a2-');
  migration.up({ target });

  const cfg = settingsOf(target);
  assert.ok(!('SessionEnd' in cfg.hooks), 'SessionEnd event dropped');
  const cmds = hookCommands(cfg);
  assert.ok(!cmds.some((c) => c.includes('session-end.cjs')), 'session-end unwired');
  assert.ok(!cmds.some((c) => c.includes('session-history.cjs')), 'session-history unwired');
  assert.ok(cmds.some((c) => c.includes('synapse-engine.cjs')), 'synapse-engine preserved');
  assert.ok(cmds.some((c) => c.includes('reference-detect.cjs')), 'reference-detect preserved');
  assert.ok(cmds.some((c) => c.includes('recall-surface.cjs')), 'recall-surface preserved');
  assert.ok(cmds.some((c) => c.includes('session-start.cjs')), 'session-start preserved');
});

test('(b) idempotent — a second run is a no-op and does not throw', () => {
  const target = staleInstall('wrxn-retire-b-');
  migration.up({ target });
  const settingsAfter1 = fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8');

  assert.doesNotThrow(() => migration.up({ target }), 'second run does not throw');
  assert.equal(
    fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'),
    settingsAfter1,
    'settings byte-identical on the second run',
  );
});

test('(c) an already-clean install is a no-op (never throws)', () => {
  // a fresh-shape install: no retired hooks, an already-unwired settings, no sessions tier
  const target = tmp('wrxn-retire-clean-');
  fs.mkdirSync(path.join(target, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'hooks', 'session-start.cjs'), '// start\n');
  const clean = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.cjs"' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/synapse-engine.cjs"' }] }],
    },
  };
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify(clean, null, 2) + '\n');

  assert.doesNotThrow(() => migration.up({ target }), 'clean install does not throw');
  assert.deepEqual(settingsOf(target), clean, 'clean settings untouched');
});

test('(d) a bare target (no settings, no tiers) is a no-op (never throws)', () => {
  const target = tmp('wrxn-retire-bare-');
  assert.doesNotThrow(() => migration.up({ target }), 'a bare install does not throw');
});

test('(e) a corrupt settings.json is left untouched (never clobbered)', () => {
  const target = staleInstall('wrxn-retire-corrupt-');
  const garbage = '{ not valid json,,, SessionEnd';
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), garbage);

  assert.doesNotThrow(() => migration.up({ target }));
  assert.equal(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'), garbage, 'corrupt settings preserved byte-for-byte');
  // the other sweeps still happen even though settings was left alone
  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-end.cjs')), false, 'hooks still swept');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', 'sessions')), false, 'tier still swept');
});

// ── e2e through wrxn update ────────────────────────────────────────────────────

test('wrxn update sweeps the subsystem on a stale install and records 004 (resumable)', () => {
  const target = staleInstall('wrxn-retire-e2e-legacy-');
  // a pre-0.7.0 receipt so update applies pending migrations up to 0.7.0
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.6.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );

  const pkg = fakePkg(tmp('wrxn-retire-pkg-'), '0.7.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  assert.ok(report.migrationsRan.includes('004'), 'report.migrationsRan includes 004');
  assert.ok(receiptOf(target).migrationsApplied.includes('004'), 'receipt records 004 applied');

  // end state: the subsystem is gone from the install
  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-end.cjs')), false, 'session-end hook gone after update');
  assert.equal(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-history.cjs')), false, 'session-history hook gone after update');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', 'sessions')), false, 'sessions tier gone after update');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'history', 'sid-old.trail')), false, 'orphaned trail swept after update');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'history', 'sid-old.touched')), false, 'orphaned touched swept after update');
  const cfg = settingsOf(target);
  assert.ok(!('SessionEnd' in cfg.hooks), 'SessionEnd unwired after update');
  assert.ok(!hookCommands(cfg).some((c) => c.includes('session-history.cjs')), 'session-history unwired after update');

  // re-update at the same version: 004 does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('004'), false, 're-update does not re-run the applied 004');
});
