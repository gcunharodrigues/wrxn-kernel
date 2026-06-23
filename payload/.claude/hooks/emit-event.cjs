#!/usr/bin/env node
'use strict';

// WRXN emit-event hook — the metadata-grade session event source (C2 / kernel #35). Wired on BOTH
// UserPromptSubmit and PostToolUse, it appends one JSON record per line to .wrxn/events/<sid>.jsonl:
//   · a `prompt` record (the user prompt, SECRET-REDACTED) per UserPromptSubmit, and
//   · a SKELETON `tool` record (tool name + a target only) per PostToolUse.
// This FREEZES the event-JSONL contract the recon-wrxn ② analyzer consumes: { ts, sid, kind, ... } with
// kind ∈ { prompt, tool }. It is an INDEXED SOURCE (a file recon reads), never a write API.
//
// PRIVACY-CRITICAL: a tool record carries ONLY the tool name + a target (e.g. the file path). It NEVER
// reads the tool input wholesale, the tool response/output, file contents, or a command — by construction
// the only fields ever copied are tool_name and tool_input.file_path (itself redacted, defence-in-depth).
//
// Reuse, do not reinvent: prompt redaction is the sibling sidecar.cjs's redactSecrets (the one source of
// secret shapes) — the same sibling-require posture as recall-surface.cjs. SPLIT: pure record builders
// (clock + session id INJECTED) + an IO append shell. APPEND + FAIL-OPEN: any redaction or write fault is
// swallowed so the emit NEVER throws and never blocks the prompt or the tool call.

const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./sidecar.cjs'); // reuse the existing secret-shape primitive (one source of truth)

// safeSessionId — the session-id → filesystem-safe slug. Replicated to match code-intel-push's safeId /
// recall-surface's safeSessionId BYTE-FOR-BYTE (same discipline that duplicates the sanitizer across the
// install-only modules): a crafted sid (slashes, `..`) collapses to `[a-z0-9-]` so the event filename can
// never escape .wrxn/events/.
function safeSessionId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

// An ISO-8601 stamp from the INJECTED clock (ms-epoch or Date; default real time). ISO so prune's
// Date.parse(record.ts) ages event records exactly as it ages the dream/sync/harvest trails.
function isoStamp(now) {
  const ms = Number.isFinite(now) ? now : now instanceof Date ? now.getTime() : Date.now();
  return new Date(ms).toISOString();
}

// ── pure record builders (clock + sid injected) ──────────────────────────────────────

// A `prompt` record: the user prompt, SECRET-REDACTED. Frozen key set/order: { ts, sid, kind, text }.
function buildPromptRecord({ ts, sid, prompt }) {
  return { ts, sid, kind: 'prompt', text: redactSecrets(prompt) };
}

// A `tool` record: SKELETON ONLY. Frozen key set/order: { ts, sid, kind, tool, target }. `tool` is the
// tool name; `target` is a short identifier (the file path) — redacted as defence-in-depth so even a
// crafted secret-shaped path cannot land. NOTHING else is ever carried (see eventToRecord's extraction).
function buildToolRecord({ ts, sid, tool, target }) {
  return { ts, sid, kind: 'tool', tool: String(tool || ''), target: redactSecrets(target) };
}

// Dispatch a raw hook event to the record to write, or null when there is nothing to record. The sid is
// SANITIZED into the record (so record.sid always agrees with the <sid>.jsonl filename), and the clock is
// injected. A UserPromptSubmit event (a non-empty string `prompt`) → a prompt record; a PostToolUse event
// (a `tool_name`) → a SKELETON tool record. PRIVACY-CRITICAL: from a tool event the ONLY fields ever read
// are tool_name and tool_input.file_path — never tool_input wholesale, a command, file contents, or the
// tool_response/output. A tool with no string file_path records an empty target (its input stays unseen).
function eventToRecord(event, { now } = {}) {
  if (!event || typeof event !== 'object') return null;
  const ts = isoStamp(now);
  const sid = safeSessionId(event.session_id);
  if (typeof event.prompt === 'string' && event.prompt.trim()) {
    return buildPromptRecord({ ts, sid, prompt: event.prompt });
  }
  if (typeof event.tool_name === 'string' && event.tool_name) {
    const ti = event.tool_input;
    const target = ti && typeof ti.file_path === 'string' ? ti.file_path : '';
    return buildToolRecord({ ts, sid, tool: event.tool_name, target });
  }
  return null;
}

// Walk up from event.cwd / CLAUDE_PROJECT_DIR / cwd to the install root carrying wrxn.install.json.
// Replicated across the install-only hooks (no kernel-lib import). Returns null when not inside an install.
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

// ── IO shell: append one JSON line to .wrxn/events/<sid>.jsonl ────────────────────────

// The per-session event log. The filename is built from the SANITIZED sid, so a crafted session id can
// never escape .wrxn/events/ (defence-in-depth: eventToRecord already sanitizes record.sid, and this
// re-sanitizes — sanitizing an already-safe slug is idempotent).
function eventsDir(root) {
  return path.join(root, '.wrxn', 'events');
}
function eventFile(root, sid) {
  return path.join(eventsDir(root), `${safeSessionId(sid)}.jsonl`);
}

// Append a record as one compact JSON line. Returns true on write, false on any fail-open path. APPEND
// (never rewrite) so concurrent same-session hooks only ever add lines. FAIL-OPEN: a write fault is
// swallowed — the emit must never throw into the prompt/tool path.
function appendEvent(root, record) {
  try {
    if (!root || !record || typeof record !== 'object') return false;
    fs.mkdirSync(eventsDir(root), { recursive: true });
    fs.appendFileSync(eventFile(root, record.sid), JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false; // best-effort: a write fault never blocks the prompt or the tool call
  }
}

// Dispatch a raw hook event to its record and append it. Returns true on write, false otherwise. Wholly
// FAIL-OPEN: a redaction or write fault is swallowed and never throws.
function emitEvent(root, event, { now } = {}) {
  try {
    const record = eventToRecord(event, { now });
    if (!record) return false;
    return appendEvent(root, record);
  } catch {
    return false;
  }
}

// ── entrypoint ────────────────────────────────────────────────────────────────────────
//
// Contract: a UserPromptSubmit or PostToolUse event JSON on stdin → an empty `{}` envelope on stdout
// (exit 0). This is a pure SIDE-EFFECT hook: it injects no context, it only appends an event record.
// Wholly fail-open — any fault (unparseable stdin, no install, write fault) still prints `{}` and exits 0,
// so it can never block the prompt or the tool call.
function done() {
  process.stdout.write('{}');
  process.exit(0);
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    return done(); // unparseable stdin → no-op
  }
  let root = null;
  try {
    root = findInstallRoot(event && event.cwd);
  } catch {
    root = null;
  }
  try {
    if (root) emitEvent(root, event, {});
  } catch {
    /* fail-open: an emit fault never blocks the prompt or the tool call */
  }
  return done();
}

if (require.main === module) {
  try {
    main();
  } catch {
    done();
  }
}

module.exports = {
  eventToRecord,
  buildPromptRecord,
  buildToolRecord,
  safeSessionId,
  isoStamp,
  eventsDir,
  eventFile,
  appendEvent,
  emitEvent,
  findInstallRoot,
};
