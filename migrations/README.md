# Migrations

Breaking kernel changes ship as ordered, run-once migration scripts (PRD US8). `wrxn update` runs
any pending migration whose `version` the install has reached, in `id` order, recording each in the
install receipt's `migrationsApplied`. A throwing migration halts the update and is left pending, so
the next `wrxn update` resumes from it (already-applied migrations never re-run).

A migration is a `.cjs` file in this directory:

```js
// migrations/001-rename-wiki-tier.cjs
module.exports = {
  id: '001',           // orderable; migrations run in id order (default: filename without .cjs)
  version: '0.2.0',    // the release this ships with — runs once the install reaches it
  up(ctx) {            // ctx = { target, fromVersion, toVersion }; throw to fail (resumable)
    // transform the install at ctx.target to be compatible with the new kernel
  },
};
```

No migrations ship yet — this directory documents the contract. Add one only with a breaking change.
