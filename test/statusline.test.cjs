'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
const statusline = require('../lib/statusline.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── the snippet + the canonical payload doc ──────────────────────────────────

test('snippet() carries both markers and the sidecar write', () => {
  const s = statusline.snippet();
  assert.ok(s.includes(statusline.MARKER_START), 'has START marker');
  assert.ok(s.includes(statusline.MARKER_END), 'has END marker');
  // the block is what the reader (synapse-engine readStatuslineWindow) consumes — output shape pinned
  assert.match(s, /\/tmp\/claude-statusline-ctx-\$\{session_id\}\.json/, 'writes the session sidecar file');
  assert.match(s, /"context_window_size":%s/, 'JSON shape matches readStatuslineWindow');
  // marker-bounded: START precedes END, nothing past END
  assert.ok(s.indexOf(statusline.MARKER_START) < s.indexOf(statusline.MARKER_END), 'START before END');
  assert.ok(s.trimEnd().endsWith(statusline.MARKER_END), 'nothing trails the END marker');
});

test('payload doc is the marker-bounded snippet with an explanatory header', () => {
  const doc = fs.readFileSync(statusline.DOC_PATH, 'utf8');
  assert.ok(doc.includes(statusline.MARKER_START) && doc.includes(statusline.MARKER_END), 'doc bears both markers');
  // a header precedes the block, documenting the $input / $session_id assumption
  assert.ok(doc.indexOf('$input') < doc.indexOf(statusline.MARKER_START), 'header documents $input before the block');
  assert.match(doc, /\$session_id/, 'header documents $session_id');
});

test('manifest classifies the statusline doc as managed (project profile)', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === 'docs/statusline-sidecar.sh');
  assert.ok(entry, 'doc is in the manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
});

// ── injectSnippet: append-only + idempotent ──────────────────────────────────

test('injectSnippet appends the block, and running twice yields exactly one block', () => {
  const dir = tmp('wrxn-sl-inject-');
  const script = path.join(dir, 'statusline.sh');
  fs.writeFileSync(script, '#!/usr/bin/env bash\ninput=$(cat)\necho "ctx"\n');

  const first = statusline.injectSnippet(script);
  assert.equal(first.injected, true);

  const second = statusline.injectSnippet(script);
  assert.equal(second.injected, false, 'second inject is a no-op');
  assert.equal(second.reason, 'already-present');

  const body = fs.readFileSync(script, 'utf8');
  const starts = body.split(statusline.MARKER_START).length - 1;
  assert.equal(starts, 1, 'exactly one sidecar block after two injects');
  // append-only: the operator's original lines survive untouched, ahead of the block
  assert.ok(body.indexOf('echo "ctx"') < body.indexOf(statusline.MARKER_START), 'original content preserved before the block');
});

test('injectSnippet refuses a non-existent script (never conjures a statusline)', () => {
  const dir = tmp('wrxn-sl-missing-');
  assert.throws(() => statusline.injectSnippet(path.join(dir, 'nope.sh')), /not found/);
});

// ── detectStatusLine: present / absent / non-bash ────────────────────────────

function homeWithSettings(statusLine) {
  const home = tmp('wrxn-sl-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  const settings = statusLine === undefined ? {} : { statusLine };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return home;
}

test('detectStatusLine resolves a bash <path> command', () => {
  const home = homeWithSettings({ type: 'command', command: 'bash /home/op/.claude/statusline.sh' });
  const d = statusline.detectStatusLine(home);
  assert.equal(d.configured, true);
  assert.equal(d.scriptPath, '/home/op/.claude/statusline.sh');
});

test('detectStatusLine resolves a bare <path> command and expands ~', () => {
  const home = homeWithSettings({ command: '~/.claude/statusline.sh' });
  const d = statusline.detectStatusLine(home);
  assert.equal(d.configured, true);
  assert.equal(d.scriptPath, path.join(home, '.claude/statusline.sh'));
});

test('detectStatusLine reports configured-but-unresolvable for a non-bash command', () => {
  const home = homeWithSettings({ command: 'node /home/op/statusline.js' });
  const d = statusline.detectStatusLine(home);
  assert.equal(d.configured, true);
  assert.equal(d.scriptPath, null, 'a node command cannot be auto-resolved to a shell script');
});

test('detectStatusLine reports absent when no statusLine is configured', () => {
  const home = homeWithSettings(undefined);
  const d = statusline.detectStatusLine(home);
  assert.equal(d.configured, false);
  assert.equal(d.scriptPath, null);
});

test('detectStatusLine fails safe when settings.json is missing or malformed', () => {
  const missing = tmp('wrxn-sl-nohome-');
  assert.equal(statusline.detectStatusLine(missing).configured, false);
  const bad = tmp('wrxn-sl-badhome-');
  fs.mkdirSync(path.join(bad, '.claude'));
  fs.writeFileSync(path.join(bad, '.claude', 'settings.json'), '{ not json');
  assert.equal(statusline.detectStatusLine(bad).configured, false);
});

// ── bin: wrxn statusline ─────────────────────────────────────────────────────

test('wrxn statusline prints the snippet + enable instructions', () => {
  const out = execFileSync('node', [BIN, 'statusline'], { encoding: 'utf8' });
  assert.ok(out.includes(statusline.MARKER_START), 'prints the sidecar block');
  assert.match(out, /Enable: wrxn statusline --inject/);
});

test('wrxn statusline --inject --path appends to the given script idempotently', () => {
  const dir = tmp('wrxn-sl-cli-');
  const script = path.join(dir, 'sl.sh');
  fs.writeFileSync(script, 'input=$(cat)\n');

  execFileSync('node', [BIN, 'statusline', '--inject', '--path', script], { encoding: 'utf8' });
  execFileSync('node', [BIN, 'statusline', '--inject', '--path', script], { encoding: 'utf8' });
  const body = fs.readFileSync(script, 'utf8');
  assert.equal(body.split(statusline.MARKER_START).length - 1, 1, 'CLI inject is idempotent');
});

test('wrxn statusline --inject with no resolvable script exits 2', () => {
  let threw = false;
  const home = homeWithSettings(undefined);
  try {
    execFileSync('node', [BIN, 'statusline', '--inject'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, HOME: home } });
  } catch (err) {
    threw = true;
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /no statusline script/);
  }
  assert.ok(threw, 'inject with nothing to target must exit non-zero');
});

// ── init prints the adopt-hint, and never touches a statusline ───────────────

test('wrxn init prints the SYNAPSE live-window adopt-hint', () => {
  const target = tmp('wrxn-sl-init-');
  const out = execFileSync('node', [BIN, 'init', '--project', '--root', target], { encoding: 'utf8' });
  assert.match(out, /SYNAPSE live-window: run `wrxn statusline` to enable/);
  // init lays the managed doc but writes no statusline anywhere
  assert.ok(fs.existsSync(path.join(target, 'docs', 'statusline-sidecar.sh')), 'managed doc laid');
});
