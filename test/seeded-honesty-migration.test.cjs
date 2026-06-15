'use strict';

// foundation-honesty-06 — seeded-file honesty migration (002).
// Covers migration 002 in isolation (conditional rewrite of the seeded .synapse/routing
// ROUTING_RULE_0 authority line + the seeded docs/agents/domain.md glossary, each gated on the
// known-stale text, idempotent, missing-file-safe) AND end-to-end through `wrxn update` (the
// file-class update SKIPS the present seeded files, so the migration is what fixes a stale install).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');

const MIGRATION_FILE = '002-seeded-honesty.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');

// The shipped honest seeds are the oracle: the migration must bring a stale install to EXACTLY the
// content a new install gets. Read them off the real payload so any drift between the migration's
// frozen constants and the shipped template fails the suite.
const HONEST_DOMAIN = fs.readFileSync(path.join(PKG_ROOT, 'payload', 'docs', 'agents', 'domain.md'), 'utf8');
const HONEST_ROUTING_LINE = fs.readFileSync(path.join(PKG_ROOT, 'payload', '.synapse', 'routing'), 'utf8')
  .split('\n').find((l) => l.startsWith('ROUTING_RULE_0='));

// The known-stale seeds a pre-0.2.1 install still carries on disk (the migration gates on these).
const STALE_RULE0 =
  'ROUTING_RULE_0=git push, PR creation, and release tags go through the devops role only — delegate, never run them directly.';
const STALE_DOMAIN = '# Domain Docs\n\nSee CONTEXT-MAP.md for the squad layout under aiox-core/.\n';

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A throwaway kernel package at `version`, carrying the supplied migration files (mirrors recon test).
function fakePkg(work, version, migrations) {
  const dir = path.join(work, 'pkg-' + version + '-' + Math.floor(version.length * 7 + (migrations ? migrations.length : 0)));
  fs.cpSync(path.join(PKG_ROOT, 'payload'), path.join(dir, 'payload'), { recursive: true });
  fs.copyFileSync(path.join(PKG_ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wrxn', version }));
  if (migrations) {
    const mdir = path.join(dir, 'migrations');
    fs.mkdirSync(mdir, { recursive: true });
    for (const m of migrations) fs.writeFileSync(path.join(mdir, m.file), m.body);
  }
  return dir;
}

// Lay a `.synapse/routing` with the given ROUTING_RULE_0 line (+ optional extra operator lines), under
// the two comment-header lines and a sibling ROUTING_RULE_1, ending in a trailing newline.
function writeRouting(target, rule0Line, extraLines = []) {
  fs.mkdirSync(path.join(target, '.synapse'), { recursive: true });
  const lines = [
    '# Domain: routing (L6 keyword-recall) — fires only when a trigger word appears in the prompt.',
    '# SEEDED: operator-owned, created once at init, never overwritten on `wrxn update`.',
    rule0Line,
    'ROUTING_RULE_1=A new project is a git worktree, never a bare mkdir.',
    ...extraLines,
  ];
  fs.writeFileSync(path.join(target, '.synapse', 'routing'), lines.join('\n') + '\n');
}

function writeDomain(target, body) {
  fs.mkdirSync(path.join(target, 'docs', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(target, 'docs', 'agents', 'domain.md'), body);
}

function readRouting(target) {
  return fs.readFileSync(path.join(target, '.synapse', 'routing'), 'utf8');
}
function readDomain(target) {
  return fs.readFileSync(path.join(target, 'docs', 'agents', 'domain.md'), 'utf8');
}
function rule0Of(routingText) {
  return routingText.split('\n').find((l) => l.startsWith('ROUTING_RULE_0='));
}

// ── Migration in isolation (require the REAL shipped module, call up() against a fixture) ──

test('migration metadata: id 002 ships with version 0.2.1', () => {
  assert.equal(migration.id, '002');
  assert.equal(migration.version, '0.2.1');
  assert.equal(typeof migration.up, 'function');
});

test('rewrites the stale seeded routing + domain, preserving comments and operator additions', () => {
  const target = tmp('wrxn-h6-stale-');
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator-added: deploy windows are Tuesdays only.']);
  writeDomain(target, STALE_DOMAIN);

  migration.up({ target });

  // routing: ROUTING_RULE_0 is now the honest line; operator + comment lines verbatim; newline kept
  const routing = readRouting(target);
  assert.equal(rule0Of(routing), HONEST_ROUTING_LINE, 'ROUTING_RULE_0 rewritten to the honest line');
  assert.equal(/devops role/.test(routing), false, 'no devops-role authority wording remains');
  assert.match(routing, /^# Domain: routing/m, 'comment header preserved');
  assert.match(routing, /^ROUTING_RULE_1=A new project is a git worktree/m, 'sibling rule preserved');
  assert.match(routing, /^ROUTING_RULE_4=Operator-added: deploy windows are Tuesdays only\.$/m, 'operator ROUTING_RULE_4 preserved');
  assert.ok(routing.endsWith('\n'), 'trailing newline preserved');

  // domain: the honest glossary, dead-context marker gone
  const domain = readDomain(target);
  assert.equal(domain, HONEST_DOMAIN, 'domain.md rewritten to the honest glossary');
  assert.equal(domain.includes('CONTEXT-MAP.md'), false, 'dead-context marker gone');
});

test('no-op when the seeds are already honest (byte-identical)', () => {
  const target = tmp('wrxn-h6-honest-');
  writeRouting(target, HONEST_ROUTING_LINE);
  writeDomain(target, HONEST_DOMAIN);
  const r0 = readRouting(target);
  const d0 = readDomain(target);

  migration.up({ target });

  assert.equal(readRouting(target), r0, 'already-honest routing left byte-identical');
  assert.equal(readDomain(target), d0, 'already-honest domain left byte-identical');
});

test('no-op when the operator customized away from the known-stale strings (byte-identical)', () => {
  const target = tmp('wrxn-h6-custom-');
  // operator rewrote ROUTING_RULE_0 to their own wording (no "devops role") and edited the glossary
  // to drop the CONTEXT-MAP.md marker — neither carries the known-stale text the migration gates on.
  writeRouting(target, 'ROUTING_RULE_0=Our team ships releases via the deploy bot; ping #releases first.');
  const customDomain = '# Domain Docs\n\nOur glossary lives in the team wiki.\n';
  writeDomain(target, customDomain);
  const r0 = readRouting(target);
  const d0 = readDomain(target);

  migration.up({ target });

  assert.equal(readRouting(target), r0, 'customized routing left byte-identical');
  assert.equal(readDomain(target), d0, 'customized domain left byte-identical');
});

test('idempotent — a second run changes nothing', () => {
  const target = tmp('wrxn-h6-idem-');
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator note.']);
  writeDomain(target, STALE_DOMAIN);

  migration.up({ target });
  const r1 = readRouting(target);
  const d1 = readDomain(target);

  migration.up({ target }); // markers gone after run 1 → second run is a no-op

  assert.equal(readRouting(target), r1, 'routing unchanged on the 2nd run');
  assert.equal(readDomain(target), d1, 'domain unchanged on the 2nd run');
});

test('does not throw and creates nothing when neither seed exists', () => {
  const target = tmp('wrxn-h6-missing-');
  const before = fs.readdirSync(target).sort();

  assert.doesNotThrow(() => migration.up({ target }));

  assert.deepEqual(fs.readdirSync(target).sort(), before, 'no files created');
  assert.equal(fs.existsSync(path.join(target, '.synapse')), false, 'no .synapse/ created');
  assert.equal(fs.existsSync(path.join(target, 'docs')), false, 'no docs/ created');
});

// ── End-to-end through wrxn update (seeded files skipped by the update → the migration fixes them) ──

test('wrxn update brings a stale legacy install to honest seeds and records 002 (resumable)', () => {
  const work = tmp('wrxn-h6-e2e-');
  const target = fs.mkdtempSync(path.join(work, 'legacy-'));
  // a pre-0.2.1 install carrying the STALE seeded files on disk + a pre-0.2.1 receipt
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.2.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator-added line.']);
  writeDomain(target, STALE_DOMAIN);

  const pkg = fakePkg(work, '0.2.1', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  // recorded + resumable
  assert.ok(report.migrationsRan.includes('002'), 'report.migrationsRan includes 002');
  assert.ok(receiptOf(target).migrationsApplied.includes('002'), 'receipt records 002 applied');

  // both seeded files are now honest (update PRESERVED them as seeded → the migration corrected them)
  assert.equal(rule0Of(readRouting(target)), HONEST_ROUTING_LINE, 'routing ROUTING_RULE_0 honest after update');
  assert.match(readRouting(target), /^ROUTING_RULE_4=Operator-added line\.$/m, 'operator routing line survived');
  assert.equal(readDomain(target), HONEST_DOMAIN, 'domain.md honest after update');

  // re-update at the same version: 002 does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('002'), false, 're-update does not re-run the applied 002');
});
