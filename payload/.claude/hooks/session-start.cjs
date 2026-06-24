#!/usr/bin/env node
'use strict';

// WRXN session-start hook — the orientation surface (wrxn-kernel-10).
// SessionStart. Injects identity + resume as additionalContext so every new session opens
// oriented. The resume surfaces the handoff baton at .wrxn/continuity/latest.md (single writer =
// the memory synth `memory-synth.cjs`, which writes the baton automatically on SessionEnd); absent
// a baton there is no prior handoff to resume. (The automatic episodic session-page fallback was
// retired with the session-capture subsystem in harvest-01.)
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any fault emits {} (no orientation) — the hook NEVER blocks a session opening.
//
// Contract: SessionStart event JSON on stdin → envelope JSON on stdout (exit 0).
//   inject → { "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }
//   no-op  → {}

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

// ── S2 / #13: the start-HEAD baseline (the reward signal's anchor) ────────────────
// session-start records the session's start commit (git HEAD) into a tiny per-session marker so the
// session-end reward shell can compute "commits made THIS session" EXACTLY (HEAD-then vs HEAD-now). The
// git resolver is injected so the marker-writing core is unit-tested with no real repo; production
// resolves the real HEAD rooted at the install. Wholly fail-open: any fault → no marker, never a throw,
// orientation always proceeds. The marker dir is STATE (runtime, gitignored), keyed by session id.

const BASELINE_DIR_REL = ['.wrxn', 'baseline'];

// safeId — canonicalize a session id used as a FILESYSTEM PATH component (sec-F1): lowercase, collapse every
// non-alnum run to '-', trim, cap length. A raw session id concatenated into a path is a traversal surface;
// this keeps the marker INSIDE .wrxn/baseline. REPLICATED byte-identically from code-intel-push.cjs and the
// session-end reward shell — each install-only hook is self-contained (node stdlib only, no shared import,
// exactly as secretScan is duplicated across the adapters). The reward shell sanitizes the SAME way, so the
// baseline marker round-trips (writer here ↔ reader there) and the read can never miss what this wrote.
function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

// Resolve the install repo's current git HEAD sha. Returns the sha string, or null when there is no git
// / no repo (fail-open). Rooted at the install so a nested cwd can't resolve a different repo's HEAD.
function resolveGitHead(root) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = String(out || '').trim();
    return sha || null;
  } catch {
    return null; // no git binary / not a repo / detached with no commit → no baseline (fail-open)
  }
}

/**
 * Stamp the session's start HEAD into <root>/.wrxn/baseline/<sessionId> as { head, at }. Returns true
 * when a marker was written, false on any fail-open path (no root/session, unresolvable HEAD, unwritable).
 * The HEAD resolver is injected (tests pass a stub); production uses resolveGitHead. NEVER throws.
 * @param {string} root  install root
 * @param {string} sessionId  the session id (marker key)
 * @param {{resolveHead?:Function, now?:Function}} [opts]
 * @returns {boolean}
 */
function stampStartHead(root, sessionId, opts = {}) {
  try {
    if (!root || !sessionId) return false;
    const resolveHead = opts.resolveHead || (() => resolveGitHead(root));
    let head;
    try {
      head = resolveHead();
    } catch {
      return false; // resolver threw → fail-open, no marker
    }
    if (!head || typeof head !== 'string') return false; // unresolvable HEAD → no baseline
    const now = opts.now || Date.now;
    const dir = path.join(root, ...BASELINE_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeId(sessionId)), JSON.stringify({ head, at: now() }));
    return true;
  } catch {
    return false; // best-effort: a baseline-stamp fault must never block session orientation
  }
}

// Walk up from CLAUDE_PROJECT_DIR (or cwd) to the install root carrying wrxn.install.json.
function findInstallRoot(startDir) {
  let dir = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

function identityLine(root) {
  const name = path.basename(root);
  let version = '';
  let profile = 'project';
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'wrxn.install.json'), 'utf8'));
    version = receipt.kernelVersion ? ` v${receipt.kernelVersion}` : '';
    profile = receipt.profile || 'project';
  } catch {
    /* receipt unreadable → name-only identity */
  }
  return `Install: ${name}${version} (${profile} profile)`;
}

// The deliberate handoff baton — the intent-carrying continuity slot. Single writer: the
// auto-handoff synth (memory-synth.cjs, auto-memory-03). Read-only here; its presence is the resume.
function readBaton(root) {
  return readFileOr(path.join(root, '.wrxn', 'continuity', 'latest.md'), null);
}

// ── the SessionEnd-synth hold (auto-memory-03) ──────────────────────────────────
// When a session ends, memory-synth-spawn.cjs raises a `.pending-handoff` marker and launches the synth
// detached; the synth writes the baton then clears the marker. So a back-to-back /clear could start
// BEFORE the fresh baton exists. We hold: poll the marker until it clears (synth done) so the new session
// ALWAYS resumes on the freshly-written handoff — not the previous one. The cap is a crash backstop only
// (a SIGKILLed synth that never clears the marker must not hang start forever), NOT a budget for a healthy
// synth. The poll-decision is pure and the loop takes an injected clock, so it is unit-tested with no wall sleep.
const HANDOFF_MARKER_REL = ['.wrxn', 'continuity', '.pending-handoff'];
// 3 min: a heavy HITL-session synth takes >1min to write its baton; 60s abandoned it mid-write and the
// next session resumed on the PREVIOUS baton (operator-set 2026-06-21). Crash backstop only — never a budget.
const HOLD_CAP_MS = 180000;
const HOLD_POLL_MS = 250; // poll cadence (the real sleep step; tests inject their own).

// A synchronous sleep for the real poll loop (the hook must finish before it emits; tests inject their
// own sleep and never reach this). Atomics.wait blocks the thread without a busy-spin (node stdlib).
function sleepMs() {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_POLL_MS);
  } catch {
    /* SharedArrayBuffer unavailable → degrade to no wait (the loop's wall-cap still bounds it) */
  }
}

/**
 * Pure poll-decision: wait vs proceed, from the marker's presence + age + the cap. No marker → proceed
 * (no synth in flight). Marker present and younger than the cap → wait. Marker at/over the cap → proceed
 * anyway (a crashed synth must not hang start). PURE.
 * @param {{ markerExists:boolean, markerAgeMs:number, capMs:number }} s
 * @returns {'wait'|'proceed'}
 */
function holdDecision({ markerExists, markerAgeMs, capMs }) {
  if (!markerExists) return 'proceed';
  return markerAgeMs >= capMs ? 'proceed' : 'wait';
}

/** Age (ms) of the handoff marker per the injected clock; Infinity if it is absent/unreadable. */
function markerAgeMs(root, now) {
  try {
    const st = fs.statSync(path.join(root, ...HANDOFF_MARKER_REL));
    return Math.max(0, now() - st.mtimeMs);
  } catch {
    return Infinity; // absent → treated as "no marker" by the caller.
  }
}

/**
 * Hold until the in-flight synth clears the handoff marker, or the safety-cap elapses. The clock is
 * injected (now()/sleep()) so the loop is deterministic in tests — NO wall-clock sleep here. Returns
 * 'cleared' (marker gone → fresh baton ready) or 'capped' (gave up at the cap). Never throws.
 * @param {{ root:string, capMs?:number, now?:Function, sleep?:Function }} opts
 * @returns {'cleared'|'capped'}
 */
function holdForHandoff({ root, capMs = HOLD_CAP_MS, now = Date.now, sleep } = {}) {
  const marker = path.join(root, ...HANDOFF_MARKER_REL);
  const wait = sleep || (() => {}); // with no injected waiter the loop takes a single pass then caps (line below).
  const started = now();
  for (;;) {
    const exists = fs.existsSync(marker);
    if (!exists) return 'cleared';
    const age = markerAgeMs(root, now);
    if (holdDecision({ markerExists: true, markerAgeMs: age, capMs }) === 'proceed') return 'capped';
    // also cap on wall-elapsed-since-entry, so a marker with a future/odd mtime still can't hang us.
    if (now() - started >= capMs) return 'capped';
    wait();
    if (!sleep) return 'capped'; // no real waiter injected → don't spin; proceed.
  }
}

// ── baton-staleness guard (#51) ─────────────────────────────────────────────────
// The handoff baton is surfaced as the resume point with no health check, so a baton frozen by a failed
// SessionEnd synth (no-engine / error) is shown as current — silently (real incident 2026-06-22→23: the
// baton froze ~20h while .synth.log logged no-engine from later sessions). This guard reads the synth log +
// the baton mtime and, when the latest synth attempt failed and it is NOT a same-session double-spawn (the
// session that wrote the baton failing again right after — #45), surfaces a visible warning. The DECISION is
// pure (no IO, no clock — the holdDecision idiom); the hook does the IO and formats the age where it holds
// the clock. NO polling/sleeping — one file read + one stat.

const SYNTH_LOG_REL = ['.wrxn', 'continuity', '.synth.log'];

// sec-F2 (#52): cap the .synth.log read at its TAIL. The staleness decision needs only the NEWEST rows (+ the
// latest `wrote`), which live at the END of this append-only log — so reading the last SYNTH_LOG_TAIL_BYTES
// bounds memory against a pathologically large log without losing the signal. A partial first line (a row
// sliced mid-way by the byte window) is dropped so parseSynthLog only ever sees complete rows. FAIL-OPEN +
// total: a sub-cap log is read whole (unchanged); any stat/open/read fault → "" (no rows → no warning, no throw).
const SYNTH_LOG_TAIL_BYTES = 64 * 1024;

function readSynthLogTail(p) {
  let fd;
  try {
    const size = fs.statSync(p).size;
    if (size <= SYNTH_LOG_TAIL_BYTES) return readFileOr(p, '');
    fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(SYNTH_LOG_TAIL_BYTES);
    const read = fs.readSync(fd, buf, 0, SYNTH_LOG_TAIL_BYTES, size - SYNTH_LOG_TAIL_BYTES);
    const text = buf.toString('utf8', 0, read);
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(nl + 1); // drop the partial first line sliced by the byte window
  } catch {
    return ''; // fail-open: any stat/open/read fault → no rows → no warning
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fd already gone — never throw out of the cleanup */ }
    }
  }
}

// A synth row is a FAILURE iff its outcome is `no-engine` or an `error…` string (`wrote`/`trivial` = healthy).
function isFailure(outcome) {
  const o = String(outcome || '');
  return o === 'no-engine' || /^error/.test(o);
}

// Parse the tab-separated synth log into chronological rows { timestampMs, sessionId, outcome }, dropping
// any line we cannot resolve (malformed / unparseable timestamp) — "newest-resolvable last". The sessionId
// (field 1, `-` when absent) is what discriminates a double-spawn from genuine rot. PURE + total, never throws.
function parseSynthLog(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 6) continue; // not a full outcome row → skip (fail-open)
    const ts = Date.parse(f[0]);
    if (!Number.isFinite(ts)) continue; // unresolvable timestamp → drop
    rows.push({ timestampMs: ts, sessionId: f[1], outcome: f.slice(5).join('\t').trim() });
  }
  return rows;
}

// Human age for the warning line (computed where the clock is, so batonStaleness stays clock-free). PURE.
function formatAge(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

// Sanitize the echoed synth outcome before it is interpolated into the orientation block (sec-F1). An
// `error: …` row carries a FREE-FORM message, so a crafted/corrupt log row could smuggle control chars or a
// forged `</wrxn-orientation>` close tag into additionalContext. Strip control chars (incl CR/LF/tab), drop
// angle brackets so no tag can be forged, and cap the length. PURE + total. (Mirrors memory-synth's
// sanitizeLogField idiom — each install-only hook is self-contained, node stdlib only.)
function sanitizeOutcome(s) {
  return String(s == null ? '' : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[<>]/g, '')
    .slice(0, 120);
}

/**
 * Pure baton-staleness decision (#51). Given the baton's last-write time and the synth-log rows
 * (chronological, newest-resolvable last, each carrying its sessionId), return the FAILING outcome to name
 * in the warning, or null when the baton is healthy/fresh. Warn IFF the newest row failed (`no-engine` |
 * `error…`) AND the baton predates that newest row AND it is NOT a same-session double-spawn.
 *
 * Double-spawn vs genuine-rot is discriminated by SESSION ID, NOT by timestamp. The session that wrote the
 * CURRENT baton is the session of the MOST-RECENT `wrote` row (every successful synth logs a `wrote` row in
 * runHandoff's finally, a few ms AFTER it set the baton mtime — so that row's timestamp is ALWAYS ≥ the baton
 * mtime, and a timestamp test can never tell the two apart). The #45 double-spawn logs `wrote` then a spurious
 * `no-engine` ~2s later under the SAME session → suppress. A genuine freeze has later failures from DIFFERENT
 * sessions (real incident 2026-06-22→23: baton written by 6898c0a9, then 7b69b97c / 39e5754b no-engine hours
 * later) → warn. A missing/`-` session id on either side cannot confirm a double-spawn → default to warn (a
 * loud false-positive beats silent rot). PURE + total: no IO, no clock, never throws.
 * @param {{ batonMtimeMs:number, rows:Array<{timestampMs:number, sessionId?:string, outcome:string}> }} [input]
 * @returns {string|null} the failing outcome to name, or null when healthy
 */
function batonStaleness({ batonMtimeMs, rows } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null; // no rows → nothing to judge
  if (typeof batonMtimeMs !== 'number' || !Number.isFinite(batonMtimeMs)) return null; // no usable mtime
  const newest = rows[rows.length - 1];
  if (!newest || !isFailure(newest.outcome)) return null; // latest run healthy → fresh
  if (Number.isFinite(newest.timestampMs) && newest.timestampMs <= batonMtimeMs) return null; // baton at/after newest → fresh
  // The session that wrote the CURRENT baton = the session of the most-recent `wrote` row.
  let wroteSession;
  for (const r of rows) {
    if (r && r.outcome === 'wrote') wroteSession = r.sessionId;
  }
  const sameSession =
    !!wroteSession && wroteSession !== '-' &&
    !!newest.sessionId && newest.sessionId !== '-' &&
    wroteSession === newest.sessionId;
  if (sameSession) return null; // same-session double-spawn → not stale
  return newest.outcome; // genuine rot (or unconfirmable) → name the failing outcome
}

function main() {
  let consumed = '';
  try {
    consumed = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin → still try to orient */
  }
  // SessionStart carries the session id — used to key the start-HEAD baseline marker (#13). Parse
  // defensively; a malformed payload simply yields no session id (the baseline is then skipped).
  let event = {};
  try {
    event = consumed.trim() ? JSON.parse(consumed) : {};
  } catch {
    event = {};
  }

  const root = findInstallRoot();
  if (!root) emit({});

  // Stamp the session's start HEAD so the session-end reward shell can attribute commits made THIS
  // session (#13 / S2). Fail-open: any fault is swallowed and orientation proceeds unchanged.
  try {
    if (event && event.session_id) stampStartHead(root, event.session_id);
  } catch {
    /* never block orientation on the baseline stamp */
  }

  // Hold for an in-flight SessionEnd synth (auto-memory-03) so a back-to-back /clear resumes on the
  // FRESH baton, bounded by the crash safety-cap. Fail-open: any fault here must not block orientation.
  try {
    holdForHandoff({ root, sleep: sleepMs });
  } catch {
    /* never block the session opening on the hold */
  }

  const parts = [identityLine(root)];

  const baton = readBaton(root);
  if (baton && baton.trim()) {
    parts.push('', 'Resume — deliberate handoff baton (.wrxn/continuity/latest.md):', baton.trim());
    // #51: warn if the latest SessionEnd synth failed and no successful write has refreshed the baton since
    // — a frozen baton must not be surfaced as current silently. Fail-open: any read/stat/parse fault → no
    // warning, never a throw. Pure file reads + a stat only (no polling/sleeping beyond the hold cap above).
    try {
      const rows = parseSynthLog(readSynthLogTail(path.join(root, ...SYNTH_LOG_REL)));
      const batonMtimeMs = fs.statSync(path.join(root, '.wrxn', 'continuity', 'latest.md')).mtimeMs;
      const failing = batonStaleness({ batonMtimeMs, rows });
      if (failing) {
        const age = formatAge(Date.now() - batonMtimeMs);
        const outcome = sanitizeOutcome(failing); // sec-F1: never echo a raw log field into the orientation
        parts.push(
          '',
          `WARNING — stale handoff baton: the latest memory-synth run failed ("${outcome}") and the baton has not been refreshed for ${age}. It may not reflect the last session — see .wrxn/continuity/.synth.log.`,
        );
      }
    } catch {
      /* fail-open: a staleness-check fault must never block orientation (#51 AC3) */
    }
  } else {
    parts.push('', 'Resume — no prior handoff.');
  }

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: ['<wrxn-orientation>', ...parts, '</wrxn-orientation>'].join('\n'),
    },
  });
}

if (require.main === module) {
  try {
    main();
  } catch {
    emit({}); // fail-open: never block a session opening
  }
}

module.exports = { holdDecision, holdForHandoff, HOLD_CAP_MS, stampStartHead, resolveGitHead, BASELINE_DIR_REL, batonStaleness, parseSynthLog, readSynthLogTail, SYNTH_LOG_TAIL_BYTES };
