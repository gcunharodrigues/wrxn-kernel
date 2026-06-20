'use strict';

// auto-memory-05 — migration 007 (auto-memory transition), the install sweep.
// The new payload no longer SHIPS the `handoff` skill or the `_slots/current-focus` slot, and it now
// wires SessionEnd → memory-synth-spawn.cjs + ships a seeded `memory.config.json`. But `wrxn update`
// overwrites managed files in place and never PRUNES a removed one, and a seeded file already present
// is preserved — so a pre-0.12.0 install keeps the old `handoff` skill files + the stale focus slot,
// and (if it carried a hand-edited settings or an old config) may not have the new wiring/seed. Migration
// 007 transitions it: removes the handoff skill, idempotently wires the SessionEnd spawn hook, seeds
// memory.config.json if absent, removes _slots/current-focus.md, and backfills the .gitignore for the
// `.env` secret + the continuity runtime temps the synth/dream now write. Idempotent, never throws on a
// clean install. Covered in isolation (call up() against a fixture) AND e2e through `wrxn update`. Mirrors
// test/retire-session-capture-migration.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

const MIGRATION_FILE = '007-auto-memory-transition.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

// A throwaway kernel package at `version` carrying ONLY the supplied migrations (mirrors the 004 test) —
// so `update()` runs just migration 007 against the install, not the full 001..006 chain.
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

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}
function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A settings.json a pre-auto-memory install carried: SessionStart wired, SessionEnd ABSENT (the synth
// spawn hook did not exist yet), the UserPromptSubmit chain present. The transition must ADD SessionEnd.
const PRE_SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.cjs"' }] }],
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/synapse-engine.cjs"' },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/reference-detect.cjs"' },
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/recall-surface.cjs"' },
        ],
      },
    ],
  },
};

// Build a stale install fixture carrying the pre-auto-memory shape: the `handoff` skill, a settings.json
// without the SessionEnd spawn wiring, NO memory.config.json, the stale `_slots/current-focus.md` slot,
// and a `.gitignore` lacking the `.env` + continuity-temp lines. `settingsObj` is overridable so the
// no-throw / corrupt-file cases can vary it.
function staleInstall(prefix, settingsObj = PRE_SETTINGS) {
  const target = tmp(prefix);

  const handoff = path.join(target, '.claude', 'skills', 'handoff');
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, 'SKILL.md'), '---\nname: handoff\n---\nold handoff skill\n');

  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify(settingsObj, null, 2) + '\n');

  const slots = path.join(target, '.wrxn', 'wiki', '_slots');
  fs.mkdirSync(slots, { recursive: true });
  fs.writeFileSync(path.join(slots, '.gitkeep'), '');
  fs.writeFileSync(path.join(slots, 'current-focus.md'), '---\nname: current-focus\ntier: _slots\n---\n# Current focus\n\nstale.\n');

  // a pre-existing .gitignore WITHOUT the auto-memory lines (only the older recon/reinforce ignores)
  fs.writeFileSync(path.join(target, '.gitignore'), '.recon-wrxn/\n.wrxn/reinforce.json\n');
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
function gitignoreLines(target) {
  return fs.readFileSync(path.join(target, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
}

// ── metadata ──────────────────────────────────────────────────────────────────

test('migration metadata: id 007 ships with version 0.12.0', () => {
  assert.equal(migration.id, '007');
  assert.equal(migration.version, '0.12.0');
  assert.equal(typeof migration.up, 'function');
});

// ── in isolation: up() transitions a stale install ────────────────────────────

test('(a) up() removes the handoff skill from the install', () => {
  const target = staleInstall('wrxn-am-handoff-');
  migration.up({ target });
  assert.equal(
    fs.existsSync(path.join(target, '.claude', 'skills', 'handoff')),
    false,
    'the handoff skill dir is removed',
  );
});

test('(a) up() wires SessionEnd → memory-synth-spawn.cjs, preserving the other events', () => {
  const target = staleInstall('wrxn-am-wire-');
  migration.up({ target });

  const cfg = settingsOf(target);
  const cmds = hookCommands(cfg);
  assert.ok('SessionEnd' in cfg.hooks, 'SessionEnd event present');
  assert.ok(cmds.some((c) => c.includes('memory-synth-spawn.cjs')), 'memory-synth-spawn wired');
  // the SessionEnd command is anchored to $CLAUDE_PROJECT_DIR like every other hook command
  const se = cmds.find((c) => c.includes('memory-synth-spawn.cjs'));
  assert.match(se, /\$CLAUDE_PROJECT_DIR/, 'SessionEnd command anchored to $CLAUDE_PROJECT_DIR');
  // the pre-existing wiring is untouched
  assert.ok(cmds.some((c) => c.includes('session-start.cjs')), 'session-start preserved');
  assert.ok(cmds.some((c) => c.includes('synapse-engine.cjs')), 'synapse-engine preserved');
  assert.ok(cmds.some((c) => c.includes('reference-detect.cjs')), 'reference-detect preserved');
  assert.ok(cmds.some((c) => c.includes('recall-surface.cjs')), 'recall-surface preserved');
});

test('(a) up() seeds memory.config.json (the payload default shape) when absent', () => {
  const target = staleInstall('wrxn-am-seed-');
  migration.up({ target });

  const cfgPath = path.join(target, '.wrxn', 'memory.config.json');
  assert.ok(fs.existsSync(cfgPath), 'memory.config.json seeded');
  const seeded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // it matches the payload default the new install ships (slice-02), so old + new installs agree.
  const payloadDefault = JSON.parse(
    fs.readFileSync(path.join(PKG_ROOT, 'payload', '.wrxn', 'memory.config.json'), 'utf8'),
  );
  assert.deepEqual(seeded, payloadDefault, 'seeded config equals the payload default');
  assert.ok(seeded.tasks && seeded.tasks.handoff && seeded.tasks.dream, 'seeded config has handoff + dream tasks');
});

test('(a) up() preserves an existing operator-edited memory.config.json (seeded = never clobber)', () => {
  const target = staleInstall('wrxn-am-seed-keep-');
  const cfgPath = path.join(target, '.wrxn', 'memory.config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const mine = { tasks: { handoff: { primary: { engine: 'claude', model: 'claude-opus-4-8[1m]' } } } };
  fs.writeFileSync(cfgPath, JSON.stringify(mine, null, 2) + '\n');

  migration.up({ target });
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), mine, 'operator config untouched');
});

test('(a) up() removes the stale _slots/current-focus.md slot (the tier dir + gitkeep stay)', () => {
  const target = staleInstall('wrxn-am-slot-');
  migration.up({ target });

  const slotPage = path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md');
  assert.equal(fs.existsSync(slotPage), false, 'the stale focus slot page is removed');
  // the empty tier dir + its gitkeep are NOT swept (the tier is retained, only the slot page is dropped)
  assert.equal(
    fs.existsSync(path.join(target, '.wrxn', 'wiki', '_slots', '.gitkeep')),
    true,
    'the _slots tier gitkeep survives',
  );
});

test('(a) up() backfills the .gitignore for .env + the continuity runtime temps (slice-04 F1)', () => {
  const target = staleInstall('wrxn-am-gitignore-');
  migration.up({ target });

  const lines = gitignoreLines(target);
  // the secret slice-02 added for NEW installs — backfilled here for OLD ones
  assert.ok(lines.includes('.env'), '.env is gitignored');
  // the continuity runtime markers + temps the synth/dream write (never committed)
  assert.ok(lines.includes('.wrxn/continuity/.pending*'), '.pending markers ignored');
  assert.ok(lines.includes('.wrxn/continuity/.dream.*.tmp'), 'dream temps ignored');
  assert.ok(lines.includes('.wrxn/continuity/.latest.md.*.tmp'), 'baton temp ignored');
  // the pre-existing ignores are preserved, and the tracked baton itself is NOT ignored
  assert.ok(lines.includes('.recon-wrxn/'), 'pre-existing .recon-wrxn/ preserved');
  assert.ok(!lines.includes('.wrxn/continuity/latest.md'), 'the tracked baton is not ignored');
});

test('(a) the SessionEnd wiring is idempotent — already wired ⇒ not duplicated', () => {
  // a settings.json that ALREADY carries the SessionEnd spawn hook (e.g. update's managed overwrite
  // laid it before the migration ran). The migration must NOT add a second copy.
  const wired = JSON.parse(JSON.stringify(PRE_SETTINGS));
  wired.hooks.SessionEnd = [
    { hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs"' }] },
  ];
  const target = staleInstall('wrxn-am-wire-idem-', wired);
  migration.up({ target });

  const cmds = hookCommands(settingsOf(target));
  const occurrences = cmds.filter((c) => c.includes('memory-synth-spawn.cjs')).length;
  assert.equal(occurrences, 1, 'the spawn hook is wired exactly once (no duplicate)');
});

// ── defensiveness (mirrors 004 b/c/d/e) ───────────────────────────────────────

test('(b) idempotent — a second run is a no-op and does not throw', () => {
  const target = staleInstall('wrxn-am-idem-');
  migration.up({ target });
  const settingsAfter1 = fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8');
  const gitignoreAfter1 = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');
  const configAfter1 = fs.readFileSync(path.join(target, '.wrxn', 'memory.config.json'), 'utf8');

  assert.doesNotThrow(() => migration.up({ target }), 'second run does not throw');
  assert.equal(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'), settingsAfter1, 'settings byte-identical on the second run');
  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), gitignoreAfter1, '.gitignore byte-identical on the second run');
  assert.equal(fs.readFileSync(path.join(target, '.wrxn', 'memory.config.json'), 'utf8'), configAfter1, 'config byte-identical on the second run');
});

test('(c) an already-transitioned install is a no-op (never throws)', () => {
  // a fresh-shape install: no handoff skill, SessionEnd already wired, config seeded, no focus slot,
  // gitignore already backfilled.
  const target = tmp('wrxn-am-clean-');
  fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
  const clean = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.cjs"' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs"' }] }],
    },
  };
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), JSON.stringify(clean, null, 2) + '\n');
  fs.mkdirSync(path.join(target, '.wrxn'), { recursive: true });
  fs.writeFileSync(path.join(target, '.wrxn', 'memory.config.json'), '{"tasks":{}}\n');

  assert.doesNotThrow(() => migration.up({ target }), 'a transitioned install does not throw');
  assert.deepEqual(settingsOf(target), clean, 'already-wired settings untouched');
});

test('(d) a bare target (no settings, no config, no slot) is a no-op (never throws)', () => {
  const target = tmp('wrxn-am-bare-');
  assert.doesNotThrow(() => migration.up({ target }), 'a bare install does not throw');
  // with no settings.json the migration leaves it absent (the managed overwrite lays the wired one).
  assert.equal(fs.existsSync(path.join(target, '.claude', 'settings.json')), false, 'no settings synthesized on a bare target');
});

test('(e) a corrupt settings.json is left untouched (never clobbered); the other steps still run', () => {
  const target = staleInstall('wrxn-am-corrupt-');
  const garbage = '{ not valid json,,, SessionEnd';
  fs.writeFileSync(path.join(target, '.claude', 'settings.json'), garbage);

  assert.doesNotThrow(() => migration.up({ target }));
  assert.equal(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'), garbage, 'corrupt settings preserved byte-for-byte');
  // the settings-independent steps still happen even though settings was left alone
  assert.equal(fs.existsSync(path.join(target, '.claude', 'skills', 'handoff')), false, 'handoff still removed');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md')), false, 'focus slot still removed');
  assert.ok(fs.existsSync(path.join(target, '.wrxn', 'memory.config.json')), 'config still seeded');
  assert.ok(gitignoreLines(target).includes('.env'), '.gitignore still backfilled');
});

// ── e2e through wrxn update ────────────────────────────────────────────────────

test('wrxn update transitions a stale install onto auto-memory and records 007 (resumable)', () => {
  const target = staleInstall('wrxn-am-e2e-');
  // a pre-0.12.0 receipt so update applies pending migrations up to 0.12.0
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.11.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );

  const pkg = fakePkg(tmp('wrxn-am-pkg-'), '0.12.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  assert.ok(report.migrationsRan.includes('007'), 'report.migrationsRan includes 007');
  assert.ok(receiptOf(target).migrationsApplied.includes('007'), 'receipt records 007 applied');

  // end state: the install is on auto-memory
  assert.equal(fs.existsSync(path.join(target, '.claude', 'skills', 'handoff')), false, 'handoff skill gone after update');
  assert.equal(fs.existsSync(path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md')), false, 'focus slot gone after update');
  assert.ok(fs.existsSync(path.join(target, '.wrxn', 'memory.config.json')), 'memory.config.json present after update');
  const cmds = hookCommands(settingsOf(target));
  assert.ok(cmds.some((c) => c.includes('memory-synth-spawn.cjs')), 'SessionEnd spawn wired after update');
  assert.equal(cmds.filter((c) => c.includes('memory-synth-spawn.cjs')).length, 1, 'spawn wired exactly once (no duplicate)');
  const gi = gitignoreLines(target);
  assert.ok(gi.includes('.env') && gi.includes('.wrxn/continuity/.dream.*.tmp'), '.gitignore backfilled after update');

  // re-update at the same version: 007 does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('007'), false, 're-update does not re-run the applied 007');
});
