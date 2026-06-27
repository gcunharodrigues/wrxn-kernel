#!/usr/bin/env node
'use strict';

// WRXN memory-synth-spawn — the SessionEnd hook that launches the background synthesizer (auto-memory-03).
// SessionEnd is otherwise unwired, so this is its sole hook. Its ONLY job: return {} immediately and
// spawn memory-synth.cjs DETACHED, so closing a session is NEVER blocked by summarization (PRD story 16).
//
// Recursion guard (PRD story 17): the synth runs `claude -p`, whose own session fires SessionEnd again —
// a SessionEnd→claude→SessionEnd fork-bomb. The synth sets WRXN_MEMORY_SYNTH=1 on every engine spawn;
// this hook no-ops (spawns nothing, writes no markers) when it sees that sentinel set.
//
// Before launching, it stashes the SessionEnd payload as the `.pending` marker and writes a
// `.pending-handoff` marker under .wrxn/continuity/ — both so SessionStart can detect an in-flight synth
// (and hold on the handoff marker) even before the detached child has done anything. The synth clears
// them on exit (memory-synth.cjs), so the markers describe "a synth is running for this session".
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any fault emits {} (no spawn) — the hook NEVER blocks a session closing.
//
// Contract: SessionEnd event JSON on stdin → {} on stdout (exit 0).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SENTINEL = 'WRXN_MEMORY_SYNTH'; // recursion guard (mirrors memory-synth.cjs's SENTINEL).

// safeId — canonicalize a session id used as a FILESYSTEM PATH component (#45): lowercase, collapse every
// non-alnum run to '-', trim, cap length. A raw session id concatenated into a path is a traversal surface;
// this keeps the once-per-session marker INSIDE .wrxn/continuity. REPLICATED byte-identically from
// session-start.cjs (and code-intel-push / the reward shell) — each install-only hook is self-contained
// (node stdlib only, no shared import).
function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

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

// ── skip-log (#104) ──────────────────────────────────────────────────────────────
// The #45 `wx` claim blocks a re-spawn SILENTLY, so a benign dedup skip is invisible in the synth log.
// When a fire skips because the marker is already present, append ONE row to .wrxn/continuity/.synth.log so
// the dedup is diagnosable. The row matches memory-synth.cjs's writeSynthLog shape EXACTLY — tab-separated
// six fields: ISO timestamp, session id, task `handoff`, engine `-`, `attempts=0`, outcome `skip`. The
// session id is sanitized via the same idiom as memory-synth's sanitizeLogField (strip C0/C1 control chars —
// which INCLUDES tab \x09 and newline \x0a — then length-cap) so a hostile id can't forge extra rows. `skip`
// is a NON-failure token (the #51 staleness guard treats only no-engine/error as rot), so a dedup never
// false-warns. Self-contained — node stdlib only, NO kernel import; sanitizeLogField is duplicated by design
// (every install-only hook is standalone, exactly as safeId is replicated across the hooks).
const SYNTH_LOG = '.synth.log';
const LOG_FIELD_MAX = 64;

function sanitizeLogField(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, LOG_FIELD_MAX);
}

// ── content-versioned claim (#105) ───────────────────────────────────────────────
// Slice 1 (#104) released the `.spawned-<sid>` marker on SessionStart so a resumed session's later end could
// re-synth. When that release is MISSED (e.g. a multi-terminal continuation whose new process never released
// the claim), the existence-only marker freezes the baton with no recovery. Slice 2 makes the dedup
// CONTENT-AWARE: stamp the marker with the session transcript's byte size (+ a timestamp) at claim time, then
// on a marker-present end re-arm the synth when the transcript has GROWN materially since the stamp — a
// self-heal that needs no SessionStart release. Any fault (absent/unreadable transcript path, stat fault,
// unparseable marker) falls back to slice 1's existence-only claim and is fully fail-open (never throws,
// never double-fires on a fault). Self-contained — node stdlib only, NO kernel import.
//
// GROWTH_THRESHOLD — the byte growth that counts as "did real work since the stamp". A same-end double-fire
// appends NOTHING to the transcript (~0 bytes); a resumed session that did real work appends KB–MB of JSONL
// (each transcript turn — uuid/parentUuid/sessionId/timestamp/message — is hundreds of bytes to several KB).
// 1 KiB sits comfortably above zero / trailing-byte jitter and well below a single real exchange, so it
// cleanly separates "no new work" (skip) from "genuine continuation" (re-arm). Conservative by design: the
// re-arm fires only on a POSITIVE growth signal, so any uncertainty defaults to skip (never double-fire).
const GROWTH_THRESHOLD = 1024;

// The transcript byte size from the SessionEnd payload's transcript_path, or null on ANY fault (absent path,
// ENOENT, EACCES, …). null = "size unknown" → the caller falls back to the existence-only claim (fail-open).
function transcriptSize(transcriptPath) {
  try {
    if (!transcriptPath) return null;
    return fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }
}

// The marker payload stamped at claim/re-arm time: the transcript size + an ISO timestamp. A null size
// (unreadable transcript) is stamped as-is, so a later read yields no baseline → existence-only fallback.
function stampContent(size) {
  return JSON.stringify({ size: typeof size === 'number' ? size : null, at: new Date().toISOString() });
}

// The size stamped into an existing marker, or null when there is no usable baseline — a #104 zero-byte
// marker, unparseable JSON, or a null/non-number size. null → the caller falls back to existence-only (skip),
// so a corrupt/legacy marker can never trigger a re-arm (any uncertainty defaults to skip, never double-fire).
function readStampedSize(markerPath) {
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.size === 'number' ? parsed.size : null;
  } catch {
    return null;
  }
}

// Append exactly one tab-separated `skip` row for a marker-present dedup. Best-effort + FAIL-OPEN: a logging
// fault is swallowed so it can NEVER affect the dedup (the diagnosability log must not become a failure mode).
function appendSkipLog(dir, sessionId) {
  try {
    const line = [
      new Date().toISOString(),
      sanitizeLogField(sessionId) || '-', // untrusted stash value — strip control chars, cap length.
      'handoff',
      '-',
      'attempts=0',
      'skip',
    ].join('\t');
    fs.appendFileSync(path.join(dir, SYNTH_LOG), line + '\n');
  } catch {
    /* the skip log is best-effort — a write fault must never affect the dedup */
  }
}

/**
 * The testable core. Given the SessionEnd payload, the install root, the env (for the recursion guard),
 * and an injectable `spawn`, it stashes the payload + writes the pending markers and launches the synth
 * detached — returning {} immediately. With the recursion sentinel set it no-ops (spawns nothing, writes
 * no markers). Fail-open: any fault → {} (session close is never blocked).
 * @param {{ payload:object, root:string, env:object, spawn:Function }} opts
 * @returns {object} the hook envelope — always {}
 */
function run({ payload, root, env = process.env, spawn: spawnFn = spawn }) {
  try {
    if (env && env[SENTINEL]) return {}; // inside a synth-spawned session — do not recurse.
    if (!root) return {};

    const dir = path.join(root, '.wrxn', 'continuity');
    fs.mkdirSync(dir, { recursive: true });

    // Once-per-session claim (#45): the harness fires SessionEnd more than once per session, so an
    // unguarded hook launches N synths that race on one shared `.pending`. CLAIM the session ATOMICALLY
    // with an exclusive create (`wx` throws EEXIST if the marker exists) BEFORE staging markers / spawning:
    // the FIRST fire creates+stamps the marker and proceeds; a later fire for the same session throws EEXIST,
    // handled below by the content-aware dedup (#105: re-arm if the transcript grew, else skip). Race-safe
    // across the separate hook processes (no TOCTOU). The marker is a PERSISTENT per-session file — it must
    // OUTLIVE the synth, so it is NOT `.pending`/`.pending-handoff` (which the synth clears on exit). A
    // missing/empty session_id cannot be deduped → preserve today's spawn-every-time behavior for that path.
    const sid = payload && payload.session_id;
    if (sid) {
      const markerPath = path.join(dir, `.spawned-${safeId(sid)}`);
      const currentSize = transcriptSize(payload && payload.transcript_path); // null on any fault → fallback
      try {
        // Atomic exclusive claim (wx is TOCTOU-free across the separate hook processes, #45) — and STAMP it
        // with the transcript byte size + a timestamp (#105), so a later marker-present end can tell a genuine
        // continuation (transcript grew) from a same-end duplicate. Write to the just-claimed fd so the create
        // and the stamp are one operation on the file we exclusively own.
        const fd = fs.openSync(markerPath, 'wx');
        try {
          fs.writeSync(fd, stampContent(currentSize));
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          // The session is already claimed — a same-instance double-fire (#45) OR a resume's later end before
          // SessionStart released the marker. Content-aware dedup (#105): re-arm ONLY on a positive growth
          // signal — if the transcript grew past the threshold since the stamp, this is a genuine continuation
          // (a missed release), so RE-STAMP to the new size and fall through to spawn (the baton un-freezes).
          // Otherwise — no material growth, OR an indeterminate baseline/size from a fault — it is a same-end
          // duplicate: log ONE benign `skip` row (#104) and no-op. Any uncertainty defaults to skip, so a
          // stat/read fault can never double-fire the synth.
          const stampedSize = readStampedSize(markerPath);
          if (stampedSize != null && currentSize != null && currentSize - stampedSize > GROWTH_THRESHOLD) {
            try {
              fs.writeFileSync(markerPath, stampContent(currentSize)); // re-stamp the new baseline
            } catch {
              /* re-stamp is best-effort: a write fault must not block the re-arm — still spawn (PRD: the rare
                 double-spawn is bounded by the in-flight .pending markers + the synth's once-per-session guard) */
            }
            // fall through (do NOT return) → stash the pending markers + spawn the synth.
          } else {
            appendSkipLog(dir, sid);
            return {};
          }
        } else {
          throw err; // any OTHER claim fault → fail-open via the outer catch (not a dedup → no skip row)
        }
      }
    }

    // Stash the payload as .pending (the synth reads it for transcript_path) and raise the handoff gate.
    fs.writeFileSync(path.join(dir, '.pending'), JSON.stringify(payload || {}));
    fs.writeFileSync(path.join(dir, '.pending-handoff'), String(Date.now()));

    // Launch the synth detached: stdio ignored + unref() so the parent's event loop never waits on it.
    const synth = path.join(root, '.wrxn', 'memory-synth.cjs');
    const child = spawnFn('node', [synth, '--from-spawn', '--root', root], {
      detached: true,
      stdio: 'ignore',
      env: { ...env, [SENTINEL]: '1' },
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch {
    // fail-open: never block session close.
  }
  return {};
}

function main() {
  let consumed = '';
  try {
    consumed = fs.readFileSync(0, 'utf8');
  } catch {
    /* no stdin → nothing to synthesize */
  }
  let payload = {};
  try {
    payload = consumed.trim() ? JSON.parse(consumed) : {};
  } catch {
    payload = {};
  }
  const root = findInstallRoot(payload && payload.cwd);
  const out = run({ payload, root, env: process.env, spawn });
  process.stdout.write(JSON.stringify(out));
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

module.exports = { run };
