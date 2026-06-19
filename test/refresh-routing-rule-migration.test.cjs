'use strict';

// gate-04 — seeded-routing refresh migration (006).
// The install seed `.synapse/routing` is SEEDED (operator-owned), so `wrxn update` never overwrites
// it. An install created (or last refreshed by migration 002) before this release keeps the OLD
// ROUTING_RULE_0 — the retired `WRXN_ACTIVE_AGENT` confirmation-flag dance — forever unless a
// migration refreshes it to the PR + CI + auto-merge model the managed docs already moved to.
// Covers migration 006 in isolation (conditional rewrite of ONLY the ROUTING_RULE_0 line still
// carrying the `WRXN_ACTIVE_AGENT` marker; idempotent; operator-edit-safe; missing/unreadable-safe)
// AND end-to-end through `wrxn update` (the file-class update SKIPS the present seeded routing, so
// the migration is what refreshes a stale install).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { RECEIPT } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const { loadMigrations } = require('../lib/migrate.cjs');

const MIGRATION_FILE = '006-refresh-routing-rule.cjs';
const migration = require('../migrations/' + MIGRATION_FILE);

// The new rule's oracle is the migration's OWN frozen constant (read off the immutable source), like
// 002's routing oracle — a migration is a historical transform, so it must keep delivering ITS OWN
// promise even if the seeded template advances again past this release.
const realMigrationBody = () => fs.readFileSync(path.join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');
// Require NON-empty content ([^']+): the migration source also carries the empty literal
// startsWith('ROUTING_RULE_0=') — the frozen rule constant is the only non-empty single-quoted match.
const NEW_RULE0 = realMigrationBody().match(/'(ROUTING_RULE_0=[^']+)'/)[1];

// The known-stale ROUTING_RULE_0 the 5 existing installs carry on disk: byte-identical to migration
// 002's HONEST_ROUTING_RULE_0 (002 wrote it). The `WRXN_ACTIVE_AGENT` env-flag dance is the marker.
const STALE_RULE0 =
  'ROUTING_RULE_0=git push, PR creation, and release tags are deliberate acts held behind a confirmation flag (anti-accidental-push) — they run only once the session sets WRXN_ACTIVE_AGENT=devops in .claude/settings.local.json; `devops` is a dispatch-phase label, not an authority.';

function tmp(p) {
  return fs.mkdtempSync(path.join(os.tmpdir(), p));
}

// Lay a `.synapse/routing` with the given ROUTING_RULE_0 line (+ optional extra operator lines), under
// the four-line comment header and the sibling ROUTING_RULE_1..3, ending in a trailing newline.
function writeRouting(target, rule0Line, extraLines = []) {
  fs.mkdirSync(path.join(target, '.synapse'), { recursive: true });
  const lines = [
    '# Domain: routing (L6 keyword-recall) — fires only when a trigger word appears in the prompt.',
    '# SEEDED: operator-owned, created once at init, never overwritten on `wrxn update`. This is the',
    '# representative keyword domain — add your own recall rules here, or register more domains in',
    '# .synapse/manifest with a <DOMAIN>_RECALL=word1,word2 line and a sibling .synapse/<domain> file.',
    rule0Line,
    'ROUTING_RULE_1=A new project is a git worktree (e.g. `wrxn init --project` under projects/<slug>), never a bare mkdir.',
    'ROUTING_RULE_2=Deploys: the first `vercel deploy` auto-promotes to production — confirm intent before shipping.',
    'ROUTING_RULE_3=An issue is the unit of work; cut vertical tracer-bullet slices, each independently buildable and walkable.',
    ...extraLines,
  ];
  fs.writeFileSync(path.join(target, '.synapse', 'routing'), lines.join('\n') + '\n');
}

function readRouting(target) {
  return fs.readFileSync(path.join(target, '.synapse', 'routing'), 'utf8');
}
function rule0Of(routingText) {
  return routingText.split('\n').find((l) => l.startsWith('ROUTING_RULE_0='));
}
function receiptOf(target) {
  return JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
}

// A throwaway kernel package at `version`, carrying the supplied migration files (mirrors 002/003 test).
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

// ── Migration in isolation (require the REAL shipped module, call up() against a fixture) ──

test('migration metadata: id 006 ships with version 0.11.0', () => {
  assert.equal(migration.id, '006');
  assert.equal(migration.version, '0.11.0');
  assert.equal(typeof migration.up, 'function');
});

test('rewrites the stale WRXN_ACTIVE_AGENT routing rule, preserving header, siblings, and operator additions', () => {
  const target = tmp('wrxn-r6-stale-');
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator-added: deploy windows are Tuesdays only.']);

  migration.up({ target });

  const routing = readRouting(target);
  assert.equal(rule0Of(routing), NEW_RULE0, 'ROUTING_RULE_0 rewritten to the PR+CI+auto-merge rule');
  assert.equal(/WRXN_ACTIVE_AGENT/.test(routing), false, 'no retired env-flag dance wording remains');
  assert.match(routing, /^# Domain: routing/m, 'comment header preserved');
  assert.match(routing, /^ROUTING_RULE_1=A new project is a git worktree/m, 'sibling rule 1 preserved');
  assert.match(routing, /^ROUTING_RULE_3=An issue is the unit of work/m, 'sibling rule 3 preserved');
  assert.match(routing, /^ROUTING_RULE_4=Operator-added: deploy windows are Tuesdays only\.$/m, 'operator ROUTING_RULE_4 preserved');
  assert.ok(routing.endsWith('\n'), 'trailing newline preserved');
});

test('transcription guard: the frozen rule constant byte-matches the current seeded routing template', () => {
  // Valid while the seeded template still sits at this release. If a later epic advances the template
  // again (as gate-04 advanced it past 002), a successor migration retires THIS one assertion — 006
  // stays frozen and keeps delivering its own constant (the 002 routing precedent).
  const templateRule0 = rule0Of(fs.readFileSync(path.join(PKG_ROOT, 'payload', '.synapse', 'routing'), 'utf8'));
  assert.equal(NEW_RULE0, templateRule0, 'embedded 0.11.0 rule equals the seeded template ROUTING_RULE_0');
});

test('idempotent — a second run changes nothing (marker gone after run 1)', () => {
  const target = tmp('wrxn-r6-idem-');
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator note.']);

  migration.up({ target });
  const after1 = readRouting(target);

  migration.up({ target });

  assert.equal(readRouting(target), after1, 'routing byte-identical on the 2nd run');
});

test('no-op when the routing already carries the new rule (byte-identical)', () => {
  const target = tmp('wrxn-r6-new-');
  writeRouting(target, NEW_RULE0);
  const before = readRouting(target);

  migration.up({ target });

  assert.equal(readRouting(target), before, 'already-refreshed routing left byte-identical');
});

test('no-op when the operator customized ROUTING_RULE_0 away from the marker (byte-identical)', () => {
  const target = tmp('wrxn-r6-custom-');
  // operator rewrote rule 0 to their own doctrine — no WRXN_ACTIVE_AGENT marker to gate on
  writeRouting(target, 'ROUTING_RULE_0=Our team ships releases via the deploy bot; ping #releases first.');
  const before = readRouting(target);

  migration.up({ target });

  assert.equal(readRouting(target), before, 'customized routing left byte-identical');
});

test('the marker in a sibling rule (not ROUTING_RULE_0) is never touched — rewrite is scoped to rule 0', () => {
  const target = tmp('wrxn-r6-sibling-');
  // rule 0 is already the new doctrine; an operator-added rule happens to mention the retired flag.
  writeRouting(target, NEW_RULE0, ['ROUTING_RULE_5=Legacy note: we used to set WRXN_ACTIVE_AGENT=devops by hand.']);
  const before = readRouting(target);

  migration.up({ target });

  assert.equal(readRouting(target), before, 'a WRXN_ACTIVE_AGENT mention outside rule 0 is preserved verbatim');
});

test('a missing .synapse/routing is a no-op — no throw, no file created', () => {
  const target = tmp('wrxn-r6-missing-');
  const before = fs.readdirSync(target).sort();

  assert.doesNotThrow(() => migration.up({ target }));

  assert.deepEqual(fs.readdirSync(target).sort(), before, 'no files created');
  assert.equal(fs.existsSync(path.join(target, '.synapse')), false, 'no .synapse/ created');
});

test('an unreadable routing (a directory at the path) is a clean no-op — never a throw', () => {
  const target = tmp('wrxn-r6-unreadable-');
  // force an fs error on read: existsSync(routingPath) is true, but readFileSync throws EISDIR
  fs.mkdirSync(path.join(target, '.synapse', 'routing'), { recursive: true });

  assert.doesNotThrow(() => migration.up({ target }));
  assert.ok(fs.statSync(path.join(target, '.synapse', 'routing')).isDirectory(), 'the path is left as-is');
});

test('runner contract: 006 loads in id order, immediately after 005', () => {
  const ids = loadMigrations(PKG_ROOT).map((m) => m.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'real migrations load in ascending id order');
  assert.ok(ids.includes('006'), '006 is registered in the package');
  assert.equal(ids.indexOf('006'), ids.indexOf('005') + 1, '006 runs right after 005');
});

// ── End-to-end through wrxn update (the seeded routing is preserved → the migration refreshes it) ──

test('wrxn update refreshes a stale legacy install and records 006 (resumable)', () => {
  const work = tmp('wrxn-r6-e2e-');
  const target = fs.mkdtempSync(path.join(work, 'legacy-'));
  // a pre-0.11.0 install carrying the STALE seeded routing on disk + a pre-0.11.0 receipt
  fs.writeFileSync(
    path.join(target, RECEIPT),
    JSON.stringify({ kernelVersion: '0.10.0', profile: 'project', installs: [] }, null, 2) + '\n',
  );
  writeRouting(target, STALE_RULE0, ['ROUTING_RULE_4=Operator-added line.']);

  const pkg = fakePkg(work, '0.11.0', [{ file: MIGRATION_FILE, body: realMigrationBody() }]);
  const report = update({ pkgRoot: pkg, target });

  // recorded + resumable
  assert.ok(report.migrationsRan.includes('006'), 'report.migrationsRan includes 006');
  assert.ok(receiptOf(target).migrationsApplied.includes('006'), 'receipt records 006 applied');

  // update PRESERVED the seeded routing (operator data) → the migration is what refreshed rule 0
  assert.equal(rule0Of(readRouting(target)), NEW_RULE0, 'routing ROUTING_RULE_0 refreshed after update');
  assert.match(readRouting(target), /^ROUTING_RULE_4=Operator-added line\.$/m, 'operator routing line survived');

  // re-update at the same version: 006 does not re-run
  const second = update({ pkgRoot: pkg, target });
  assert.equal(second.migrationsRan.includes('006'), false, 're-update does not re-run the applied 006');
});
