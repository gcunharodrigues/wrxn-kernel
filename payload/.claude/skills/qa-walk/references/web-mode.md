# Web walk mode — execution details

The web-specific execution details for the SKILL.md spine. The spine (promises → plan → execute →
file → verdict) is identical to CLI mode; only **how you exercise the artifact** changes: instead of
running shell commands and reading exit codes, you **drive the running app through a browser** and
capture page state, console, and navigation as evidence.

**Exercising the artifact:** the orchestrator supplies a **local target origin** (e.g.
`http://localhost:4317`). Drive a real browser against it with **Playwright** — navigate to each
route, click/fill the promised controls, and read back what the page actually rendered. A web
artifact's contract is *the rendered DOM + the navigation it performs + a clean console*, the way a
CLI's contract is *exit code + stdout*. The walk verifies the app honors the contract the PRD/issues
promised.

**Console errors are first-class evidence.** A page that renders the right HTML but logs an
uncaught error, a failed fetch, or a thrown exception is **not** passing — it is a FINDING, exactly
like a CLI that prints the right output but exits non-zero. **Always attach a console listener
before the first navigation** and keep it for the whole walk; a `console.error`, a `pageerror`
(uncaught exception), or a `requestfailed` during any step is load-bearing evidence. Capture an HTTP
**status** for each navigation too (`response.status()`): a `4xx`/`5xx` on a promised route is a
finding even if the body looks plausible.

## Reading the promised route/control surface

The PRD/issues name the **routes** and the **controls**. Map each to a plan item:

- **PRD routes table / user stories** → one plan item per promised route ("home links to /new and
  /notes", "the form posts and lands on the list").
- **Issue ACs** → concrete checks on a route or a control ("Save creates the note and shows it in
  the list", "empty title shows a validation message, not an error").

Common web promises and how to walk them:

| Promised behavior | Walk it by | Edge probes |
|-------------------|-----------|-------------|
| a **route renders** | `page.goto(origin + route)`, assert status 2xx + a load-bearing selector/text is present | bad route (`/no-such-page` → 404 page, not a crash); empty state (route with no data → empty-state copy); repeat (reload → same render, no console error) |
| a **link navigates** | click it, assert the URL + the destination's marker element | n/a (covered by the destination route's probes) |
| a **form submits** | fill the fields, click submit, assert the resulting page/redirect + the created record appears | bad input (empty/invalid field → validation message + stay on form, NEVER a 500); empty state covered by the list route; **re-submit** (submit the same form twice → no duplicate / explicit "already saved") |

**Driving a probe expected to error.** The happy-path and re-submit probes go through a real
`page.fill` + `page.click` so you exercise the rendered form. A **bad-input probe expected to fail**
(empty field → 500/validation) MAY instead be driven by an in-page `fetch` to the POST route — a real
submit to a 500 strands the browser on an error page, while `fetch` cleanly captures the status + body.
This is the **server-contract** path (like the curl fallback below) running inside a real browser:
**the captured `console.error`/`pageerror` is genuine browser evidence, but the status/body came via
`fetch`** — say so in the evidence line, do not present it as a rendered click. Keep one real rendered
artifact for the finding (a `page.goto` of the error page → screenshot) so the browser half is real.
| a **button triggers an action** | click it, assert the observable DOM/route change | bad state (click when the action is invalid → handled, not thrown); double-click → idempotent |
| a **list/empty view** | load it with 0 records then ≥1 | empty state is the probe itself; repeat (reload → stable) |

## The edge-probe trio, mapped to web

The three mandatory probes per promised interaction (a class that genuinely cannot apply is recorded
`N/A — <reason>`, never silently dropped):

- **Bad input → bad route / invalid form.** Visit an unknown route (expect the app's 404 page, a
  clean `4xx`, no stack trace in the body or console). Submit a form with empty/malformed fields
  (expect an inline validation message and the user kept on the form — a `5xx` or an uncaught
  console error here is the classic web defect).
- **Empty state → first-run / no-data view.** Load a list/detail route before any record exists
  (expect a graceful "nothing here" copy, never a blank page or a thrown render).
- **Repeat-run → re-submit / reload / double-click idempotency.** Re-submit a create form, reload a
  page, or double-click an action button (expect no duplicate record, no corrupted state, no console
  error on the second pass).

## Evidence capture (web)

For each plan item record, in the walk report:

```
> goto <origin><route>            (or: click "<control>", fill "<field>"=<value> then submit)
status: <http status>
console: <none | console.error/pageerror/requestfailed lines, redacted>
dom: <the load-bearing assertion — selector/text found or absent, redirect URL, created record visible>
```

A **screenshot** may be saved into the batch dir as supporting evidence (`NN-<slug>.png`); reference
it by filename in the report. Keep excerpts trimmed to the load-bearing lines — a console excerpt is
proof of a fault, not a full page dump.

**Redaction:** redact per SKILL.md §Execution guardrails — same rule, single source of truth. It
applies to web evidence at every point of capture: console excerpts, captured URLs, DOM text, and
screenshots (crop or omit one that would show secrets; never file it raw).

## No-mocks rule (web)

Drive a **real browser against the real running app** at the supplied origin. Reading the route
handlers to *predict* what a page renders is not a walk — you must *load the page, click the control,
and record what actually happened* (the rendered DOM, the real status, the real console). No request
stubbing, no mocked responses, no asserting against source.

## Playwright unavailable — documented fallback

If Playwright (or its browser binary) cannot be obtained non-interactively in the environment,
**degrade honestly — never fake browser evidence**:

- Drive each route with `curl -i` (capture HTTP status + headers + body) and assert against the
  returned HTML (presence/absence of the promised selector/text, the redirect `Location` header for
  a form POST).
- You **lose** client-side console capture and real click/fill interaction — record that explicitly
  in the walk report (`Walker context` / `Caveats`): "Playwright unavailable; routes driven via curl,
  console-error capture and client-side interaction NOT exercised." Mark any AC that depends on
  in-browser behavior as **partially walked**.
- Form submits are still walkable via `curl --data` against the POST route (status + redirect +
  the created record appearing on the list route). The bad-input probe still catches a server-side
  `5xx`.
- The fallback is bounded **identically** to the browser walk: every `curl` targets
  `<origin><route>` only; **never pass `-L`** (no redirect-following), and an off-origin `Location`
  header is asserted as text, never re-requested — same localhost-origin bound as the web guardrails.

The fallback verifies the server contract; it does not verify the browser contract. Say which one
you ran.
