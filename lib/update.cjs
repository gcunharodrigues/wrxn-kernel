'use strict';

const fs = require('fs');
const path = require('path');

const { loadManifest } = require('./manifest.cjs');
const { RECEIPT, packageVersion } = require('./install.cjs');

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

  if (compareVersions(to, from) < 0) {
    throw new Error(`refusing downgrade: install is ${from}, package is the older ${to}`);
  }

  const manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
  const payloadDir = path.join(pkgRoot, 'payload');
  const updated = [];
  const preserved = [];

  for (const entry of manifest.files) {
    const src = path.join(payloadDir, entry.path);
    const dest = path.join(target, entry.path);
    if (!fs.existsSync(src)) {
      throw new Error(`package payload is missing "${entry.path}"`);
    }

    if (entry.class === 'managed') {
      lay(src, dest);
      updated.push({ path: entry.path, class: entry.class });
    } else if (!fs.existsSync(dest)) {
      // seeded/state that did not exist in the prior version → lay it once now
      lay(src, dest);
      updated.push({ path: entry.path, class: entry.class, reason: 'new-in-version' });
    } else {
      preserved.push({ path: entry.path, class: entry.class });
    }
  }

  receipt.kernelVersion = to;
  receipt.profile = receipt.profile || 'project';
  receipt.files = manifest.files.map((f) => ({ path: f.path, class: f.class }));
  receipt.installs = receipt.installs || [];
  receipt.installs.push({ update: { from, to, updatedCount: updated.length, preservedCount: preserved.length } });
  fs.writeFileSync(path.join(target, RECEIPT), JSON.stringify(receipt, null, 2) + '\n');

  return { from, to, updated, preserved };
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

// Compare dotted numeric versions: <0 if a<b, 0 if equal, >0 if a>b.
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

module.exports = { update, compareVersions };
