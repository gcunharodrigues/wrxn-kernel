# CLI walk mode — execution details

The CLI-specific execution details for the SKILL.md spine.

**Exercising the artifact:** invoke via the shell exactly as a user would. Capture the exit code
(`$?` / the tool's reported exit) — exit codes are first-class evidence for a CLI. A well-behaved
CLI uses distinct codes (e.g. `0` success, `1` runtime error, `2` unknown command); the walk
verifies the artifact actually honors whatever contract the PRD/issues promise.

**Reading the promised command surface:** the PRD/issues name the subcommands + their contracts.
Map each to a plan item. Every invocation stays inside the execution guardrails (SKILL.md §Execution
guardrails): rooted at the supplied entry point, mutating commands sandboxed. Common CLI promises
and how to walk them:

| Promised behavior | Walk it by | Edge probes |
|-------------------|-----------|-------------|
| `list` enumerates X | run `list`, count/inspect rows vs known state | empty state (no X exist); repeat (identical output) |
| `query <term>` filters | run with a term that hits + a term that misses | no-arg (usage, not crash); repeat |
| `help` / `--help` prints usage | run it, check usage text appears, exit 0 | n/a |
| exit-code contract | run success path + each error path | unknown subcommand → expected non-zero code |
| a write/mutate command | run it **against a disposable copy of the state**, observe the change | run twice (idempotency); bad input (rejected cleanly) — all probes sandboxed |

**Evidence capture (CLI):** for each command record `$ <command>` then `exit: <code>` then the
output excerpt (redacted per SKILL.md §3). A crash (stack trace, unhandled exception, wrong exit
code) is always a FINDING even if "the happy path works."

**No-mocks rule (CLI):** run the actual built script against actual (or disposable-real) inputs.
Reading the source to *predict* behavior is not a walk — you must *run* it and record what happened.
