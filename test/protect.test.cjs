'use strict';

// Tests for `wrxn protect` — the server-side hard gate (gate-redesign gate-02).
// buildRulesetSpec is the pure `gh api` ruleset payload; applyProtection is the idempotent,
// fail-soft create-or-update; originSlug/protectOrigin derive the repo from `origin`.
// The gh/git invoker is injectable so unit tests are deterministic — a REAL mutating `gh api`
// is NEVER issued here (prior art: test/connect.test.cjs, test/ship.test.cjs).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const protect = require('../lib/protect.cjs');
const WRXN = path.join(__dirname, '..', 'bin', 'wrxn.cjs');

// The authoritative wrxn-main-gate payload (gate-02 prompt's API contract — not invented):
// block direct push to the default branch · require a PR with 0 approvals (solo auto-merge) ·
// require the wrxn-ci check, strict (branch up-to-date) · no bypass actor · repo-agnostic via
// ~DEFAULT_BRANCH so the SAME spec protects any default-main repo (incl. recon-wrxn).
const EXPECTED = {
  name: 'wrxn-main-gate',
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'wrxn-ci' }],
      },
    },
  ],
};

// ── buildRulesetSpec: pure, the authoritative payload (every invariant pinned) ──

test('buildRulesetSpec returns the authoritative wrxn-main-gate payload', () => {
  assert.deepEqual(protect.buildRulesetSpec(), EXPECTED);
});

test('buildRulesetSpec: name is wrxn-main-gate, active, branch target, NO bypass actor', () => {
  const spec = protect.buildRulesetSpec();
  assert.equal(spec.name, 'wrxn-main-gate');
  assert.equal(spec.target, 'branch');
  assert.equal(spec.enforcement, 'active');
  assert.deepEqual(spec.bypass_actors, [], 'no bypass actor — the agent (on the operator token) cannot quietly bypass');
});

test('buildRulesetSpec: repo-agnostic — conditions target ~DEFAULT_BRANCH (no hard-coded main)', () => {
  const cond = protect.buildRulesetSpec().conditions.ref_name;
  assert.deepEqual(cond.include, ['~DEFAULT_BRANCH'], 'the SAME spec protects any default-main repo');
  assert.deepEqual(cond.exclude, []);
});

test('buildRulesetSpec: requires a PR with 0 approvals (solo account auto-merges its own PR)', () => {
  const pr = protect.buildRulesetSpec().rules.find((r) => r.type === 'pull_request');
  assert.ok(pr, 'a pull_request rule is present (direct push is blocked)');
  assert.equal(pr.parameters.required_approving_review_count, 0, 'no human approval required (solo auto-merge)');
});

test('buildRulesetSpec: requires the wrxn-ci check, strict (branch up-to-date = race-safety)', () => {
  const rsc = protect.buildRulesetSpec().rules.find((r) => r.type === 'required_status_checks');
  assert.equal(rsc.parameters.strict_required_status_checks_policy, true, 'require-up-to-date serializes merges');
  assert.deepEqual(rsc.parameters.required_status_checks, [{ context: 'wrxn-ci' }]);
});

test('buildRulesetSpec: blocks branch deletion and non-fast-forward', () => {
  const types = protect.buildRulesetSpec().rules.map((r) => r.type);
  assert.ok(types.includes('deletion'));
  assert.ok(types.includes('non_fast_forward'));
});

test('buildRulesetSpec is pure — a fresh, independent object each call (no shared mutation)', () => {
  const a = protect.buildRulesetSpec();
  const b = protect.buildRulesetSpec();
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'distinct object identity per call');
  a.rules.push({ type: 'tampered' });
  a.bypass_actors.push('attacker');
  assert.deepEqual(protect.buildRulesetSpec(), EXPECTED, 'mutating one result never leaks into the next');
});

test('buildRulesetSpec: the required-check context is parameterizable (default wrxn-ci)', () => {
  const rsc = protect.buildRulesetSpec({ requiredCheck: 'ci' }).rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(rsc.parameters.required_status_checks, [{ context: 'ci' }], 'reusable for a repo whose check has another name');
});

// ── applyProtection: idempotent create-or-update by name + fail-soft (fake gh, no real `gh api`) ──

// A deterministic gh stand-in. The list call returns `rulesets`; a `--method` call is the apply.
// `failAll` simulates no-gh/not-authenticated; `failApply` simulates not-a-repo-admin (403 on write).
function fakeGh({ rulesets = [], failAll = false, failApply = false } = {}) {
  const calls = [];
  const invoker = (step) => {
    calls.push(step);
    if (failAll) return { ok: false, status: 1, stdout: '', stderr: 'gh: not authenticated' };
    if (!step.args.includes('--method')) {
      return { ok: true, status: 0, stdout: JSON.stringify(rulesets), stderr: '' }; // the list call
    }
    if (failApply) return { ok: false, status: 1, stdout: '', stderr: 'HTTP 403: must be admin' };
    return { ok: true, status: 0, stdout: JSON.stringify({ id: 999, name: 'wrxn-main-gate' }), stderr: '' };
  };
  return { invoker, calls };
}
const methodOf = (args) => {
  const i = args.indexOf('--method');
  return i >= 0 ? args[i + 1] : 'GET';
};

test('applyProtection creates the ruleset (POST) when none named wrxn-main-gate exists', () => {
  const { invoker, calls } = fakeGh({ rulesets: [] });
  const res = protect.applyProtection({ invoker, slug: 'gcunharodrigues/wrxn-kernel' });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'created');
  const methods = calls.map((c) => methodOf(c.args));
  assert.ok(methods.includes('POST'), 'a POST create was issued');
  assert.ok(!methods.includes('PUT'), 'no PUT when creating');
});

test('applyProtection POSTs the authoritative ruleset body via --input -', () => {
  const { invoker, calls } = fakeGh({ rulesets: [] });
  protect.applyProtection({ invoker, slug: 'gcunharodrigues/wrxn-kernel' });
  const post = calls.find((c) => methodOf(c.args) === 'POST');
  assert.ok(post.input, 'the POST carries the ruleset body on stdin');
  assert.deepEqual(JSON.parse(post.input), protect.buildRulesetSpec(), 'the wire body is the authoritative spec');
  assert.ok(post.args.includes('--input') && post.args.includes('-'), 'body sent via `--input -`');
});

test('applyProtection updates in place (PUT to the existing id) when the ruleset exists — idempotent re-run', () => {
  const { invoker, calls } = fakeGh({ rulesets: [{ id: 7, name: 'something-else' }, { id: 42, name: 'wrxn-main-gate' }] });
  const res = protect.applyProtection({ invoker, slug: 'gcunharodrigues/wrxn-kernel' });
  assert.equal(res.action, 'updated');
  const put = calls.find((c) => methodOf(c.args) === 'PUT');
  assert.ok(put, 'a PUT update was issued');
  assert.ok(put.args.some((a) => a.endsWith('/rulesets/42')), 'PUT targets the existing ruleset id, not a new one');
  assert.ok(!calls.some((c) => methodOf(c.args) === 'POST'), 'no duplicate create on re-run');
});

test('applyProtection fail-soft: no remote (empty slug) → skip WITHOUT calling gh, never throws', () => {
  let called = false;
  const invoker = () => { called = true; return { ok: true, stdout: '[]' }; };
  let res;
  assert.doesNotThrow(() => { res = protect.applyProtection({ invoker, slug: '' }); });
  assert.equal(res.ok, false);
  assert.equal(res.action, 'skipped');
  assert.equal(called, false, 'a remote-less install issues no gh call');
});

test('applyProtection fail-soft: no gh / not authenticated (list errors) → skip, never throws', () => {
  const { invoker } = fakeGh({ failAll: true });
  let res;
  assert.doesNotThrow(() => { res = protect.applyProtection({ invoker, slug: 'o/r' }); });
  assert.equal(res.ok, false);
  assert.equal(res.action, 'skipped');
});

test('applyProtection fail-soft: not a repo admin (create returns non-zero) → skip, never throws', () => {
  const { invoker } = fakeGh({ rulesets: [], failApply: true });
  let res;
  assert.doesNotThrow(() => { res = protect.applyProtection({ invoker, slug: 'o/r' }); });
  assert.equal(res.ok, false);
  assert.equal(res.action, 'skipped');
});

test('applyProtection fail-soft: unparseable gh list output → skip, never throws', () => {
  const invoker = (step) => (step.args.includes('--method')
    ? { ok: true, stdout: '{}' }
    : { ok: true, stdout: 'not json at all' });
  let res;
  assert.doesNotThrow(() => { res = protect.applyProtection({ invoker, slug: 'o/r' }); });
  assert.equal(res.ok, false);
});

test('applyProtection returns a clear reason on a soft skip (the CLI surfaces why)', () => {
  const { invoker } = fakeGh({ failAll: true });
  const res = protect.applyProtection({ invoker, slug: 'o/r' });
  assert.ok(res.reason && res.reason.length > 0, 'a reason is present');
  assert.match(res.reason, /skip|gh|admin|list|remote/i);
});

test('applyProtection is repo-agnostic: the SAME logic protects recon-wrxn (slug + ~DEFAULT_BRANCH)', () => {
  const { invoker, calls } = fakeGh({ rulesets: [] });
  const res = protect.applyProtection({ invoker, slug: 'gcunharodrigues/recon-wrxn' });
  assert.equal(res.action, 'created');
  assert.equal(res.slug, 'gcunharodrigues/recon-wrxn');
  assert.ok(
    calls.every((c) => c.args.some((a) => typeof a === 'string' && a.includes('gcunharodrigues/recon-wrxn'))),
    'every gh call targets the recon-wrxn slug',
  );
  const post = calls.find((c) => methodOf(c.args) === 'POST');
  assert.deepEqual(
    JSON.parse(post.input).conditions.ref_name.include,
    ['~DEFAULT_BRANCH'],
    'protects recon-wrxn’s default branch without naming it',
  );
});

// ── parseSlug: accept ONLY a well-formed owner/repo; reject junk (gate-02 LOW-1, defense-in-depth) ──
// Not exploitable today (gh is spawned via an args array, no shell) but the no-injection guarantee
// must not rest solely on the absence of `shell:true` — a malformed remote fail-soft-skips instead.

test('parseSlug accepts well-formed owner/repo (bare + ssh + https) → owner/repo', () => {
  assert.equal(protect.parseSlug('owner/repo'), 'owner/repo');
  assert.equal(protect.parseSlug('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(protect.parseSlug('https://github.com/owner/repo.git'), 'owner/repo');
});

test('parseSlug rejects junk — .. traversal, spaces/flags, ; $() and backticks → null (LOW-1)', () => {
  const junk = [
    'git@github.com:owner/../../x',          // path traversal segment survives capture as `../x`
    'git@github.com:owner/repo;evil',        // shell metacharacter
    'git@github.com:o/r --method DELETE',    // space + flag-looking text
    'git@github.com:owner/repo$(touch pwned)', // command-substitution syntax
    'git@github.com:owner/repo`id`',         // backticks
  ];
  for (const bad of junk) {
    assert.equal(protect.parseSlug(bad), null, `rejected: ${bad}`);
  }
});

// ── originSlug: derive owner/repo from `origin`, repo-agnostic, fail-soft (injected git) ──

// A git stand-in answering only `git -C <root> remote get-url origin`.
function fakeGit(url, { ok = true } = {}) {
  return ({ args }) => {
    if (args.includes('remote') && args.includes('get-url')) {
      return ok
        ? { ok: true, status: 0, stdout: url + '\n', stderr: '' }
        : { ok: false, status: 2, stdout: '', stderr: "error: No such remote 'origin'" };
    }
    return { ok: false, stdout: '', stderr: 'unexpected git call' };
  };
}

test('originSlug parses an ssh remote (git@github.com:owner/repo.git)', () => {
  assert.equal(
    protect.originSlug('/x', { invoker: fakeGit('git@github.com:gcunharodrigues/wrxn-kernel.git') }),
    'gcunharodrigues/wrxn-kernel',
  );
});

test('originSlug parses an https remote (https://github.com/owner/repo.git)', () => {
  assert.equal(
    protect.originSlug('/x', { invoker: fakeGit('https://github.com/gcunharodrigues/recon-wrxn.git') }),
    'gcunharodrigues/recon-wrxn',
  );
});

test('originSlug parses an https remote without a .git suffix', () => {
  assert.equal(
    protect.originSlug('/x', { invoker: fakeGit('https://github.com/gcunharodrigues/WRXN-OS') }),
    'gcunharodrigues/WRXN-OS',
  );
});

test('originSlug returns null when there is no origin remote (fail-soft)', () => {
  assert.equal(protect.originSlug('/x', { invoker: fakeGit('', { ok: false }) }), null);
});

test('originSlug reads a REAL git origin (real spawn, no gh) and parses the slug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-protect-git-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'git@github.com:fake-owner/fake-repo.git']);
  assert.equal(protect.originSlug(dir), 'fake-owner/fake-repo'); // real defaultInvoke (git only — never gh)
});

test('originSlug returns null on a real repo with NO origin (deterministic no-remote)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-protect-noremote-'));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal(protect.originSlug(dir), null);
});

// ── protectOrigin: derive slug from origin, then apply (the wiring CLI/update/migration share) ──

test('protectOrigin derives the slug from origin and applies the ruleset', () => {
  const gh = fakeGh({ rulesets: [] });
  const res = protect.protectOrigin('/x', {
    gitInvoker: fakeGit('git@github.com:gcunharodrigues/wrxn-kernel.git'),
    ghInvoker: gh.invoker,
  });
  assert.equal(res.action, 'created');
  assert.equal(res.slug, 'gcunharodrigues/wrxn-kernel');
});

test('protectOrigin is a fail-soft no-op when origin is absent (remote-less install) — never calls gh', () => {
  let ghCalled = false;
  const res = protect.protectOrigin('/x', {
    gitInvoker: fakeGit('', { ok: false }),
    ghInvoker: () => { ghCalled = true; return { ok: true, stdout: '[]' }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.action, 'skipped');
  assert.equal(ghCalled, false, 'no gh call when there is no origin');
});

// defaultInvoke: a child that RAN is judged by its EXIT STATUS, not by whether we finished writing its
// stdin (gate-redesign-09). The real `gh api ... --input -` reads the request body from stdin; a stub
// (or a real gh that errors out before draining the body) that does NOT read stdin makes spawnSync's
// stdin write race the child's exit -> EPIPE. spawnSync still captures the child's exit status (0) and
// stdout, so defaultInvoke must honor them, not misreport a successful run as a command-not-found skip.
// This was the full-suite flake: the update-protect stub `gh` does not drain stdin, so under parallel
// load the POST-body write EPIPEd and a real exit-0 apply was surfaced as "protection skipped". A body
// larger than the OS pipe buffer (64KB) forces the EPIPE deterministically -> reproducible every run.

test('defaultInvoke: an stdin-write EPIPE from a child that exited 0 is a SUCCESS, not a skip (gate-09)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-protect-epipe-'));
  // A `gh`-shaped stub that echoes to stdout and exits 0 but NEVER reads stdin (mirrors the
  // update-protect stub, and a real gh that exits before draining the `--input -` body).
  const stub = path.join(dir, 'gh');
  fs.writeFileSync(stub, '#!/bin/sh\necho "{}"\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  const body = 'x'.repeat(200 * 1024); // > 64KB pipe buffer -> the stdin write EPIPEs deterministically
  const r = protect.defaultInvoke({ cmd: stub, args: ['api', '--method', 'POST', '/x', '--input', '-'], input: body });
  assert.equal(r.ok, true, 'a child that exited 0 is a success even when its stdin write EPIPEd');
  assert.equal(r.status, 0, 'the real exit status is honored, not discarded as null');
  assert.match(r.stdout, /\{\}/, 'the child stdout is captured, not thrown away as a command-not-found skip');
});

test('defaultInvoke: a genuinely missing binary (never ran, status null) is still a soft failure', () => {
  const r = protect.defaultInvoke({ cmd: 'definitely-not-a-real-binary-xyz', args: ['api'] });
  assert.equal(r.ok, false, 'an unspawnable command is a failure (the fail-soft skip path is preserved)');
  assert.equal(r.status, null, 'a command that never ran has no exit status');
});

// ── CLI: `wrxn protect` wiring (fail-soft exit 0 — no real `gh api` is issued on a no-remote repo) ──

test('CLI: wrxn protect on a no-remote repo prints a skip and exits 0 (fail-soft wiring)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-protect-cli-'));
  execFileSync('git', ['init', '-q', dir]); // a real repo with NO origin → no slug → no gh call at all
  // execFileSync throws on a non-zero exit; returning stdout IS the exit-0 proof.
  const out = execFileSync('node', [WRXN, 'protect', '--root', dir], { encoding: 'utf8' });
  assert.match(out, /protect/i);
  assert.match(out, /skip/i);
  assert.match(out, /origin|remote/i, 'the skip names the missing origin');
});
