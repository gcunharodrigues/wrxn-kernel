---
name: audit
description: Use when someone asks to audit their AIOS, score their setup against the Four Cs, or says "is my AIOS working" / "find gaps in my setup". Produces a Four-Cs scoreboard with the top-3 fixes ranked by leverage. Run on Day 7, then weekly.
---

## What this skill does

Score the operator's AIOS against the **Four Cs** and surface the highest-leverage gaps.

## Execution

1. **Read the state.** `connections.md` (what's wired), `aios-intake.md` (what they do), `context/`
   (about + priorities), `decisions/log.md` (recent decisions).
2. **Score each C (0-3):**
   - **Capture** — are tasks / notes / docs landing somewhere the AIOS can reach?
   - **Communicate** — email / chat / calendar connected?
   - **Convert** — revenue / CRM / billing visible?
   - **Coordinate** — team / recordings / automation wired?
3. **Scoreboard.** Print the four scores + a total (/12), and the trend vs. the last audit (read the
   previous score from `decisions/log.md` if one was logged).
4. **Top-3 fixes by leverage.** The three gaps that, if closed, move the score most for the least
   effort. Each: the gap, the one action, the expected point gain.
5. **Log it.** Suggest appending the score + date to `decisions/log.md` so next week shows the climb.
