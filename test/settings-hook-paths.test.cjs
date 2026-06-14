'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const SETTINGS = path.join(PKG_ROOT, 'payload', '.claude', 'settings.json');

// Collect every hook command string across all events in the payload settings.json.
function hookCommands() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const cmds = [];
  for (const groups of Object.values(cfg.hooks || {})) {
    for (const group of groups) {
      for (const hook of group.hooks || []) {
        if (hook.type === 'command') cmds.push(hook.command);
      }
    }
  }
  return cmds;
}

test('payload settings.json is valid JSON with hook commands', () => {
  const cmds = hookCommands();
  assert.ok(cmds.length > 0, 'expected at least one hook command');
});

test('every hook command is anchored to $CLAUDE_PROJECT_DIR', () => {
  for (const cmd of hookCommands()) {
    assert.match(
      cmd,
      /\$CLAUDE_PROJECT_DIR/,
      `hook command not anchored to $CLAUDE_PROJECT_DIR: ${cmd}`
    );
  }
});

test('no hook command uses a bare relative node .claude/hooks/ path', () => {
  for (const cmd of hookCommands()) {
    assert.doesNotMatch(
      cmd,
      /node\s+\.claude\/hooks\//,
      `hook command uses a bare relative path: ${cmd}`
    );
  }
});
