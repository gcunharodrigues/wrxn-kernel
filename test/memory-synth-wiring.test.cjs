'use strict';

// Wiring tests for auto-memory-03 (AC8): the new SessionEnd spawn hook must be REGISTERED in the
// manifest (managed-integrity stays consistent across installs) and WIRED on SessionEnd in the payload
// settings.json (SessionEnd was previously unwired, so this is its sole hook). The existing session
// wiring (SessionStart → session-start) must be untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const SETTINGS = path.join(PKG_ROOT, 'payload', '.claude', 'settings.json');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── manifest registration ───────────────────────────────────────────────────────

test('the manifest registers memory-synth-spawn.cjs as a managed project hook', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/memory-synth-spawn.cjs');
  assert.ok(entry, 'the spawn hook is registered in the manifest');
  assert.equal(entry.class, 'managed', 'the hook is managed (overwritten on update)');
  assert.equal(entry.profile, 'project');
});

// ── settings: SessionEnd is wired to the spawn hook ─────────────────────────────

function settingsJSON() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

test('the payload settings.json wires SessionEnd to the spawn hook', () => {
  const cfg = settingsJSON();
  assert.ok(cfg.hooks.SessionEnd, 'a SessionEnd event group exists');
  const cmds = JSON.stringify(cfg.hooks.SessionEnd);
  assert.match(cmds, /memory-synth-spawn\.cjs/, 'SessionEnd launches the spawn hook');
  assert.match(cmds, /\$CLAUDE_PROJECT_DIR/, 'the command is anchored to $CLAUDE_PROJECT_DIR (house style)');
});

test('the existing SessionStart → session-start wiring is untouched', () => {
  const cfg = settingsJSON();
  const cmds = JSON.stringify(cfg.hooks.SessionStart);
  assert.match(cmds, /session-start\.cjs/, 'SessionStart still runs the orientation hook');
});

// ── the spawn hook actually lands in a fresh install (end-to-end managed copy) ──

test('a fresh install carries the spawn hook on disk and wires SessionEnd', () => {
  const target = tmp('wrxn-synth-wire-install-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(
    fs.existsSync(path.join(target, '.claude', 'hooks', 'memory-synth-spawn.cjs')),
    'the spawn hook is copied into the install',
  );
  const installed = JSON.parse(fs.readFileSync(path.join(target, '.claude', 'settings.json'), 'utf8'));
  assert.match(JSON.stringify(installed.hooks.SessionEnd), /memory-synth-spawn\.cjs/, 'the install wires SessionEnd');
});
