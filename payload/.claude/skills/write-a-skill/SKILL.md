---
name: write-a-skill
description: Author a predictable agent skill — or sharpen an existing one — using the theory that earns predictability: the invocation tradeoff, the information-hierarchy ladder, leading words, completion criteria, and the failure-mode vocabulary. Use when someone wants to create, write, build, or improve a skill, design its structure or progressive disclosure, or says "write a skill", "new skill", or "make a skill".
---

# Writing a Skill

A skill exists to **wrangle determinism out of a stochastic system**. **Predictability** — the agent
taking the same *process* every run, not producing the same output — is the root virtue; every lever
below serves it. Author skills by reasoning from that virtue, not by filling a template.

**Scope:** the theory + a light process for writing skills *well*. For packaging mechanics (the
`init_skill.py` scaffold, `package_skill.py` validate-and-zip) use **skill-creator**; for a
separate-context subagent use **write-an-agent**. A skill is a workflow the agent follows inline.

**Bold terms** are defined in **[GLOSSARY.md](GLOSSARY.md)** — the disclosed reference; consult it for
the full domain model.

## Invocation — the first decision

Two choices, trading different costs:

| | Model-invoked | User-invoked |
|---|---|---|
| Reach | agent fires it autonomously + other skills + you by name | only you, by name |
| Cost | **context load** — the description sits in the window every turn | **cognitive load** — *you* are the index that must remember it |
| Mechanics | keep `description`, rich trigger phrasing | `disable-model-invocation: true` |

Pick model-invocation only when the agent (or another skill) must reach it on its own. **wrxn skills
are model-invoked: never set `disable-model-invocation`.** This skill's own frontmatter is the worked
example.

## The description — the routing lever

The description is the one **context pointer** a model-invoked skill always keeps loaded, and the only
thing the agent sees when deciding to load. It does two jobs: state what the skill is, and list the
**branches** that should trigger it. Every word costs context load, so prune it harder than the body:

- **Front-load the leading word** — the description is where it does its invocation work.
- **One trigger per branch.** Synonyms renaming a single branch are **duplication** — collapse them.
- **Cut identity already in the body.** Keep triggers + any "when another skill needs…" reach clause.
- Third person; end on "Use when [specific triggers]".

## Information hierarchy — where each piece sits

A skill is built from **steps** (ordered actions) and **reference** (definitions, rules, facts), mixed
freely. Rank every piece on the ladder by how immediately the agent needs it:

1. **In-skill step** — an ordered action in SKILL.md. The primary tier: what the agent does, in order.
2. **In-skill reference** — a rule or fact consulted on demand. Often a legitimately flat peer-set
   (every rule of a review on one rung) — fine, not a smell.
3. **Disclosed reference** — pushed into a sibling file (like this skill's GLOSSARY.md), reached by a
   context pointer, loaded only when it fires.

**Progressive disclosure** is the move down the ladder so the top stays legible — *licensed by
branching*: inline what every branch needs, push behind a pointer what only some branches reach. A
pointer's *wording*, not its target, decides when and how reliably the agent reaches the material.

This ladder — not a line budget — governs what stays in SKILL.md. It retires the old arbitrary rules
("SKILL.md under 100 lines", "references one level deep"): **sprawl** is the disease, the ladder is the
cure. Push down whatever you can; keep the top legible.

## Completion criteria — defeat premature completion

Each step ends on a **completion criterion** — the condition that tells the agent the work is done. The
strongest criteria are both:

- **Checkable** — can the agent tell done from not-done? A vague bound ("understanding reached") invites
  **premature completion**: the agent declares done and slips to the next step.
- **Exhaustive** where it matters — "every modified model accounted for", not "produce a change list".
  The demand drives thorough **legwork**, and binds flat reference too ("every rule applied").

Sharpening the bound is the cheapest defence against a rushed step — reach for it before any structural
fix.

## Leading words — anchor behaviour in one token

A **leading word** (*Leitwort*) is a compact concept already living in the model's pretraining that the
agent thinks with while running the skill (*lesson*, *fog of war*, *tracer bullets*, *red*/*green*).
Repeated as a token — not as a sentence — it accumulates a distributed definition and anchors a whole
region of behaviour in the fewest tokens, by recruiting priors the model already holds. It serves
predictability twice: in the body it anchors *execution*; in the description it anchors *invocation*
(shared language across your prompts, docs, and code makes the agent fire the skill more reliably).

Hunt restatements a leading word retires — "fast, deterministic, low-overhead" → *tight*; "a loop you
believe in" → *red*. Reach for an existing pretrained word first; a coined word recruits no priors, so
you pay in definition tokens what a pretrained word gives free.

## Prune — and the failure modes it prevents

- **Single source of truth** — each meaning in exactly one place, so a change is a one-place edit.
- **Relevance** — does each line still bear on what the skill does? Cut stale lines.
- **No-op test** — does a line change behaviour versus the model's default? Hunt no-ops sentence by
  sentence; when one fails, delete the whole sentence, don't trim words. Be aggressive. A weak leading
  word (*be thorough* when the agent already is) is a no-op — fix with a stronger word (*relentless*).

Use this vocabulary to diagnose a misbehaving skill:

| Mode | What it is | Cure |
|---|---|---|
| **Premature completion** | a step ends before it's done; attention slips to *being done* | sharpen the criterion first; only then split to hide post-completion steps |
| **Duplication** | one meaning in two places | collapse to a single source of truth |
| **Sediment** | stale layers that settle because adding feels safe, removing risky | a pruning discipline (relevance) |
| **Sprawl** | simply too long, even when every line is live and unique | the ladder — disclose reference, split by branch |
| **No-op** | a line the model already obeys by default | delete it, or strengthen a weak leading word |

## Process

1. **Gather** — the task/domain, the concrete use cases (the **branches**), executable scripts vs just
   instructions, reference material to bundle. Ask only the few that matter; don't overwhelm.
2. **Draft** — write the `description` first (it's the routing lever); body in **imperative form**
   (verb-first, not second person); rank every piece on the ladder; disclose reference behind pointers.
3. **Prune + review** — run the no-op test; check single source of truth + relevance; present to the
   user (covers the cases? missing? right altitude?).

## Validate

- [ ] Frontmatter `---` opens/closes; `name` present, kebab-case, equals the folder.
- [ ] `description` is third person, states what + "Use when…" triggers, front-loads the leading word.
- [ ] **No** `disable-model-invocation` (wrxn skills are model-invoked).
- [ ] Every step ends on a checkable — and where it matters, exhaustive — completion criterion.
- [ ] Reference only some branches need is disclosed behind a pointer, not buried inline.
- [ ] No duplication / sediment / sprawl / no-ops; leading words used consistently throughout.
