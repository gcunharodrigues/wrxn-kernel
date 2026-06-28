---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. These issues are considered ready for AFK agents, so publish them with the correct triage label unless instructed otherwise.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or modify any parent issue.

## `--repo` / cross-repo targeting

By default this skill publishes the slices to the project's configured tracker (see
`docs/agents/issue-tracker.md`). Passing **`--repo owner/repo`** instead targets a named **GitHub** repo
for this one invocation (e.g. the kernel or `recon-wrxn`), so you can slice a sibling repo from this
session without leaving the pipeline. Resolve the target through the ONE shared helper —
`.wrxn/tracker-target.cjs` — never hand-roll the parsing:

```bash
# WITH --repo present: pass the owner/repo value as the trailing argument.
node -e 'console.log(JSON.stringify(require("./.wrxn/tracker-target.cjs").resolveTarget(process.argv[1])))' "owner/repo"
# WITHOUT --repo: OMIT the argument entirely (process.argv[1] is undefined → resolves to local).
# NEVER pass "" — resolveTarget("") THROWS (empty is malformed, not "absent"), which would break the local path.
node -e 'console.log(JSON.stringify(require("./.wrxn/tracker-target.cjs").resolveTarget(process.argv[1])))'
```

It returns `{ mechanism, repo, ghBaseArgs }` and **throws loud** on a malformed / empty / trailing
`--repo` BEFORE any publish — let that refusal surface; never proceed on a bad target.

- **`mechanism: "local"`** (no `--repo`) → publish exactly as today, to `.scratch/` — unchanged.
- **`mechanism: "github"`** → publish via `gh`, prepending the returned **`ghBaseArgs`** (`-R owner/repo`)
  to every `gh` call, e.g. `gh issue create -R owner/repo --title "…" --body "…" --label ready-for-agent`.
  Slices are AFK-ready, so apply `ready-for-agent` from the shared wrxn triage vocab
  (`ready-for-agent` / `backlog` / `epic`). `gh` fails loud if the target lacks the label; do not work
  around it. The helper's `publishIssue({ target, title, body, label }, gh)` builds that exact argv and
  refuses an off-vocab label — use it as the create boundary.

**Target the SAME `owner/repo` the PRD was published to** (via `to-prd --repo`), so each slice's "Parent"
references a real PRD issue number on that tracker. Publish slices in dependency order so the "Blocked by"
field can cite real issue identifiers.
