'use strict';

// Tests for `.wrxn/tracker-target.cjs` — the ONE shared cross-repo tracker resolver behind
// `to-prd --repo`, `to-issues --repo`, and `triage --repo` (PRD #114 / issue #115).
//
// The seam mirrors lib/release-cut.cjs: the decision is a PURE core (resolveTarget — parse / validate /
// select-mechanism), and the gh create/label/close side-effects run through an INJECTED `gh` boundary,
// so the emitted spec is asserted over a recording fake with NO live gh (mirrors release-cut's injected
// `deps`). Prior art: test/release-cut.test.cjs (injected boundary asserted via the emitted spec).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const MODULE = path.join(PKG_ROOT, 'payload', '.wrxn', 'tracker-target.cjs');
const tt = require(MODULE);

// ── resolveTarget is PURE: absent → the install's configured default (local-md, unchanged) ──────

test('resolveTarget: ABSENT --repo (omitted) → the install local-md default, behaves as today (US-4)', () => {
  // `--repo` omitted ⇒ rawRepo is nullish; the install's configured default tracker is local-md.
  assert.deepEqual(tt.resolveTarget(undefined), { mechanism: 'local' });
  assert.deepEqual(tt.resolveTarget(null), { mechanism: 'local' });
});

// ── resolveTarget is PURE: a valid owner/repo → github + the exact gh base args, no remote inference ──

test('resolveTarget: a valid owner/repo → github + ghBaseArgs ["-R", repo], NO git-remote inference (US-1, US-8)', () => {
  assert.deepEqual(tt.resolveTarget('gcunharodrigues/wrxn-kernel'), {
    mechanism: 'github',
    repo: 'gcunharodrigues/wrxn-kernel',
    ghBaseArgs: ['-R', 'gcunharodrigues/wrxn-kernel'],
  });
});

test('resolveTarget: works for any owner/repo — recon-wrxn too, GitHub by construction (US-13)', () => {
  assert.deepEqual(tt.resolveTarget('gcunharodrigues/recon-wrxn'), {
    mechanism: 'github',
    repo: 'gcunharodrigues/recon-wrxn',
    ghBaseArgs: ['-R', 'gcunharodrigues/recon-wrxn'],
  });
});

// ── resolveTarget is PURE: a present-but-malformed --repo refuses LOUD, before any side-effect ──

test('resolveTarget: malformed / empty / trailing / whitespace --repo THROWS loud, pre-publish (US-5)', () => {
  // Each of these is a PRESENT but malformed value (not exactly owner/repo) → loud refusal, no half-file.
  for (const bad of ['', '   ', 'no-slash', 'owner/', '/repo', 'owner/repo/', 'a/b/c', 'owner /repo', 'owner/ repo', ' owner/repo']) {
    assert.throws(
      () => tt.resolveTarget(bad),
      /--repo must be "owner\/repo"/,
      `expected ${JSON.stringify(bad)} to refuse loud`,
    );
  }
});

// ── security chokepoint: the validator is a GitHub-legal ALLOWLIST, not a slash/space blocklist. The 3
// SKILL.md wirings steer the agent to hand-compose `gh -R owner/repo` Bash, so a value carrying a shell
// metacharacter (`;` `$()` `|` backtick) or a leading-`-` (parsed as a gh flag) must refuse HERE, at the
// one chokepoint, BEFORE it can reach that live command. Reviewer/security convergent finding (NB / FIX 1). ──

test('resolveTarget: a --repo carrying a shell metachar or leading dash THROWS (no injection past the gate)', () => {
  const dangerous = [
    'a;id/b',      // command separator
    'a$(id)/b',    // command substitution
    'a`id`/b',     // backtick substitution
    'a|b/c',       // pipe
    'a&b/c',       // background / chain
    'a>b/c',       // redirect
    'a b/c',       // embedded space
    'a/b/c',       // extra path segment
    '-a/b',        // leading dash → gh would read the whole value as a flag (argument injection)
  ];
  for (const bad of dangerous) {
    assert.throws(
      () => tt.resolveTarget(bad),
      /--repo must be "owner\/repo"/,
      `expected ${JSON.stringify(bad)} to refuse loud (injection vector)`,
    );
  }
});

test('resolveTarget: both real cross-repo targets still resolve to github after the allowlist tightening', () => {
  for (const repo of ['gcunharodrigues/wrxn-kernel', 'gcunharodrigues/recon-wrxn']) {
    assert.deepEqual(tt.resolveTarget(repo), { mechanism: 'github', repo, ghBaseArgs: ['-R', repo] });
  }
});

// ── the shared wrxn triage vocab is exactly these three states (a label means the same across repos) ──

test('TRIAGE_LABELS == the shared wrxn vocab: ready-for-agent / backlog / epic (US-7)', () => {
  assert.deepEqual(tt.TRIAGE_LABELS, ['ready-for-agent', 'backlog', 'epic']);
});

// ── publishIssue: the gh side-effect is an INJECTED boundary, asserted via the emitted spec (no live gh) ──

// A recording fake gh runner: captures every argv handed to it; `throws` simulates a gh failure (e.g. the
// target repo lacks the label) so we can assert it is NOT swallowed. Mirrors release-cut's recording deps.
function fakeGh(over = {}) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    if (over.throws) throw over.throws;
    return over.result !== undefined ? over.result : { ok: true };
  };
  fn.calls = calls;
  return fn;
}

test('publishIssue hands the gh boundary the exact `issue create` argv: ghBaseArgs + a vocab --label (US-1, US-6)', () => {
  const target = tt.resolveTarget('gcunharodrigues/wrxn-kernel');
  const gh = fakeGh();
  const res = tt.publishIssue({ target, title: 'Sentinel', body: 'a body', label: 'ready-for-agent' }, gh);

  // exactly one gh call, carrying -R <repo> (NOT remote-inferred) + the title/body + the vocab label.
  assert.deepEqual(gh.calls, [[
    'issue', 'create',
    '-R', 'gcunharodrigues/wrxn-kernel',
    '--title', 'Sentinel',
    '--body', 'a body',
    '--label', 'ready-for-agent',
  ]]);
  assert.deepEqual(res, { ok: true }); // the boundary's return is passed through
});

test('publishIssue REFUSES an off-vocab label LOUD, before any gh call (no silent mis-label) (US-7)', () => {
  const target = tt.resolveTarget('gcunharodrigues/wrxn-kernel');
  const gh = fakeGh();
  assert.throws(
    () => tt.publishIssue({ target, title: 't', body: 'b', label: 'priority-high' }, gh),
    /off the shared wrxn vocab/,
  );
  assert.deepEqual(gh.calls, [], 'an off-vocab label never reaches the gh boundary');
});

test('publishIssue does NOT swallow a gh failure — a target missing the label fails loud (US-6)', () => {
  const target = tt.resolveTarget('gcunharodrigues/wrxn-kernel');
  const boom = new Error("could not add label: 'epic' not found");
  const gh = fakeGh({ throws: boom });
  // the label IS in-vocab, so we reach the boundary; gh then fails on the absent remote label → propagates.
  assert.throws(
    () => tt.publishIssue({ target, title: 't', body: 'b', label: 'epic' }, gh),
    /'epic' not found/,
  );
  assert.equal(gh.calls.length, 1, 'the boundary was invoked (the failure came from gh, not swallowed)');
});

test('publishIssue REFUSES a non-github (local) target loud — there is no gh path for local-md', () => {
  const local = tt.resolveTarget(undefined);
  const gh = fakeGh();
  assert.throws(() => tt.publishIssue({ target: local, title: 't', body: 'b', label: 'backlog' }, gh), /github/i);
  assert.deepEqual(gh.calls, []);
});

// ── the helper ships into installs: it must be registered in the file-class manifest as managed ──
// (the installer refuses any payload file absent from manifest.json — an unlisted helper never lays).

test('tracker-target.cjs is a MANAGED payload entry in manifest.json (so it ships into installs)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.files.find((f) => f.path === '.wrxn/tracker-target.cjs');
  assert.ok(entry, 'manifest.json does not list .wrxn/tracker-target.cjs — it would never lay into an install');
  assert.equal(entry.class, 'managed', 'tracker-target.cjs must be managed (kernel-owned, overwritten on update)');
});

// ── all three skills wire the ONE shared resolver + document the --repo / cross-repo path (US-2/3/12) ──

test('to-prd / to-issues / triage each gain a --repo cross-repo section routing through tracker-target.cjs', () => {
  for (const skill of ['to-prd', 'to-issues', 'triage']) {
    const body = fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, /--repo/, `${skill} SKILL.md does not document --repo`);
    assert.match(body, /tracker-target\.cjs/, `${skill} SKILL.md does not route through the shared tracker-target.cjs`);
    assert.match(body, /ghBaseArgs/, `${skill} SKILL.md does not publish via the resolved ghBaseArgs`);
  }
});

// ── FIX 2: the resolver-call placeholder must instruct OMITTING the arg when there's no --repo. Passing an
// empty string would hit resolveTarget('') → THROW (empty is a present-but-bad value), breaking the
// absent-flag local path (AC#4 "behaves exactly as today"). Only a nullish/omitted arg resolves to local. ──

test('the --repo invocation guidance says OMIT the arg when absent — never pass an empty string (AC#4)', () => {
  for (const skill of ['to-prd', 'to-issues', 'triage']) {
    const body = fs.readFileSync(path.join(PKG_ROOT, 'payload', '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, /omit/i, `${skill} SKILL.md must tell the agent to omit the argument when there is no --repo`);
    assert.doesNotMatch(
      body,
      /empty if no/i,
      `${skill} SKILL.md still tells the agent to pass an empty value — resolveTarget('') THROWS, breaking the local path`,
    );
  }
});

// ── reconciling docs (structural; mirrors release-cut.test.cjs's ADR / CONTEXT checks) ──────────

test('ADR 0011 records the cross-repo --repo targeting decision, closes the ADR-0009 seam, refs #81 AC#4', () => {
  const adr = path.join(PKG_ROOT, 'docs', 'adr', '0011-cross-repo-repo-tracker-targeting.md');
  assert.ok(fs.existsSync(adr), 'ADR 0011 missing');
  const body = fs.readFileSync(adr, 'utf8');
  assert.match(body, /--repo/, 'ADR 0011 does not name the --repo flag');
  assert.match(body, /cross-repo/i, 'ADR 0011 does not record the cross-repo decision');
  assert.match(body, /ADR 0009/, 'ADR 0011 does not record it closes the ADR-0009 seam');
  assert.match(body, /#81\s*AC#4|AC#4/, 'ADR 0011 does not reference #81 AC#4');
  assert.match(body, /tracker-target/, 'ADR 0011 does not name the shared resolver module');
});

test('CONTEXT.md gains the "cross-repo targeting" glossary term', () => {
  const ctx = fs.readFileSync(path.join(PKG_ROOT, 'CONTEXT.md'), 'utf8');
  assert.match(ctx, /\*\*cross-repo targeting\*\*/i, 'no **cross-repo targeting** glossary term');
  assert.match(ctx, /--repo/, 'the cross-repo targeting term does not name the --repo override');
});

test('issue-tracker.md documents the --repo override (default-vs-override behavior)', () => {
  const body = fs.readFileSync(path.join(PKG_ROOT, 'payload', 'docs', 'agents', 'issue-tracker.md'), 'utf8');
  assert.match(body, /--repo/, 'issue-tracker.md does not document the --repo override');
  assert.match(body, /owner\/repo/, 'issue-tracker.md does not show the owner/repo shape');
});
