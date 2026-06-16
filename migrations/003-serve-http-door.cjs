'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 003 — open the warm-brain HTTP find door on existing installs (recon-brain-recall-05).
 *
 * The door is the concurrent, read-only, loopback HTTP transport `recon serve` runs alongside its
 * stdio MCP transport when `.recon-wrxn.json` carries `serveHttp:true` (recon-wrxn ADR 0003) — the one
 * warm index the per-prompt Recall hook and `wrxn brain query` reach. A fresh install gets the door
 * from the updated seed, but `.recon-wrxn.json` is SEEDED (operator-owned), so `wrxn update` never
 * overwrites it — an install created before this release would keep the door shut forever unless a
 * migration flips it.
 *
 * up() sets `serveHttp:true` in place, PRESERVING every existing operator field (projects, ignore,
 * watch, …) — it touches only the door bit, it does not retrofit the rest of the new template.
 * Defensive like 002/001: a missing config is a no-op (a non-recon install has nothing to migrate), an
 * already-open door is an idempotent no-op, and a corrupt/unparseable (or non-object) config is left
 * untouched — never clobber a hand-edited file. `version` is a frozen 0.4.0: it runs via `wrxn update`
 * once the install reaches the release that carries the door (the same release that bumps the recon-wrxn
 * pin to the wrxn.3 build whose serve actually honors serveHttp).
 */
module.exports = {
  id: '003',
  version: '0.4.0',
  up(ctx) {
    const cfgPath = path.join(ctx.target, '.recon-wrxn.json');
    if (!fs.existsSync(cfgPath)) return; // no recon config → nothing to migrate

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      return; // malformed operator config → leave it untouched, never clobber
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return; // not a config object → leave it

    if (cfg.serveHttp === true) return; // door already open → idempotent no-op

    cfg.serveHttp = true; // open the door; every other operator field is preserved
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  },
};
