# WRXN Constitution

The four universal articles. Managed law: kernel-owned, overwritten on `wrxn update`.
Project-local preferences live in the seeded `constitution.local.md` addendum, never here.

## Article I — Agent Authority (NON-NEGOTIABLE)

- `git push`, PR creation, and release tags are deliberate acts. The deliberate act is a
  **pull request, not a settings flag**: the `devops` executor promotes via `wrxn ship`
  (push the branch → open a PR → arm auto-merge), and a server-enforced GitHub ruleset blocks
  direct pushes to the trunk and merges only once CI is green. No client-side env flag gates
  the push; `devops` here is a dispatch-phase label, not an authority grant.
- An agent acts only within its scope; it delegates when out of scope and never assumes
  another agent's authority.

## Article II — Issue-Driven (supersedes Story-Driven)

- The unit of work is an **issue with acceptance criteria**. No code is written without one.
- Acceptance criteria are explicit before implementation; progress is tracked against them.
- Issues are cut as vertical tracer-bullet slices — each independently buildable and walkable.

## Article III — Quality-First

- Tests and typecheck pass on every commit; the **server-enforced CI check** (the project suite
  plus kernel-universal checks) is the gate to the trunk — never a locally self-attested suite.
- Code review and security review gate integration — run by the AFK `reviewer` + `security` agents
  before the PR, with CI as the server-side backstop, not a self-written human-review marker;
  functional QA walks the real artifact.
- Coverage does not decrease.

## Article IV — No-Invention

- Every claim in a spec traces to a stated requirement or a researched source.
- Do not add features absent from the requirements, assume unresearched implementation
  details, or specify unvalidated technologies.
