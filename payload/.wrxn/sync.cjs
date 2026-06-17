#!/usr/bin/env node
'use strict';

// WRXN sync adapter — the install-local DRIFT REPORT gate (issue sync-04). Sibling to wiki.cjs /
// dream.cjs. Self-contained: this ships INTO an install and MUST NOT import the kernel lib or recon —
// node stdlib ONLY (fs / http / path), so it is install-portable.
//
// What it does: discovers recon-wrxn's warm serve door (the recall-surface.cjs contract), POSTs the
// `recon_drift` tool (sync-03 — the pure indexed-graph stale set), and REPORTS which derived docs are
// stale + the source symbol that moved + the watermark (`synced_to`) vs the current source fingerprint.
// recon_drift computes the stale set from the watermark it parsed out of each doc's frontmatter
// (sync-01) — so the kernel consumes the watermark FROM the door response and stays strictly
// REPORT-ONLY: it never re-reads or rewrites a wiki file. Auto-regen (sync-05) + prose propose/confirm
// (sync-06) build on this; there are NO writes here.
//
// Subcommand:
//   report   query recon_drift over the serve door and print the drift summary JSON:
//            { status, stale[], unwatermarked[] }
//              · status "drift"        — at least one doc is stale (stale[] names doc/symbol/synced_to/current).
//              · status "synced"       — the warm door computed an EMPTY stale set ("all synced"; AC3 no-op,
//                                        never manufactures stale rows).
//              · status "unavailable"  — recon is unreachable (no warm door, a timeout, a non-200, or a
//                                        malformed body). FAIL-SOFT: reported, NEVER thrown (AC5).
//
// Flag: --root <dir> (override the install-root walk-up; mainly for tests).

const fs = require('fs');
const http = require('http');
const path = require('path');

const ENDPOINT_REL = path.join('.recon-wrxn', 'serve-endpoint.json');
const DRIFT_PATH = '/api/tools/recon_drift'; // the recon serve door (sync-03 AC6 added it to DOOR_TOOLS)
// Operator-invoked (an explicit `wrxn sync`), NOT the per-prompt hot path — so a generous budget, unlike
// recall-surface's 150ms UserPromptSubmit ceiling. Still bounded so a wedged door can't hang the command.
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // hard cap on an accumulated door response body (anti-flood)

// ── install-root resolution (mirrors wiki.cjs / dream.cjs / recall-surface.cjs) ─
function findInstallRoot(start) {
  let dir = start || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function installRoot() {
  const root = flag('root') || findInstallRoot();
  if (!root) {
    fail('cannot resolve the install root — run inside a wrxn install (no wrxn.install.json found walking up) or pass --root <dir>');
  }
  return root;
}

function fail(msg) {
  process.stderr.write(`sync: ${msg}\n`);
  process.exit(2);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ── the report (PURE) ──────────────────────────────────────────────────────────
// Deterministic over the parsed recon_drift door response. Surfaces the stale set (each entry naming
// doc / symbol / synced_to / current straight from the door) + passes the unwatermarked bucket through
// (sync-03 AC5 — a distinct bucket, never dropped). "all synced" keys off an EMPTY stale set (AC3); it
// never invents a row. A malformed / non-object response degrades to synced (an empty stale set), never
// throws.
function isEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e);
}

function summarizeDrift(parsed) {
  const p = isEntry(parsed) ? parsed : {};
  const stale = Array.isArray(p.stale) ? p.stale.filter(isEntry) : [];
  const unwatermarked = Array.isArray(p.unwatermarked) ? p.unwatermarked.filter(isEntry) : [];
  return { status: stale.length ? 'drift' : 'synced', stale, unwatermarked };
}

function unavailable() {
  return { status: 'unavailable', stale: [], unwatermarked: [] };
}

// ── the door (IO shell, injectable transport) — the recall-surface.cjs contract ─

// A pid is alive unless process.kill(pid,0) throws ESRCH. EPERM means it exists (owned by another
// user) — still alive.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// Refuse a discovery file another user could have planted, or that is group/world-writable — trusting
// it would let a hostile workspace point the door host/port at an exfil/injection sink. lstat (not stat)
// so a symlink's OWN ownership/mode is judged. Any fault → not trusted (treated as not-warm).
function endpointTrusted(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false; // foreign owner
  if ((st.mode & 0o022) !== 0) return false; // group/world-writable
  return true;
}

// Discover the warm serve door from <root>/.recon-wrxn/serve-endpoint.json = {pid,port}. Returns
// {pid,port} only when the file is well-owned (not planted), present, well-formed, and the pid is
// alive — else null (not warm). Never throws.
function discoverEndpoint(root) {
  const file = path.join(root, ENDPOINT_REL);
  if (!endpointTrusted(file)) return null; // absent, foreign-owned, or loose perms → not warm
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent (race)
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null; // malformed
  }
  const pid = Number(obj && obj.pid);
  const port = Number(obj && obj.port);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!pidAlive(pid)) return null; // dead pid → not warm
  return { pid, port };
}

// Default transport: a real POST over http with a hard timeout. Resolves {statusCode, body}; rejects
// on socket error or timeout. Injectable so unit tests never touch the network (mirrors recall-surface).
function httpTransport({ port, path: reqPath, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const deadline = timeoutMs || TIMEOUT_MS;
    let settled = false;
    let wall = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (wall) clearTimeout(wall);
      fn(arg);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) { req.destroy(new Error('drift door response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => done(resolve, { statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => done(reject, e));
      }
    );
    req.on('error', (e) => done(reject, e));
    // Idle timeout (no bytes for `deadline`) AND an independent wall-clock that bounds a trickle attacker
    // dribbling bytes to keep the idle timer from ever firing.
    req.setTimeout(deadline, () => req.destroy(new Error('drift door timeout')));
    wall = setTimeout(() => req.destroy(new Error('drift door wall-clock timeout')), deadline);
    req.write(payload);
    req.end();
  });
}

// IO shell: discover the door, POST recon_drift, summarize the stale set. `transport` is injected in
// tests; production uses httpTransport. FAIL-SOFT everywhere: a cold/dead door, a timeout, a non-200, or
// a malformed body all degrade to status "unavailable" — never an exception (AC5).
async function driftFromDoor(root, { transport, timeoutMs } = {}) {
  const door = discoverEndpoint(root);
  if (!door) return unavailable(); // not warm → recon unreachable
  let resp;
  try {
    resp = await (transport || httpTransport)({
      port: door.port,
      path: DRIFT_PATH,
      body: {}, // recon_drift is a whole-graph scan; it takes no required args
      timeoutMs: timeoutMs || TIMEOUT_MS,
    });
  } catch {
    return unavailable(); // timeout / connection refused / abort
  }
  if (!resp || resp.statusCode !== 200) return unavailable();
  let parsed;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    return unavailable(); // malformed body
  }
  return summarizeDrift(parsed);
}

// ── subcommands ─────────────────────────────────────────────────────────────────
async function runReport() {
  const root = installRoot();
  let summary;
  try {
    summary = await driftFromDoor(root, {});
  } catch {
    summary = unavailable(); // belt-and-suspenders: the report never throws
  }
  print(summary);
  process.exit(0);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'report':
      return runReport();
    default:
      process.stdout.write('Usage: node .wrxn/sync.cjs report [--root <dir>]\n');
      process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) {
  main().catch((err) => fail(err && err.message ? err.message : 'unexpected error'));
}

module.exports = {
  summarizeDrift,
  driftFromDoor,
  discoverEndpoint,
  httpTransport,
  pidAlive,
  findInstallRoot,
  DRIFT_PATH,
  TIMEOUT_MS,
};
