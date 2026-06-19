'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 006 — seeded-routing refresh to the PR + CI + auto-merge gate (gate-redesign gate-04).
 *
 * `.synapse/routing` is a SEEDED file: `wrxn update` refreshes the managed `.synapse/global`, the
 * constitution, and the synapse skill docs (all moved to the PR + CI + auto-merge model in gate-04),
 * but it NEVER overwrites the operator-owned routing seed. So the existing installs keep their OLD
 * ROUTING_RULE_0 — the retired WRXN_ACTIVE_AGENT=devops confirmation-flag dance, the exact text
 * migration 002 last wrote — leaving one doctrine echo out of step with the rest of the install.
 *
 * up() rewrites ONLY a ROUTING_RULE_0 line that still carries the WRXN_ACTIVE_AGENT marker, replacing
 * it with the frozen 0.11.0 rule below. The marker is the retired mechanism's own identifier: it is
 * absent from the new rule (so a second run / an already-refreshed install is a no-op) and from any
 * operator doctrine (a rule that never named the kernel-internal flag is left untouched). The
 * startsWith('ROUTING_RULE_0=') clause scopes the rewrite to rule 0 alone — sibling rules, the comment
 * header, and operator-added ROUTING_RULE_N lines are preserved verbatim, and the split/join
 * round-trip keeps the trailing newline. A missing or unreadable routing is a clean no-op (the fs work
 * is wrapped defensively, like 005, so a cosmetic doctrine refresh can never break `wrxn update`).
 *
 * The new rule is EMBEDDED as a frozen 0.11.0 constant: a migration is a historical transform of the
 * release it ships with, not a re-read of the evolving seeded template (ctx carries no pkgRoot, by
 * design). Idempotency falls out of the gate — after the rewrite the marker is gone. Runs via
 * `wrxn update` once the install reaches 0.11.0.
 */

// The PR + CI + auto-merge ROUTING_RULE_0 — mirrors the seeded `.synapse/routing` template at 0.11.0.
const NEW_ROUTING_RULE_0 =
  'ROUTING_RULE_0=git push, PR creation, and release tags promote through `wrxn ship` (push the branch → open a PR → arm auto-merge); a server-enforced GitHub ruleset is the gate — it blocks direct pushes to the trunk and merges only when CI is green, so never push directly to the trunk.';

module.exports = {
  id: '006',
  version: '0.11.0',
  up(ctx) {
    const routingPath = path.join(ctx.target, '.synapse', 'routing');
    try {
      if (!fs.existsSync(routingPath)) return;
      const lines = fs.readFileSync(routingPath, 'utf8').split('\n');
      let changed = false;
      const out = lines.map((line) => {
        if (line.startsWith('ROUTING_RULE_0=') && line.includes('WRXN_ACTIVE_AGENT')) {
          changed = true;
          return NEW_ROUTING_RULE_0;
        }
        return line;
      });
      if (changed) fs.writeFileSync(routingPath, out.join('\n'));
    } catch {
      // Defensive (belt-and-braces, like 005): an unreadable/odd routing is a clean no-op — a cosmetic
      // doctrine refresh must never fail `wrxn update`.
    }
  },
};
