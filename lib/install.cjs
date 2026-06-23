'use strict';

const fs = require('fs');
const path = require('path');

const { loadManifest, inProfile } = require('./manifest.cjs');
const { STATUSLINE_HINT } = require('./statusline.cjs');

const RECEIPT = 'wrxn.install.json';
const MCP_PATH = '.mcp.json';

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
  const merged = [];

  const version = packageVersion(pkgRoot);
  // Did the target hold project content BEFORE we laid anything? Drives the adopt-hint: a non-empty
  // repo has existing code worth priming the recon-wrxn index over now (.git and our own receipt
  // don't count). Captured up front so a re-init's own laid files don't read as "pre-existing".
  const wasNonEmpty = dirHasContent(target);
  // What a PRIOR wrxn install laid here — used to tell a re-init skip (wrxn's own file) apart from a
  // BROWNFIELD collision (a pre-existing PROJECT file that happens to clash with a payload path).
  const priorPaths = priorReceiptPaths(target);

  // Lay only the files that belong to the chosen profile: the project subset is the shared floor
  // (laid for both), workspace files lay only for a workspace install. Brownfield-safe by construction:
  // a clashing dest is NEVER overwritten — the existing file is preserved and (if new) reported.
  for (const entry of manifest.files) {
    if (!inProfile(entry.profile, profile)) continue;
    const src = path.join(payloadDir, entry.path);
    const dest = path.join(target, entry.path);

    if (!fs.existsSync(src)) {
      throw new Error(`manifest lists "${entry.path}" but payload/${entry.path} does not exist in the package`);
    }

    if (fs.existsSync(dest)) {
      // A collision = the file existed but was NOT laid by a prior wrxn install (it is the operator's
      // own pre-existing project file). A re-init skip of wrxn's own file is `exists`, not a collision.
      const collision = !priorPaths.has(entry.path);
      // .mcp.json is the one payload file we MERGE rather than preserve on a brownfield collision: the
      // operator's other MCP servers must survive while gaining the recon-wrxn server. A re-init
      // (not a collision) is left as a plain `exists` skip. A malformed operator file is preserved
      // untouched (we never clobber or crash) and reported as an ordinary collision.
      if (entry.path === MCP_PATH && collision && mergeMcpServer(src, dest)) {
        merged.push({ path: entry.path, class: entry.class });
        continue;
      }
      skipped.push({ path: entry.path, class: entry.class, reason: collision ? 'collision' : 'exists', collision });
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    laid.push({ path: entry.path, class: entry.class });
  }

  const collisions = skipped.filter((s) => s.collision);
  const brownfield = collisions.length > 0;

  // recon-wrxn writes its index into a fixed `.recon-wrxn/` dir — keep it out of version control.
  ensureGitignoreLine(target, '.recon-wrxn/');
  // the recall-surface hook writes per-install access-recency state here (harvest-08) — runtime, not committed.
  ensureGitignoreLine(target, '.wrxn/reinforce.json');
  // the recall-surface hook also writes the per-session surfaced-log here (#12 S1) — runtime STATE, not committed.
  ensureGitignoreLine(target, '.wrxn/surfaced.json');
  // session-start stamps a per-session start-HEAD baseline here and the session-end shell keeps the
  // coalesced reward sidecar here (#13 S2) — runtime STATE (survives `wrxn update`), never committed.
  ensureGitignoreLine(target, '.wrxn/baseline/');
  ensureGitignoreLine(target, '.wrxn/reward.json');
  // the emit-event hook appends verbatim (secret-redacted) prompt text to .wrxn/events/<sid>.jsonl (#35) —
  // the only sink persisting raw prompt text. Ignore the whole dir so captured prompts are never committed
  // (#38 F1); the shipped .gitkeep only makes init create the dir on disk, nothing in it is ever tracked.
  ensureGitignoreLine(target, '.wrxn/events/');
  // the memory-synth writes one outcome line per synth run to `.wrxn/continuity/.synth.log` (synth-handoff-fix-01)
  // — install runtime state (never shipped in the payload), so keep it out of version control.
  ensureGitignoreLine(target, '.wrxn/continuity/.synth.log');
  // the memory-synth gemini fallback reads GEMINI_API_KEY from `.env` — ignore it so the secret is
  // never committed (the synth's doc-comment calls it the install's gitignored `.env`).
  ensureGitignoreLine(target, '.env');

  writeReceipt(target, { version, profile, laid, skipped, merged, brownfield });

  // No synchronous index here (AC-5): `recon-wrxn serve` auto-indexes lazily on first use. On a
  // non-empty repo we only HINT that the operator can prime it now with `recon-wrxn index`.
  const adoptHint = wasNonEmpty
    ? 'recon-wrxn indexes lazily on first use — run `recon-wrxn index` to prime it over your existing code now.'
    : null;

  // init NEVER touches a statusline (that would risk overwriting the operator's). It only surfaces
  // the opt-in path so installs discover the SYNAPSE live-window writer.
  return { profile, laid, skipped, merged, collisions, brownfield, adoptHint, statuslineHint: STATUSLINE_HINT, receipt: path.join(target, RECEIPT) };
}

/** Does the target hold content other than `.git` and wrxn's own receipt? (Missing dir → empty.) */
function dirHasContent(target) {
  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    return false;
  }
  return entries.some((e) => e !== '.git' && e !== RECEIPT);
}

/** Append `line` to `<target>/.gitignore` (create if absent), exactly once — idempotent. */
function ensureGitignoreLine(target, line) {
  const giPath = path.join(target, '.gitignore');
  let body = '';
  try {
    body = fs.readFileSync(giPath, 'utf8');
  } catch {
    body = '';
  }
  if (body.split('\n').some((l) => l.trim() === line)) return; // already ignored
  const prefix = body.length && !body.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(giPath, body + prefix + line + '\n');
}

/**
 * Merge the recon-wrxn server key from the payload `.mcp.json` into an operator's existing one.
 * Returns true on a successful merge, false when the operator file is not parseable JSON (in which
 * case the caller preserves it untouched — wrxn never clobbers or crashes on a hand-written config).
 */
function mergeMcpServer(src, dest) {
  let operator;
  try {
    operator = JSON.parse(fs.readFileSync(dest, 'utf8'));
  } catch {
    return false; // unparseable operator file → preserve as a plain collision, don't merge
  }
  if (!operator || typeof operator !== 'object') return false;
  const payload = JSON.parse(fs.readFileSync(src, 'utf8'));
  operator.mcpServers = operator.mcpServers || {};
  operator.mcpServers['recon-wrxn'] = payload.mcpServers['recon-wrxn'];
  fs.writeFileSync(dest, JSON.stringify(operator, null, 2) + '\n');
  return true;
}

/** Paths a prior wrxn install recorded in the receipt (empty when there is no prior install). */
function priorReceiptPaths(target) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(target, RECEIPT), 'utf8'));
    return new Set((r.files || []).map((f) => f.path));
  } catch {
    return new Set();
  }
}

/** Read the kernel package's release version (the semver `wrxn update` compares). */
function packageVersion(pkgRoot) {
  return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
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
  existing.brownfield = !!data.brownfield;
  existing.files = [...data.laid, ...data.skipped, ...(data.merged || [])].map((f) => ({ path: f.path, class: f.class }));
  existing.installs.push({ laidCount: data.laid.length, skippedCount: data.skipped.length, mergedCount: (data.merged || []).length });
  fs.writeFileSync(receiptPath, JSON.stringify(existing, null, 2) + '\n');
}

module.exports = { init, RECEIPT, MCP_PATH, packageVersion, mergeMcpServer };
