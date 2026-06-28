# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`. This is the
WRXN kernel default — a tracker that needs no remote and no `gh`/`glab` CLI.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Switching trackers

To use GitHub or GitLab issues instead, re-run `setup-matt-pocock-skills` and pick the
matching tracker — it will rewrite this file from the right template.

## Per-invocation override: `--repo owner/repo` (cross-repo targeting)

`to-prd`, `to-issues`, and `triage` accept an optional `--repo owner/repo` flag that targets a
named **GitHub** repo for that one invocation, instead of this install's default tracker above. It
exists so the operator can spec / slice / triage a sibling GitHub repo (e.g. the kernel or
`recon-wrxn`) end-to-end from a workspace-install session, without leaving the four-phase pipeline.

- **Absent `--repo`** → the default tracker described above (local-markdown `.scratch/`), unchanged.
  Existing install-local workflows are untouched.
- **`--repo owner/repo`** → publish/manage on that GitHub repo via `gh`, using the shared wrxn triage
  vocab (`ready-for-agent` / `backlog` / `epic`). The repo is passed explicitly to `gh -R owner/repo`
  — it is **not** inferred from a git remote (the tracker TYPE is a config choice, not the remote).
- **Malformed / empty / trailing `--repo`** (anything not exactly `owner/repo`) → the skill refuses
  loud *before* any publish, so a bad invocation never half-files.

The override is per-invocation only; it never reconfigures this install's default tracker. All three
skills resolve the target through the one shared `.wrxn/tracker-target.cjs` helper (see those skills'
"`--repo` / cross-repo targeting" sections), so validation, label handling, and `gh`-arg construction
are identical across them.
