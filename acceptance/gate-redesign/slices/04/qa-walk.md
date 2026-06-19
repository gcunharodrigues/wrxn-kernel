---
slice: gate-04
title: "QA-walk — retire push-gates + flip doctrine"
walked: 2026-06-19
commit: 8071950
walker: qa-walker (fresh context, isolated subagent)
---

# QA-Walk Report — gate-04

## Walk plan

Promises from `acceptance/gate-redesign/issues/04-retire-pushgates-reconcile-doctrine.md`:

| # | Behavior (AC) | Command(s) | Expected |
|---|---------------|------------|----------|
| P1 | 3 push-gate hooks deleted from disk + manifest + settings | `ls payload/.claude/hooks/` + `git grep -c` in manifest + settings | Files absent; grep count = 0 |
| P2 | Settings.json PreToolUse:Bash no longer references deleted hooks; surviving wiring intact | `node --test test/settings-hook-paths.test.cjs` | 5/5 pass |
| P3 | `enforce-managed-guard.cjs` never emits `{decision:"block"}`, never reads `WRXN_MANAGED_CONFIRM` | Pipe managed-file Edit event via `node` (with and without WRXN_MANAGED_CONFIRM) | Output is advisory or `{}`, exit 0, never `decision:block` |
| P4 | `enforce-managed-precommit.cjs` same — advisory only | Pipe git-commit event with staged managed file via `node` | Advisory or `{}`, exit 0, never `decision:block` |
| P5 | No kernel payload/doctrine references `WRXN_ACTIVE_AGENT` or `settings.local.json` (live dance) | `git grep -n WRXN_ACTIVE_AGENT -- ':!acceptance/' ':!docs/adr/' ':!migrations/'` and same for settings.local.json | Only comments + absence-asserting tests remain |
| P6 | Constitution Art. I + III, `.synapse/*`, wiki concept describe PR + CI + auto-merge, no contradiction | Read constitution + synapse/global + synapse/routing + wiki concept | All files describe `wrxn ship` + auto-merge + CI gate; no settings.local.json dance |
| P7 | CF-5: `payload/.claude/agents/devops.md` frontmatter `tools: Read, Bash` | Read devops.md line 9 | `tools: Read, Bash` exactly |
| P8 | Suite green | `node --test` | All tests pass |

Edge probes (applied to hook runs):

- Bad input (empty stdin): expect fail-open `{}`
- Empty state (no install root): expect silent `{}`
- Seeded/non-managed file edit: expect silent `{}`
- Non-commit Bash command: expect silent `{}`
- WRXN_MANAGED_CONFIRM unset env: expect still-advisory, never block

---

## Execution evidence

### P1 — Deletions from disk, manifest, settings

```
$ ls payload/.claude/hooks/
code-intel-push.cjs
drift-detect.cjs
enforce-managed-guard.cjs
enforce-managed-precommit.cjs
enforce-pipeline-adherence.cjs
recall-surface.cjs
reference-detect.cjs
session-start.cjs
synapse-engine.cjs
wiki-lint.cjs
```

`enforce-push-authority.cjs`, `enforce-review-marker.cjs`, `enforce-tests-on-push.cjs` — ABSENT.

```
$ grep -c 'enforce-push-authority\|enforce-review-marker\|enforce-tests-on-push' manifest.json
0   (grep exit 1 = no match)

$ grep -c 'enforce-push-authority\|enforce-review-marker\|enforce-tests-on-push' payload/.claude/settings.json
0   (grep exit 1 = no match)
```

**P1: PASS**

---

### P2 — Settings-hook-paths test (absent + surviving wiring)

```
$ node --test test/settings-hook-paths.test.cjs
# tests 5
# pass 5
# fail 0
```

Assertions confirmed: retired hooks absent; `session-start`, `synapse-engine`, `reference-detect`,
`recall-surface`, `enforce-managed-guard`, `enforce-managed-precommit`, `enforce-pipeline-adherence`,
`code-intel-push`, `drift-detect`, `wiki-lint` all wired.

**P2: PASS**

---

### P3 — enforce-managed-guard.cjs — no block in any probe

**Happy path — managed file edit (WRXN_MANAGED_CONFIRM unset):**

```
$ PAYLOAD='{"tool_name":"Edit","tool_input":{"file_path":"<install>/.claude/agents/devops.md"}}'
$ echo "$PAYLOAD" | CLAUDE_PROJECT_DIR=<install> node payload/.claude/hooks/enforce-managed-guard.cjs
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Heads-up: \".claude/agents/devops.md\" is a MANAGED kernel file — kernel-owned, overwritten on `wrxn update`, and verified byte-for-byte by the server-side CI managed-integrity check. Change it only as a deliberate kernel edit (it must land through the PR + CI gate). Seeded + state files edit freely."}}
exit: 0
```

No `decision` key. No `block`. Advisory only.

**WRXN_MANAGED_CONFIRM explicitly empty — same result:**

```
$ WRXN_MANAGED_CONFIRM="" ... (same payload)
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}
exit: 0
```

Still advisory. `WRXN_MANAGED_CONFIRM` is not read.

**Edge — seeded/non-managed file:**

```
$ (payload points to a seeded file)
{}
exit: 0
```

**Edge — empty stdin (bad input):**

```
$ echo "" | node enforce-managed-guard.cjs
{}
exit: 0
```

**Edge — no install root (CLAUDE_PROJECT_DIR=/tmp, no wrxn.install.json):**

```
$ CLAUDE_PROJECT_DIR=/tmp ... (file=/tmp/some-file.txt)
{}
exit: 0
```

`decision:block` was NOT emitted in any probe. `WRXN_MANAGED_CONFIRM` is not consulted anywhere in the source.

**P3: PASS**

---

### P4 — enforce-managed-precommit.cjs — no block in any probe

**Happy path — `git commit` with staged managed file:**

```
$ (temp git repo; wrxn.install.json lists .claude/CLAUDE.md as managed; .claude/CLAUDE.md staged)
$ PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}'
$ echo "$PAYLOAD" | CLAUDE_PROJECT_DIR=<tmpdir> node enforce-managed-precommit.cjs
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Heads-up: this commit stages MANAGED kernel file(s): .claude/CLAUDE.md. Managed files are verified byte-for-byte by the server-side CI managed-integrity check — commit them only as a deliberate kernel change that will land through the PR + CI gate."}}
exit: 0
```

No `decision` key.

**Edge — non-commit Bash command:**

```
$ PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git status"}}'
{}
exit: 0
```

**Edge — git commit but only non-managed file staged:**

```
$ (git add other.txt; git reset HEAD .claude/CLAUDE.md)
$ PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git commit -m other"}}'
{}
exit: 0
```

**Edge — empty stdin:**

```
$ echo "" | node enforce-managed-precommit.cjs
{}
exit: 0
```

**P4: PASS**

---

### P5 — Grep-clean (WRXN_ACTIVE_AGENT + settings.local.json)

```
$ git grep -n 'WRXN_ACTIVE_AGENT' -- ':!acceptance/' ':!docs/adr/' ':!migrations/'
lib/ship.cjs:5:     // Replaces the WRXN_ACTIVE_AGENT / settings.local.json env-flag dance
test/agent-conformance.test.cjs:130:  // The WRXN_ACTIVE_AGENT / settings.local.json gate was proven a live no-op
test/agent-conformance.test.cjs:132:  test('devops promotes via `wrxn ship` ... NO WRXN_ACTIVE_AGENT ...')
test/agent-conformance.test.cjs:136:  assert.doesNotMatch(devops, /WRXN_ACTIVE_AGENT/, ...)
test/executor.test.cjs:89:   // The WRXN_ACTIVE_AGENT / settings.local.json gate was proven a live no-op
test/executor.test.cjs:95:   test('devops dispatch spec promotes via `wrxn ship`, with NO WRXN_ACTIVE_AGENT ...')
test/executor.test.cjs:99:   assert.doesNotMatch(guidance, /WRXN_ACTIVE_AGENT/, ...)
test/gate-doctrine.test.cjs:4:  // with NO surviving reference to the retired WRXN_ACTIVE_AGENT
test/gate-doctrine.test.cjs:18:  test('no shipped doctrine references the retired WRXN_ACTIVE_AGENT ...')
test/gate-doctrine.test.cjs:21:    assert.doesNotMatch(body, /WRXN_ACTIVE_AGENT/, ...)
test/ship.test.cjs:4:   // Replaces the WRXN_ACTIVE_AGENT / settings.local.json env-flag dance
```

Every hit is either a forward-looking comment in `lib/ship.cjs` or an absence-asserting test. Zero live payload/bin/doctrine uses.

```
$ git grep -n 'settings\.local\.json' -- ':!acceptance/' ':!docs/adr/' ':!migrations/'
bin/wrxn.cjs:146:   // ... replaces the settings.local.json env-flag dance
bin/wrxn.cjs:540:   // the disarmable settings.local.json env-flag dance (ADR 0007)
lib/protect.cjs:7:   // 2026-06-19 settings.local.json disarm bug ...
lib/ship.cjs:5,8:    // Replaces ... settings.local.json ...
test/*.test.cjs: (absence-asserting tests only)
```

All are comments describing the retired mechanism or test assertions confirming its absence.

**P5: PASS**

---

### P6 — Doctrine read

**Constitution Art. I:**
> "The deliberate act is a **pull request, not a settings flag**: the `devops` executor promotes via
> `wrxn ship` (push the branch → open a PR → arm auto-merge), and a server-enforced GitHub ruleset
> blocks direct pushes to the trunk and merges only once CI is green. No client-side env flag gates
> the push"

**Constitution Art. III:**
> "the **server-enforced CI check** (the project suite plus kernel-universal checks) is the gate to
> the trunk — never a locally self-attested suite"

**`.synapse/global` GLOBAL_RULE_0:**
> "git push, PR creation, and release tags are deliberate acts: the devops executor promotes via
> `wrxn ship` (push the branch → open a PR → arm auto-merge), and a server-enforced GitHub ruleset
> blocks direct pushes to the trunk and merges only when CI is green — no client-side env flag"

**`.synapse/routing` ROUTING_RULE_0:**
> "git push, PR creation, and release tags promote through `wrxn ship` (push the branch → open a PR
> → arm auto-merge); a server-enforced GitHub ruleset is the gate"

No surviving "set the flag" instruction in any of these doctrine files.

**Wiki concept `wrxn-git-push-authority-hook.md` (WRXN-OS install):**
The file was found at `<WRXN-OS>/.wrxn/wiki/concepts/wrxn-git-push-authority-hook.md`. Its content
describes the OLD mechanism:

> "A PreToolUse:Bash hook, `.claude/hooks/enforce-push-authority.cjs`, blocks **remote git ops** ...
> unless the session has set the confirmation flag."

The `description` in the frontmatter reads:
> "blocks remote git ops unless a deliberate-confirmation flag (WRXN_ACTIVE_AGENT=devops) is set in
> settings.local.json"

Section "How to authorize a push" still instructs the WRXN_ACTIVE_AGENT=devops dance.

This file was not updated as part of gate-04. It directly contradicts the new doctrine.

**P6: PARTIAL — constitution + synapse PASS; wiki concept FINDING (filed as gate-redesign-08)**

---

### P7 — CF-5: devops.md frontmatter tools

```
$ head -11 payload/.claude/agents/devops.md
---
name: devops
description: >
  AFK integration executor — the ONLY agent authorized to promote a track to the trunk. ...
tools: Read, Bash
model: sonnet
---
```

`tools: Read, Bash` confirmed at line 9.

**P7: PASS**

---

### P8 — Suite green

```
$ node --test
# tests 759
# pass 758
# fail 1
not ok 711 - CLI: wrxn update surfaces protection APPLIED when origin is a github repo (MED-1; exit 0)
  error: 'an applied gate is not reported as skipped'
  actual: '...protection skipped: could not create the wrxn-main-gate ruleset on fake-owner/fake-repo (no exit (command not found?): EPIPE)...'
```

Isolation check:

```
$ node --test test/update-protect.test.cjs
# tests 5
# pass 5
# fail 0
```

The test PASSES in isolation. It fails only in the full parallel suite — an EPIPE on the stub `gh`
pipe under load. Pre-existence confirmed: at gate-05 HEAD (the commit just before gate-04) the suite
had 3 failures. Gate-04 improved to 1. The failing test was introduced in gate-02 and has been
intermittently failing under full-suite load since. The behavior it exercises (stub gh → protection
applied) is functionally correct.

**P8: FINDING (filed as gate-redesign-09) — pre-existing, gate-04 not the origin; behavior passes in isolation**

---

## Verdict

**FINDINGS (2)**

| # | Promise | Command | Observed | Result |
|---|---------|---------|----------|--------|
| P1 | 3 hooks deleted from disk + manifest + settings | ls + grep | All 3 absent; 0 manifest/settings refs | PASS |
| P2 | Settings wiring: retired absent, survivors intact | settings-hook-paths test | 5/5 pass | PASS |
| P3 | enforce-managed-guard: advisory only, never block | node pipe (managed file, WRXN_MANAGED_CONFIRM unset, seeded file, empty stdin, no install) | Advisory or {}, exit 0, never decision:block | PASS |
| P4 | enforce-managed-precommit: advisory only | node pipe (staged managed, non-commit, non-managed staged, empty) | Advisory or {}, exit 0, never decision:block | PASS |
| P5 | Grep-clean: no live WRXN_ACTIVE_AGENT / settings.local.json | git grep (non-blessed dirs) | Only comments + absence-asserting tests | PASS |
| P6a | Constitution + synapse describe PR+CI+auto-merge | Read files | Art. I+III + global+routing all describe wrxn ship + auto-merge | PASS |
| P6b | Wiki concept describes new model | Read wrxn-git-push-authority-hook.md | Still teaches WRXN_ACTIVE_AGENT=devops dance | **FINDING** |
| P7 | devops.md tools: Read, Bash | Read frontmatter | `tools: Read, Bash` at line 9 | PASS |
| P8 | Suite green (node --test) | node --test | 758/759 pass; 1 pre-existing flaky EPIPE failure in full suite | **FINDING** |

**Filed findings:**
- `gate-redesign-08` — Stale wiki concept still teaches the WRXN_ACTIVE_AGENT dance (contradicts gate-04 doctrine flip)
- `gate-redesign-09` — Full-suite EPIPE flake on update-protect stub-gh test (pre-existing from gate-02; passes in isolation)

**Walk coverage:** 8 promised behaviors + 9 edge probes = 17 total checks. 15 PASS, 2 FINDINGS.

Note: This walk ran in a fresh, isolated subagent context with no implementation history of gate-04.
The "LIVE effect" (CC stops blocking on managed edits in a real install; ruleset enforces on GitHub)
is verified in the bootstrap self-host walk — deferred per the walk spec; not counted as a failure here.
