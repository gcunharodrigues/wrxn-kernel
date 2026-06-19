'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { execFileSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'bin', 'wrxn.cjs');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const ci = require('../lib/ci-checks.cjs');

function freshInstall(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  init({ pkgRoot: PKG_ROOT, target: dir });
  return dir;
}

function runCli(args) {
  try {
    const stdout = execFileSync('node', [BIN, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
  }
}

// ── managed-integrity ────────────────────────────────────────────────────────

test('managed-integrity passes on a clean fresh install', () => {
  const root = freshInstall('wrxn-ci-mi-clean-');
  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.name, 'managed-integrity');
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('managed-integrity fails when a managed file is drifted, naming it', () => {
  const root = freshInstall('wrxn-ci-mi-drift-');
  fs.writeFileSync(path.join(root, '.claude/constitution.md'), 'TAMPERED — not the kernel content\n');
  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /constitution\.md/.test(f)), r.failures.join('; '));
});

test('managed-integrity fails when a managed file is deleted from the install', () => {
  const root = freshInstall('wrxn-ci-mi-del-');
  fs.rmSync(path.join(root, '.claude/hooks/wiki-lint.cjs'));
  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /wiki-lint\.cjs/.test(f) && /missing/.test(f)), r.failures.join('; '));
});

test('managed-integrity exempts the operator-merged .mcp.json from byte-equality', () => {
  const root = freshInstall('wrxn-ci-mi-mcp-');
  // Simulate the real merge outcome: the operator's own MCP server lives alongside recon-wrxn, so
  // .mcp.json (class managed) legitimately diverges from the payload copy. It must NOT read as drift.
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  mcp.mcpServers.myOwnTool = { command: 'node', args: ['my-tool.js'] };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('managed-integrity passes (no-op) on a non-install dir with no receipt', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-ci-mi-bare-'));
  const r = ci.managedIntegrity(bare, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, true);
});

test('managed-integrity anchors the managed SET to the manifest, not the receipt — dropping a receipt entry cannot hide drift (CF-2)', () => {
  const root = freshInstall('wrxn-ci-mi-cf2-drop-');
  // Tamper a managed file AND drop its entry from the unprotected receipt. The OLD receipt-scoped check
  // derived its set from receipt.files, so it would skip the dropped entry and pass; the manifest-anchored
  // check (the kernel source of truth) still catches the drift.
  fs.writeFileSync(path.join(root, '.claude/constitution.md'), 'TAMPERED — receipt entry dropped\n');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
  receipt.files = receipt.files.filter((f) => f.path !== '.claude/constitution.md');
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify(receipt, null, 2) + '\n');

  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false, 'manifest-anchored check still catches the drift after the receipt entry is dropped');
  assert.ok(r.failures.some((f) => /constitution\.md/.test(f)), r.failures.join('; '));
});

test('managed-integrity catches a drifted managed file even if the receipt PROFILE is flipped to hide it (CF-2 defense-in-depth)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-ci-mi-cf2-profile-'));
  init({ pkgRoot: PKG_ROOT, target: root, profile: 'workspace' });
  // Tamper a workspace-only managed file, then flip the receipt profile to project — which would drop
  // workspace files from a profile-filtered set. The file is still ON DISK, so it must still be verified.
  const wsManaged = '.claude/skills/audit/SKILL.md';
  fs.writeFileSync(path.join(root, wsManaged), 'TAMPERED workspace-managed file\n');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
  receipt.profile = 'project';
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify(receipt, null, 2) + '\n');

  const r = ci.managedIntegrity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false, 'a present, drifted managed file is caught regardless of the claimed profile');
  assert.ok(r.failures.some((f) => /audit\/SKILL\.md/.test(f)), r.failures.join('; '));
});

// ── wiki-lint ─────────────────────────────────────────────────────────────────

test('wiki-lint passes on a clean install (empty wiki tiers)', () => {
  const root = freshInstall('wrxn-ci-wiki-clean-');
  const r = ci.wikiLint(root);
  assert.equal(r.name, 'wiki-lint');
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('wiki-lint fails on a malformed wiki page, naming it', () => {
  const root = freshInstall('wrxn-ci-wiki-bad-');
  const conceptsDir = path.join(root, '.wrxn/wiki/concepts');
  fs.mkdirSync(conceptsDir, { recursive: true });
  // No frontmatter fence at all → malformed.
  fs.writeFileSync(path.join(conceptsDir, 'broken.md'), '# just a heading, no frontmatter\n');
  const r = ci.wikiLint(root);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /broken\.md/.test(f)), r.failures.join('; '));
});

test('wiki-lint fails on a page missing a required frontmatter key', () => {
  const root = freshInstall('wrxn-ci-wiki-missingkey-');
  const conceptsDir = path.join(root, '.wrxn/wiki/concepts');
  fs.mkdirSync(conceptsDir, { recursive: true });
  // Has a fence + name + tier but no description → malformed (required keys: name/description/tier).
  fs.writeFileSync(path.join(conceptsDir, 'partial.md'), '---\nname: partial\ntier: concepts\n---\nbody\n');
  const r = ci.wikiLint(root);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /partial\.md/.test(f) && /description/.test(f)), r.failures.join('; '));
});

// ── synapse-manifest lint ─────────────────────────────────────────────────────

test('synapse-manifest lint passes on a clean install', () => {
  const root = freshInstall('wrxn-ci-syn-clean-');
  const r = ci.synapseManifestLint(root);
  assert.equal(r.name, 'synapse-manifest');
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('synapse-manifest lint fails when an active domain has no domain file', () => {
  const root = freshInstall('wrxn-ci-syn-nofile-');
  // Declare an active domain with no sibling .synapse/foo rules file → the engine would read nothing.
  fs.appendFileSync(path.join(root, '.synapse/manifest'), '\nFOO_STATE=active\n');
  const r = ci.synapseManifestLint(root);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /FOO/i.test(f)), r.failures.join('; '));
});

test('synapse-manifest lint fails when a declared active domain file is deleted', () => {
  const root = freshInstall('wrxn-ci-syn-del-');
  fs.rmSync(path.join(root, '.synapse/global'));
  const r = ci.synapseManifestLint(root);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /GLOBAL/i.test(f)), r.failures.join('; '));
});

test('synapse-manifest lint fails when the manifest is absent', () => {
  const root = freshInstall('wrxn-ci-syn-nomanifest-');
  fs.rmSync(path.join(root, '.synapse/manifest'));
  const r = ci.synapseManifestLint(root);
  assert.equal(r.ok, false);
});

// ── JSON validity ─────────────────────────────────────────────────────────────

test('json-validity passes on a clean install', () => {
  const root = freshInstall('wrxn-ci-json-clean-');
  const r = ci.jsonValidity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.name, 'json-validity');
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('json-validity fails on a corrupt wrxn-owned JSON file, naming it', () => {
  const root = freshInstall('wrxn-ci-json-bad-');
  fs.writeFileSync(path.join(root, '.recon-wrxn.json'), '{ this is not: valid json,, }');
  const r = ci.jsonValidity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /\.recon-wrxn\.json/.test(f)), r.failures.join('; '));
});

test('json-validity fails on a corrupt install receipt', () => {
  const root = freshInstall('wrxn-ci-json-receipt-');
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), '{ broken');
  const r = ci.jsonValidity(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /wrxn\.install\.json/.test(f)), r.failures.join('; '));
});

// ── node --check syntax ───────────────────────────────────────────────────────

test('node-check passes on a clean install (all wrxn .cjs parse)', () => {
  const root = freshInstall('wrxn-ci-node-clean-');
  const r = ci.nodeCheck(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.name, 'node-check');
  assert.equal(r.ok, true, r.failures.join('; '));
});

test('node-check fails on a .cjs with a syntax error, naming it', () => {
  const root = freshInstall('wrxn-ci-node-bad-');
  fs.writeFileSync(path.join(root, '.claude/hooks/wiki-lint.cjs'), "'use strict';\nconst x = ;\n");
  const r = ci.nodeCheck(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /wiki-lint\.cjs/.test(f)), r.failures.join('; '));
});

// ── runChecks aggregate (the universal gate) ──────────────────────────────────

test('runChecks aggregates all five checks green on a clean install', () => {
  const root = freshInstall('wrxn-ci-agg-clean-');
  const r = ci.runChecks(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((c) => !c.ok)));
  const names = r.results.map((c) => c.name).sort();
  assert.deepEqual(names, ['json-validity', 'managed-integrity', 'node-check', 'synapse-manifest', 'wiki-lint']);
});

// The "never vacuous" guarantee: with NO project suite at all, the universal checks still run and CAN
// fail — a repo whose only "test" is `true` is still really gated.
test('runChecks fails (never vacuous) when a single universal check fails', () => {
  const root = freshInstall('wrxn-ci-agg-fail-');
  fs.writeFileSync(path.join(root, '.claude/constitution.md'), 'TAMPERED\n');
  const r = ci.runChecks(root, { pkgRoot: PKG_ROOT });
  assert.equal(r.ok, false);
  const failed = r.results.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['managed-integrity']);
});

// ── wrxn ci CLI ───────────────────────────────────────────────────────────────

test('wrxn ci exits 0 and reports the gate passing on a clean install', () => {
  const root = freshInstall('wrxn-ci-cli-pass-');
  const r = runCli(['ci', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrxn-ci/);
  assert.match(r.stdout, /pass/i);
});

test('wrxn ci exits 2 and names the failing check on a violation', () => {
  const root = freshInstall('wrxn-ci-cli-fail-');
  fs.writeFileSync(path.join(root, '.claude/constitution.md'), 'TAMPERED\n');
  const r = runCli(['ci', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stdout + r.stderr, /managed-integrity/);
});

// ── the wrxn-ci workflow (structural; not executed in node --test) ─────────────
//
// No js-yaml in the kernel — validate the workflow structurally (valid-YAML heuristics + the required
// keys/anchors), the same approach test/settings-hook-paths.test.cjs uses for the payload settings.
const WORKFLOW = path.join(PKG_ROOT, 'payload', '.github', 'workflows', 'wrxn-ci.yml');

test('wrxn-ci.yml exists and is structurally valid YAML', () => {
  assert.ok(fs.existsSync(WORKFLOW), 'payload/.github/workflows/wrxn-ci.yml missing');
  const body = fs.readFileSync(WORKFLOW, 'utf8');
  // YAML forbids hard tabs for indentation — a tab is the classic invalid-YAML defect.
  assert.doesNotMatch(body, /\t/, 'workflow uses a hard tab (invalid YAML indentation)');
  // the structural anchors a GitHub Actions workflow must carry
  assert.match(body, /^name:\s*wrxn-ci\s*$/m, 'no top-level name: wrxn-ci');
  assert.match(body, /^on:/m, 'no on: trigger block');
  assert.match(body, /^jobs:/m, 'no jobs: block');
});

test('wrxn-ci.yml triggers on pull_request and defines the wrxn-ci job', () => {
  const body = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(body, /pull_request/, 'workflow does not trigger on pull_request');
  assert.match(body, /^\s{2}wrxn-ci:\s*$/m, 'no job named wrxn-ci (the required status check)');
});

test('wrxn-ci.yml invokes the node check path (wrxn ci)', () => {
  const body = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(body, /wrxn ci\b/, 'workflow does not invoke the `wrxn ci` universal checks');
});

test('wrxn-ci.yml runs the project test command but skips the true/empty stub', () => {
  const body = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(body, /WRXN_TEST_CMD/, 'workflow does not reference WRXN_TEST_CMD');
  // the never-vacuous guard: the stub `true`/empty command is skipped, the universal checks still run
  assert.match(body, /!=\s*["']?true["']?/, 'workflow does not skip the `true` stub test command');
});

test('wrxn-ci.yml pins `wrxn ci` to the install receipt kernel version (CF-1, no version-float drift)', () => {
  const body = fs.readFileSync(WORKFLOW, 'utf8');
  // managed-integrity byte-compares against the kernel that LAID the files; floating npx to `latest`
  // reads a version skew as drift. The workflow must read the receipt's kernelVersion and pin to it.
  assert.match(body, /wrxn\.install\.json/, 'workflow does not read the install receipt');
  assert.match(body, /kernelVersion/, 'workflow does not read the receipt kernelVersion');
  assert.match(body, /@gcunharodrigues\/wrxn@"\$VER"/, 'workflow does not pin npx to the receipt version');
});

// ── workflow is a managed payload file (laid by init/update) ───────────────────

test('wrxn-ci.yml is a managed/project payload file in the manifest and is laid on init', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.github/workflows/wrxn-ci.yml');
  assert.ok(entry, '.github/workflows/wrxn-ci.yml is not in the manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');

  const root = freshInstall('wrxn-ci-laydown-');
  assert.ok(
    fs.existsSync(path.join(root, '.github/workflows/wrxn-ci.yml')),
    'init did not lay the wrxn-ci workflow into the install'
  );
});
