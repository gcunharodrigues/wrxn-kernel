---
name: dream
description: Consolidate the live session into durable wiki memory — reflect on this conversation, draft evidence-backed Proposals (concept/decision/gotcha/rule), gate each through the dream adapter, and on your confirmation write net-new pages the Brain will recall next time. Use when someone says "dream", "consolidate this session", "save what we learned", or wants to capture durable memory before a handoff.
user-invocable: true
---

# dream — session consolidation

dream turns what you learned in **this session** into durable wiki pages the **Brain** will recall in
future sessions. You **propose**; the deterministic adapter **judges**. Every page must quote the
session that justifies it, and **nothing is written without the operator's confirmation** — so a bad
proposal can never poison recall. "Bad memory is worse than no memory."

## Indirection contract (MUST)

> Drive the adapters. NEVER write wiki files directly and NEVER re-implement the gate.

- Validate / stage / commit go through **`.wrxn/dream.cjs`** (the Validation gate + audit + writer).
- Wiki reads (to check what already exists, or to confirm recall) go through **`.wrxn/wiki.cjs`**.
- The skill is the **semantic** filter (you don't even draft junk); the adapter is the **mechanical**
  backstop (it rejects what slips through). Run a proposal the gate rejected? It is never written.

## The loop

1. **Reflect** on the live conversation already in your context. Do NOT read transcripts or stored
   session pages — reflect on what is in front of you, this session only.
2. **Draft** candidate Proposals (see schema + rubric below), each grounded in a **verbatim quote**
   from THIS session. If the session yields no durable insight, **abstain** — propose nothing.
3. **check** the batch through the adapter; drop or fix anything it rejects (never carry a reject
   forward).
4. **stage** the validated batch — records it to the audit trail, outside the recalled wiki.
5. **Present** the staged batch to the operator and wait for confirmation.
6. **commit** only the operator-approved subset — net-new pages, additively, into their tiers.

If reflection surfaces nothing durable, or the gate rejects every proposal, **stop**: say so, stage
nothing, commit nothing. Restraint is a success, not a failure.

## FAITHFULNESS — the most important rule

The wiki records *what happened in this project, this session* — not what you know about the topic in
general. You are not writing tutorials, documentation, or reference material. Every claim in every
page MUST trace to the session in front of you.

Do NOT:
- Invent dates, version numbers, commit hashes, author names, file paths, function names, line
  numbers, or error codes that did not appear in the session.
- Add "When to use" / "Best practices" / "Alternatives" / "See also" sections that weren't grounded in
  the session — those are reference-material patterns, not memory.
- Enumerate options that weren't actually considered, or expand a terse operator comment into an essay.
- Fabricate code or speculate about consequences the session itself didn't raise.

Do:
- Compress the session into well-titled pages with the right `kind`.
- **Preserve the operator's actual phrasing** for decisions and rules — it is load-bearing.
- Write each page at the length the session actually warrants — dense fact, no padding, no truncation.
- If the session yields no durable insight, **abstain**. Resist the urge to manufacture content.

## What to propose — the `kind` rubric

Exactly one kind per Proposal; `tier` must agree with `kind`.

| kind       | tier         | propose when the session produced…                                            |
|------------|--------------|-------------------------------------------------------------------------------|
| `decision` | `decisions`  | a choice of X over Y, with its rationale and consequences (why the project is the way it is) |
| `gotcha`   | `gotchas`    | a reproducible pitfall / failure mode, its root cause, and the mitigation     |
| `concept`  | `concepts`   | stable architecture or domain knowledge (synthesis, not a task chronology)    |
| `rule`     | `_rules`     | an always/never project convention the session established — a standing rule, recalled like a concept (NOT a SYNAPSE always-on rule; see Boundaries) |

Two unrelated insights stay **two** pages — never merge them into one. Small pages, stable
kebab-case names (Karpathy LLM-wiki style). Cap a run at **≤ 5** proposals.

## What NOT to propose — anti-superstition

Do not even draft these. A transient or false "memory", once recalled, hardens into a permanent false
constraint on every future session. (The adapter rejects them too — but you are the first filter.)

| Reject                          | Why                                                                  |
|---------------------------------|----------------------------------------------------------------------|
| "tool X is broken"              | A broad negative tool claim hardens into a permanent false refusal after the tool is fixed. |
| Transient env / setup failures  | ENOENT, connection refused, timeouts, flaky/intermittent, rate-limits, a missing binary — stale false constraints, not durable truth. |
| Smoke / sanity / happy-path checks | Operational evidence, not reusable knowledge.                     |
| Release / version markers       | A one-time event (a version bump, a changelog, an npm publish), not a lesson. |
| One-off task narratives         | "Renamed a file", "fixed a typo", a trivial chore — episodic, already captured. |
| **wrxn itself**                 | Never memorialize wrxn's own routing / skills / synapse / hooks / constitution / adapters — the memory system must not pollute itself. |

## Proposal schema

A Proposal is one JSON object. A run is a JSON **array** of them (the batch).

```jsonc
{
  "kind":  "concept" | "decision" | "gotcha" | "rule",      // pick one
  "tier":  "concepts" | "decisions" | "gotchas" | "_rules", // = f(kind); MUST agree
  "slug":  "kebab-case-page-name",                  // stable name
  "title": "One-line page title",
  "body":  "# Title\n\n…markdown… ",                // MUST start with '# '
  "confidence": 0.0,                                 // honest 0–1; the gate floor is 0.75
  "rationale": "Why this is durable.",
  "evidence": [                                      // >= 1, each a VERBATIM quote from THIS session
    { "quote": "exact words from the session", "source": "file:line | commit | turn-N" }  // source optional
  ]
}
```

## Driving the adapter

Run from inside the install (the adapter walks up to `wrxn.install.json` to find the root — no
`--root` needed). Write each batch to a **throwaway temp file** (it is scratch input, not a wiki page;
only the adapter's own `.wrxn/dream/*.jsonl` audit files persist).

**1 — check** (the gate; PROPOSE, then let it JUDGE):

```bash
node .wrxn/dream.cjs check /tmp/dream-batch.json
```

A batch returns `{ abstained, accepted[], rejected[ {index, slug, reason} ] }`. Each `reason` is a
machine code — `confidence_below_threshold`, `missing_evidence`, `missing_rationale`,
`body_missing_h1`, `unsupported_tier`, `kind_tier_mismatch`, `duplicate_existing_path`,
`duplicate_existing_title`, `max_proposals_exceeded`, or a `negative_filter_*`. Fix or drop every
rejected proposal; re-check until the batch is clean. If it returns `{ abstained: true }` (or every
proposal is rejected), **stop** — write nothing.

**2 — stage** (record the validated batch to the audit trail; nothing reaches the wiki yet):

```bash
node .wrxn/dream.cjs stage /tmp/dream-batch.json
```

**3 — present, then confirm.** Show the operator each staged proposal — its **tier/slug**, **title**,
**confidence**, the **verbatim evidence quote**, and the one-line rationale — and ask which to approve.
Never skip this step. If the operator approves none, you are done: commit nothing.

**4 — commit** (write ONLY the operator-approved subset). Build a JSON array of just the approved
Proposals and commit it:

```bash
node .wrxn/dream.cjs commit /tmp/dream-approved.json
```

`commit` writes each net-new page to its tier via `wiki.cjs` and **dedup-skips** any whose path
already exists — it never clobbers a curated page. It returns `{ written[], skipped[] }`.

**5 — confirm recall (optional).** The committed pages are plain `.md` in the wiki, so the Brain
recalls them automatically next session. Spot-check with a wiki query:

```bash
node .wrxn/wiki.cjs query "<a phrase from a page you just wrote>"
```

## Refreshing the focus slot

`_slots/current-focus.md` is the project's **durable standing focus** — a short statement of what the
project is centered on right now, recall-surfaced like any other page. It is the **lone updatable wiki
page**: every knowledge page is additive + dedup-skip, but the focus slot may be **overwritten in
place**.

This is **not** the knowledge-proposal loop — do not run a focus update through `check` / `stage` /
`commit` (those are for evidence-backed concept/decision/gotcha/rule pages). The slot has its **own op**:

1. Draft a short standing-focus statement (a few lines of markdown, body starting with `# `).
2. **Present it to the operator and wait for confirmation** — like every dream write.
3. On approval, write it via the dedicated op — it overwrites the slot in place:

```bash
node .wrxn/dream.cjs set-focus /tmp/dream-focus.json   # { "title": "Current focus", "body": "# Current focus\n\n…" }
```

**Continuity doctrine — do not cross these wires.** The focus slot is **disjoint** from the handoff
**baton** (`.wrxn/continuity/latest.md`): different path, different writer. `set-focus` NEVER reads or
writes the baton, and the **handoff** skill remains its sole writer. The baton is ephemeral cross-session
resume; the focus slot is durable standing context. Keeping their paths and writers separate is the
structural fix that stops a deliberate handoff from being clobbered.

## Boundaries

- **Current session only.** No transcript mining, no cross-session backlog.
- **Additive only, save one slot.** dream creates net-new knowledge pages; merging or refreshing an
  existing page is out of scope (that is harvest, a later phase). The **lone exception** is the focus
  slot `_slots/current-focus.md`, which `set-focus` overwrites in place (see *Refreshing the focus slot*).
- **Never autonomous.** dream is a deliberate, attended, operator-confirmed skill — never a background
  run, never a write without confirmation.
- **`_rules` ≠ SYNAPSE.** A `rule` page is *recalled knowledge* — the Brain surfaces it like a concept
  or gotcha. It is NOT a SYNAPSE always-on rule. Promoting a `_rules` page into SYNAPSE's curated
  always-injected set (`.synapse/`) is a separate, deliberate act — **dream NEVER edits `.synapse/`**.

## Source

WRXN Kernel issue dream-02. Adapter: `.wrxn/dream.cjs` (dream-01). Prompts adapted from
`akitaonrails/ai-memory` (`auto_improve` system prompt, the `batch_consolidate` FAITHFULNESS block,
the `kind` rubric, the `docs/auto-improvement-loop.md` negative-filter list). ADR 0003; PRD
`dream-prd`.
