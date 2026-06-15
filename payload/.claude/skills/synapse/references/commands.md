# SYNAPSE invocation & configuration

## SYNAPSE has no interactive commands

SYNAPSE is not something you call. It is a hook that runs automatically on every prompt. There are no
mode toggles and no management sub-commands — you change its behavior by editing its files or by
setting environment variables. (The legacy engine's interactive command surface was removed.)

## How it is invoked

SYNAPSE is wired as a `UserPromptSubmit` hook in the install's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/synapse-engine.cjs\"" } ] }
    ]
  }
}
```

On each prompt Claude Code passes the event JSON on stdin; the engine returns an envelope whose
`additionalContext` is the `<synapse-rules>` block (or `{}` to inject nothing). It is fail-open: any
fault injects nothing and never blocks the prompt.

## Configuration

| Knob | Where | Effect |
|------|-------|--------|
| `RULES_BUDGET_TOKENS` | `.synapse/manifest` | Token ceiling on the trimmable sections (default 600). |
| `HANDOFF_PCT` | `.synapse/manifest` | Handoff threshold as a window fraction (default 0.40). |
| `CONTEXT_WINDOW` | `.synapse/manifest` | Pin the model window (tokens) for the handoff math. |
| `WRXN_RULES_BUDGET` | env | Overrides the rules budget for the session. |
| `WRXN_HANDOFF_PCT` | env | Overrides the handoff threshold for the session. |
| `WRXN_CONTEXT_WINDOW` | env | Forces the model window for the session. |

To add or change the injected rules, edit the domain files and the registry — see
[domains & rule files](domains.md) and [the manifest format](manifest.md).

## Inspecting it

Run the engine by hand with a sample event to see exactly what it would inject:

```sh
echo '{"prompt":"please deploy","cwd":"'"$PWD"'"}' \
  | node .claude/hooks/synapse-engine.cjs
```

- An empty `{}` means nothing was injected — check that you are inside a wrxn install (a
  `wrxn.install.json` receipt exists at or above `cwd`) and that domains are `active` in the manifest.
- A `<synapse-rules>` block shows the assembled layers; a recall domain (e.g. `routing`) appears only
  when the prompt contains one of its trigger words (the sample above includes `deploy`).

## Source

| File | Purpose |
|------|---------|
| `.claude/hooks/synapse-engine.cjs` | The engine entry point (`main`) + `compose`. |
| `.claude/settings.json` | Wires the `UserPromptSubmit` hook. |
| `.synapse/manifest` | The budget/handoff scalars. |
