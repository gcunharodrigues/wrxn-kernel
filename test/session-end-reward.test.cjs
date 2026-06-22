'use strict';

// Tests for the SessionEnd reward shell (S2 / kernel #13). At session end a thin, FAIL-OPEN hook reads
// the start-HEAD baseline (stamped by session-start) + this session's surfaced set (from
// .wrxn/surfaced.json by session id), derives a GIT-GROUNDED outcome signal, and persists updated
// Beta-Bernoulli counts to the reward sidecar (.wrxn/reward.json) via the shared coalesceSidecar helper.
//
// Per Article III a landed commit is green by construction (the commit gate), so the production signal
// is git-only and cheap: new non-revert commit(s) since baseline ⇒ +1; a `git revert` of this session's
// work ⇒ −1; no new commits ⇒ neutral. The suite is NEVER run in the hook. The pure deriveSignal takes
// the new-commit subjects explicitly so good/neutral/revert are injected directly.
//
// SHADOW: the shell only WRITES counts. It never reads/writes recall ranking — proven by the recall
// no-op test in recall-surface.test.cjs. The git resolver + surfaced-set reader are injected so the
// core is unit-tested with no real repo; one temp-repo integration check exercises the real git path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const shell = require('../payload/.claude/hooks/session-end-reward.cjs');
const sessionStart = require('../payload/.claude/hooks/session-start.cjs');
const HOOK = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'session-end-reward.cjs');
const SETTINGS = path.join(PKG_ROOT, 'payload', '.claude', 'settings.json');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}
const rewardFile = (target) => path.join(target, '.wrxn', 'reward.json');
const baselineFile = (target, sid) => path.join(target, '.wrxn', 'baseline', sid);
const surfacedFile = (target) => path.join(target, '.wrxn', 'surfaced.json');

// ── wiring + shipping: managed payload, registered SessionEnd, self-contained ──────

test('the reward shell imports nothing outside node stdlib + its co-located hook siblings', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    if (m.startsWith('./')) {
      assert.ok(/^\.\/(sidecar|reward)\.cjs$/.test(m), `only the co-located sidecar/reward siblings may be required: ${m}`);
      continue;
    }
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — the shell imports no kernel-lib/recon`);
  }
});

test('the reward shell is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/session-end-reward.cjs');
  assert.ok(entry, 'session-end-reward.cjs is classified in the manifest');
  assert.equal(entry.class, 'managed', 'kernel-owned hook code → managed');
  const target = freshInstall('wrxn-reward-laid-');
  assert.ok(fs.existsSync(path.join(target, '.claude', 'hooks', 'session-end-reward.cjs')), 'the shell is laid into installs');
});

test('the reward shell is registered on SessionEnd ALONGSIDE the memory-synth spawn (not replacing it)', () => {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const cmds = [];
  for (const group of cfg.hooks.SessionEnd || []) for (const h of group.hooks || []) cmds.push(h.command);
  assert.ok(cmds.some((c) => /session-end-reward\.cjs/.test(c)), 'the reward shell is wired on SessionEnd');
  assert.ok(cmds.some((c) => /memory-synth-spawn\.cjs/.test(c)), 'the existing synth-spawn hook is preserved');
  assert.ok(cmds.every((c) => /\$CLAUDE_PROJECT_DIR/.test(c)), 'every SessionEnd hook stays anchored to $CLAUDE_PROJECT_DIR');
});

// ── the PURE signal: new non-revert commits ⇒ +1, a revert ⇒ −1, nothing ⇒ neutral ──

test('deriveSignal: new non-revert commit(s) since baseline ⇒ +1 (good)', () => {
  assert.equal(shell.deriveSignal({ newCommits: ['feat: ship the validator'] }), +1);
  assert.equal(shell.deriveSignal({ newCommits: ['fix: a', 'docs: b'] }), +1);
});

test('deriveSignal: no new commits since baseline ⇒ neutral (0)', () => {
  assert.equal(shell.deriveSignal({ newCommits: [] }), 0);
  assert.equal(shell.deriveSignal({ newCommits: null }), 0);
  assert.equal(shell.deriveSignal({}), 0);
});

test('deriveSignal: a git revert among the new commits ⇒ −1 (bad, the session work was corrected)', () => {
  assert.equal(shell.deriveSignal({ newCommits: ['Revert "feat: ship the validator"'] }), -1);
  // a revert anywhere in the new set flips the session bad (the work did not durably hold)
  assert.equal(shell.deriveSignal({ newCommits: ['feat: x', 'Revert "feat: x"'] }), -1);
});

test('deriveSignal is total: garbage never throws and is treated as neutral', () => {
  assert.doesNotThrow(() => shell.deriveSignal(null));
  assert.equal(shell.deriveSignal(null), 0);
  assert.equal(shell.deriveSignal({ newCommits: 'not-an-array' }), 0);
});

// ── the persist core: read baseline + surfaced set → update counts → write sidecar ──
// `run` is the testable core: git facts are injected (no real repo), the surfaced-log is on disk, and it
// persists the updated (s,f) to .wrxn/reward.json via coalesceSidecar.

// Seed a per-session surfaced-log + a baseline marker, then run the shell.
function seed(target, sid, surfaced) {
  fs.mkdirSync(path.dirname(baselineFile(target, sid)), { recursive: true });
  fs.writeFileSync(baselineFile(target, sid), JSON.stringify({ head: 'base000', at: 1 }));
  fs.mkdirSync(path.dirname(surfacedFile(target)), { recursive: true });
  fs.writeFileSync(surfacedFile(target), JSON.stringify({ [sid]: surfaced }, null, 2) + '\n');
}

test('run(+1): credits s for each surfaced page of the session and writes the reward sidecar', () => {
  const target = freshInstall('wrxn-reward-good-');
  seed(target, 'sid-1', ['concepts/a.md', 'gotchas/b.md']);
  const out = shell.run({ payload: { session_id: 'sid-1' }, root: target, gitFacts: { newCommits: ['feat: x'] } });
  assert.deepEqual(out, {}, 'the hook always returns {}');
  const counts = JSON.parse(fs.readFileSync(rewardFile(target), 'utf8'));
  assert.deepEqual(counts, {
    'concepts/a.md': { s: 1, f: 0 },
    'gotchas/b.md': { s: 1, f: 0 },
  });
});

test('run(−1 revert): credits f for each surfaced page (the session work was reverted)', () => {
  const target = freshInstall('wrxn-reward-bad-');
  seed(target, 'sid-2', ['concepts/a.md']);
  shell.run({ payload: { session_id: 'sid-2' }, root: target, gitFacts: { newCommits: ['Revert "feat: x"'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 0, f: 1 } });
});

test('run accumulates onto existing reward counts across sessions', () => {
  const target = freshInstall('wrxn-reward-accum-');
  fs.mkdirSync(path.dirname(rewardFile(target)), { recursive: true });
  fs.writeFileSync(rewardFile(target), JSON.stringify({ 'concepts/a.md': { s: 2, f: 1 } }, null, 2) + '\n');
  seed(target, 'sid-3', ['concepts/a.md']);
  shell.run({ payload: { session_id: 'sid-3' }, root: target, gitFacts: { newCommits: ['fix: y'] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 3, f: 1 } });
});

test('run on a NEUTRAL session (no new commits) writes nothing — counts are unchanged', () => {
  const target = freshInstall('wrxn-reward-neutral-');
  seed(target, 'sid-4', ['concepts/a.md']);
  shell.run({ payload: { session_id: 'sid-4' }, root: target, gitFacts: { newCommits: [] } });
  assert.equal(fs.existsSync(rewardFile(target)), false, 'a neutral session creates no reward sidecar');
});

// ── once per session: a second run for the SAME session does not double-credit ──────

test('run is once-per-session: re-running for the same session does not credit twice', () => {
  const target = freshInstall('wrxn-reward-once-');
  seed(target, 'sid-5', ['concepts/a.md']);
  const facts = { newCommits: ['feat: x'] };
  shell.run({ payload: { session_id: 'sid-5' }, root: target, gitFacts: facts });
  shell.run({ payload: { session_id: 'sid-5' }, root: target, gitFacts: facts }); // SessionEnd fired again
  assert.deepEqual(
    JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')),
    { 'concepts/a.md': { s: 1, f: 0 } },
    'the page is credited exactly once for the session, not twice'
  );
});

// ── rev-F2: the once-per-session guard tracks REAL persistence, not the computed delta ──
// The guard must be armed ONLY when coalesceSidecar actually rewrote the sidecar. If it is armed from the
// mutate's computed delta instead, a refuse/fail AFTER the mutate (secret-scan refusal, unwritable path)
// marks the session rewarded while dropping the counts — the attribution is then silently lost forever.

test('run does NOT arm the once-per-session guard when sidecar persistence FAILS after the mutate (rev-F2)', () => {
  const target = freshInstall('wrxn-reward-revf2-');
  seed(target, 'sid-revf2', ['concepts/a.md']);
  // Force coalesceSidecar to fail the write AFTER the mutate computes a non-empty change: make reward.json a
  // directory so writeFileSync throws (EISDIR) and coalesceSidecar returns false (it did NOT persist).
  fs.mkdirSync(rewardFile(target), { recursive: true });
  assert.doesNotThrow(() => shell.run({ payload: { session_id: 'sid-revf2' }, root: target, gitFacts: { newCommits: ['feat: x'] } }));
  // the guard must reflect what was PERSISTED — a dropped write leaves the session re-creditable next time
  const baseline = JSON.parse(fs.readFileSync(baselineFile(target, 'sid-revf2'), 'utf8'));
  assert.ok(!baseline.rewarded, 'a failed persistence must NOT mark the session rewarded (else attribution is silently lost)');
});

// ── fail-open: missing baseline / corrupt sidecar never throw and never block close ──

test('run with NO baseline marker is a no-op (commits-this-session undefined) — no throw', () => {
  const target = freshInstall('wrxn-reward-nobaseline-');
  fs.mkdirSync(path.dirname(surfacedFile(target)), { recursive: true });
  fs.writeFileSync(surfacedFile(target), JSON.stringify({ 'sid-6': ['concepts/a.md'] }));
  let out;
  assert.doesNotThrow(() => {
    out = shell.run({ payload: { session_id: 'sid-6' }, root: target, gitFacts: { newCommits: ['feat: x'] } });
  });
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(rewardFile(target)), false, 'without a baseline nothing is attributed');
});

test('run with a corrupt reward sidecar leaves it untouched and never throws (fail-open)', () => {
  const target = freshInstall('wrxn-reward-corrupt-');
  seed(target, 'sid-7', ['concepts/a.md']);
  fs.mkdirSync(path.dirname(rewardFile(target)), { recursive: true });
  fs.writeFileSync(rewardFile(target), 'not json{ broken');
  assert.doesNotThrow(() => shell.run({ payload: { session_id: 'sid-7' }, root: target, gitFacts: { newCommits: ['feat: x'] } }));
  assert.equal(fs.readFileSync(rewardFile(target), 'utf8'), 'not json{ broken', 'a corrupt sidecar is never clobbered');
});

test('run with no surfaced pages this session is a silent no-op', () => {
  const target = freshInstall('wrxn-reward-nosurfaced-');
  fs.mkdirSync(path.dirname(baselineFile(target, 'sid-8')), { recursive: true });
  fs.writeFileSync(baselineFile(target, 'sid-8'), JSON.stringify({ head: 'base', at: 1 }));
  // surfaced-log has an entry for ANOTHER session, none for this one
  fs.mkdirSync(path.dirname(surfacedFile(target)), { recursive: true });
  fs.writeFileSync(surfacedFile(target), JSON.stringify({ 'other-sid': ['concepts/z.md'] }));
  shell.run({ payload: { session_id: 'sid-8' }, root: target, gitFacts: { newCommits: ['feat: x'] } });
  assert.equal(fs.existsSync(rewardFile(target)), false);
});

// ── sec-F3: a surfaced value is a JOIN KEY only — never opened as a path ─────────────

test('run treats a surfaced value strictly as a join key (sec-F3): a traversal-shaped value is not opened', () => {
  const target = freshInstall('wrxn-reward-secf3-');
  seed(target, 'sid-9', ['../../etc/passwd', 'concepts/a.md']);
  // It must neither throw nor read the filesystem path — it joins on the key space only.
  assert.doesNotThrow(() => shell.run({ payload: { session_id: 'sid-9' }, root: target, gitFacts: { newCommits: ['feat: x'] } }));
  const counts = JSON.parse(fs.readFileSync(rewardFile(target), 'utf8'));
  // both surfaced keys are credited AS KEYS (the traversal string is just a map key, harmless)
  assert.deepEqual(counts, { '../../etc/passwd': { s: 1, f: 0 }, 'concepts/a.md': { s: 1, f: 0 } });
});

// ── sec-F1: the session id is a FILESYSTEM PATH component for the baseline marker — sanitize it ──
// session-start writes the baseline keyed by the session id and the reward shell reads + stamps it back.
// A raw id like '../../evil' is a traversal surface; both sides must route the id through the SAME safeId,
// so the marker round-trips and the read can never miss what the write wrote (no silent attribution loss).
// The surfaced-log MAP KEY stays RAW (join parity with S1) — only the on-disk path component is sanitized.

test('sec-F1: a traversal session id round-trips through safeId — session-start writes & the reward shell reads/stamps the SAME sanitized baseline, nothing escapes .wrxn/baseline', () => {
  const target = freshInstall('wrxn-reward-secf1-rt-');
  const evil = '../../evil';
  sessionStart.stampStartHead(target, evil, { resolveHead: () => 'cafef00d' }); // session-start stamps the baseline
  fs.mkdirSync(path.dirname(surfacedFile(target)), { recursive: true });
  fs.writeFileSync(surfacedFile(target), JSON.stringify({ [evil]: ['concepts/a.md'] })); // surfaced keyed RAW (S1 join parity)

  shell.run({ payload: { session_id: evil }, root: target, gitFacts: { newCommits: ['feat: x'] } });

  // readBaseline found the SAME sanitized marker session-start wrote → the page is credited (no silent loss)
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 1, f: 0 } });
  // markRewarded stamped the SANITIZED marker (the once-per-session guard rides the sanitized path too)
  const safeMarker = path.join(target, '.wrxn', 'baseline', 'evil');
  assert.equal(JSON.parse(fs.readFileSync(safeMarker, 'utf8')).rewarded, true);
  // and a traversal id never escapes the baseline dir to the install root
  assert.equal(fs.existsSync(path.join(target, 'evil')), false);
});

// ── the entrypoint: invoked as the real SessionEnd harness would (stdin JSON → {} stdout) ──

test('the hook binary emits {} and credits the session when run end-to-end via stdin', () => {
  const target = freshInstall('wrxn-reward-e2e-');
  seed(target, 'sid-e2e', ['concepts/a.md']);
  // a real repo so the binary's own git-facts path resolves; baseline points at its HEAD
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: target, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
  const base = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(baselineFile(target, 'sid-e2e'), JSON.stringify({ head: base, at: 1 }));
  git('commit', '-q', '--allow-empty', '-m', 'feat: shipped this session');

  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 'sid-e2e', cwd: target }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {}, 'the hook returns {}');
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 1, f: 0 } });
});

test('the hook binary fails open ({}) with no install root and writes nothing', () => {
  const orphan = tmp('wrxn-reward-orphan-');
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 'x' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: orphan },
  });
  assert.deepEqual(out.trim() ? JSON.parse(out) : {}, {});
});

// ── sec-F2: the baseline head (read from an on-disk marker that may be corrupt) into git ──
// gitFactsSince interpolates the baseline head into `git log <head>..HEAD`. The head must be sha-SHAPED
// before it can become a git revision — a corrupt / option- / ref-expression-shaped head is rejected to a
// NEUTRAL signal, never handed to git (defense-in-depth: execFile already blocks the shell; this blocks
// ref/option abuse + makes "corrupt baseline ⇒ neutral" explicit rather than relying on git erroring out).

test('gitFactsSince rejects a non-sha-shaped baseline head — a ref-expression/option never becomes a git revision (sec-F2)', () => {
  const target = freshInstall('wrxn-reward-secf2-');
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: target, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  // 'HEAD~1' is a VALID git ref-expression but NOT a sha — if it reached git the range would resolve to ['two'];
  // the guard must reject it to neutral so a corrupt baseline can never silently drive the signal off a live ref.
  assert.deepEqual(shell.gitFactsSince(target, 'HEAD~1'), { newCommits: [] }, 'a non-sha head ⇒ neutral, never used as a git revision');
  // an option-shaped corrupt head is likewise rejected (defense-in-depth)
  assert.deepEqual(shell.gitFactsSince(target, '--all'), { newCommits: [] });
  // a REAL sha still resolves through — the guard is shape-only, not a blanket block
  const base = git('rev-parse', 'HEAD~1').trim();
  assert.deepEqual(shell.gitFactsSince(target, base), { newCommits: ['two'] }, 'a real sha range still works');
});

// ── integration: the real git path over a temp repo (good → +1, then a revert → −1) ──

test('run over a REAL temp repo: a session that committed earns +1, a later revert earns −1 (integration)', () => {
  const target = freshInstall('wrxn-reward-integ-');
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: target, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'seed');
  const baseHead = git('rev-parse', 'HEAD').trim();

  // session-start would have stamped this baseline; do it directly here.
  fs.mkdirSync(path.dirname(baselineFile(target, 'sid-real')), { recursive: true });
  fs.writeFileSync(baselineFile(target, 'sid-real'), JSON.stringify({ head: baseHead, at: 1 }));
  fs.mkdirSync(path.dirname(surfacedFile(target)), { recursive: true });
  fs.writeFileSync(surfacedFile(target), JSON.stringify({ 'sid-real': ['concepts/a.md'] }));

  // the session ships a real commit → the shell gathers git facts from the real repo → +1
  fs.writeFileSync(path.join(target, 'work.txt'), 'shipped\n');
  git('add', 'work.txt');
  git('commit', '-q', '-m', 'feat: ship work');
  shell.run({ payload: { session_id: 'sid-real' }, root: target }); // NO gitFacts → real git path
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 1, f: 0 } }, 'real commit ⇒ +1');

  // a later session reverts that work; its baseline is the post-feat HEAD, and a `git revert` lands ⇒ −1
  const afterFeat = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(baselineFile(target, 'sid-revert'), JSON.stringify({ head: afterFeat, at: 2 }));
  const cur = JSON.parse(fs.readFileSync(surfacedFile(target), 'utf8'));
  cur['sid-revert'] = ['concepts/a.md'];
  fs.writeFileSync(surfacedFile(target), JSON.stringify(cur));
  git('revert', '--no-edit', 'HEAD');
  shell.run({ payload: { session_id: 'sid-revert' }, root: target }); // real git path sees the Revert subject
  assert.deepEqual(JSON.parse(fs.readFileSync(rewardFile(target), 'utf8')), { 'concepts/a.md': { s: 1, f: 1 } }, 'a real revert ⇒ −1');
});
