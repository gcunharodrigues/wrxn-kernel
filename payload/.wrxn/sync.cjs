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
//            { status, stale[], unwatermarked[], orphaned[] }
//              · status "drift"        — at least one doc is stale OR orphaned. stale[] names doc/symbol/
//                                        synced_to/current; orphaned[] (phase-4.5-02) names a doc whose
//                                        derived_from source symbol is GONE (doc/synced_to, no symbol/current).
//              · status "synced"       — the warm door computed an EMPTY stale AND orphaned set ("all synced";
//                                        AC3 no-op, never manufactures rows).
//              · status "unavailable"  — recon is unreachable OR answered without the structured drift sidecar
//                                        (no warm door, a timeout, a non-200, a malformed body, or a 200 whose
//                                        body lacks an affirmative `drift.stale` array — unknown is not clean,
//                                        sync-09). FAIL-SOFT: reported, NEVER thrown (AC5).
//
// Flag: --root <dir> (override the install-root walk-up; mainly for tests).

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT_REL = path.join('.recon-wrxn', 'serve-endpoint.json');
const DRIFT_PATH = '/api/tools/recon_drift'; // the recon serve door (sync-03 AC6 added it to DOOR_TOOLS)
// Operator-invoked (an explicit `wrxn sync`), NOT the per-prompt hot path — so a generous budget, unlike
// recall-surface's 150ms UserPromptSubmit ceiling. Still bounded so a wedged door can't hang the command.
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // hard cap on an accumulated door response body (anti-flood)

// ── sync-06 prose propose → confirm → re-stamp ───────────────────────────────────
// The two-phase staging trail mirrors dream's (.wrxn/dream/): a non-.md audit area so recon's prose
// ingestion (which walks all of .wrxn and reads *.md) never recalls a staged-but-unconfirmed edit.
const SYNC_DIR = ['.wrxn', 'sync'];
const WIKI_REL = ['.wrxn', 'wiki']; // prose docs live here; a reconciling edit may target ONLY this subtree.
const STAGED_FILE = 'staged.jsonl'; // the proposed-but-unconfirmed reconciling edits (full body, by-reference).
const AUDIT_FILE = 'audit.jsonl'; // append-only outcome log (propose + confirm events).
const BODY_MAX = 32000; // size cap (chars) — a durable reconciling edit, not a transcript dump (dream parity).

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
// Deterministic over the parsed recon_drift door response { result, drift:{ stale[], unwatermarked[], … } }.
// Reads the structured `drift` sidecar (sync-08), normalizing each camelCase entry (page→doc, syncedTo→
// synced_to, keeping symbol/current) so a stale row directly seeds a proposal, + passes the unwatermarked
// bucket through (sync-03 AC5 — a distinct bucket, never dropped). "all synced" keys off an EMPTY stale
// array (AC3); it never invents a row. A response lacking an affirmative `drift.stale` array degrades to
// "unavailable" (unknown is not clean, sync-09), never throws.
function isEntry(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e);
}

// Normalize a raw recon DriftReport entry (camelCase page/pageFile/symbol/symbolFile/symbolLine/syncedTo/
// current) into the kernel's external report contract (doc/symbol/synced_to/current) — the shape `propose`
// seeds from and the report's consumers read. `doc` is the FILE PATH (recon's `pageFile`), not the page
// title (`page`): `propose`/`confirm` feed `doc` to resolveSafeDoc, which requires a path under .wrxn/wiki/
// ending in .md — the title would never resolve. The door-only fields (page title/symbolFile/symbolLine)
// are dropped; an unwatermarked entry (no syncedTo/current) normalizes to { doc, symbol }.
function normEntry(e) {
  const out = {};
  if (e.pageFile !== undefined) out.doc = e.pageFile;
  if (e.symbol !== undefined) out.symbol = e.symbol;
  if (e.syncedTo !== undefined) out.synced_to = e.syncedTo;
  if (e.current !== undefined) out.current = e.current;
  return out;
}

function summarizeDrift(parsed) {
  const p = isEntry(parsed) ? parsed : {};
  // sync-08/09: the real recon_drift door returns { result:<markdown>, drift:{ stale[], unwatermarked[], … } }.
  // The structured set lives under `drift` (camelCase), NOT top-level. A 200 lacking an affirmative
  // `drift.stale` ARRAY (a markdown-only {result} body, or an older recon) is UNKNOWN, not clean — surface it
  // as unavailable so a contract regression fails loud, never as a confident false "synced" (sync-09).
  const d = p.drift;
  if (!isEntry(d) || !Array.isArray(d.stale)) return unavailable();
  const stale = d.stale.filter(isEntry).map(normEntry);
  const unwatermarked = (Array.isArray(d.unwatermarked) ? d.unwatermarked : []).filter(isEntry).map(normEntry);
  // phase-4.5-02: the third drift class — a watermarked page whose derived_from source symbol is GONE from
  // recon's graph (renamed/deleted). Each entry normalizes to { doc, synced_to } (no symbol/current — the
  // source is absent). It is DISTINCT from stale (source moved) and unwatermarked (never reconciled), but
  // like stale it MUST elevate the status off a clean "synced": a dangling page is the exact case sync used
  // to hide (the operator never learned the page was un-reconcilable). An older recon with no drift.orphaned
  // degrades to [] (back-compatible, never throws).
  const orphaned = (Array.isArray(d.orphaned) ? d.orphaned : []).filter(isEntry).map(normEntry);
  return { status: stale.length || orphaned.length ? 'drift' : 'synced', stale, unwatermarked, orphaned };
}

function unavailable() {
  return { status: 'unavailable', stale: [], unwatermarked: [], orphaned: [] };
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

// ── credential / secret scan (reused from dream.cjs, security M2) ────────────────
// A reconciling edit must never harden a session secret into prose. Same patterns + scope as dream's
// secretScan — replicated here because each install-only adapter is self-contained (node stdlib only;
// no shared kernel-lib import), exactly as findInstallRoot/flag/fail are duplicated across these files.
// CASE-SENSITIVE: the token shapes are case-specific.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_); {20,} covers the 36-char + CI forms
  /github_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained PAT
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style secret key
  /sk-proj-[A-Za-z0-9_-]{20,}/, // OpenAI project-scoped key (underscore form sk-… misses)
  /AIza[0-9A-Za-z._-]{10,}/, // Google / Gemini API key
  /sk_(?:live|test)_[A-Za-z0-9]{20,}/, // Stripe live/test secret key
  /npm_[A-Za-z0-9]{20,}/, // npm publish / automation token
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/, // JWT (incl. Bearer payloads); the eyJ… header gates it
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/, // PEM block (FULL — must precede the header fallback so redaction eats the body)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM header (fallback: a lone/truncated header with no END)
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/, // opaque Bearer token (non-JWT)
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+/i, // KEY/TOKEN/SECRET/PASSWORD = value
];

function secretScan(text) {
  const s = String(text || ''); // NOT lowercased — the token shapes are case-sensitive.
  for (const re of SECRET_PATTERNS) if (re.test(s)) return 'contains_secret';
  return null;
}

// ── watermark fingerprint validation (security M1) ───────────────────────────────
// `current` is written VERBATIM into the doc's `synced_to:` frontmatter at confirm (restampDoc), so it is
// a SECOND write channel the body-only secret-scan missed: a newline/colon injects arbitrary
// frontmatter/markdown, and a credential hardens unscanned into a recall-ingested page (defeats AC4).
// `synced_to` is operator/LLM-supplied too. Both must be a single fingerprint/commit token; `current` must
// additionally pass the secret-scan. proposalHash covers `current`, so the integrity gate does NOT catch
// this. Returns a problem code (the propose fail reason / the confirm skip reason) or null.
const FINGERPRINT_RE = /^[A-Za-z0-9._-]{1,128}$/;

function fingerprintProblem(rec) {
  if (typeof rec.current !== 'string' || !FINGERPRINT_RE.test(rec.current)) return 'malformed_current';
  if (rec.synced_to != null && (typeof rec.synced_to !== 'string' || !FINGERPRINT_RE.test(rec.synced_to))) return 'malformed_synced_to';
  return secretScan(rec.current); // 'contains_secret' (current is a write channel) or null
}

// ── shared helpers (mirror dream.cjs) ────────────────────────────────────────────
// The first positional after the subcommand (the JSON file path), up to the first --flag.
function positionalFile() {
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    return process.argv[i];
  }
  fail('missing <file.json> argument');
  return undefined;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read JSON from "${file}": ${err.message}`);
    return undefined;
  }
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function syncDir(root) {
  const dir = path.join(root, ...SYNC_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── path safety: a reconciling edit may target ONLY a prose .md under .wrxn/wiki/ ─
// The proposal's `doc` is LLM/operator-controlled, so it is the write-path's trust boundary (the sync
// analog of dream's flag-injection guard). Resolve it and refuse anything that escapes the wiki subtree
// or is not a .md — so confirm can never write outside the curated prose tree. Returns the abs path or null.
function resolveSafeDoc(root, doc) {
  if (typeof doc !== 'string' || !doc.trim()) return null;
  const wikiRoot = path.join(root, ...WIKI_REL);
  const abs = path.resolve(root, doc);
  const rel = path.relative(wikiRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // escapes .wrxn/wiki/
  if (!abs.endsWith('.md')) return null; // prose pages only
  return abs;
}

// The integrity fingerprint captured at stage time over the fields that determine the write (doc target,
// watermark advance target, and body). Recomputed at the write boundary and compared to the staged value
// → a staged record whose body/target was altered after staging cannot write (AC2 tamper-refusal).
function proposalHash(p) {
  const canon = JSON.stringify({ doc: String(p.doc || ''), current: String(p.current || ''), body: String(p.body || '') });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// ── the in-place re-stamp (PURE) — the net-new write transform ───────────────────
// Replace a prose doc's body with the reconciling `body` and advance its `synced_to:` watermark to the
// source's `current` fingerprint, preserving all other frontmatter (derived_from etc.). A doc without a
// frontmatter fence cannot carry a watermark → returns null (the caller skips it, never writes). This is
// the OPPOSITE of dream's create-refuses-overwrite: an in-place edit + re-stamp of an existing prose page.
function restampDoc(content, { body, current }) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content));
  if (!m) return null; // no frontmatter fence → not a watermarkable prose doc
  const lines = m[1].split(/\r?\n/);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^synced_to:\s*/.test(lines[i])) { lines[i] = `synced_to: ${current}`; found = true; break; }
  }
  if (!found) lines.push(`synced_to: ${current}`); // unwatermarked doc → first stamp
  return ['---', lines.join('\n'), '---', '', body, ''].join('\n');
}

// Read .wrxn/sync/staged.jsonl into a doc → staged-record map (last proposed wins). Malformed lines skip.
function readStaged(root) {
  const map = new Map();
  let txt;
  try {
    txt = fs.readFileSync(path.join(root, ...SYNC_DIR, STAGED_FILE), 'utf8');
  } catch {
    return map; // no staging trail yet → nothing to confirm by reference
  }
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && rec.doc && typeof rec.body === 'string') map.set(rec.doc, rec);
    } catch {
      /* skip a malformed staging line */
    }
  }
  return map;
}

// Normalize confirm input into the operator-approved DOC list (["doc"…] or { approved:[…] }). An empty
// list is the DECLINE — confirm writes nothing (AC3).
function approvedDocs(input) {
  if (Array.isArray(input)) return input.map(String);
  if (input && typeof input === 'object' && Array.isArray(input.approved)) return input.approved.map(String);
  return [];
}

// ── subcommands ─────────────────────────────────────────────────────────────────
// propose (STAGE): secret-scan the drafted reconciling edit, then record it by-reference under
// .wrxn/sync/staged.jsonl with an integrity fingerprint. Never touches the live doc. Mirrors dream's stage.
function runPropose() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (!resolveSafeDoc(root, p.doc)) fail('propose needs a "doc" path inside .wrxn/wiki/ ending in .md');
  if (typeof p.body !== 'string' || !p.body.trim()) fail('propose needs a non-empty "body" — the reconciling edit the skill drafted');
  if (p.body.length > BODY_MAX) fail(`propose rejected — body exceeds the ${BODY_MAX}-char cap (body_too_large); a durable reconciling edit, not a transcript dump`); // L3: dream parity
  if (typeof p.current !== 'string' || !p.current.trim()) {
    fail('propose needs "current" — the source fingerprint to advance the watermark to (from the drift report, never re-derived here)');
  }
  const sec = secretScan(p.body); // AC4: secret-scan BEFORE staging
  if (sec) fail(`propose rejected — the drafted edit contains a credential (${sec}); never reconcile a session secret into prose`);
  // M1: `current` becomes the doc's synced_to watermark verbatim at confirm — a second write channel the
  // body-only scan missed. Shape-validate current + synced_to (no newline/colon → no frontmatter injection)
  // and secret-scan current, at propose AND again at the confirm write boundary.
  const fp = fingerprintProblem(p);
  if (fp === 'contains_secret') fail('propose rejected — "current" contains a credential; never write a session secret into the doc watermark');
  if (fp) fail(`propose rejected — "${fp === 'malformed_synced_to' ? 'synced_to' : 'current'}" must be a fingerprint token matching ${FINGERPRINT_RE} (no newline/colon) — it is written verbatim into the doc watermark`);

  const dir = syncDir(root);
  const ts = new Date().toISOString();
  const record = { ts, op: 'propose', doc: p.doc, symbol: p.symbol, synced_to: p.synced_to, current: p.current, body: p.body, hash: proposalHash(p) };
  appendLine(path.join(dir, STAGED_FILE), record);
  appendLine(path.join(dir, AUDIT_FILE), { ts, op: 'propose', doc: p.doc, current: p.current });
  return print({ staged: 1, doc: p.doc, stagedFile: path.relative(root, path.join(dir, STAGED_FILE)) });
}

// confirm (COMMIT-by-reference): for each operator-approved doc, look up its staged edit, RE-VALIDATE at
// the write boundary (secret-scan → integrity fingerprint → path-safety → target exists → frontmatter),
// then edit the file in place + advance its watermark. A rejected/tampered/declined edit cannot write
// (AC2/AC3); the watermark advances ONLY as part of a confirmed write (AC5). Binds written == staged.
function runConfirm() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const approved = approvedDocs(input);
  const staged = readStaged(root);
  const written = [];
  const skipped = [];
  for (const ref of approved) {
    const key = String(ref);
    const rec = staged.get(key);
    if (!rec) { skipped.push({ doc: key, reason: 'not_staged' }); continue; }
    const sec = secretScan(rec.body); // re-scan at the write boundary
    if (sec) { skipped.push({ doc: key, reason: sec }); continue; }
    // M1: re-gate the `current` write channel at the boundary too (a seeded staged.jsonl bypasses propose).
    const fp = fingerprintProblem(rec);
    if (fp) { skipped.push({ doc: key, reason: fp }); continue; }
    if (proposalHash(rec) !== rec.hash) { skipped.push({ doc: key, reason: 'integrity_mismatch' }); continue; } // tamper → refuse
    const abs = resolveSafeDoc(root, rec.doc);
    if (!abs) { skipped.push({ doc: key, reason: 'unsafe_target' }); continue; }
    // L2: resolveSafeDoc is lexical — refuse a pre-existing symlink so the read+write can't FOLLOW it out of
    // the wiki subtree (git preserves symlinks; a hostile branch/clone can plant one). lstat → the link's
    // own type; fail closed (skip, no write), mirroring unsafe_target / missing_target.
    let lst;
    try {
      lst = fs.lstatSync(abs);
    } catch {
      skipped.push({ doc: key, reason: 'missing_target' }); continue; // the doc vanished since staging
    }
    if (lst.isSymbolicLink()) { skipped.push({ doc: key, reason: 'symlink_target' }); continue; }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ doc: key, reason: 'missing_target' }); continue; // the doc vanished since staging
    }
    const next = restampDoc(content, { body: rec.body, current: rec.current });
    if (next == null) { skipped.push({ doc: key, reason: 'no_frontmatter' }); continue; }
    fs.writeFileSync(abs, next); // the in-place edit + re-stamp (the net-new write path)
    written.push({ doc: rec.doc, synced_to: rec.current });
  }
  appendLine(path.join(syncDir(root), AUDIT_FILE), { ts: new Date().toISOString(), op: 'confirm', written: written.map((w) => w.doc), skipped });
  return print({ written, skipped });
}

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
    case 'propose':
      return runPropose();
    case 'confirm':
      return runConfirm();
    default:
      process.stdout.write('Usage: node .wrxn/sync.cjs <report|propose <proposal.json>|confirm <approved.json>> [--root <dir>]\n');
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
  // sync-06 prose propose → confirm → re-stamp
  secretScan,
  restampDoc,
  proposalHash,
  resolveSafeDoc,
};
