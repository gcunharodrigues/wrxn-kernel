'use strict';

// Tests for the SessionStart HOLD (auto-memory-03, AC4) — the bounded wait the existing session-start
// hook performs BEFORE its baton read, so a back-to-back /clear resumes on the FRESH handoff the
// in-flight synth is still writing (PRD stories 3, 4). The wait is bounded by a crash safety-cap so a
// SIGKILLed synth can never hang the next session start forever.
//
// DESIGN LOCK (PRD testing decisions): test the PURE poll-decision function and the loop with an
// INJECTED clock — NEVER a wall-clock sleep. holdDecision is pure; holdForHandoff loops over injected
// now()/sleep() so "the marker clears after N polls" and "the marker is older than the cap" are both
// deterministic with no real time.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const start = require('../payload/.claude/hooks/session-start.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function continuityDir(root) {
  const d = path.join(root, '.wrxn', 'continuity');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function handoffMarker(root) {
  return path.join(root, '.wrxn', 'continuity', '.pending-handoff');
}

// ── the pure poll-decision ──────────────────────────────────────────────────────
// Given the marker's presence + age + the safety-cap, decide wait vs proceed. No I/O, no clock.

test('holdDecision: no marker → proceed immediately (no synth in flight)', () => {
  assert.equal(start.holdDecision({ markerExists: false, markerAgeMs: 0, capMs: 60000 }), 'proceed');
});

test('holdDecision: a fresh marker present → wait (synth still writing the baton)', () => {
  assert.equal(start.holdDecision({ markerExists: true, markerAgeMs: 1000, capMs: 60000 }), 'wait');
});

test('holdDecision: a marker older than the safety-cap → proceed anyway (crashed synth never hangs start)', () => {
  assert.equal(start.holdDecision({ markerExists: true, markerAgeMs: 90000, capMs: 60000 }), 'proceed');
  // exactly at the cap is also a proceed (the cap is the upper bound on the wait).
  assert.equal(start.holdDecision({ markerExists: true, markerAgeMs: 60000, capMs: 60000 }), 'proceed');
});

// ── the loop, driven by an INJECTED clock (no wall-clock sleep) ──────────────────

// A fake clock: now() advances by `step` ms on each injected sleep() call.
function fakeClock(startMs, step) {
  let t = startMs;
  return {
    now: () => t,
    sleep: () => { t += step; },
    at: () => t,
  };
}

test('holdForHandoff returns once the marker clears — polling via the injected clock, never real time', () => {
  const root = tmp('wrxn-hold-clears-');
  continuityDir(root);
  // marker present now; it will be removed after the 3rd poll (the synth finished + cleared it).
  fs.writeFileSync(handoffMarker(root), String(0));
  const clock = fakeClock(0, 1000);
  let polls = 0;
  const result = start.holdForHandoff({
    root,
    capMs: 60000,
    now: clock.now,
    sleep: () => {
      polls += 1;
      if (polls === 3) fs.unlinkSync(handoffMarker(root)); // synth clears the gate on its exit.
      clock.sleep();
    },
  });
  assert.equal(result, 'cleared', 'the hold ended because the marker cleared (synth done)');
  assert.equal(polls, 3, 'it polled until the marker was gone — no wall-clock sleep involved');
});

test('holdForHandoff gives up at the safety-cap when the marker never clears (crashed synth)', () => {
  const root = tmp('wrxn-hold-cap-');
  continuityDir(root);
  fs.writeFileSync(handoffMarker(root), String(0)); // present and never removed (synth was SIGKILLed).
  const clock = fakeClock(0, 10000); // each poll advances 10s; cap 60s → it must stop by ~6 polls.
  let polls = 0;
  const result = start.holdForHandoff({
    root,
    capMs: 60000,
    now: clock.now,
    sleep: () => { polls += 1; clock.sleep(); },
  });
  assert.equal(result, 'capped', 'the hold ended at the safety-cap, not by the marker clearing');
  assert.ok(polls <= 7, 'it stopped near the cap (bounded), never spinning forever');
  assert.ok(fs.existsSync(handoffMarker(root)), 'the stale marker is left as-is — the synth owns it, not start');
});

test('holdForHandoff returns immediately when there is no marker (the common case: no synth in flight)', () => {
  const root = tmp('wrxn-hold-none-');
  continuityDir(root);
  let polls = 0;
  const result = start.holdForHandoff({
    root,
    capMs: 60000,
    now: () => 0,
    sleep: () => { polls += 1; },
  });
  assert.equal(result, 'cleared', 'no in-flight synth → proceed at once');
  assert.equal(polls, 0, 'no sleep at all when there is nothing to wait for');
});
