# WRXN Constitution

The four universal articles. Managed law: kernel-owned, overwritten on `wrxn update`.
Project-local preferences live in the seeded `constitution.local.md` addendum, never here.

## Article I — Agent Authority (NON-NEGOTIABLE)

- `git push`, PR creation, and release tags are EXCLUSIVE to the devops role.
- An agent acts only within its scope; it delegates when out of scope and never assumes
  another agent's authority.

## Article II — Issue-Driven (supersedes Story-Driven)

- The unit of work is an **issue with acceptance criteria**. No code is written without one.
- Acceptance criteria are explicit before implementation; progress is tracked against them.
- Issues are cut as vertical tracer-bullet slices — each independently buildable and walkable.

## Article III — Quality-First

- Tests and typecheck pass on every commit; the full suite green is the push gate.
- Code review and security review gate integration; functional QA walks the real artifact.
- Coverage does not decrease.

## Article IV — No-Invention

- Every claim in a spec traces to a stated requirement or a researched source.
- Do not add features absent from the requirements, assume unresearched implementation
  details, or specify unvalidated technologies.
