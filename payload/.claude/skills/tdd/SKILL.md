---
name: tdd
description: Test-driven build loop — red, green, refactor. Use when building a feature or fixing a bug; write a failing test first, make it pass, then refactor with the suite green.
---

# TDD — the kernel build loop

The canonical build stage of the WRXN pipeline (grill → research → prototype → PRD → issues →
verticality review → **tdd** → code review → security review → QA-walk → operator accepts).

## The loop

1. **Red** — write one failing test that pins the next slice of behavior at the highest seam
   (public interface, not internals). Run it; watch it fail for the right reason.
2. **Green** — write the minimum code to pass. Nothing speculative.
3. **Refactor** — clean up with the suite green. Behavior unchanged.

## Rules

- Tests and typecheck pass on **every commit** (Constitution Art. III). A red commit is not done.
- Test external behavior, not implementation — internals stay refactorable.
- One slice = one tracer bullet: independently buildable and walkable (Constitution Art. II).
