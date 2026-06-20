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

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
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
// BEFORE the fresh baton exists. We hold: poll the marker until it clears (synth done), bounded by a
// crash safety-cap so a SIGKILLed synth (marker never cleared) can never hang start forever. The
// poll-decision is pure and the loop takes an injected clock, so it is unit-tested with no wall sleep.
const HANDOFF_MARKER_REL = ['.wrxn', 'continuity', '.pending-handoff'];
const HOLD_CAP_MS = 60000; // crash safety-cap: never wait past this for an in-flight synth.
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

function main() {
  let consumed = '';
  try {
    consumed = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin → still try to orient */
  }
  void consumed; // SessionStart carries no field we need beyond the install context

  const root = findInstallRoot();
  if (!root) emit({});

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

module.exports = { holdDecision, holdForHandoff };
