# Verticality review — flow-redesign

Gate: each slice must be a vertical tracer (cuts all layers), demoable/walkable, right-grained, no
dependency error. Reviewed 2026-06-18 (orchestrator inline; a fresh-eyes pass may be requested).

| # | Slice | Horizontal? | Demoable? | Too coarse? | Dep error? | Verdict |
|---|---|---|---|---|---|---|
| 01 | pipeline doctrine rewrite | no — whole doctrine | yes — rules inject in a session (Seam 2) | no | no (none) | PASS |
| 02 | builder agent + validator | no — contract+agent+test | yes — validator runs, builder conforms | no | no (none) | PASS |
| 03 | remaining 5 agents | no — same wrapper pattern ×5 | yes — all six conform | no — homogeneous wrappers, one check (prior art kernel-19) | no (←02) | PASS |
| 04 | compass + coverage | no — skill+coverage+test | yes — invoke compass → live map | no | no (←01; names agents/flow-status as forward refs in prose) | PASS |
| 05 | flow status | no — lib+CLI+test | yes — run `wrxn flow status` | no | no (none; reads existing artifact shapes) | PASS |
| 06 | qa-walk operator-mode | thin but complete | yes — skill documents both modes | no | no (none) | PASS |
| 07 | retire skill-creator | no — remove+migration+lint | yes — absent from install | no | no (←04) | PASS |

## Notes

- DAG is acyclic: `01 → {04}`, `02 → 03`, `04 → 07`; `05`, `06` independent. Unblocked at start: 01, 02, 05, 06.
- 04's references to the executor agents (02/03) and `wrxn flow status` (05) are **descriptive prose** in a
  doctrine doc, not runtime dependencies — each slice stays independently walkable; all land in one release.
- 03 bundles five agents deliberately: each is a trivial wrapper validated by the same `validateAgentFile`
  check, so five separate issues would be too fine (mirrors kernel-19).

**Gate: PASS — all seven ready-for-agent.**
