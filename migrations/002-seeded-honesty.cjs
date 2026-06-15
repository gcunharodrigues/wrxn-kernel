'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 002 — seeded-file honesty migration (foundation-honesty-06).
 *
 * Managed payload reaches existing installs on `wrxn update`, but SEEDED files are never overwritten
 * (operator-owned) — so two artifacts seeded before 0.2.1 keep their stale wording forever unless a
 * migration corrects them:
 *   - .synapse/routing's ROUTING_RULE_0 still asserts a fictional "devops role" authority.
 *   - docs/agents/domain.md still points at the deleted CONTEXT-MAP.md context.
 * Each file is rewritten in place ONLY while it still carries its known-stale marker, so an operator
 * who already customized it (or whose install is already honest) is never clobbered. The two branches
 * are independent and neither ever crashes on a missing file.
 *
 * The honest content is EMBEDDED below as frozen 0.2.1 constants: a migration is a historical
 * transform of the 0.2.1 release, not a re-read of the evolving template (ctx carries no pkgRoot, by
 * design). Idempotency falls out of the gate — after the rewrite the stale markers ("devops role",
 * "CONTEXT-MAP.md") are gone, so a second run is a no-op. Runs via `wrxn update` once the install
 * reaches 0.2.1.
 */

// The honest ROUTING_RULE_0 — mirrors the seeded `.synapse/routing` template (issue 04 confirmation-
// gate wording, minus the constitution citation the managed `global` GLOBAL_RULE_0 carries).
const HONEST_ROUTING_RULE_0 =
  'ROUTING_RULE_0=git push, PR creation, and release tags are deliberate acts held behind a confirmation flag (anti-accidental-push) — they run only once the session sets WRXN_ACTIVE_AGENT=devops in .claude/settings.local.json; `devops` is a dispatch-phase label, not an authority.';

// The honest domain glossary — frozen verbatim from the post-issue-05 payload docs/agents/domain.md.
const HONEST_DOMAIN_MD = `# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **\`CONTEXT.md\`** at the repo root — the domain glossary, the canonical vocabulary for this project.
- **\`docs/adr/\`** — Architecture Decision Records. Read the ADRs that touch the area you're about to work in.

If either doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it upfront. The producer skill (\`grill-with-docs\`) creates them lazily — \`CONTEXT.md\` when the first term is resolved, an ADR when a hard-to-reverse decision is actually made.

## File structure

A fresh install ships neither file. They appear at the repo root as the project's language and decisions accumulate:

\`\`\`
/
├── CONTEXT.md        ← domain glossary (created lazily by grill-with-docs)
└── docs/
    └── adr/          ← one file per decision, named NNNN-<slug>.md
\`\`\`

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in \`CONTEXT.md\`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for \`grill-with-docs\`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 — but worth reopening because…_
`;

module.exports = {
  id: '002',
  version: '0.2.1',
  up(ctx) {
    const target = ctx.target;

    // 1. routing: replace ONLY a ROUTING_RULE_0 line still carrying the stale "devops role" authority
    //    wording. Comments and any operator-added ROUTING_RULE_N lines are preserved verbatim; the
    //    split/join round-trip keeps the trailing newline. No stale line → routing left untouched.
    const routingPath = path.join(target, '.synapse', 'routing');
    if (fs.existsSync(routingPath)) {
      const lines = fs.readFileSync(routingPath, 'utf8').split('\n');
      let changed = false;
      const out = lines.map((line) => {
        if (line.startsWith('ROUTING_RULE_0=') && line.includes('devops role')) {
          changed = true;
          return HONEST_ROUTING_RULE_0;
        }
        return line;
      });
      if (changed) fs.writeFileSync(routingPath, out.join('\n'));
    }

    // 2. domain.md: overwrite the whole glossary with the honest content ONLY while it still names the
    //    deleted CONTEXT-MAP.md context. An honest or operator-customized file (marker absent) is left
    //    untouched. Missing file → nothing to do.
    const domainPath = path.join(target, 'docs', 'agents', 'domain.md');
    if (fs.existsSync(domainPath)) {
      const body = fs.readFileSync(domainPath, 'utf8');
      if (body.includes('CONTEXT-MAP.md')) {
        fs.writeFileSync(domainPath, HONEST_DOMAIN_MD);
      }
    }
  },
};
