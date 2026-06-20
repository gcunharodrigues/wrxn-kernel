'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 007 — transition existing installs onto auto-memory (auto-memory-05).
 *
 * The auto-memory release makes memory automatic: a SessionEnd hook (memory-synth-spawn.cjs) spawns a
 * background synth that writes the continuity baton and consolidates dream pages — so the manual
 * `handoff` skill is removed (the synth is the sole baton writer) and the stale `_slots/current-focus`
 * slot + its `set-focus` op are dropped. The new payload stops shipping the handoff skill and now wires
 * SessionEnd + ships a seeded `memory.config.json`. But `wrxn update` overwrites managed files in place —
 * it never PRUNES a removed one — and a seeded file already present is preserved, so a pre-0.12.0 install
 * still carries the old `handoff` skill files and the stale focus slot, and may lack the new wiring/seed
 * (e.g. a hand-edited settings.json the managed overwrite left alone, or an install that never had a
 * config). up() transitions it.
 *
 * Steps: (1) remove the install's `handoff` skill dir; (2) wire SessionEnd → memory-synth-spawn.cjs into
 * the install settings.json IDEMPOTENTLY (add only if absent — if update's managed overwrite already laid
 * it, this is a safe no-op); a corrupt settings.json is left untouched; (3) seed `memory.config.json` if
 * absent (the slice-02 default shape); (4) remove the stale `_slots/current-focus.md` focus slot;
 * (5) backfill the install `.gitignore` for the `.env` secret and the continuity runtime temps the synth/
 * dream now write (`.wrxn/continuity/.pending`, `.pending-handoff`, the baton `.tmp`, `.dream.*.tmp`) —
 * slice-02 added `.env` for NEW installs; this closes the gap for OLD ones (slice-04 reviewer F1).
 *
 * Defensive like 004: every step is existence-guarded and best-effort (force-rm ignores a missing file),
 * a missing/clean target is a no-op, a corrupt settings.json is left untouched (never clobber a hand-
 * edited file — the other steps still run), and the gitignore backfill adds each line at most once.
 * Idempotent (a second run finds nothing to do) and never throws on an already-clean install. `version`
 * 0.12.0 = the auto-memory release that carries the transition (the same release whose payload stops
 * shipping the handoff skill and starts wiring the SessionEnd synth).
 */

// The .gitignore lines auto-memory needs an install to carry: the `.env` secret (slice-02 added it for
// NEW installs — backfilled here for OLD ones) + the continuity runtime markers/temps the synth and dream
// write and clean in a finally, which a SIGKILL could leave behind UNTRACKED (slice-04 reviewer F1). The
// tracked baton `latest.md` is deliberately NOT ignored — only its dot-prefixed `.tmp` is.
const GITIGNORE_LINES = [
  '.env',
  '.wrxn/continuity/.pending*', // the .pending + .pending-handoff synth markers
  '.wrxn/continuity/.dream.*.tmp', // dream's per-call blob/batch/stage/approved temps
  '.wrxn/continuity/.latest.md.*.tmp', // the atomic baton-write temp (rename-over target)
];

/** Append `line` to `<target>/.gitignore` (create if absent) exactly once — mirrors install.cjs. */
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

// The SessionEnd spawn hook the auto-memory payload wires (must match payload/.claude/settings.json).
const SPAWN_HOOK_BASENAME = 'memory-synth-spawn.cjs';
const SPAWN_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/memory-synth-spawn.cjs"';

// Idempotently wire SessionEnd → the spawn hook into a parsed settings config. Adds the hook ONLY if no
// existing hook command across any event already references it — so a config the managed overwrite already
// laid (or a prior run) is a safe no-op. Returns true iff the config changed. Preserves every other event.
function wireSessionEndSpawn(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {};
  // already wired anywhere? (mirror unwireHook's whole-config scan) → no-op.
  for (const groups of Object.values(cfg.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      if (group.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(SPAWN_HOOK_BASENAME))) {
        return false;
      }
    }
  }
  const event = Array.isArray(cfg.hooks.SessionEnd) ? cfg.hooks.SessionEnd : [];
  event.push({ hooks: [{ type: 'command', command: SPAWN_HOOK_COMMAND }] });
  cfg.hooks.SessionEnd = event;
  return true;
}

module.exports = {
  id: '007',
  version: '0.12.0',
  up(ctx) {
    const target = ctx.target;

    // 1. remove the retired `handoff` skill dir (the synth is the sole baton writer now). recursive +
    //    force = an absent dir is a no-op.
    fs.rmSync(path.join(target, '.claude', 'skills', 'handoff'), { recursive: true, force: true });

    // 2. wire SessionEnd → memory-synth-spawn.cjs into the install settings.json, idempotently. A corrupt
    //    file is left untouched (never clobber a hand-edited config); an absent file is left absent (the
    //    managed overwrite lays the wired settings — the migration only backfills a hand-edited one).
    const settingsPath = path.join(target, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      let cfg = null;
      try {
        cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        cfg = null; // hand-corrupted operator file → never clobber, never crash
      }
      if (cfg && typeof cfg === 'object' && wireSessionEndSpawn(cfg)) {
        fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
      }
    }

    // 3. seed memory.config.json if absent (the slice-02 default). Copied from THIS package's payload so
    //    the seeded shape can never drift from what a fresh install ships. Already present ⇒ preserved
    //    (it is a seeded, operator-owned file). A missing payload source is swallowed (best-effort).
    const cfgPath = path.join(target, '.wrxn', 'memory.config.json');
    if (!fs.existsSync(cfgPath)) {
      const seedSrc = path.join(__dirname, '..', 'payload', '.wrxn', 'memory.config.json');
      try {
        const seed = fs.readFileSync(seedSrc, 'utf8');
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, seed);
      } catch {
        // no payload seed reachable → skip (the managed/seeded update path lays it anyway)
      }
    }

    // 4. remove the stale `_slots/current-focus.md` focus slot (the slot + its set-focus op are dropped).
    //    Only the slot PAGE goes — the empty `_slots` tier dir + its gitkeep stay (the tier is retained).
    //    force = an absent slot is a no-op.
    fs.rmSync(path.join(target, '.wrxn', 'wiki', '_slots', 'current-focus.md'), { force: true });

    // 5. gitignore backfill — add the `.env` secret + continuity runtime-temp lines (each at most once).
    //    Closes the gap for installs created before slice-02 added `.env` / before the synth wrote temps.
    for (const line of GITIGNORE_LINES) ensureGitignoreLine(target, line);
  },
};
