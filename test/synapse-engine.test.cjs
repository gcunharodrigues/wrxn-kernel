'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { snippet } = require('../lib/statusline.cjs');

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

test('wrapped multi-line constitution bullets keep their continuation text', () => {
  // A bullet that wraps across two physical lines must not be truncated at the wrap.
  const body = engine.renderConstitution(
    '# Title\n\n## Article I\n\n- it delegates when out of scope and never assumes\n  another agent\'s authority.\n'
  );
  assert.match(body, /never assumes another agent's authority\./);
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

// ── 06c token-base + forced handoff ────────────────────────────────────────────

// Write a transcript JSONL whose last assistant line carries the given usage; return its path.
function writeTranscript(dir, usage) {
  const p = path.join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', usage } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// Write a fake HOME with a .claude.json recording lastModelUsage keys for `cwd`; return the HOME dir.
function fakeHome(prefix, cwd, modelKeys) {
  const home = tmp(prefix);
  const lastModelUsage = {};
  for (const k of modelKeys) lastModelUsage[k] = {};
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ projects: { [cwd]: { lastModelUsage } } })
  );
  return home;
}

// Write the statusline sidecar for a session (the bridge the statusline publishes for hooks); return its path.
function writeSidecar(sid, windowSize) {
  const p = path.join(os.tmpdir(), `claude-statusline-ctx-${sid}.json`);
  fs.writeFileSync(p, JSON.stringify({ context_window_size: windowSize, model_id: 'claude-opus-4-8[1m]' }));
  return p;
}

// resident = input + cache_read + cache_creation (output excluded).
const USAGE_90K = { input_tokens: 80000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000, output_tokens: 5000 };

test('forced handoff fires at >= the threshold (45% of a 200k window)', () => {
  const root = freshInstall('wrxn-syn-ho-fire-');
  const tx = writeTranscript(root, USAGE_90K);
  const home = fakeHome('wrxn-home-200k-', root, ['claude-opus-4-8']); // no [1m] → 200k window
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[HANDOFF REQUIRED\]/);
});

test('the forced-handoff directive carries a dream consolidation nudge — a suggestion, never an auto-run', () => {
  const d = engine.handoffDirective(0.5, 0.4);
  assert.match(d, /\[HANDOFF REQUIRED\]/);   // mirrors the existing directive assertion
  assert.match(d, /dream/i);                 // the dream consolidation reminder rides the directive
  assert.match(d, /suggestion|optional/i);   // … and only suggests — dream is never auto-invoked
});

test('no handoff below the threshold (20% of a 200k window)', () => {
  const root = freshInstall('wrxn-syn-ho-below-');
  const tx = writeTranscript(root, { input_tokens: 40000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9000 });
  const home = fakeHome('wrxn-home-200k2-', root, ['claude-opus-4-8']);
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.doesNotMatch(ctx, /\[HANDOFF REQUIRED\]/);
  assert.match(ctx, /\[CONSTITUTION\]/); // rules still inject
});

test('the [1m] window tag rebases the math (90k of 1M = 9%, no handoff — the original-bug fix)', () => {
  const root = freshInstall('wrxn-syn-ho-1m-');
  const tx = writeTranscript(root, USAGE_90K);
  const home = fakeHome('wrxn-home-1m-', root, ['claude-opus-4-8[1m]']); // [1m] → 1M window
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.doesNotMatch(ctx, /\[HANDOFF REQUIRED\]/);
});

test('WRXN_HANDOFF_PCT overrides the default threshold', () => {
  const root = freshInstall('wrxn-syn-ho-override-');
  const tx = writeTranscript(root, { input_tokens: 50000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  const home = fakeHome('wrxn-home-ov-', root, ['claude-opus-4-8']); // 25% of 200k
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000', WRXN_HANDOFF_PCT: '0.2' }
  );
  assert.match(ctx, /\[HANDOFF REQUIRED\]/); // 25% >= 20%
});

test('no transcript_path → no handoff, rules still inject (silent)', () => {
  const root = freshInstall('wrxn-syn-ho-notx-');
  const ctx = inject(
    { prompt: 'continue', cwd: root },
    { CLAUDE_PROJECT_DIR: root, WRXN_RULES_BUDGET: '100000' }
  );
  assert.doesNotMatch(ctx, /\[HANDOFF REQUIRED\]/);
  assert.match(ctx, /\[GLOBAL\]/);
});

test('readResidentTokens sums input + cache, excludes output', () => {
  const dir = tmp('wrxn-syn-resident-');
  const tx = writeTranscript(dir, USAGE_90K);
  assert.equal(engine.readResidentTokens(tx), 90000);
});

test('modelWindow reads the [1m] tag from ~/.claude.json keys', () => {
  const root = '/some/project';
  const home1m = fakeHome('wrxn-win-1m-', root, ['claude-opus-4-8[1m]']);
  const home200 = fakeHome('wrxn-win-200-', root, ['claude-sonnet-4-6']);
  assert.equal(engine.modelWindow(root, home1m), 1000000);
  assert.equal(engine.modelWindow(root, home200), 200000);
});

// ── 29: explicit WRXN_CONTEXT_WINDOW override precedence ──────────────────────────
// On [1m] sessions lastModelUsage is often empty AND the transcript model id lacks the
// [1m] tag — there is no reliable auto-signal. modelWindow must honor an explicit override.

test('WRXN_CONTEXT_WINDOW env overrides the window regardless of claude.json', () => {
  const root = '/some/project';
  // claude.json says 200k (no [1m] tag) — the env override must win.
  const home200 = fakeHome('wrxn-win-envov-', root, ['claude-opus-4-8']);
  const prev = process.env.WRXN_CONTEXT_WINDOW;
  process.env.WRXN_CONTEXT_WINDOW = '1000000';
  try {
    assert.equal(engine.modelWindow(root, home200), 1000000);
  } finally {
    if (prev === undefined) delete process.env.WRXN_CONTEXT_WINDOW;
    else process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('an invalid/empty WRXN_CONTEXT_WINDOW falls through to auto-detection', () => {
  const root = '/some/project';
  const home1m = fakeHome('wrxn-win-envbad-', root, ['claude-opus-4-8[1m]']);
  const prev = process.env.WRXN_CONTEXT_WINDOW;
  try {
    process.env.WRXN_CONTEXT_WINDOW = 'not-a-number';
    assert.equal(engine.modelWindow(root, home1m), 1000000); // falls through to [1m] auto-detect
    process.env.WRXN_CONTEXT_WINDOW = '0';
    assert.equal(engine.modelWindow(root, home1m), 1000000); // non-positive ignored
    process.env.WRXN_CONTEXT_WINDOW = '';
    assert.equal(engine.modelWindow(root, home1m), 1000000); // empty ignored
  } finally {
    if (prev === undefined) delete process.env.WRXN_CONTEXT_WINDOW;
    else process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('the manifest CONTEXT_WINDOW value is used when no env override is set', () => {
  const root = '/some/project';
  const home200 = fakeHome('wrxn-win-manifest-', root, ['claude-opus-4-8']); // no [1m] → would be 200k
  const prev = process.env.WRXN_CONTEXT_WINDOW;
  delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home200, 'CONTEXT_WINDOW=1000000\n'), 1000000);
  } finally {
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('the [1m] auto-detect still returns 1M when no override is present', () => {
  const root = '/some/project';
  const home1m = fakeHome('wrxn-win-auto1m-', root, ['claude-opus-4-8[1m]']);
  const prev = process.env.WRXN_CONTEXT_WINDOW;
  delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home1m), 1000000);
  } finally {
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('the plain fallback is 200k when no override and no [1m] signal', () => {
  const root = '/some/project';
  const home200 = fakeHome('wrxn-win-fallback-', root, ['claude-opus-4-8']);
  const prev = process.env.WRXN_CONTEXT_WINDOW;
  delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home200), 200000);
  } finally {
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

// ── dynamic statusline sidecar bridge (live window; survives a mid-session /model switch) ──
// Hooks get no model/context-window; the statusline publishes the live window per session and we
// read it here. Precedence: env override > sidecar > manifest > [1m] key > resident-net > 200k.

test('modelWindow reads the live window from the statusline sidecar (beats a 200k claude.json)', () => {
  const root = '/some/project';
  const home200 = fakeHome('wrxn-sc-1m-', root, ['claude-opus-4-8']);
  const sid = 'sess-sc-1m';
  const p = writeSidecar(sid, 1000000);
  const prev = process.env.WRXN_CONTEXT_WINDOW; delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home200, null, sid), 1000000);
  } finally {
    fs.rmSync(p, { force: true });
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('a mid-session switch to a 200k model is reflected (sidecar overrides a stale [1m] claude.json)', () => {
  const root = '/some/project';
  const home1m = fakeHome('wrxn-sc-200-', root, ['claude-opus-4-8[1m]']);
  const sid = 'sess-sc-200';
  const p = writeSidecar(sid, 200000);
  const prev = process.env.WRXN_CONTEXT_WINDOW; delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home1m, null, sid), 200000);
  } finally {
    fs.rmSync(p, { force: true });
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('WRXN_CONTEXT_WINDOW still overrides the sidecar (manual force wins)', () => {
  const root = '/some/project';
  const home200 = fakeHome('wrxn-sc-env-', root, ['claude-opus-4-8']);
  const sid = 'sess-sc-env';
  const p = writeSidecar(sid, 200000);
  const prev = process.env.WRXN_CONTEXT_WINDOW; process.env.WRXN_CONTEXT_WINDOW = '1000000';
  try {
    assert.equal(engine.modelWindow(root, home200, null, sid), 1000000);
  } finally {
    fs.rmSync(p, { force: true });
    if (prev === undefined) delete process.env.WRXN_CONTEXT_WINDOW; else process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('a missing or corrupt sidecar falls through to auto-detection', () => {
  const root = '/some/project';
  const home1m = fakeHome('wrxn-sc-miss-', root, ['claude-opus-4-8[1m]']);
  const prev = process.env.WRXN_CONTEXT_WINDOW; delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home1m, null, 'sess-none'), 1000000);
    const p = path.join(os.tmpdir(), 'claude-statusline-ctx-sess-bad.json');
    fs.writeFileSync(p, 'not json');
    try { assert.equal(engine.modelWindow(root, home1m, null, 'sess-bad'), 1000000); }
    finally { fs.rmSync(p, { force: true }); }
  } finally {
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('the resident-past-200k net returns 1M when no other signal applies', () => {
  const root = '/some/project';
  const home200 = fakeHome('wrxn-net-', root, ['claude-opus-4-8']);
  const prev = process.env.WRXN_CONTEXT_WINDOW; delete process.env.WRXN_CONTEXT_WINDOW;
  try {
    assert.equal(engine.modelWindow(root, home200, null, 'sess-net', 216000), 1000000);
    assert.equal(engine.modelWindow(root, home200, null, 'sess-net', 50000), 200000);
  } finally {
    if (prev !== undefined) process.env.WRXN_CONTEXT_WINDOW = prev;
  }
});

test('readStatuslineWindow returns the size or null', () => {
  const sid = 'sess-direct';
  const p = writeSidecar(sid, 1000000);
  try {
    assert.equal(engine.readStatuslineWindow(sid), 1000000);
    assert.equal(engine.readStatuslineWindow('nope-none'), null);
    assert.equal(engine.readStatuslineWindow(), null);
  } finally { fs.rmSync(p, { force: true }); }
});

// B1 regression: the REAL shell snippet writer and the node reader must resolve the SAME temp dir.
// Both honor $TMPDIR (the writer via ${TMPDIR:-/tmp}, the reader via os.tmpdir()); a hardcoded /tmp
// in the writer silently broke the feature on macOS / any host with $TMPDIR set.
test('the shell snippet writer and readStatuslineWindow agree under a custom $TMPDIR', () => {
  const tdir = tmp('wrxn-tmpdir-');
  const sid = 'b1-regression';
  const input = JSON.stringify({ context_window: { context_window_size: 1000000 }, model: { id: 'claude-opus-4-8[1m]' } });
  const script = `input='${input}'\nsession_id='${sid}'\n${snippet()}`;
  execFileSync('bash', ['-c', script], { env: { ...process.env, TMPDIR: tdir } });
  // the writer must have placed the file under $TMPDIR (not a hardcoded /tmp)
  assert.ok(fs.existsSync(path.join(tdir, `claude-statusline-ctx-${sid}.json`)), 'writer honors $TMPDIR');
  const prevT = process.env.TMPDIR;
  process.env.TMPDIR = tdir;
  try {
    assert.equal(engine.readStatuslineWindow(sid), 1000000); // reader (os.tmpdir) finds the same file
  } finally {
    if (prevT === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevT;
    fs.rmSync(path.join(tdir, `claude-statusline-ctx-${sid}.json`), { force: true });
  }
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

// ── harvest-05: debt-gated harvest nudge in the handoff directive (after dream) ──────
// H5 appends a harvest curation line to [HANDOFF REQUIRED], ordered AFTER the dream line, but ONLY when
// the latest .wrxn/harvest/*.jsonl health-check report carries real debt. The probe is cheap (reads the
// single latest report — never recomputes near-dup / never touches the recon door) and fail-open (any
// fault → no harvest line, no throw, the rest of the directive intact). The cold-door near_dup
// "unavailable" marker is a "couldn't check", NOT debt.

// Write a harvest health-check report (one JSON record per line) under .wrxn/harvest/<name>.
function writeHarvestReport(root, name, records) {
  const dir = path.join(root, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body ? body + '\n' : '');
  return file;
}

const DEBT_REC = { ts: '2026-06-17T10:00:00.000Z', type: 'near_dup', members: [{ slug: 'a' }, { slug: 'b' }], score: 0.9 };
const UNAVAIL_REC = { ts: '2026-06-17T10:00:00.000Z', type: 'near_dup', status: 'unavailable', reason: 'door cold' };

test('handoffDirective appends the harvest line AFTER the dream line when debt is present', () => {
  const d = engine.handoffDirective(0.5, 0.4, true);
  assert.match(d, /\[HANDOFF REQUIRED\]/);
  assert.match(d, /run the dream skill to consolidate/);
  assert.match(d, /run the harvest skill to/);
  assert.ok(d.indexOf('dream skill') < d.indexOf('harvest skill'), 'dream line precedes the harvest line');
});

test('handoffDirective emits NO harvest line when there is no debt (dream line intact)', () => {
  const d = engine.handoffDirective(0.5, 0.4, false);
  assert.match(d, /run the dream skill to consolidate/);
  assert.doesNotMatch(d, /harvest skill/);
});

test('hasCurationDebt is true when the latest report carries a real finding', () => {
  const root = tmp('wrxn-debt-yes-');
  writeHarvestReport(root, '2026-06-17T09-00-00-000Z.jsonl', [DEBT_REC]);
  assert.equal(engine.hasCurationDebt(root), true);
});

test('hasCurationDebt reads only the LATEST report (a newer clean report clears stale debt)', () => {
  const root = tmp('wrxn-debt-latest-');
  writeHarvestReport(root, '2026-06-17T09-00-00-000Z.jsonl', [DEBT_REC]); // older: had debt
  writeHarvestReport(root, '2026-06-17T10-00-00-000Z.jsonl', []);          // newer: clean
  assert.equal(engine.hasCurationDebt(root), false);
});

test('hasCurationDebt is false on a clean tree — empty report, only-unavailable, or no reports dir', () => {
  const a = tmp('wrxn-debt-empty-');
  writeHarvestReport(a, '2026-06-17T09-00-00-000Z.jsonl', []);
  assert.equal(engine.hasCurationDebt(a), false);

  const b = tmp('wrxn-debt-unavail-');
  writeHarvestReport(b, '2026-06-17T09-00-00-000Z.jsonl', [UNAVAIL_REC]); // cold-door marker is NOT debt
  assert.equal(engine.hasCurationDebt(b), false);

  const c = tmp('wrxn-debt-none-'); // no .wrxn/harvest dir at all
  assert.equal(engine.hasCurationDebt(c), false);
});

test('hasCurationDebt is fail-open on a malformed/unreadable report (no throw, no debt)', () => {
  const root = tmp('wrxn-debt-bad-');
  const dir = path.join(root, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-06-17T09-00-00-000Z.jsonl'), 'not json{{{\n{also bad\n');
  assert.doesNotThrow(() => engine.hasCurationDebt(root));
  assert.equal(engine.hasCurationDebt(root), false);
});

test('end-to-end: a handoff with curation debt shows the dream line THEN a harvest line', () => {
  const root = freshInstall('wrxn-ho-debt-');
  const tx = writeTranscript(root, USAGE_90K);
  const home = fakeHome('wrxn-home-debt-', root, ['claude-opus-4-8']); // 45% of 200k → handoff fires
  writeHarvestReport(root, '2026-06-17T09-00-00-000Z.jsonl', [DEBT_REC]);
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[HANDOFF REQUIRED\]/);
  assert.match(ctx, /run the dream skill to consolidate/);
  assert.match(ctx, /run the harvest skill to/);
  assert.ok(ctx.indexOf('dream skill') < ctx.indexOf('harvest skill'), 'dream line precedes the harvest line');
});

test('end-to-end: a handoff on a clean tree shows the dream line and NO harvest line', () => {
  const root = freshInstall('wrxn-ho-clean-');
  const tx = writeTranscript(root, USAGE_90K);
  const home = fakeHome('wrxn-home-clean-', root, ['claude-opus-4-8']);
  // no harvest report written (a fresh install ships only .wrxn/harvest/.gitkeep) → no debt
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[HANDOFF REQUIRED\]/);
  assert.match(ctx, /run the dream skill to consolidate/);
  assert.doesNotMatch(ctx, /harvest skill/);
});

test('end-to-end: a malformed harvest report → handoff intact, dream line, NO harvest line (fail-open)', () => {
  const root = freshInstall('wrxn-ho-badreport-');
  const tx = writeTranscript(root, USAGE_90K);
  const home = fakeHome('wrxn-home-badreport-', root, ['claude-opus-4-8']);
  const dir = path.join(root, '.wrxn', 'harvest');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-06-17T09-00-00-000Z.jsonl'), 'not json{{{\n');
  const ctx = inject(
    { prompt: 'continue', cwd: root, transcript_path: tx },
    { CLAUDE_PROJECT_DIR: root, HOME: home, WRXN_RULES_BUDGET: '100000' }
  );
  assert.match(ctx, /\[HANDOFF REQUIRED\]/);                // directive intact
  assert.match(ctx, /run the dream skill to consolidate/);  // dream line intact
  assert.doesNotMatch(ctx, /harvest skill/);                // malformed report → no debt → no harvest line
});
