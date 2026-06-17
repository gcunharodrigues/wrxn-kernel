# ADR 0005 — `harvest` is the curation loop: merge-then-delete is the only sanctioned knowledge deletion; propose→confirm by reference; session-capture retired for handoff-dream

- **Status:** Accepted (2026-06-17) — wrxn Phase 5 grill-with-docs (8 decisions locked); PRD `harvest-prd`.
- **Context:** `dream` writes knowledge **additively with dedup-skip** (ADR 0003): it skips an exact
  title/slug collision but lets through two *differently-titled* pages on the same topic. So the four
  knowledge tiers (`concepts` / `decisions` / `gotchas` / `_rules`) slowly silt up — near-duplicates
  accumulate, superseded pages linger beside their replacements, and pages whose `derived_from:` source
  code was deleted go orphaned. Recall then surfaces a thicket where one clean page belongs: the slow
  inverse of the recall-poisoning the intelligence rebuild fixed — not *wrong* memory, but *redundant,
  stale, undifferentiated* memory. ADR 0003 explicitly **deferred merge / dedup / decay to harvest**
  (Phase 5), as `ai-memory` itself defers merge. Separately, the mechanical **session-capture** subsystem
  (`session-end` wrote a thin breadcrumb page + capped the tier; `session-history` recorded turn-trails)
  produced low-value breadcrumbs the wiki never benefited from — the rich consolidation already happens via
  `dream` on the live session.
- **Decision drivers:** (1) curation is **destructive** — it deletes and rewrites curated pages — so it
  carries strictly more risk than dream's additive writes and must be gated harder; (2) "bad memory is
  worse than no memory" (ADR 0003) extends to *losing* memory: a careless merge that drops a fact is a
  silent regression of the knowledge base; (3) SOTA memory systems converge on **eviction/down-weight, not
  deletion** (Letta evicts rather than deletes; Generative Agents rank by recency×importance×relevance;
  A-MEM forward-links rather than overwrites); (4) the session breadcrumbs are not a consolidation source —
  the handoff is the natural close-out moment, where dream consolidates the live session and harvest curates
  the enlarged set.

## Decision

`harvest` is a **user-invocable kernel skill** over a self-contained install-local adapter
(`.wrxn/harvest.cjs`, sibling to `dream.cjs` / `sync.cjs`), sharing dream's whole safety spine. Two layers:
an auto, **report-only health-check** (`check` — near-dup clusters, decay candidates, malformed pages →
a durable `.wrxn/harvest/<ts>.jsonl`, touches nothing) and a **propose→confirm destructive curation** layer
(merge + decay). Four locked choices anchor it.

- **Merge-then-delete is the ONLY sanctioned knowledge deletion.** A knowledge page is deleted *only* when
  its content has been provably folded into a survivor: the skill LLM-synthesises **one** survivor from N
  near-duplicates (union of facts + union of evidence), and on confirm the adapter **writes the survivor
  first, then deletes the absorbed** (`merged_from:` provenance stamped on the survivor). Nothing else
  deletes — there is no free-form delete path, and only a staged cluster's absorbed members are ever
  removed. This makes deletion **loss-free by construction**: the knowledge survives the page.

- **Decay never deletes — it forward-links or flags.** A superseded page gets a `superseded_by:` forward
  link; an orphaned page (its source file gone) gets a `stale: <missing-path>` flag. Both are single-key,
  in-place frontmatter stamps with the body preserved byte-for-byte. Provenance survives (Letta
  eviction-not-delete; A-MEM forward-link). A page surfaced in Recall within the **30-day** reinforcement
  window is live knowledge and is never flagged.

- **Propose → confirm, committed by reference.** Every destructive act is **staged** by reference (recorded
  to `.wrxn/harvest/staged.jsonl` / `decay-staged.jsonl` with a sha256 integrity hash, the live page
  untouched), **presented** to the operator, and **committed** only on confirmation — and the operator
  approves a list of **references** (survivor paths / page paths), not a rebuilt proposal. The adapter
  **re-runs the full gate at the write boundary** (secret-scan, integrity check, path-confinement, survivor
  is new). This binds *committed == staged == presented*: a proposal the gate would reject — or one altered
  after staging — can never write or delete, even if its reference is force-approved. This refines dream's
  propose-then-confirm: because curation is destructive, confirmation is non-negotiable and the by-reference
  + re-gate split is the structural guarantee against a tampered or stale approval.

- **Session-capture is retired; the handoff is the close-out for dream → harvest.** The `session-end`
  breadcrumb writer, the `session-history` turn-trail recorder, and the `sessions` tier they fed are
  removed (payload + a migration sweeping existing installs). They produced episodic breadcrumbs the wiki
  never consolidated. The close-out moment is now **dream** (consolidate the rich live session) →
  **harvest** (curate the enlarged knowledge set), nudged at handoff — harvest **debt-gated** (only when the
  health-check finds debt), after dream. `session-start` stays (it reads the continuity baton; only its dead
  "latest session page" fallback is trimmed) — the continuity doctrine is intact.

## Consequences

- The knowledge tiers can be **compacted without losing knowledge**: near-dups collapse to one
  authoritative page, superseded/orphaned pages are marked rather than silently kept or blindly deleted.
- Destructive curation is **safe by the same discipline as dream, hardened**: stage → present → confirm →
  re-gate-at-write. No clobber, no poisoning, no silent fact-loss; an audit jsonl records every act.
- The lifecycle simplifies to **dream + harvest at handoff** — one rich consolidation path, not a parallel
  low-value breadcrumb stream. `wrxn update` removes the dead hooks + sweeps the retired tier.
- **Limits accepted:** merge synthesis is an LLM act behind the operator's confirm + a reflection rubric
  (no automatic inferred merges); the survivor is a **net-new** page (the adapter writes before it deletes,
  so a survivor can't reuse an absorbed slug); the health-check's near-dup arm needs the recon serve door
  warm (it fails soft to "unavailable", never to a false "clean").

## Considered and rejected

- **Auto-deletion / garbage-collection of low-value pages** — reintroduces the silent knowledge-loss and
  recall-poisoning risks the rebuild fixed; deletion must always be provable folding into a survivor.
- **In-place overwrite-merge** (rewrite one near-dup in place, delete the other) — no clean before/after,
  no provenance, and it mutates a curated page without the survivor-before-delete guarantee.
- **Time-based decay that deletes stale pages** — SOTA down-weights, it doesn't delete; a long-unused page
  may still be the only record of a rare fact. Decay sinks rank (recon-wrxn ADR 0005); it never removes.
- **Re-distilling expired session breadcrumbs into knowledge** — the breadcrumbs are thin prompt
  first-lines with nothing minable; consolidation is dream on the live session, not a backlog sweep.
- **A separate confirm UI / daemon** — harvest is a deliberate, attended skill over a node-testable
  adapter; no server, no scheduler (mirrors dream / sync).

## Sources

Plan memory `wrxn-intelligence-rebuild-plan` (decisions 6/7/9). Kernel ADR 0003 (dream — additive +
dedup-skip, merge deferred to harvest) and ADR 0004 (sync — propose→confirm-by-reference re-stamp).
recon-wrxn ADR 0005 (importance×recency decay-weight). SOTA: Generative Agents (recency × importance ×
relevance retrieval), A-MEM (forward-link supersession), Letta (eviction, not deletion). Adapter
`.wrxn/harvest.cjs` (harvest-02 health-check, harvest-03 merge, harvest-04 decay). PRD `harvest-prd`
(8 locked grill decisions); CONTEXT.md (harvest / health-check / decay / reinforcement glossary).
