'use strict';

const fs = require('fs');
const path = require('path');

const { loadManifest, inProfile } = require('./manifest.cjs');
const { RECEIPT, MCP_PATH, packageVersion, mergeMcpServer } = require('./install.cjs');
const { compareVersions } = require('./semver.cjs');
const { runMigrations } = require('./migrate.cjs');

/**
 * Pull-based update honoring the three file classes:
 *   - managed → overwritten with the new package version (kernel-owned).
 *   - seeded  → never touched if present (operator-owned); laid only if new in this version.
 *   - state   → never touched if present (project data); created only if new in this version.
 *
 * Refuses a downgrade (installed version newer than the package). Pins the new version in the receipt.
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot absolute path to the new kernel package
 * @param {string} opts.target  absolute path to an existing wrxn install
 * @returns {{ from: string, to: string, updated: Array, preserved: Array }}
 */
function update(opts) {
  const { pkgRoot, target } = opts;

  const receipt = readReceipt(target);
  const from = receipt.kernelVersion;
  const to = packageVersion(pkgRoot);
  const profile = receipt.profile || 'project';

  if (compareVersions(to, from) < 0) {
    throw new Error(`refusing downgrade: install is ${from}, package is the older ${to}`);
  }

  const manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
  const payloadDir = path.join(pkgRoot, 'payload');
  const updated = [];
  const preserved = [];

  // Update only the files of the install's RECORDED profile — a project install never gains
  // workspace files on update (and vice versa is moot: workspace is the superset).
  const files = manifest.files.filter((entry) => inProfile(entry.profile, profile));
  for (const entry of files) {
    const src = path.join(payloadDir, entry.path);
    const dest = path.join(target, entry.path);
    if (!fs.existsSync(src)) {
      throw new Error(`package payload is missing "${entry.path}"`);
    }

    if (entry.class === 'managed') {
      // .mcp.json is managed but operator-shared: an update MUST NOT clobber the operator's other MCP
      // servers (finding N2). When the dest already exists, MERGE just the recon-wrxn key in (same
      // contract as init). A malformed operator file can't be merged → preserve it untouched (never
      // crash, never clobber a hand-written config); an absent dest falls through to a plain lay.
      if (entry.path === MCP_PATH && fs.existsSync(dest)) {
        if (mergeMcpServer(src, dest)) {
          updated.push({ path: entry.path, class: entry.class, merged: true });
        } else {
          preserved.push({ path: entry.path, class: entry.class, reason: 'unparseable-preserved' });
        }
      } else {
        lay(src, dest);
        updated.push({ path: entry.path, class: entry.class });
      }
    } else if (!fs.existsSync(dest)) {
      // seeded/state that did not exist in the prior version → lay it once now
      lay(src, dest);
      updated.push({ path: entry.path, class: entry.class, reason: 'new-in-version' });
    } else {
      preserved.push({ path: entry.path, class: entry.class });
    }
  }

  receipt.kernelVersion = to;
  receipt.profile = profile;
  receipt.files = files.map((f) => ({ path: f.path, class: f.class }));
  receipt.installs = receipt.installs || [];
  receipt.installs.push({ update: { from, to, updatedCount: updated.length, preservedCount: preserved.length } });
  fs.writeFileSync(path.join(target, RECEIPT), JSON.stringify(receipt, null, 2) + '\n');

  // Run pending migrations AFTER the file-class update (they fix up state for the new code). A failing
  // migration throws out of here — the receipt above is already written (version + applied-so-far), so
  // the next `wrxn update` resumes from the failed migration. See lib/migrate.cjs.
  const migrationsRan = runMigrations(pkgRoot, target, { fromVersion: from, toVersion: to });

  return { from, to, updated, preserved, migrationsRan };
}

function readReceipt(target) {
  const p = path.join(target, RECEIPT);
  if (!fs.existsSync(p)) {
    throw new Error(`not a wrxn install (no ${RECEIPT}) — run \`wrxn init\` first`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function lay(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

module.exports = { update, compareVersions };
