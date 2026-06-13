---
id: todo-03
title: "Finding: unquoted multi-word `add` drops trailing words"
status: open
labels: [needs-triage]
---

Status: needs-triage

## Source

QA-walk of wrxn-kernel-22 dogfood (qa-walk-report.md, finding QA-1); also code-review finding #1.

## What happens

`todo add hello world` (unquoted) captures only `hello` — `world` is silently dropped, because the
handler reads `args[0]` and ignores the rest.

## Why it is non-blocking

The PRD behaviour contract specifies quoted text (`add "<text>"`), so this is in-contract. But it is
surprising at the shell, where users routinely type unquoted words.

## Suggested fix (when triaged)

Join the remaining args: `const text = args.join(' ').trim()`. Add a test for the unquoted case.

## Severity

low / non-blocking — a UX sharpening, not a correctness or security defect.
