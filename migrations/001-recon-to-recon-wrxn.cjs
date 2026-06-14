'use strict';

const fs = require('fs');
const path = require('path');

/**
 * R4 — rebrand an existing install from the legacy `recon` to `recon-wrxn`, in place, preserving the
 * costly index (recon-wrxn-04). The ENTIRE migration is gated on the legacy `.recon/` index dir: a
 * fresh (or already-migrated) install has no `.recon/`, so this is a complete no-op — which also makes
 * it idempotent (a second run sees `.recon/` already renamed away). Runs via `wrxn update` once the
 * install reaches 0.2.0; the file-class update has already laid the rebranded payload before this runs.
 */
module.exports = {
  id: '001',
  version: '0.2.0',
  up(ctx) {
    const target = ctx.target;
    const legacyDir = path.join(target, '.recon');
    if (!fs.existsSync(legacyDir)) return; // gate: no legacy index → nothing to migrate

    // 1. Rename the index dir, preserving the index (storage format unchanged per R1). If the new dir
    //    already exists (operator ran recon-wrxn before updating), it is authoritative — discard the
    //    legacy `.recon/` rather than leave it behind: it is a disposable cache that would otherwise
    //    linger no-longer-gitignored, and this run-once migration would never reclaim it.
    const newDir = path.join(target, '.recon-wrxn');
    if (!fs.existsSync(newDir)) {
      fs.renameSync(legacyDir, newDir);
    } else {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    }

    // 2. Rename the config (content unchanged — the operator's recon config carries over). The seeded
    //    `.recon-wrxn.json` template laid by `wrxn update` is overwritten so the operator's content wins.
    const legacyCfg = path.join(target, '.recon.json');
    if (fs.existsSync(legacyCfg)) {
      fs.renameSync(legacyCfg, path.join(target, '.recon-wrxn.json'));
    }

    // 3. Drop the stale `recon` server key from .mcp.json (the `recon-wrxn` server was already merged in
    //    by `wrxn update`). Only touch a file that exists and parses; never crash on a malformed config,
    //    never remove any other server key.
    const mcpPath = path.join(target, '.mcp.json');
    if (fs.existsSync(mcpPath)) {
      let mcp = null;
      try {
        mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      } catch {
        mcp = null; // malformed operator config → leave it alone
      }
      if (mcp && mcp.mcpServers && Object.prototype.hasOwnProperty.call(mcp.mcpServers, 'recon')) {
        delete mcp.mcpServers.recon;
        fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
      }
    }

    // 4. .gitignore: replace the stale `.recon/` line(s) with a single `.recon-wrxn/`; drop any extra
    //    stale lines and never emit a duplicate (whether `.recon-wrxn/` pre-existed or `.recon/` repeats).
    const giPath = path.join(target, '.gitignore');
    if (fs.existsSync(giPath)) {
      const lines = fs.readFileSync(giPath, 'utf8').split('\n');
      let haveNew = lines.some((l) => l.trim() === '.recon-wrxn/');
      const out = [];
      for (const l of lines) {
        if (l.trim() === '.recon/') {
          if (!haveNew) { out.push('.recon-wrxn/'); haveNew = true; }
        } else {
          out.push(l);
        }
      }
      fs.writeFileSync(giPath, out.join('\n'));
    }

    // 5. Remove the vendored legacy recon (superseded by the npm dependency; only WRXN-OS has it).
    const vendor = path.join(target, 'vendor', 'recon-aiox');
    if (fs.existsSync(vendor)) {
      fs.rmSync(vendor, { recursive: true, force: true });
    }
  },
};
