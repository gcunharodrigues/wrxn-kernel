---
name: to-prd
description: Turn the current conversation context into a PRD and publish it to the project issue tracker. Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the PRD using the template below, then publish it to the project issue tracker. Apply the `ready-for-agent` triage label - no need for additional triage.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>

## `--repo` / cross-repo targeting

By default this skill publishes the PRD to the project's configured tracker (see
`docs/agents/issue-tracker.md`). Passing **`--repo owner/repo`** instead targets a named **GitHub** repo
for this one invocation (e.g. the kernel or `recon-wrxn`), so you can spec a sibling repo from this
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
  to every `gh` call, e.g. `gh issue create -R owner/repo --title "…" --body "…" --label backlog`. Apply a
  label from the shared wrxn triage vocab (`ready-for-agent` / `backlog` / `epic`) — a PRD is the parent
  epic, so use `backlog` (or `epic`), not `ready-for-agent`. `gh` fails loud if the target lacks the
  label; do not work around it. The helper's `publishIssue({ target, title, body, label }, gh)` builds
  that exact argv and refuses an off-vocab label — use it as the create boundary.

**Remember the published PRD's issue number.** When you later run `to-issues --repo`, point it at the
**SAME** `owner/repo` so each slice's "Parent" is a real issue number on that tracker (not a dangling
reference).
