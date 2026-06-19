# 10 — Harden `.mcp.json` managed-integrity (close the content blind spot)

Status: **RESOLVED 2026-06-19** in `41cebc0` (correction pass) — `managedIntegrity` now deep-equals each
kernel-managed `.mcp.json` server vs payload (catches command/args/env tamper + removal; operator-added servers
pass; corrupt fails closed). Re-gated: review APPROVE / security PASS / qa-walk. Residual (operator-added servers
un-judged) is the tightest false-positive-free boundary, documented + accepted.
Raised by: slice-01 review NB2 + slice-01 security MED-2 (CF-3) + slice-04 security SEC-MED-1 (gate-04 widened it)

## Problem

`.mcp.json` is class `managed` but operator-MERGED, so `managedIntegrity` (slice 01) exempts it from byte-equality
and only JSON-parse-checks it. gate-04 demoted the local managed-guard to advisory, so an injected MCP server
`command` in `.mcp.json` now slips BOTH layers — local (advisory only) and CI (byte-exempt) — and executes on the
next session open. On the auto-merge gate, a PR touching only `.mcp.json` passes `wrxn-ci` and auto-merges.

## Why deferred (not fixed in-build)

The clean fix needs design: `.mcp.json` is **operator-extensible** (operators add their own MCP servers), so you
can neither byte-check it nor allow-list only the kernel server without false-positiving real operator servers.
A partial fix (assert the kernel-managed `recon-wrxn` server entry matches payload, warn on unknown keys) closes
"kernel server swapped" but not "new malicious server injected" without breaking extensibility — a genuine design
tradeoff that belongs in deliberate review, not a rushed mid-build patch.

## Acceptance criteria (for whoever picks this up)

- [ ] Decide the policy: validate kernel-managed server entries against payload; warn-vs-fail on unknown keys.
- [ ] `managedIntegrity` (or a dedicated `.mcp.json` check) enforces it; unit-tested (injected command → caught).
- [ ] No false-positive on a legitimately operator-added MCP server.
- [ ] Suite green.
