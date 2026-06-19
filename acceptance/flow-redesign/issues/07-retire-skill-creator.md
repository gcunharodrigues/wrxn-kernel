# 07 — Retire skill-creator (separate from the flow-redesign release)

Status: ready-for-agent

## Parent

`.scratch/flow-redesign/PRD.md` (PRD "Out of Scope" item, filed here for tracking)

## What to build

Retire the duplicate `skill-creator` skill now that compass routes "create a skill" → `write-a-skill`.
Audit its three scripts (`init_skill`, `package_skill`, `quick_validate`); fold `quick_validate` into a
frontmatter lint if it adds value, and drop the rest (`package_skill` assumes a distributable-zip model
wrxn does not use; skills ship via the kernel payload/manifest). Remove skill-creator from payload +
manifest and add a migration that removes it from existing installs on `npx … update`. End-to-end:
skill-creator is absent from a fresh install and swept from an existing one; one authoring skill remains.

## Acceptance criteria

- [ ] The three skill-creator scripts are audited; the keep/fold/drop decision is recorded (fold `quick_validate` → lint or drop, with rationale; drop `package_skill`/`init_skill` with rationale).
- [ ] skill-creator is removed from payload + manifest.
- [ ] A migration removes skill-creator from existing installs on update; it is a no-op if already absent.
- [ ] `write-a-skill` remains the sole authoring skill; compass routing is unaffected.
- [ ] Coverage does not decrease; suite green; types clean.

## Blocked by

- 04 (compass must own the "create a skill" route before skill-creator is removed).

## Note

Separate from the flow-redesign release — tracked here, shipped on its own. Not required for the
flow-redesign acceptance.
