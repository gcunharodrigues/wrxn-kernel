'use strict';

const fs = require('fs');
const path = require('path');

const VALID_CLASSES = ['managed', 'seeded', 'state'];
const VALID_PROFILES = ['project', 'workspace'];

/**
 * Load and validate the file-class manifest.
 *
 * Validation is the load-bearing contract: a manifest that lists a file with no
 * class, an unknown class, or a duplicate path is rejected here — so the installer
 * never lays an unclassifiable file (PRD: "update refuses files it cannot classify").
 *
 * @param {string} manifestPath absolute path to manifest.json
 * @returns {{ version: string, files: Array<{path: string, class: string}> }}
 */
function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest is not valid JSON (${manifestPath}): ${err.message}`);
  }

  if (!Array.isArray(parsed.files)) {
    throw new Error('manifest.files must be an array');
  }

  const seen = new Set();
  for (const entry of parsed.files) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) {
      throw new Error(`manifest entry missing a path: ${JSON.stringify(entry)}`);
    }
    if (!VALID_CLASSES.includes(entry.class)) {
      throw new Error(
        `manifest entry "${entry.path}" has unclassifiable class "${entry.class}" — must be one of ${VALID_CLASSES.join(', ')}`
      );
    }
    if (!VALID_PROFILES.includes(entry.profile)) {
      throw new Error(
        `manifest entry "${entry.path}" has unclassifiable profile "${entry.profile}" — must be one of ${VALID_PROFILES.join(', ')}`
      );
    }
    if (path.isAbsolute(entry.path) || entry.path.split(path.sep).includes('..')) {
      throw new Error(`manifest path must be repo-relative, never absolute or escaping: "${entry.path}"`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`manifest lists "${entry.path}" more than once`);
    }
    seen.add(entry.path);
  }

  return { version: String(parsed.version), profiles: parsed.profiles || VALID_PROFILES, files: parsed.files };
}

/**
 * Should a file of `entry.profile` be laid for an install of `installProfile`?
 * The project profile is the shared floor (laid for BOTH); workspace files lay ONLY for workspace.
 */
function inProfile(entryProfile, installProfile) {
  return entryProfile === 'project' || entryProfile === installProfile;
}

module.exports = { loadManifest, inProfile, VALID_CLASSES, VALID_PROFILES };
