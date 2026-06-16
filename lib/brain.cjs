'use strict';

// WRXN brain query (recon-brain-recall-03) — interrogate the warm Brain from the terminal.
//
// The Brain is recon-wrxn's unified code+prose knowledge graph, loaded WARM inside the `recon serve`
// process Claude Code boots for a session. This command reaches it over the loopback find door that
// serve announces via a discovery file — it is WHOLE-BRAIN (code AND prose, no scope filter by
// default), the operator's on-demand counterpart to the prose-only proactive Recall hook.
//
// Endpoint-first (v1): if no warm door is discoverable, we raise a clear, actionable error and the CLI
// exits non-zero — there is NO cold one-shot load (that would pay the index + embedder cost the warm
// serve already absorbs).
//
// The query path takes an INJECTED transport + endpoint reader (deps) so its behavior is unit-testable
// with no live serve — mirrors the injected-invoker seam in lib/connect.cjs and the recall hook's
// httpTransport. lib/brain.cjs is PACKAGE code (invoked via bin/wrxn.cjs), NOT payload — no manifest
// entry, consistent with lib/connect.cjs / lib/executor.cjs / lib/onboard.cjs.
//
// The discovery contract (serve-endpoint.json {pid,port}, pid-liveness) is duplicated here from the
// payload recall-surface hook ON PURPOSE: that hook must be node-stdlib-only and self-contained (it
// ships into installs without the kernel lib), so package code cannot import it. The contract is ~20
// stable lines — duplicating it across the install boundary is the same self-containment trade the
// payload hooks make for findInstallRoot.

const fs = require('fs');
const http = require('http');
const path = require('path');

const ENDPOINT_REL = path.join('.recon-wrxn', 'serve-endpoint.json');
const FIND_PATH = '/api/tools/recon_find';
const EXPLAIN_PATH = '/api/tools/recon_explain';
const TIMEOUT_MS = 5000; // generous: an interactive CLI, not the per-prompt 150ms recall budget
const PROSE_TYPES = new Set(['Page', 'Section']);
const WALK_UP_LIMIT = 12;
// recon_explain's structured neighbor buckets (mirrors handleExplain's internal relationship sets).
const NEIGHBOR_BUCKETS = ['callers', 'callees', 'imports', 'importedBy', 'methods', 'implementedBy', 'usedBy', 'testRefs'];

// ── discovery (the cross-repo warm-door contract) ────────────────────────────────────

// A pid is alive unless process.kill(pid,0) throws. ESRCH = gone; EPERM = owned by another user but
// alive. Mirrors the cross-repo discovery contract (and the recall hook).
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// Walk up from startDir to the first directory carrying .recon-wrxn/serve-endpoint.json; read and
// validate {pid,port}; trust it only when the pid is alive. Returns {pid,port,root} or null (the
// Brain is not warm: absent, malformed, missing fields, or a dead process).
function discoverEndpoint(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < WALK_UP_LIMIT; i++) {
    const file = path.join(dir, ENDPOINT_REL);
    if (fs.existsSync(file)) {
      let obj;
      try {
        obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null; // malformed → not warm
      }
      const pid = Number(obj && obj.pid);
      const port = Number(obj && obj.port);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!Number.isInteger(port) || port <= 0) return null;
      if (!pidAlive(pid)) return null; // dead process → not warm
      return { pid, port, root: dir };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ── transport (injectable; default = real loopback POST) ─────────────────────────────

// Default transport: a real loopback POST with a hard timeout. Injectable so unit tests never touch
// the network (mirrors lib/connect.cjs's invoke seam). Resolves {statusCode, body}; rejects on socket
// error or timeout.
function httpTransport({ port, path: reqPath, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
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
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => req.destroy(new Error('brain door timeout')));
    req.write(payload);
    req.end();
  });
}

// POST a door tool and return the parsed JSON body. Raises a clean error (never a crash) on a transport
// fault, a non-200 status, or a non-JSON body.
async function postTool(transport, port, reqPath, body, timeoutMs) {
  let resp;
  try {
    resp = await transport({ port, path: reqPath, body, timeoutMs: timeoutMs || TIMEOUT_MS });
  } catch (err) {
    throw new Error(`Brain door request to ${reqPath} failed: ${err.message}`);
  }
  if (!resp || resp.statusCode !== 200) {
    throw new Error(`Brain door returned HTTP ${resp ? resp.statusCode : 'no-response'} for ${reqPath}`);
  }
  try {
    return JSON.parse(resp.body);
  } catch {
    throw new Error(`Brain door returned a malformed (non-JSON) response for ${reqPath}`);
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────────────

function isProse(hit) {
  return !!hit && PROSE_TYPES.has(hit.type);
}

// Post-filter hits by --type (the find request can't carry a type ARRAY, so prose=Page+Section is
// always a post-filter): 'prose' → Page/Section, 'code' → everything else, else an exact NodeType.
function filterByType(hits, type) {
  if (!type) return hits;
  if (type === 'prose') return hits.filter(isProse);
  if (type === 'code') return hits.filter((h) => !isProse(h));
  const t = String(type).toLowerCase();
  return hits.filter((h) => String(h && h.type).toLowerCase() === t);
}

// Normalize a recon ref to a stable neighbor shape (explain refs may carry startLine, not line).
function normalizeRef(ref) {
  const r = ref || {};
  const out = { name: r.name, type: r.type, file: r.file };
  if (r.id != null) out.id = r.id;
  const line = r.line != null ? r.line : r.startLine;
  if (line != null) out.line = line;
  if (r.relationship) out.relationship = r.relationship;
  return out;
}

// Extract a hit's 1-hop neighbors from a recon_explain response. Tolerant of two structured shapes:
//   (a) a flat `neighbors[]` (forward-compatible), or
//   (b) relationship buckets (callers/callees/imports/...) — mirrors recon_explain's internal sets.
// Either way it is strictly 1-hop. (The newer door's exact structured-explain shape is the one
// cross-repo unknown — the injected transport keeps this swappable; see the slice closeout.)
function extractNeighbors(resp) {
  if (!resp || typeof resp !== 'object') return [];
  if (Array.isArray(resp.neighbors)) return resp.neighbors.map(normalizeRef);
  const out = [];
  for (const bucket of NEIGHBOR_BUCKETS) {
    if (Array.isArray(resp[bucket])) {
      for (const ref of resp[bucket]) out.push(normalizeRef(Object.assign({ relationship: bucket }, ref)));
    }
  }
  return out;
}

// ── formatting (pure) ────────────────────────────────────────────────────────────────

function hitLine(h) {
  const name = h.name || '(unnamed)';
  const type = h.type || '?';
  const loc = h.file ? `${h.file}${h.line != null ? ':' + h.line : ''}` : '';
  return loc ? `${name} · ${type} · ${loc}` : `${name} · ${type}`;
}

function neighborLine(n) {
  const rel = n.relationship ? ` [${n.relationship}]` : '';
  return `    - ${hitLine(n)}${rel}`;
}

// Render results: --json re-emits the structured hits; default is a human text list. With --neighbors,
// each hit's 1-hop neighbors are listed indented beneath it.
function formatHits(hits, opts = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (opts.json) return JSON.stringify(list, null, 2);
  if (!list.length) return 'no results';
  const lines = [];
  for (const h of list) {
    lines.push(hitLine(h));
    if (opts.neighbors) {
      const ns = Array.isArray(h.neighbors) ? h.neighbors : [];
      if (ns.length) for (const n of ns) lines.push(neighborLine(n));
      else lines.push('    (no 1-hop neighbors)');
    }
  }
  return lines.join('\n');
}

// ── the query (IO shell over the injected seam) ──────────────────────────────────────

const NOT_WARM =
  'Brain is not warm — no live recon serve door found (.recon-wrxn/serve-endpoint.json is absent, ' +
  'malformed, or its process is dead). Open a Claude Code session (which boots recon serve), or run ' +
  '`recon serve` with the find door enabled, then retry.';

/**
 * Query the warm Brain. Whole-brain (code+prose) by default.
 * @param {string} q          the query string
 * @param {object} opts       { json?, limit?, type?, neighbors? }
 * @param {object} deps       { root?, discover?, transport?, timeoutMs? } — injected seam for tests
 * @returns {Promise<{hits: object[]}>}
 * @throws  a clear error when the Brain is not warm, or on a malformed/non-200 door response.
 */
async function query(q, opts = {}, deps = {}) {
  const term = String(q == null ? '' : q).trim();
  if (!term) throw new Error('wrxn brain query requires a non-empty query string');

  const startDir = deps.root || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const discover = deps.discover || discoverEndpoint;
  const transport = deps.transport || httpTransport;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;

  const door = discover(startDir);
  if (!door) throw new Error(NOT_WARM);

  const findBody = { query: term };
  if (Number.isInteger(opts.limit) && opts.limit > 0) findBody.limit = opts.limit;

  const found = await postTool(transport, door.port, FIND_PATH, findBody, timeoutMs);
  if (!Array.isArray(found.hits)) {
    throw new Error(
      'Brain door returned an unexpected response shape (no structured `hits` array) — the recon-wrxn ' +
      'serve door may predate the structured find response.'
    );
  }

  let hits = filterByType(found.hits, opts.type);

  // --neighbors: 1-hop expansion per hit via recon_explain — the ONLY place 1-hop lives. A per-hit
  // explain failure degrades to empty neighbors (the find already succeeded); it never crashes.
  if (opts.neighbors) {
    for (const h of hits) {
      const explainBody = { name: h.name };
      if (h.file) explainBody.file = h.file;
      try {
        h.neighbors = extractNeighbors(await postTool(transport, door.port, EXPLAIN_PATH, explainBody, timeoutMs));
      } catch {
        h.neighbors = [];
      }
    }
  }

  return { hits };
}

module.exports = {
  query,
  formatHits,
  discoverEndpoint,
  pidAlive,
  httpTransport,
  filterByType,
  extractNeighbors,
  isProse,
  FIND_PATH,
  EXPLAIN_PATH,
  PROSE_TYPES,
};
