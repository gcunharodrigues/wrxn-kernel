'use strict';

// Tests for the `wrxn sync` REPORT adapter (sync-04). The adapter discovers recon-wrxn's warm serve
// door, POSTs `recon_drift` (the pure indexed-graph stale set from sync-03), and REPORTS which docs are
// stale + the source symbol that moved. Report only — no writes/regen/re-stamp (those are sync-05/06).
//
// Seams mirror recall-surface.cjs: summarizeDrift is a PURE fn over the parsed door response (no IO);
// driftFromDoor is the IO shell with an INJECTED transport (tests never touch the network); the CLI is
// exercised black-box (stdin/argv -> stdout). Door discovery is the recall-surface contract.
//
// Status contract:
//   warm door + a stale set        -> 'drift'        (AC2 — reports the stale files + moved symbol)
//   warm door + an empty stale set -> 'synced'       (AC3 — "all synced", never manufactures output)
//   cold/dead door, throw, non-200, malformed body -> 'unavailable' (AC5 — fail-soft, never throws)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const SYNC_REL = '.wrxn/sync.cjs';
const SYNC = path.join(PKG_ROOT, 'payload', SYNC_REL);
const sync = require('../payload/.wrxn/sync.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A temp install root carrying the wrxn.install.json the adapter's root resolution walks up to find.
function installRoot(prefix) {
  const root = tmp(prefix);
  fs.writeFileSync(path.join(root, 'wrxn.install.json'), JSON.stringify({ version: '0.0.0' }));
  return root;
}

// A full fresh install (for the manifest/laydown + black-box CLI assertions).
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

// Write the recon-wrxn serve-door discovery file, chmod 0600 (the adapter refuses a loose/planted file).
function writeEndpoint(root, body) {
  const dir = path.join(root, '.recon-wrxn');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'serve-endpoint.json');
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  fs.chmodSync(file, 0o600);
  return file;
}

// A guaranteed-dead pid (spawnSync reaps it before returning).
function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
}

// A recon_drift door body: a stale set + an optional unwatermarked bucket (sync-03 AC4/AC5 shape).
function driftBody(over) {
  return JSON.stringify(Object.assign({ stale: [], unwatermarked: [] }, over || {}));
}

const STALE = {
  doc: '.wrxn/wiki/concepts/auth-flow.md',
  symbol: 'src/auth.ts#login',
  synced_to: 'a1b2c3d4',
  current: 'e5f6a7b8',
};

function runCli(target, args) {
  return execFileSync('node', [path.join(target, SYNC_REL), ...args, '--root', target], { encoding: 'utf8' });
}

// ── summarizeDrift — the PURE report fn ───────────────────────────────────────

test('summarizeDrift: a stale entry → status "drift", naming the doc + moved symbol + synced_to vs current (AC2)', () => {
  const out = sync.summarizeDrift({ stale: [STALE], unwatermarked: [] });
  assert.equal(out.status, 'drift');
  assert.equal(out.stale.length, 1);
  assert.equal(out.stale[0].doc, '.wrxn/wiki/concepts/auth-flow.md', 'the stale doc page');
  assert.equal(out.stale[0].symbol, 'src/auth.ts#login', 'the source symbol that moved');
  assert.equal(out.stale[0].synced_to, 'a1b2c3d4', 'the watermark it was last reconciled at');
  assert.equal(out.stale[0].current, 'e5f6a7b8', 'the current source fingerprint');
});

test('summarizeDrift: an empty stale set → status "synced", no manufactured rows (AC3)', () => {
  const out = sync.summarizeDrift({ stale: [], unwatermarked: [] });
  assert.equal(out.status, 'synced');
  assert.deepEqual(out.stale, [], 'no stale rows invented');
});

test('summarizeDrift: a malformed / non-object response does not throw and reports synced (robustness)', () => {
  assert.equal(sync.summarizeDrift(null).status, 'synced');
  assert.equal(sync.summarizeDrift(undefined).status, 'synced');
  assert.equal(sync.summarizeDrift({}).status, 'synced');
  assert.equal(sync.summarizeDrift({ stale: 'not-an-array' }).status, 'synced');
});

test('summarizeDrift: passes the unwatermarked bucket through (sync-03 AC5 — distinct, not dropped)', () => {
  const uw = { doc: '.wrxn/wiki/concepts/db.md', symbol: 'src/db.ts#connect' };
  const out = sync.summarizeDrift({ stale: [], unwatermarked: [uw] });
  assert.deepEqual(out.unwatermarked, [uw], 'the unwatermarked bucket survives');
});

// ── driftFromDoor — the IO shell, with an injected transport ──────────────────

test('driftFromDoor: a warm door returning a stale set → "drift"; pins the recon_drift POST contract (AC2)', async () => {
  const root = installRoot('wrxn-sync-warm-');
  writeEndpoint(root, { pid: process.pid, port: 64101 });
  let seen;
  const transport = async (args) => {
    seen = args;
    return { statusCode: 200, body: driftBody({ stale: [STALE] }) };
  };
  const out = await sync.driftFromDoor(root, { transport });
  assert.equal(out.status, 'drift');
  assert.equal(out.stale[0].symbol, 'src/auth.ts#login');
  // cross-repo contract pins (sync-03 AC6): the recon_drift door path + the endpoint port.
  assert.equal(seen.path, '/api/tools/recon_drift', 'POSTs the recon_drift serve door');
  assert.equal(seen.port, 64101, 'uses the port from serve-endpoint.json');
});

test('driftFromDoor: a warm door returning an empty stale set → "synced" (AC3)', async () => {
  const root = installRoot('wrxn-sync-clean-');
  writeEndpoint(root, { pid: process.pid, port: 64102 });
  const transport = async () => ({ statusCode: 200, body: driftBody({ stale: [] }) });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'synced');
});

test('driftFromDoor: no warm door (cold) → "unavailable", transport NEVER called (AC5)', async () => {
  const root = installRoot('wrxn-sync-cold-');
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: driftBody() }; };
  const out = await sync.driftFromDoor(root, { transport: spy });
  assert.equal(out.status, 'unavailable');
  assert.equal(called, false, 'a cold door short-circuits before any network call');
});

test('driftFromDoor: a dead-pid endpoint → "unavailable", transport NEVER called (AC5)', async () => {
  const root = installRoot('wrxn-sync-deadpid-');
  writeEndpoint(root, { pid: deadPid(), port: 64103 });
  let called = false;
  const spy = async () => { called = true; return { statusCode: 200, body: driftBody() }; };
  const out = await sync.driftFromDoor(root, { transport: spy });
  assert.equal(out.status, 'unavailable', 'a dead pid means recon serve is not running');
  assert.equal(called, false);
});

test('driftFromDoor: a transport throw (timeout / connection refused) → "unavailable", never throws (AC5)', async () => {
  const root = installRoot('wrxn-sync-throw-');
  writeEndpoint(root, { pid: process.pid, port: 64104 });
  const transport = async () => { throw new Error('drift door timeout'); };
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

test('driftFromDoor: a non-200 response → "unavailable" (AC5)', async () => {
  const root = installRoot('wrxn-sync-503-');
  writeEndpoint(root, { pid: process.pid, port: 64105 });
  const transport = async () => ({ statusCode: 503, body: 'busy' });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

test('driftFromDoor: a malformed JSON body → "unavailable" (AC5)', async () => {
  const root = installRoot('wrxn-sync-badbody-');
  writeEndpoint(root, { pid: process.pid, port: 64106 });
  const transport = async () => ({ statusCode: 200, body: 'not-json{' });
  assert.equal((await sync.driftFromDoor(root, { transport })).status, 'unavailable');
});

// ── black-box CLI (the `report` subcommand) ───────────────────────────────────

test('black-box: `report` on an install with no warm door exits 0 with status "unavailable" (AC5 fail-soft)', () => {
  const t = freshInstall('wrxn-sync-bb-cold-');
  const out = JSON.parse(runCli(t, ['report']));
  assert.equal(out.status, 'unavailable', 'no recon serve → drift unavailable, never a crash');
});

// ── self-contained: node stdlib only (no kernel-lib / recon import) — AC5 ──────

test('the sync adapter imports nothing outside the node standard library (AC5 install-portable)', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the adapter has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── manifest / laydown (AC1 + AC4) ────────────────────────────────────────────

test('the sync adapter is classified managed/project in the manifest and laid into a fresh install (AC4)', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === SYNC_REL);
  assert.ok(entry, 'sync.cjs in manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-sync-laid-');
  assert.ok(fs.existsSync(path.join(t, SYNC_REL)), 'sync.cjs laid into the install');
});

test('the sync SKILL.md is managed/project, laid, and user-invocable (AC1)', () => {
  const SKILL_REL = '.claude/skills/sync/SKILL.md';
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === SKILL_REL);
  assert.ok(entry, 'sync SKILL.md in manifest');
  assert.equal(entry.class, 'managed');
  assert.equal(entry.profile, 'project');
  const t = freshInstall('wrxn-sync-skill-');
  const skillMd = path.join(t, SKILL_REL);
  assert.ok(fs.existsSync(skillMd), 'sync/SKILL.md laid into the install');
  const body = fs.readFileSync(skillMd, 'utf8');
  assert.match(body, /^---/, 'opens with YAML frontmatter');
  assert.match(body, /name:\s*sync/, 'frontmatter names the skill');
  assert.match(body, /user-invocable:\s*true/, 'the skill is user-invocable');
});

// ── sync-06: prose propose → confirm → re-stamp ───────────────────────────────
// The OTHER half of the sync loop: for a STALE prose doc, the skill DRAFTS a reconciling edit (the
// LLM half — passed IN here as a deterministic test input), the adapter STAGES it by-reference
// (secret-scanned, mirroring dream's stage), then on operator confirm RE-VALIDATES at the write
// boundary and writes the edit IN PLACE + advances the doc's `synced_to:` watermark. DECLINE writes
// nothing. The watermark means "verified fresh", never "stamped without checking".
//
// Split mirrors dream exactly: the drafted reconciling body is a test INPUT (never an LLM call);
// `sync.cjs` gates/writes deterministically. Two phases: propose (stage) → confirm (commit-by-ref).

function writeJson(target, name, obj) {
  const p = path.join(target, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A stale, watermarked prose doc under .wrxn/wiki/ — declares derived_from + a synced_to watermark.
function writeStaleDoc(target, rel, over) {
  const o = Object.assign(
    { derived_from: 'src/auth.ts#login', synced_to: 'a1b2c3d4', body: '# Auth flow\n\nThe original prose, now stale.' },
    over || {}
  );
  const slug = path.basename(rel, '.md');
  const tier = path.basename(path.dirname(rel));
  const page = ['---', `name: ${slug}`, `description: ${slug} notes`, `tier: ${tier}`, `derived_from: ${o.derived_from}`, `synced_to: ${o.synced_to}`, '---', '', o.body, ''].join('\n');
  const full = path.join(target, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, page);
  return full;
}

// A reconciling proposal — the drafted edit + the drift record's fields (doc/symbol/synced_to/current).
function proseProposal(over) {
  return Object.assign(
    {
      doc: '.wrxn/wiki/concepts/auth-flow.md',
      symbol: 'src/auth.ts#login',
      synced_to: 'a1b2c3d4',
      current: 'e5f6a7b8',
      body: '# Auth flow\n\nlogin() now also issues a refresh token alongside the access token.',
    },
    over || {}
  );
}

function propose(target, proposal) {
  return JSON.parse(runCli(target, ['propose', writeJson(target, 'proposal.json', proposal)]));
}

function confirm(target, approved) {
  return JSON.parse(runCli(target, ['confirm', writeJson(target, 'approved.json', approved)]));
}

// Seed .wrxn/sync/staged.jsonl directly (simulate a tampered/stale staging trail for the re-gate probes).
function seedStaged(target, records) {
  const dir = path.join(target, '.wrxn', 'sync');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'staged.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readWatermark(file) {
  const m = /^synced_to:\s*(.*)$/m.exec(fs.readFileSync(file, 'utf8'));
  return m ? m[1].trim() : null;
}

// ── pure transforms (deterministic seams) ────────────────────────────────────

test('restampDoc: advances synced_to to the new fingerprint + swaps in the reconciling body, preserving provenance', () => {
  const content = ['---', 'name: auth-flow', 'tier: concepts', 'derived_from: src/auth.ts#login', 'synced_to: OLD', '---', '', '# Auth flow', '', 'old prose', ''].join('\n');
  const out = sync.restampDoc(content, { body: '# Auth flow\n\nNEW reconciling prose.', current: 'NEWFP' });
  assert.match(out, /^synced_to: NEWFP$/m, 'watermark advanced to the new fingerprint');
  assert.doesNotMatch(out, /synced_to: OLD/, 'old watermark replaced');
  assert.match(out, /derived_from: src\/auth\.ts#login/, 'derived_from provenance preserved');
  assert.match(out, /NEW reconciling prose/, 'body replaced with the reconciling content');
  assert.doesNotMatch(out, /old prose/, 'stale body removed');
});

test('restampDoc: inserts synced_to when the doc carried none (unwatermarked → first stamp)', () => {
  const content = ['---', 'name: x', 'derived_from: lib/x.cjs', '---', '', '# X', '', 'body'].join('\n');
  assert.match(sync.restampDoc(content, { body: '# X\n\nnew', current: 'FP1' }), /^synced_to: FP1$/m);
});

test('restampDoc: a doc with no frontmatter cannot be re-stamped → null (defensive)', () => {
  assert.equal(sync.restampDoc('# Just a body\n\nno frontmatter here', { body: '# x', current: 'fp' }), null);
});

test('secretScan: flags an AWS key, passes clean prose (AC4 primitive, reused from dream)', () => {
  assert.equal(sync.secretScan('# Notes\n\nThe key is AKIAIOSFODNN7EXAMPLE in here'), 'contains_secret');
  assert.equal(sync.secretScan('# Notes\n\nplain reconciling prose, no secrets'), null);
});

test('proposalHash: deterministic for the same content, changes when the body changes (integrity primitive)', () => {
  const a = sync.proposalHash({ doc: 'd', current: 'c', body: 'B' });
  assert.equal(a, sync.proposalHash({ doc: 'd', current: 'c', body: 'B' }), 'same content → same hash');
  assert.notEqual(a, sync.proposalHash({ doc: 'd', current: 'c', body: 'B2' }), 'body change → different hash');
});

// ── AC1: propose stages the drafted edit by-reference (mirrors dream's stage), doc untouched ──

test('propose: stages the reconciling edit by-reference under .wrxn/sync (non-.md); doc UNCHANGED at stage (AC1)', () => {
  const t = freshInstall('wrxn-sync-propose-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', {});
  const before = fs.readFileSync(doc, 'utf8');
  const marker = 'REFRESH-TOKEN-reconcile-marker';
  const out = propose(t, proseProposal({ body: `# Auth flow\n\n${marker}` }));
  assert.equal(out.staged, 1, 'one reconciling edit staged');

  const dir = path.join(t, '.wrxn', 'sync');
  const staged = path.join(dir, 'staged.jsonl');
  assert.ok(fs.existsSync(staged), 'staged.jsonl created');
  // recon walks all of .wrxn and prose-ingests *.md → the staging trail MUST stay non-markdown (mirror dream)
  assert.ok(fs.readdirSync(dir).every((f) => !f.endsWith('.md')), `no .md under .wrxn/sync (got ${fs.readdirSync(dir).join(', ')})`);
  assert.match(fs.readFileSync(staged, 'utf8'), new RegExp(marker), 'the drafted edit persisted by-reference');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'the prose doc is unchanged at propose time (stage never writes)');
});

// ── AC4: the drafted edit is secret-scanned BEFORE staging ─────────────────────

test('propose: a drafted edit containing a secret is REFUSED before staging (AC4)', () => {
  const t = freshInstall('wrxn-sync-secret-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', {});
  const before = fs.readFileSync(doc, 'utf8');
  let err;
  try {
    runCli(t, ['propose', writeJson(t, 'p.json', proseProposal({ body: '# Auth flow\n\nthe token is AKIAIOSFODNN7EXAMPLE keep it safe' }))]);
  } catch (e) { err = e; }
  assert.ok(err, 'propose exited non-zero on a secret');
  assert.match(String(err.stderr || ''), /contains_secret|credential|secret/i);
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'sync', 'staged.jsonl')), 'nothing staged');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'doc untouched');
});

// ── AC2 + AC5: confirm writes in place + advances the watermark, only on approve ──

test('confirm: an approved proposal edits the file in place AND advances the watermark to current (AC2 + AC5)', () => {
  const t = freshInstall('wrxn-sync-confirm-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  propose(t, proseProposal({ synced_to: 'a1b2c3d4', current: 'e5f6a7b8', body: '# Auth flow\n\nlogin now issues a refresh token.' }));
  // AC5: staging did NOT advance the watermark — it advances ONLY as part of a confirmed write
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'staging did NOT advance the watermark');

  const out = confirm(t, ['.wrxn/wiki/concepts/auth-flow.md']);
  assert.equal(out.written.length, 1, 'the approved edit was written');
  const after = fs.readFileSync(doc, 'utf8');
  assert.match(after, /login now issues a refresh token/, 'body reconciled in place');
  assert.equal(readWatermark(doc), 'e5f6a7b8', 'watermark advanced to the source current fingerprint (AC5)');
  assert.match(after, /derived_from: src\/auth\.ts#login/, 'derived_from provenance preserved');
});

// ── AC2: a TAMPERED staged proposal cannot write (integrity re-check at the write boundary) ──

test('confirm: a TAMPERED staged proposal (hash mismatch) cannot write — file + watermark unchanged (AC2)', () => {
  const t = freshInstall('wrxn-sync-tamper-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  const before = fs.readFileSync(doc, 'utf8');
  const docRel = '.wrxn/wiki/concepts/auth-flow.md';
  // a staged record whose body was altered AFTER staging: the hash still binds the ORIGINAL drafted body
  const honestHash = sync.proposalHash({ doc: docRel, current: 'e5f6a7b8', body: '# Auth flow\n\nORIGINAL drafted prose.' });
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: docRel, synced_to: 'a1b2c3d4', current: 'e5f6a7b8', body: '# Auth flow\n\nTAMPERED injected prose.', hash: honestHash }]);

  const out = confirm(t, [docRel]);
  assert.equal(out.written.length, 0, 'the tampered proposal was blocked at the write boundary');
  assert.equal(out.skipped[0].reason, 'integrity_mismatch');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'the prose doc is byte-identical (no write)');
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'the watermark did NOT advance');
});

test('confirm: a staged proposal carrying a secret (valid hash) is re-scanned and refused (AC2 write-boundary re-gate)', () => {
  const t = freshInstall('wrxn-sync-confirm-secret-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  const before = fs.readFileSync(doc, 'utf8');
  const docRel = '.wrxn/wiki/concepts/auth-flow.md';
  const body = '# Auth flow\n\ntoken AKIAIOSFODNN7EXAMPLE slipped into the draft';
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: docRel, synced_to: 'a1b2c3d4', current: 'e5f6a7b8', body, hash: sync.proposalHash({ doc: docRel, current: 'e5f6a7b8', body }) }]);

  const out = confirm(t, [docRel]);
  assert.equal(out.written.length, 0, 're-scan at the write boundary blocked the secret');
  assert.equal(out.skipped[0].reason, 'contains_secret');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'no write');
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'watermark unchanged');
});

// ── AC3: decline → file AND watermark both unchanged ──────────────────────────

test('confirm: DECLINE (empty approval) leaves the file AND the watermark unchanged (AC3)', () => {
  const t = freshInstall('wrxn-sync-decline-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  const before = fs.readFileSync(doc, 'utf8');
  propose(t, proseProposal({ synced_to: 'a1b2c3d4', current: 'e5f6a7b8' }));
  const out = confirm(t, { approved: [] }); // the operator declines — nothing approved
  assert.equal(out.written.length, 0, 'nothing written on decline');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'file unchanged on decline (AC3)');
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'watermark unchanged on decline (AC3)');
});

// ── SECURITY: the doc path is constrained to .wrxn/wiki/ — no write outside ────

test('SECURITY: propose refuses a doc path that escapes .wrxn/wiki/', () => {
  const t = freshInstall('wrxn-sync-escape-');
  let err;
  try {
    runCli(t, ['propose', writeJson(t, 'p.json', proseProposal({ doc: '../../etc/evil.md' }))]);
  } catch (e) { err = e; }
  assert.ok(err, 'propose refused an out-of-wiki doc path');
  assert.match(String(err.stderr || ''), /wiki|unsafe|outside|invalid/i);
});

test('SECURITY: confirm re-validates the target path — a seeded out-of-wiki doc is skipped, never written', () => {
  const t = freshInstall('wrxn-sync-escape-commit-');
  const evilRel = '.wrxn/dream/poison.md'; // inside .wrxn but OUTSIDE .wrxn/wiki/
  const body = '# x\n\ny';
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: evilRel, synced_to: 's', current: 'c', body, hash: sync.proposalHash({ doc: evilRel, current: 'c', body }) }]);
  // cwd inside the temp install so any stray relative write lands here (cleaned up), not the repo
  const out = JSON.parse(execFileSync('node', [path.join(t, SYNC_REL), 'confirm', writeJson(t, 'a.json', [evilRel]), '--root', t], { encoding: 'utf8', cwd: t }));
  assert.equal(out.written.length, 0, 'out-of-wiki target refused at the write boundary');
  assert.equal(out.skipped[0].reason, 'unsafe_target');
  assert.ok(!fs.existsSync(path.join(t, evilRel)), 'nothing written outside .wrxn/wiki');
});

// ── the headline demo: propose → confirm; re-run → decline → nothing changes ──

test('DEMO: stale doc → propose → confirm → reconciled + re-stamped; re-run → decline → nothing changes', () => {
  const t = freshInstall('wrxn-sync-demo-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'OLD0001' });

  // round 1: propose → confirm (approve) → reconciled in place + watermark advanced
  propose(t, proseProposal({ synced_to: 'OLD0001', current: 'NEW0002', body: '# Auth flow\n\nReconciled: login now returns a refresh token.' }));
  confirm(t, ['.wrxn/wiki/concepts/auth-flow.md']);
  assert.match(fs.readFileSync(doc, 'utf8'), /Reconciled: login now returns a refresh token/, 'round 1 reconciled the prose');
  assert.equal(readWatermark(doc), 'NEW0002', 'round 1 advanced the watermark after the confirmed write');

  // round 2: propose again → DECLINE → nothing changes
  const snapshot = fs.readFileSync(doc, 'utf8');
  propose(t, proseProposal({ synced_to: 'NEW0002', current: 'NEW0003', body: '# Auth flow\n\nA further drafted change the operator rejects.' }));
  confirm(t, []); // decline
  assert.equal(fs.readFileSync(doc, 'utf8'), snapshot, 'round 2 declined → file unchanged');
  assert.equal(readWatermark(doc), 'NEW0002', 'round 2 declined → watermark unchanged');
});

// ── kernel-wave review fixes: M1 (current write-channel) · L2 (symlink) · L3 (body cap) ──
// Three findings from .scratch/sync/SECURITY-kernel-wave.md. The `body` channel was well-gated; these
// close the parallel holes: `current` is a SECOND write channel (it lands verbatim in the synced_to:
// frontmatter at confirm), the lexical path check follows a planted symlink, and propose had no body cap.

// M1(b): a secret in `current` is refused at propose (current is scanned now, not only body).
test('M1 propose: a secret in "current" is REFUSED before staging — current is a second write channel', () => {
  const t = freshInstall('wrxn-sync-cur-secret-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', {});
  const before = fs.readFileSync(doc, 'utf8');
  let err;
  try {
    // AKIA… is a clean fingerprint SHAPE that is also an AWS key — it must be caught by the secret-scan.
    runCli(t, ['propose', writeJson(t, 'p.json', proseProposal({ current: 'AKIAIOSFODNN7EXAMPLE' }))]);
  } catch (e) { err = e; }
  assert.ok(err, 'propose exited non-zero on a secret in current');
  assert.match(String(err.stderr || ''), /credential|secret/i);
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'sync', 'staged.jsonl')), 'nothing staged');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'doc untouched');
});

// M1(a): a newline/colon in `current` would inject frontmatter/markdown — rejected as malformed at propose.
test('M1 propose: a "current" with a newline or colon is rejected as malformed (kills frontmatter injection)', () => {
  const t = freshInstall('wrxn-sync-cur-malformed-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', {});
  const before = fs.readFileSync(doc, 'utf8');
  for (const bad of ['FP\nINJECTED: x', 'has:colon', 'FP\n---\n\n# evil body']) {
    let err;
    try {
      runCli(t, ['propose', writeJson(t, 'p.json', proseProposal({ current: bad }))]);
    } catch (e) { err = e; }
    assert.ok(err, `propose refused a malformed current ${JSON.stringify(bad)}`);
    assert.match(String(err.stderr || ''), /fingerprint|token|malformed/i);
  }
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'sync', 'staged.jsonl')), 'nothing staged');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'doc untouched');
});

// M1(b) at the write boundary: a seeded staged record (bypassing propose) can't smuggle a secret in current.
test('M1 confirm: a seeded staged record with a secret in "current" is re-scanned and refused — no write, watermark unchanged', () => {
  const t = freshInstall('wrxn-sync-confirm-cur-secret-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  const before = fs.readFileSync(doc, 'utf8');
  const docRel = '.wrxn/wiki/concepts/auth-flow.md';
  const body = '# Auth flow\n\nclean reconciling prose';
  const current = 'AKIAIOSFODNN7EXAMPLE'; // clean shape, but an AWS key
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: docRel, synced_to: 'a1b2c3d4', current, body, hash: sync.proposalHash({ doc: docRel, current, body }) }]);
  const out = confirm(t, [docRel]);
  assert.equal(out.written.length, 0, 'the secret in current blocked the write at the boundary');
  assert.equal(out.skipped[0].reason, 'contains_secret');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'no write');
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'watermark unchanged');
});

// M1(a) at the write boundary: the exact frontmatter-injection payload from the security record is blocked.
test('M1 confirm: a seeded staged record with a newline-injecting "current" is refused — no frontmatter injected', () => {
  const t = freshInstall('wrxn-sync-confirm-cur-inject-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', { synced_to: 'a1b2c3d4' });
  const before = fs.readFileSync(doc, 'utf8');
  const docRel = '.wrxn/wiki/concepts/auth-flow.md';
  const body = '# Auth flow\n\nclean prose';
  const current = 'FP\nINJECTED_KEY: AKIAIOSFODNN7EXAMPLE'; // the security-record exploit: a 2nd frontmatter line
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: docRel, synced_to: 'a1b2c3d4', current, body, hash: sync.proposalHash({ doc: docRel, current, body }) }]);
  const out = confirm(t, [docRel]);
  assert.equal(out.written.length, 0, 'the malformed current blocked the write');
  assert.equal(out.skipped[0].reason, 'malformed_current');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'file byte-identical — no injected frontmatter line');
  assert.equal(readWatermark(doc), 'a1b2c3d4', 'watermark unchanged');
});

// L2: resolveSafeDoc is lexical; confirm must refuse a planted symlink so read+write can't follow it OUT.
test('SECURITY L2: confirm refuses a doc that resolves to a SYMLINK under .wrxn/wiki/ — the link target is untouched', () => {
  const t = freshInstall('wrxn-sync-symlink-');
  // a frontmatter-bearing target OUTSIDE the wiki (so without the fix the symlinked write would escape it)
  const outside = path.join(t, 'outside-target.md');
  const outsideBefore = ['---', 'name: outside', 'synced_to: KEEP', '---', '', '# Outside', '', 'must not be overwritten', ''].join('\n');
  fs.writeFileSync(outside, outsideBefore);
  const linkRel = '.wrxn/wiki/concepts/link.md';
  const linkAbs = path.join(t, linkRel);
  fs.mkdirSync(path.dirname(linkAbs), { recursive: true });
  fs.symlinkSync(outside, linkAbs); // git preserves symlinks → a hostile branch can plant this
  const body = '# Pwned\n\ninjected body';
  const current = 'NEWFP';
  seedStaged(t, [{ ts: 'x', op: 'propose', doc: linkRel, synced_to: 'KEEP', current, body, hash: sync.proposalHash({ doc: linkRel, current, body }) }]);
  const out = confirm(t, [linkRel]);
  assert.equal(out.written.length, 0, 'no write followed the symlink');
  assert.equal(out.skipped[0].reason, 'symlink_target');
  assert.equal(fs.readFileSync(outside, 'utf8'), outsideBefore, 'the symlink target OUTSIDE the wiki is byte-identical (confinement held)');
});

// L3: propose caps the body at dream's BODY_MAX (32000) — dream parity, reject oversize at stage time.
test("L3 propose: a body larger than dream's BODY_MAX is rejected (body_too_large parity)", () => {
  const t = freshInstall('wrxn-sync-bodymax-');
  const doc = writeStaleDoc(t, '.wrxn/wiki/concepts/auth-flow.md', {});
  const before = fs.readFileSync(doc, 'utf8');
  const huge = '# Auth flow\n\n' + 'x'.repeat(32001); // > 32000-char cap
  let err;
  try {
    runCli(t, ['propose', writeJson(t, 'p.json', proseProposal({ body: huge }))]);
  } catch (e) { err = e; }
  assert.ok(err, 'propose refused an over-cap body');
  assert.match(String(err.stderr || ''), /body_too_large|cap|too large|exceed/i);
  assert.ok(!fs.existsSync(path.join(t, '.wrxn', 'sync', 'staged.jsonl')), 'nothing staged');
  assert.equal(fs.readFileSync(doc, 'utf8'), before, 'doc untouched');
});
