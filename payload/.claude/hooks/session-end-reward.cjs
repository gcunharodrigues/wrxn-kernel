#!/usr/bin/env node
'use strict';

// WRXN session-end reward shell — the learning-moat's outcome attributor (kernel #13 / S2).
// SessionEnd. A thin, FAIL-OPEN hook that turns "did this session ship durable work?" into a per-page
// reward update. It reads the start-HEAD baseline (stamped by session-start), this session's surfaced
// set (the per-session surfaced-log .wrxn/surfaced.json by session id), derives a GIT-GROUNDED outcome
// signal, and persists updated Beta-Bernoulli counts (.wrxn/reward.json) via the shared coalesceSidecar
// helper. The pure reward math lives in reward.cjs; this shell only supplies git facts + IO.
//
// SIGNAL (resolved): Article III makes a landed commit green by construction (the commit gate runs the
// suite), so the production signal is git-only and cheap — the suite is NEVER run here:
//   · new non-revert commit(s) since baseline ⇒ +1 (good)
//   · a `git revert` / recorded correction of this session's work ⇒ −1 (bad)
//   · no new commits ⇒ neutral (no update)
// The pure deriveSignal takes the new-commit subjects explicitly, so a future stricter signal can be
// swapped in without touching the math.
//
// SHADOW: this shell only WRITES counts — it never reads or writes recall ranking (the re-rank is S3).
// Self-contained: ships into installs, MUST NOT import the kernel lib — node stdlib ONLY (+ the
// co-located sidecar.cjs / reward.cjs siblings). Fail-open: any fault emits {} (no update), never blocks
// a session closing.
//
// Contract: SessionEnd event JSON on stdin → {} on stdout (exit 0).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { coalesceSidecar } = require('./sidecar.cjs');
const { updateReward } = require('./reward.cjs');

const BASELINE_DIR_REL = ['.wrxn', 'baseline'];
const SURFACED_REL = ['.wrxn', 'surfaced.json'];
const REWARD_REL = ['.wrxn', 'reward.json'];

// safeId — canonicalize a session id used as a FILESYSTEM PATH component (sec-F1): lowercase, collapse every
// non-alnum run to '-', trim, cap length. The baseline marker is keyed by session id; a raw id like
// '../../evil' would traverse out of .wrxn/baseline. REPLICATED byte-identically from session-start.cjs /
// code-intel-push.cjs — each install-only hook is self-contained (node stdlib only, no shared import, exactly
// as secretScan is duplicated across the adapters). session-start sanitizes the SAME way, so the marker the
// reward shell reads + stamps is exactly the one session-start wrote. NB: the surfaced-log MAP KEY stays RAW
// (a JSON key is not a path; raw preserves join parity with the S1 surfaced-log writer) — only paths sanitize.
function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

// Walk up from cwd / CLAUDE_PROJECT_DIR to the install root carrying wrxn.install.json (mirrors the
// sibling session hooks). Returns null when no install is found (the hook then no-ops, fail-open).
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

// A commit subject is a REVERT when git's own `git revert` wrote it: "Revert "<subject>"". Used to flip
// a session bad — its work did not durably hold. Matched on the canonical prefix git emits.
function isRevertSubject(s) {
  return /^Revert "/.test(String(s || ''));
}

/**
 * PURE: derive the outcome signal from the new commits made since the session's start-HEAD baseline.
 *   newCommits present and none is a revert ⇒ +1 (good)
 *   any new commit is a `git revert`            ⇒ −1 (bad — the session work was corrected)
 *   no new commits                              ⇒ 0  (neutral — nothing to attribute)
 * TOTAL: any garbage (null, non-array) is treated as "no new commits" → neutral, never throws.
 * @param {{newCommits?: string[]}} facts  the git facts gathered by the shell (subjects of baseline..HEAD)
 * @returns {-1|0|1}
 */
function deriveSignal(facts) {
  const list = facts && Array.isArray(facts.newCommits) ? facts.newCommits : [];
  if (!list.length) return 0; // no new commits → neutral
  if (list.some(isRevertSubject)) return -1; // a revert flips the session bad
  return +1; // new non-revert work, green by construction (Art. III commit gate)
}

// Read the start-HEAD baseline marker for `sessionId` → { head, rewarded }, or null (absent/malformed →
// no baseline, the shell then no-ops: without a known start commit "commits this session" is undefined).
// `rewarded` is the once-per-session guard: set true after this session's first credit. Fail-open.
function readBaseline(root, sessionId) {
  try {
    const raw = fs.readFileSync(path.join(root, ...BASELINE_DIR_REL, safeId(sessionId)), 'utf8');
    const rec = JSON.parse(raw);
    const head = rec && typeof rec.head === 'string' ? rec.head.trim() : '';
    if (!head) return null;
    return { head, rewarded: !!(rec && rec.rewarded) };
  } catch {
    return null;
  }
}

// Mark the session's baseline marker as rewarded (the once-per-session guard) so a second SessionEnd for
// the same session is a no-op. Best-effort: a failure to stamp the guard must not throw — at worst the
// next run re-credits, which the coalesced no-op already softens for an unchanged surfaced set.
function markRewarded(root, sessionId) {
  try {
    const file = path.join(root, ...BASELINE_DIR_REL, safeId(sessionId));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.rewarded = true;
    fs.writeFileSync(file, JSON.stringify(rec));
  } catch {
    /* best-effort guard */
  }
}

// Read THIS session's surfaced set from the per-session surfaced-log (.wrxn/surfaced.json).
// sec-F3 (carried from S1): every value is treated STRICTLY as a join key — a page-identity STRING —
// and is NEVER passed to fs as a path to open. We join on the key space only. Returns a de-duplicated
// array of string keys, or [] (absent / malformed / no entry for this session). Fail-open.
function readSurfacedSet(root, sessionId) {
  let map;
  try {
    map = JSON.parse(fs.readFileSync(path.join(root, ...SURFACED_REL), 'utf8'));
  } catch {
    return []; // absent or malformed surfaced-log → nothing to attribute
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  const entry = map[sessionId];
  if (!Array.isArray(entry)) return [];
  const seen = new Set();
  const out = [];
  for (const v of entry) {
    if (typeof v !== 'string') continue; // join keys are strings; ignore anything else (never coerce)
    const key = v;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Production git facts: the subjects of the commits made since the session's start-HEAD baseline, i.e.
// `git log <baseline>..HEAD --format=%s`. An empty range (HEAD unchanged) → [] → neutral. Rooted at the
// install; fail-open (no git / bad range → no facts → neutral). NEVER runs the suite (Art. III makes a
// landed commit green by construction — the signal is git-only and cheap).
function gitFactsSince(root, baselineHead) {
  // sec-F2: the baseline head comes from an on-disk marker that could be corrupt — only a sha-SHAPED value
  // may become a git revision. A missing or non-sha head (option-/ref-expression-shaped) ⇒ neutral, never an
  // arg to `git log` (defense-in-depth: execFile already blocks the shell; this blocks ref/option abuse).
  if (!baselineHead || !/^[0-9a-f]{7,40}$/.test(baselineHead)) return { newCommits: [] };
  try {
    const out = execFileSync('git', ['log', `${baselineHead}..HEAD`, '--format=%s'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const newCommits = String(out || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return { newCommits };
  } catch {
    return { newCommits: [] }; // unknown baseline sha / no git → treat as no new commits (neutral)
  }
}

/**
 * The testable persist core. Reads the session's start-HEAD baseline + surfaced set, derives the
 * git-grounded signal (git facts injected in tests, gathered from real git in production), applies the
 * pure Beta-Bernoulli update ONCE for the session, and persists the updated counts to .wrxn/reward.json
 * via coalesceSidecar. Returns {} always. FAIL-OPEN: any fault → {} (no update), never blocks close.
 *
 * No-op (writes nothing) when: no session id, no surfaced pages this session, no baseline, or a NEUTRAL
 * signal. SHADOW: it only writes counts — it never touches recall ranking.
 * @param {{payload?:object, root:string, gitFacts?:object}} opts
 * @returns {object} always {}
 */
function run({ payload, root, gitFacts } = {}) {
  try {
    const sessionId = payload && typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!root || !sessionId) return {};

    const surfaced = readSurfacedSet(root, sessionId);
    if (!surfaced.length) return {}; // nothing surfaced this session → nothing to attribute

    const baseline = readBaseline(root, sessionId);
    if (!baseline) return {}; // no exact start commit → "commits this session" is undefined → skip
    if (baseline.rewarded) return {}; // ONCE PER SESSION: already credited → do not double-count

    const facts = gitFacts || gitFactsSince(root, baseline.head);
    const signal = deriveSignal(facts);
    if (!signal) return {}; // neutral (no new commits) → no update, no write

    // Persist via the shared coalesced helper: read current counts, apply the pure update once, rewrite.
    // The update is pure (produces a fresh map); the mutate adopts that map and reports whether it changed.
    // rev-F2: `wrote` is coalesceSidecar's ACTUAL return (did the rewrite land on disk), NOT the mutate's
    // computed delta — so a refuse/fail AFTER the mutate (secret-scan refusal, EISDIR, unwritable path) does
    // not arm the once-per-session guard below, and the dropped attribution stays re-creditable on retry.
    const wrote = coalesceSidecar(path.join(root, ...REWARD_REL), (map) => {
      // The discount is OFF in S2 (gate-tuned later, per the PRD); pass no opts → no decay.
      const next = updateReward(map, surfaced, signal);
      const before = JSON.stringify(map);
      // adopt next into the map object the helper will serialize
      for (const k of Object.keys(map)) delete map[k];
      Object.assign(map, next);
      return JSON.stringify(map) !== before; // write only when the counts actually changed
    });

    // Mark the session credited so a second SessionEnd is a no-op (once-per-session). Only when a write
    // actually happened — if the helper refused (corrupt/secret), leave the guard unset so a healthy
    // retry can still attribute.
    if (wrote) markRewarded(root, sessionId);
  } catch {
    // fail-open: a reward-update fault must never block a session closing.
  }
  return {};
}

function main() {
  let consumed = '';
  try {
    consumed = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin → nothing to attribute */
  }
  let payload = {};
  try {
    payload = consumed.trim() ? JSON.parse(consumed) : {};
  } catch {
    payload = {};
  }
  const root = findInstallRoot(payload && payload.cwd);
  let out = {};
  try {
    if (root) out = run({ payload, root });
  } catch {
    out = {}; // fail-open: never block a session closing
  }
  process.stdout.write(JSON.stringify(out || {}));
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch {
    process.stdout.write('{}');
    process.exit(0);
  }
}

module.exports = { deriveSignal, run, readSurfacedSet, readBaseline, gitFactsSince, findInstallRoot };
