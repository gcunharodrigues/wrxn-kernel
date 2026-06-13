'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');

const ENGINE = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'synapse-engine.cjs');

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function freshInstall(prefix) {
  const dir = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target: dir });
  return dir;
}

// Run the engine black-box: feed a UserPromptSubmit event on stdin, return the parsed envelope.
// The engine always exits 0 with a JSON envelope (possibly {}) on stdout.
function runEngine(event, env) {
  const out = execFileSync('node', [ENGINE], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return out.trim() ? JSON.parse(out) : {};
}

// Convenience: the additionalContext string the engine injects, or '' when it no-ops.
function inject(event, env) {
  const env2 = runEngine(event, env);
  return (env2.hookSpecificOutput && env2.hookSpecificOutput.additionalContext) || '';
}

// ── 06a engine core: layer assembly + envelope + budget governor ───────────────

test('injects the constitution + global + pipeline layers in a synapse-rules block', () => {
  const root = freshInstall('wrxn-syn-layers-');
  const env = runEngine(
    { prompt: 'do a thing', cwd: root },
    { CLAUDE_PROJECT_DIR: root }
  );
  assert.equal(env.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = env.hookSpecificOutput.additionalContext;
  assert.match(ctx, /^<synapse-rules>/);
  assert.match(ctx, /<\/synapse-rules>\s*$/);
  assert.match(ctx, /\[CONSTITUTION\] \(NON-NEGOTIABLE\)/);
  assert.match(ctx, /\[GLOBAL\]/);
  assert.match(ctx, /\[PIPELINE\]/);
});

test('the constitution body is sourced from constitution.md (article text present)', () => {
  const root = freshInstall('wrxn-syn-const-');
  const ctx = inject({ prompt: 'hello', cwd: root }, { CLAUDE_PROJECT_DIR: root });
  // An article heading from payload/.claude/constitution.md.
  assert.match(ctx, /Agent Authority/);
  assert.match(ctx, /No-Invention/);
});

test('budget governor trims over-budget sections with a visible marker, never the constitution', () => {
  const root = freshInstall('wrxn-syn-budget-');
  // A 1-token budget forces every trimmable (non-constitution) section to drop.
  const ctx = inject({ prompt: 'hello', cwd: root }, { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '1' });
  assert.match(ctx, /\[SYNAPSE-RULES-TRIM\]/);
  // Constitution survives (outside the budget); GLOBAL/PIPELINE were trimmed.
  assert.match(ctx, /\[CONSTITUTION\] \(NON-NEGOTIABLE\)/);
  assert.doesNotMatch(ctx, /\[GLOBAL\]/);
});

test('a generous budget keeps every section and emits no trim marker', () => {
  const root = freshInstall('wrxn-syn-nobudget-');
  const ctx = inject({ prompt: 'hello', cwd: root }, { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '100000' });
  assert.match(ctx, /\[GLOBAL\]/);
  assert.match(ctx, /\[PIPELINE\]/);
  assert.doesNotMatch(ctx, /\[SYNAPSE-RULES-TRIM\]/);
});

test('no-op (empty object) when not inside a wrxn install', () => {
  const bare = tmp('wrxn-syn-noinstall-');
  const env = runEngine({ prompt: 'hello', cwd: bare }, { CLAUDE_PROJECT_DIR: bare });
  assert.deepEqual(env, {});
});

test('fail-open (empty object) on unparseable stdin', () => {
  const root = freshInstall('wrxn-syn-badstdin-');
  const out = execFileSync('node', [ENGINE], {
    input: 'not json{{{',
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {});
});

// ── 06b keyword recall: L6 domain fires only on its trigger word ───────────────

test('a keyword-recall domain fires when its trigger word appears in the prompt', () => {
  const root = freshInstall('wrxn-syn-recall-hit-');
  const ctx = inject(
    { prompt: 'how do I deploy this to prod', cwd: root },
    { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[RECALL: routing\]/);
});

test('the same recall domain stays silent when no trigger word is present', () => {
  const root = freshInstall('wrxn-syn-recall-miss-');
  const ctx = inject(
    { prompt: 'explain this function to me', cwd: root },
    { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '100000' }
  );
  assert.doesNotMatch(ctx, /\[RECALL: routing\]/);
  // always-on layers still inject regardless.
  assert.match(ctx, /\[GLOBAL\]/);
});

test('recall matching is case-insensitive', () => {
  const root = freshInstall('wrxn-syn-recall-case-');
  const ctx = inject(
    { prompt: 'Set up a WORKTREE for the new track', cwd: root },
    { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[RECALL: routing\]/);
});

// ── pure-function units (engine is self-contained but exports its internals) ────

const engine = require('../payload/.claude/hooks/synapse-engine.cjs');

test('parseSynapseManifest reads domain flags (KEY=VALUE)', () => {
  const m = engine.parseSynapseManifest(
    'GLOBAL_STATE=active\nGLOBAL_ALWAYS_ON=true\nROUTING_RECALL=deploy,push\n'
  );
  assert.equal(m.GLOBAL.state, 'active');
  assert.equal(m.GLOBAL.alwaysOn, true);
  assert.deepEqual(m.ROUTING.recall, ['deploy', 'push']);
});

test('domainRules extracts <DOMAIN>_RULE_N values in numeric order', () => {
  const rules = engine.domainRules('GLOBAL', 'GLOBAL_RULE_1=b\nGLOBAL_RULE_0=a\nGLOBAL_RULE_10=c\n');
  assert.deepEqual(rules, ['a', 'b', 'c']);
});

test('estimateTokens approximates chars/4', () => {
  assert.equal(engine.estimateTokens('a'.repeat(40)), 10);
});
