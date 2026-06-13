'use strict';

const fs = require('fs');
const path = require('path');

const { RECEIPT } = require('./install.cjs');
const { compareVersions } = require('./semver.cjs');

/**
 * Migration runner — breaking kernel changes ship as ordered scripts that run once per install
 * (PRD US8). A migration file lives in the package `migrations/` dir and exports:
 *   module.exports = { id: '001', version: '0.2.0', up(ctx) { ... } }
 *   - id      : orderable string (files run in id order; default = filename without .cjs).
 *   - version : the release the migration ships with — it runs only once the install reaches it.
 *   - up(ctx) : the migration; ctx = { target, fromVersion, toVersion }. Throw to fail (resumable).
 *
 * Semantics: pending = not-yet-applied AND toVersion >= migration.version, run in id order, each
 * recorded in the receipt's migrationsApplied the instant it succeeds (so a later failure keeps the
 * earlier successes). A throwing migration halts the run and is NOT recorded → the next `wrxn update`
 * resumes from it. Re-running with no pending migrations is a no-op.
 */

/** Load + order the package's migrations. Absent dir → []. */
function loadMigrations(pkgRoot) {
  const dir = path.join(pkgRoot, 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => {
      // eslint-disable-next-line global-require
      const mod = require(path.join(dir, f));
      return {
        id: String(mod.id || f.replace(/\.cjs$/, '')),
        version: String(mod.version || '0.0.0'),
        up: mod.up,
        file: f,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Run the pending migrations against an install. Returns the ids that ran this call.
 * Throws (propagating to the caller) on the first failing migration — the install's receipt then
 * records every migration that succeeded before it, and the failed one stays pending for a resume.
 *
 * @param {string} pkgRoot package root holding migrations/
 * @param {string} target  install root holding the receipt
 * @param {{fromVersion?:string, toVersion?:string}} ctx
 * @returns {string[]} ids run this call (in order)
 */
function runMigrations(pkgRoot, target, ctx = {}) {
  const receiptPath = path.join(target, RECEIPT);
  const applied = new Set(readReceipt(receiptPath).migrationsApplied || []);
  const toVersion = ctx.toVersion || '0.0.0';

  const pending = loadMigrations(pkgRoot).filter(
    (m) => !applied.has(m.id) && compareVersions(toVersion, m.version) >= 0,
  );

  const ran = [];
  for (const m of pending) {
    if (typeof m.up !== 'function') {
      throw new Error(`migration "${m.id}" (${m.file}) has no up() function`);
    }
    try {
      m.up({ target, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion });
    } catch (err) {
      throw new Error(
        `migration "${m.id}" (${m.file}) failed: ${err.message} — resumable: fix it and re-run \`wrxn update\``,
      );
    }
    markApplied(receiptPath, m.id); // persist immediately so a later failure keeps this success
    ran.push(m.id);
  }
  return ran;
}

function readReceipt(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function markApplied(p, id) {
  const r = readReceipt(p);
  r.migrationsApplied = [...new Set([...(r.migrationsApplied || []), id])];
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
}

module.exports = { loadMigrations, runMigrations };
