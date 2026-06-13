'use strict';

const fs = require('fs');
const path = require('path');

const { loadManifest } = require('./manifest.cjs');

const RECEIPT = 'wrxn.install.json';

/**
 * Lay the kernel payload into a target root, governed by the file-class manifest.
 *
 * Walking-skeleton install semantics (init only; update is a later issue):
 *   - every class is laid create-if-absent — a file already present is left untouched.
 *   - that makes init idempotent across all three classes: a second run lays nothing.
 *   - the class is recorded per file in the receipt + returned report, so the
 *     class-aware engine is observable now even though the divergent UPDATE rules
 *     (managed overwrite / seeded preserve / state never-touch) land with `wrxn update`.
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot   absolute path to the installed kernel package (holds manifest.json + payload/)
 * @param {string} opts.target    absolute path to the install target (a project root)
 * @param {string} [opts.profile] "project" (default) | "workspace"
 * @returns {{ profile: string, laid: Array, skipped: Array, receipt: string }}
 */
function init(opts) {
  const pkgRoot = opts.pkgRoot;
  const target = opts.target;
  const profile = opts.profile || 'project';

  const manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
  const payloadDir = path.join(pkgRoot, 'payload');

  const laid = [];
  const skipped = [];

  for (const entry of manifest.files) {
    const src = path.join(payloadDir, entry.path);
    const dest = path.join(target, entry.path);

    if (!fs.existsSync(src)) {
      throw new Error(`manifest lists "${entry.path}" but payload/${entry.path} does not exist in the package`);
    }

    if (fs.existsSync(dest)) {
      skipped.push({ path: entry.path, class: entry.class, reason: 'exists' });
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    laid.push({ path: entry.path, class: entry.class });
  }

  writeReceipt(target, { version: manifest.version, profile, laid, skipped });

  return { profile, laid, skipped, receipt: path.join(target, RECEIPT) };
}

function writeReceipt(target, data) {
  const receiptPath = path.join(target, RECEIPT);
  // The receipt is generated state, not a payload file — it records what THIS install
  // laid, so a re-run (and a future `wrxn update`) can reason about install history.
  const existing = fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    : { installs: [] };
  existing.kernelVersion = data.version;
  existing.profile = data.profile;
  existing.files = [...data.laid, ...data.skipped].map((f) => ({ path: f.path, class: f.class }));
  existing.installs.push({ laidCount: data.laid.length, skippedCount: data.skipped.length });
  fs.writeFileSync(receiptPath, JSON.stringify(existing, null, 2) + '\n');
}

module.exports = { init, RECEIPT };
