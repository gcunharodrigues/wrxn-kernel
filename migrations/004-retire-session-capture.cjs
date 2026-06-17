'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 004 — retire the session-capture subsystem (harvest-01).
 *
 * Phase 5 (harvest) drops the low-value mechanical session-capture layer: the `session-end` episodic
 * breadcrumb writer, the `session-history` turn-trail recorder, and the `sessions` wiki tier they fed.
 * The deliberate handoff (continuity baton) + dream consolidation are the close-out moment now — the
 * automatic breadcrumb no longer earns its keep. The new payload no longer SHIPS the two hooks, but a
 * pre-0.7.0 install still carries them: `wrxn update` overwrites a managed file in place, it never
 * PRUNES one that was removed. So an existing install keeps the two hook files, a settings.json still
 * wired for them, a populated `sessions` tier, and now-orphaned history scratch. up() sweeps all of it.
 *
 * Steps: (1) remove the two retired hook files; (2) unwire them from the install settings.json — drop
 * the SessionEnd event whose only hook was session-end, and the session-history command from the
 * UserPromptSubmit chain (synapse-engine + the rest are preserved); (3) remove the whole
 * `.wrxn/wiki/sessions/` tier (dated pages + the gitkeep); (4) reap the now-orphaned
 * `.wrxn/history/*.trail` (no writer/reader left) + `*.touched` markers. The `.wrxn/history/` dir
 * itself STAYS — code-intel-push still writes `.touched` markers there.
 *
 * Defensive like 002/003: every step is existence-guarded and best-effort (force-rm ignores a missing
 * file), a missing/clean target is a no-op, and a corrupt settings.json is left untouched (never
 * clobber a hand-edited file — the other sweeps still run). Idempotent (a second run finds nothing to
 * do) and never throws on an already-clean install. `version` 0.7.0 = the harvest release that carries
 * the retirement (the same release whose payload stops shipping the two hooks).
 */

const RETIRED_HOOKS = ['session-end.cjs', 'session-history.cjs'];

// Remove every hook command referencing `basename` across all settings events; drop any group left
// with no hooks, and any event left with no groups. Returns true iff the config changed. Preserves
// every other hook (synapse-engine, reference-detect, recall-surface, session-start, …).
function unwireHook(cfg, basename) {
  const hooks = cfg && cfg.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(
        (h) => !(h && typeof h.command === 'string' && h.command.includes(basename)),
      );
      if (group.hooks.length !== before) changed = true;
    }
    const kept = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (kept.length !== groups.length) {
      changed = true;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
  }
  return changed;
}

module.exports = {
  id: '004',
  version: '0.7.0',
  up(ctx) {
    const target = ctx.target;

    // 1. remove the two retired hook files (force = absent is a no-op)
    for (const h of RETIRED_HOOKS) {
      fs.rmSync(path.join(target, '.claude', 'hooks', h), { force: true });
    }

    // 2. unwire them from settings.json — only while still wired; a corrupt file is left untouched
    const settingsPath = path.join(target, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      let cfg = null;
      try {
        cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      } catch {
        cfg = null; // hand-corrupted operator file → never clobber, never crash
      }
      if (cfg && typeof cfg === 'object') {
        let changed = false;
        for (const h of RETIRED_HOOKS) if (unwireHook(cfg, h)) changed = true;
        if (changed) fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
      }
    }

    // 3. sweep the retired `sessions` wiki tier (the whole dir: dated pages + the gitkeep)
    fs.rmSync(path.join(target, '.wrxn', 'wiki', 'sessions'), { recursive: true, force: true });

    // 4. reap orphaned history scratch — the *.trail (no writer/reader left) + *.touched markers.
    //    The `.wrxn/history/` dir itself stays: code-intel-push still records .touched markers there.
    const histDir = path.join(target, '.wrxn', 'history');
    let names = [];
    try {
      names = fs.readdirSync(histDir);
    } catch {
      names = []; // no history dir → nothing to reap
    }
    for (const n of names) {
      if (n.endsWith('.trail') || n.endsWith('.touched')) {
        fs.rmSync(path.join(histDir, n), { force: true });
      }
    }
  },
};
