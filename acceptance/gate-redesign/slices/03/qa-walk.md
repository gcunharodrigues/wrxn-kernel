# QA Walk — gate-03: `wrxn ship` + devops rewrite

Artifact commit: `0c7f6ab`
Entry point: `node /home/guilherme/Documents/_projects/wrxn-kernel/bin/wrxn.cjs ship`
Walker context: fresh isolated qa-walker executor (not the builder)
Date: 2026-06-19

---

## Promises (source: `acceptance/gate-redesign/issues/03-ship-devops-rewrite.md`)

| # | AC | Checkable here? |
|---|----|-----------------|
| AC-1 | `buildShipPlan()` is pure: given branch/title, returns ordered git + gh commands (push, pr-create, auto-merge); unit-tested | Yes (via --dry-run) |
| AC-2 | `ship({ invoker })` runs the plan via injected invoker; tested with fake invoker | Structural — exercised indirectly via --dry-run; unit tests not re-run (walk != test-re-run) |
| AC-3 | `wrxn ship` CLI opens PR with auto-merge enabled (real `gh` invocation) | UNWALKABLE — requires live remote + PR-open; deferred to bootstrap self-host walk per walk instructions |
| AC-4 | `payload/.claude/agents/devops.md` describes `wrxn ship` path, no `WRXN_ACTIVE_AGENT`/settings.local.json | Yes |
| AC-5 | Suite green | Not re-run here (walk != test runner) |

---

## Walk plan

### P1 — No `--title`: exit 2 + clean error
**Behavior (AC-1):** malformed promote rejected before any network call.
**Command:** `node bin/wrxn.cjs ship`
**Expected:** exit 2, error naming the missing flag, no crash/stack trace.

### P2 — `--dry-run` prints the ordered promote plan, executes nothing
**Behavior (AC-1):** pure plan visible; correct order (push → pr-create → auto-merge).
**Command:** `node bin/wrxn.cjs ship --branch my-feature-branch --title "feat: add new feature" --dry-run`
**Expected:** exit 0, JSON array with labels `push` / `pr-create` / `auto-merge` in that order; correct git/gh commands.

### P3 — `--help` / USAGE self-describes `wrxn ship`
**Behavior:** USAGE entry present, flags documented.
**Command:** `node bin/wrxn.cjs --help` (grepped for ship section)
**Expected:** ship entry with flags `--title`, `--branch`, `--dry-run` etc.

### P4 — devops.md: no forbidden env-flag refs
**Behavior (AC-4):** grep for `WRXN_ACTIVE_AGENT` or `settings.local.json` returns no matches.
**Command:** `git grep -n 'WRXN_ACTIVE_AGENT\|settings.local.json' -- payload/.claude/agents/devops.md`
**Expected:** no output, exit 1 (grep found nothing).

### P5 — devops.md: coherently instructs wrxn ship + confirm auto-merge
**Behavior (AC-4):** the promote path is complete — ship command + confirmation step present, not dangling.
**Evidence:** read `payload/.claude/agents/devops.md`
**Expected:** step 2 = `wrxn ship`, step 3 = confirm auto-merge is armed; no settings.local.json dance.

### P6 — Edge probe: bad flag → sane error, no crash
**Command:** `node bin/wrxn.cjs ship --bad-flag`
**Expected:** exit 2, clean message (the unknown flag is treated as boolean; the title/branch checks fire), no stack trace.

### P7 — Edge probe: empty title string → exit 2 clean
**Command:** `node bin/wrxn.cjs ship --branch my-branch --title ""`
**Expected:** exit 2, "ship requires --title" error, no crash.

### P8 — Edge probe: blank-only title → exit 2 from pure validator
**Command:** `node bin/wrxn.cjs ship --branch my-branch --title "   "`
**Expected:** exit 2, error from `buildShipPlan` ("title is required"), no crash.

### P9 — Edge probe: no git repo (empty state)
**Command:** `node /path/to/bin/wrxn.cjs ship --title "test" --dry-run` from `/tmp`
**Expected:** exit 2, branch error (git detection fails gracefully), no crash/stack trace from wrxn.

### P10 — Edge probe: dry-run idempotency (repeat-run)
**Command:** dry-run run twice consecutively with same args.
**Expected:** identical JSON output both times, exit 0 both times.

### P11 — `--base` and `--body` honored in plan
**Command:** `node bin/wrxn.cjs ship --branch my-branch --title "feat: test" --base develop --body "desc text" --dry-run`
**Expected:** `pr-create` step has `--base develop` and `--body "desc text"`.

### P12 — AC-3: real PR open + auto-merge arm
**UNWALKABLE** — requires a live remote, a real `gh` authenticated session, an actual PR. Deferred to the bootstrap self-host walk (land the slice → apply ruleset → ship a real branch → confirm auto-merge + CI green).

---

## Execution

### P1 — No `--title`: exit 2 + clean error

```
$ node bin/wrxn.cjs ship
wrxn: ship requires --title "<pr title>"
EXIT: 2
```

**Result: PASS** — exit 2, clean message naming the missing flag, no crash.

Note: when run inside a git repo, branch detection succeeds silently first; `--title` check fires next. Message could be more specific ("--title was not provided" vs "requires --title") but is unambiguous and not a crash.

---

### P2 — `--dry-run` prints ordered promote plan

```
$ node bin/wrxn.cjs ship --branch my-feature-branch --title "feat: add new feature" --dry-run
[
  {
    "label": "push",
    "cmd": "git",
    "args": ["push", "-u", "origin", "my-feature-branch"]
  },
  {
    "label": "pr-create",
    "cmd": "gh",
    "args": ["pr", "create", "--base", "main", "--head", "my-feature-branch",
             "--title", "feat: add new feature", "--body", ""]
  },
  {
    "label": "auto-merge",
    "cmd": "gh",
    "args": ["pr", "merge", "my-feature-branch", "--auto", "--squash"]
  }
]
EXIT: 0
```

**Result: PASS** — correct 3-step plan in the promised order (push → pr-create → auto-merge). Labels match the AC description. `gh pr merge --auto --squash` is present. No network call made.

---

### P3 — USAGE self-describes `wrxn ship`

```
$ node bin/wrxn.cjs --help   (ship section)
  wrxn ship --title "<pr title>" [--branch <name>] [--base <main>] [--body <text>] [--dry-run] [--root <dir>]
             the autonomous promote path (replaces the WRXN_ACTIVE_AGENT /
             settings.local.json dance): push the reviewed branch, open a PR,
             and arm auto-merge (gh pr merge --auto --squash) ...
EXIT: 0
```

**Result: PASS** — all flags documented; the USAGE explicitly names the `WRXN_ACTIVE_AGENT` / settings.local.json replacement.

---

### P4 — devops.md: no forbidden env-flag refs

```
$ git grep -n 'WRXN_ACTIVE_AGENT\|settings.local.json' -- payload/.claude/agents/devops.md
(no output)
GREP_EXIT: 1
```

**Result: PASS** — zero matches; the env-flag dance is completely absent.

---

### P5 — devops.md: coherent promote path

Observed content (key sections):
- Step 2: "Promote with one command: `wrxn ship --title "<conventional PR title>"`." — `--dry-run` preview option mentioned. ✓
- Step 3: "Confirm auto-merge is armed (e.g. `gh pr view --json autoMergeRequest` shows it enabled)." ✓
- Constraints: "wrxn ship is the ONLY sanctioned promote path — never push directly to the trunk..." ✓
- No `settings.local.json`, no `WRXN_ACTIVE_AGENT`, no set/unset dance. ✓

**Result: PASS** — promote path is complete and coherent. wrxn ship → confirm auto-merge; CI handles the merge.

---

### P6 — Edge probe: bad flag

```
$ node bin/wrxn.cjs ship --bad-flag
wrxn: ship requires --title "<pr title>"
EXIT: 2
```

**Result: PASS** — unknown flag silently treated as boolean (parseArgs pattern); title/branch validation catches the missing required arg. No stack trace.

---

### P7 — Edge probe: empty title string

```
$ node bin/wrxn.cjs ship --branch my-branch --title ""
wrxn: ship requires --title "<pr title>"
EXIT: 2
```

**Result: PASS** — falsy-string guard fires at CLI layer before `buildShipPlan`. Exit 2, clean message.

---

### P8 — Edge probe: blank-only title

```
$ node bin/wrxn.cjs ship --branch my-branch --title "   "
wrxn: cannot build ship plan: title is required (the PR title)
EXIT: 2
```

**Result: PASS** — blank-whitespace title passes the CLI falsy check (`"   "` is truthy) but `buildShipPlan` catches it via `.trim() === ''`. Error surfaces from the pure function, no crash.

---

### P9 — Edge probe: no git repo

```
$ cd /tmp && node /path/to/bin/wrxn.cjs ship --title "test" --dry-run
fatal: not a git repository (or any of the parent directories): .git
wrxn: ship requires a branch — pass --branch <name>, or run inside the git repo on the branch to promote
EXIT: 2
```

**Result: PASS** — exit 2, clean wrxn error message. The `git branch --show-current` subprocess's stderr leaks through before the wrxn message (git error is NOT captured; it goes to parent stderr). This is standard `execFileSync` behavior and is informative, not a crash. No stack trace from wrxn.

*Observation (non-blocking):* the git subprocess stderr ("fatal: not a git repository...") appears on stderr before the wrxn-controlled error message. Consider `{ stdio: ['ignore', 'pipe', 'ignore'] }` in the `execFileSync` call to suppress git's stderr — wrxn's own message is sufficient. Recorded as observation only; not a blocking finding.

---

### P10 — Edge probe: dry-run idempotency

```
$ node bin/wrxn.cjs ship --branch my-branch --title "test title" --dry-run
[...same plan...]
$ node bin/wrxn.cjs ship --branch my-branch --title "test title" --dry-run
[...same plan — byte-identical...]
EXIT: 0 both runs
```

**Result: PASS** — pure function; identical output on every run.

---

### P11 — `--base` and `--body` honored

```
$ node bin/wrxn.cjs ship --branch my-branch --title "feat: test" --base develop --body "desc text" --dry-run
pr-create step: ["pr","create","--base","develop","--head","my-branch","--title","feat: test","--body","desc text"]
EXIT: 0
```

**Result: PASS** — both flags flow through to the pr-create step correctly.

---

### P12 — AC-3: real PR open + auto-merge arm

**UNWALKABLE** — requires live authenticated `gh`, a real remote, and a pushable branch. Deferred to the bootstrap self-host walk (apply gate-redesign to kernel → ship a real branch → verify `gh pr view` shows autoMergeRequest enabled + CI merge).

---

## Verdict

**PASS**

| Promised behavior | Commands run | Observed | Result |
|-------------------|--------------|----------|--------|
| P1: no --title → exit 2 | 1 | "ship requires --title", exit 2 | PASS |
| P2: --dry-run prints ordered plan (push→pr-create→auto-merge) | 1 | correct 3-step JSON, exit 0 | PASS |
| P3: USAGE self-documents ship + flags | 1 | ship entry present with all flags | PASS |
| P4: devops.md: no WRXN_ACTIVE_AGENT/settings.local.json | 1 (grep) | 0 matches | PASS |
| P5: devops.md: coherent wrxn ship + confirm auto-merge path | read | step 2 = ship, step 3 = confirm; no env dance | PASS |
| P6: bad flag → sane error | 1 | "ship requires --title", exit 2 | PASS |
| P7: empty title string → exit 2 | 1 | "ship requires --title", exit 2 | PASS |
| P8: blank-only title → pure-fn error | 1 | "cannot build ship plan", exit 2 | PASS |
| P9: no git repo → graceful branch error | 1 | exit 2 + branch message (git stderr leak, non-blocking) | PASS |
| P10: dry-run idempotency | 2 | byte-identical output both runs | PASS |
| P11: --base/--body honored | 1 | flags flow to pr-create step | PASS |
| P12: real PR open + auto-merge arm | N/A | UNWALKABLE — deferred to bootstrap self-host walk | DEFERRED |

**Walk coverage:** 5 promised behaviors checked (AC-1, AC-2 structural, AC-4 both parts); 1 UNWALKABLE (AC-3 deferred per instructions); 11 commands run; 6 edge probes run (bad-flag, empty-title, blank-title, no-git-repo, repeat-run, flag-passthrough).
**Findings filed:** 0
**Observations (non-blocking, not filed):** git subprocess stderr leaks through on `execFileSync` when outside a git repo (P9); wrxn's own error is still clear and the exit code is correct.

The real PR-open + auto-merge-on-green is not walkable in isolation — it is deferred to the bootstrap self-host walk (land gate-redesign → apply ruleset → ship a real branch → confirm CI merge).
