#!/usr/bin/env node
'use strict';

// WRXN harvest adapter — the install-local, REPORT-ONLY curation-debt detector (harvest-02 / H2).
// Sibling to wiki.cjs / dream.cjs / sync.cjs. Self-contained: this ships INTO an install and MUST NOT
// import the kernel lib or recon — node stdlib ONLY (fs / http / path), so it is install-portable.
//
// What it does: `harvest.cjs check [--root]` scans the 4 knowledge tiers and writes a durable structured
// report under `.wrxn/harvest/<ts>.jsonl` — one JSON record per finding, classified:
//   · near_dup        clusters of pages over a MEASURED semantic-similarity threshold, via recon's
//                     hybrid similarity over the warm serve door (the recall-surface.cjs contract:
//                     discoverEndpoint → POST recon_find → read parsed.hits[].semanticScore). For each
//                     prose page we query the door with its body; other harvest-tier pages whose dense
//                     cosine clears the threshold are near-dup neighbours. Pairwise edges are collapsed
//                     into connected-component CLUSTERS (so an A↔B match is reported once, not twice).
//   · decay_candidate orphaned (its `derived_from:` source FILE is gone) OR superseded (it carries a
//                     `superseded_by:` forward-link). Both are LOCAL frontmatter scans — no door.
//   · malformed       bad frontmatter — the existing wiki-lint signal (kernel-11), over the 4 tiers.
//
// This is LAYER 1 of harvest: detection only. The report is the SOLE input to the destructive curation
// layer (H3 merge / H4 decay) and the debt-gate (H5). It is strictly REPORT-ONLY: `check` writes ONLY
// under `.wrxn/harvest/`; it NEVER edits, deletes, or annotates a knowledge page, and re-running writes a
// FRESH timestamped report (it never mutates a prior one). FAIL-SOFT: a cold/unreachable door degrades
// near-dup to status "unavailable" in the report while the local malformed + orphaned/superseded scans
// still run — `check` never throws, never blocks (exit 0).
//
// Scope = the 4 tiers concepts/decisions/gotchas/_rules ONLY. The retired `sessions` tier is NEVER
// scanned (it is absent from HARVEST_TIERS), and a near-dup neighbour OUTSIDE these tiers (a sessions
// page, a .scratch draft, code) is never clustered — curation acts only on the curated knowledge set.
//
// Flag: --root <dir> (override the install-root walk-up; mainly for tests).

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// The harvest curation scope (8-decision grill: scope = the 4 knowledge tiers). NOTE this DIFFERS from
// wiki-lint's TIERS: harvest scans `_rules` (the dream-written tier) and never scans the retired
// `sessions` tier — the handoff baton + dream consolidation are the close-out now (harvest-01).
const HARVEST_TIERS = ['concepts', 'decisions', 'gotchas', '_rules'];
const REQUIRED_KEYS = ['name', 'description', 'tier']; // wiki-lint's malformed-frontmatter contract.

const HARVEST_DIR = ['.wrxn', 'harvest'];
// merge (harvest-03) staging trail — mirrors sync's .wrxn/sync/. NON-.md so recon's prose ingestion (which
// walks all of .wrxn and reads *.md) never recalls a staged-but-unconfirmed merge. Coexists with check's
// timestamped <ts>.jsonl reports in the same dir (distinct fixed names, no collision).
const STAGED_FILE = 'staged.jsonl'; // the proposed-but-unconfirmed merges (survivor body + absorbed, by-reference).
const AUDIT_FILE = 'audit.jsonl'; // append-only outcome log (stage + commit events).
const BODY_MAX = 32000; // survivor body cap (chars) — a durable merged page, not a dump (dream/sync parity).
const WIKI_REL = ['.wrxn', 'wiki']; // all merge targets confine under <root>/.wrxn/wiki/<knowledge-tier>/.
const ENDPOINT_REL = path.join('.recon-wrxn', 'serve-endpoint.json');
const FIND_PATH = '/api/tools/recon_find'; // the recon serve door recall-surface/brain query.
const PROSE_TYPES = new Set(['Page', 'Section']); // prose scope — code symbols are never near-dup targets.

// ── the MEASURED near-dup threshold ──────────────────────────────────────────────
// NEAR_DUP_THRESHOLD gates the door's dense cosine (`semanticScore`), NOT the fused RRF `score` (RRF is
// rank-based, not a relevance magnitude — ADR 0002 / recall-surface). BASIS (measured on the live
// WRXN-OS prose corpus via the recon HTTP door, 384-d hybrid embedder, 2026-06-17):
//   · a page queried with its own body scores ~0.85–0.99 against itself (≈1.0 ceiling for identical text);
//   · merely-RELATED but distinct pages top out at ~0.66–0.70 (e.g. a PRD vs a sibling design doc);
//   · the repo's established RELEVANCE floor is 0.40 (recall-surface SEMANTIC_FLOOR, validated on real prose).
// 0.85 sits in the clear gap above the ~0.70 "related" ceiling (a ~0.15 margin → merely-related pages do
// NOT trip near-dup) and below the ~1.0 identical ceiling (so genuine heavy-overlap duplicates DO). It is
// well above the 0.40 relevance floor because near-DUPLICATE is a strictly stronger relation than relevance.
const NEAR_DUP_THRESHOLD = 0.85;
// Operator-invoked (an explicit `wrxn harvest`), not the per-prompt hot path — so a generous query budget
// (recall-surface caps at 512 for its 150ms ceiling; truncating the near-dup query that hard suppresses
// the signal — the measurement showed a 512-char self-query drops to ~0.78). We send more of the body.
const NEAR_DUP_QUERY_CHARS = 2000;
const FETCH_LIMIT = 15; // ask the door wide; we post-filter to harvest-tier prose then threshold.
const TIMEOUT_MS = 5000; // bounded so a wedged door can't hang the command (sync.cjs parity).
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // hard cap on an accumulated door response body (anti-flood).

// ── install-root resolution (mirrors wiki.cjs / dream.cjs / sync.cjs) ─────────────
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
  process.stderr.write(`harvest: ${msg}\n`);
  process.exit(2);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ── frontmatter helpers (mirror drift-detect.cjs) ────────────────────────────────
function frontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content));
  return m ? m[1] : '';
}

function unquote(s) {
  return String(s).trim().replace(/^["']|["']$/g, '').trim();
}

// Normalize a derived_from path-ish value to an install-root-relative POSIX path: drop a `#symbol`
// anchor, resolve relative/absolute forms. Returns '' on empty. (drift-detect.cjs relTo.)
function relTo(root, p) {
  const s = String(p == null ? '' : p).split('#')[0].trim();
  if (!s) return '';
  const abs = path.isAbsolute(s) ? s : path.resolve(root, s);
  return path.relative(root, abs).split(path.sep).join('/');
}

// Parse the `derived_from:` declaration(s) from a page's frontmatter — scalar, inline list, or block
// list. Returns the raw value strings (anchors intact). (drift-detect.cjs parseDerivedFrom.)
function parseDerivedFrom(content) {
  const fm = frontmatter(content);
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^derived_from:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const val = m[1].trim();
    if (val.startsWith('[')) {
      for (const part of val.replace(/^\[|\]$/g, '').split(',')) {
        const v = unquote(part);
        if (v) out.push(v);
      }
    } else if (val) {
      out.push(unquote(val));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const li = /^\s*-\s+(.*)$/.exec(lines[j]);
        if (!li) break;
        const v = unquote(li[1]);
        if (v) out.push(v);
      }
    }
  }
  return out;
}

// The `superseded_by:` forward-link, or null. (The supersession convention H4 writes; here it is a
// report-only signal — a page already marked superseded is a decay candidate.)
function parseSupersededBy(content) {
  const fm = frontmatter(content);
  if (!fm) return null;
  const m = /^superseded_by:\s*(.+)$/m.exec(fm);
  const v = m ? unquote(m[1]) : null;
  return v || null;
}

// The malformed signal (wiki-lint.cjs lintPage): the reason a page is malformed, or null when well-formed.
function lintPage(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return 'no frontmatter';
  const end = src.indexOf('\n---', 3);
  if (end < 0) return 'unterminated frontmatter';
  const fm = src.slice(3, end);
  const missing = REQUIRED_KEYS.filter((k) => !new RegExp(`^${k}\\s*:`, 'm').test(fm));
  if (missing.length) return `missing ${missing.join('/')}`;
  return null;
}

// ── tier/slug derivation from a wiki relpath ─────────────────────────────────────
// `.wrxn/wiki/<tier>/<slug>.md` → tier (or null if not a tier-scoped wiki page).
function tierOfPath(file) {
  const m = /^\.wrxn\/wiki\/([^/]+)\/[^/]+\.md$/.exec(String(file || ''));
  return m ? m[1] : null;
}

function isHarvestPath(file) {
  return HARVEST_TIERS.includes(tierOfPath(file));
}

function slugOfPath(file) {
  return path.basename(String(file || ''), '.md');
}

// List every .md page under the 4 harvest tiers as { file (relpath), slug, tier, query }. A missing tier
// dir is skipped. The query is the page BODY (frontmatter stripped) trimmed to the near-dup budget — the
// most discriminating near-dup signal — falling back to the slug for an empty body.
function listProsePages(root) {
  const out = [];
  for (const tier of HARVEST_TIERS) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue; // tier dir absent → no pages
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue; // unreadable page → skip (fail-soft per file)
      }
      const rel = path.relative(root, file).split(path.sep).join('/');
      const slug = name.replace(/\.md$/, '');
      const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      out.push({ file: rel, slug, tier, query: (body || slug).slice(0, NEAR_DUP_QUERY_CHARS) });
    }
  }
  return out;
}

// ── the local scan (PURE over fs) — malformed + decay (orphaned/superseded) ──────
function scanLocal(root) {
  const malformed = [];
  const decay = [];
  for (const tier of HARVEST_TIERS) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(root, file).split(path.sep).join('/');
      const slug = name.replace(/\.md$/, '');

      const reason = lintPage(text);
      if (reason) malformed.push({ type: 'malformed', slug, path: rel, tier, reason });

      // orphaned — a declared derived_from source FILE no longer exists on disk (a moved SYMBOL in an
      // existing file is drift, sync's job, not orphaning; we strip the #anchor and test the FILE).
      for (const raw of parseDerivedFrom(text)) {
        const cleaned = String(raw).split('#')[0].trim();
        if (!cleaned) continue;
        const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(root, cleaned);
        if (!fs.existsSync(abs)) {
          decay.push({ type: 'decay_candidate', subtype: 'orphaned', slug, path: rel, tier, reason: `derived_from source missing: ${relTo(root, raw)}`, missing_source: relTo(root, raw) });
        }
      }

      // superseded — already carries a forward-link to its replacement.
      const sup = parseSupersededBy(text);
      if (sup) decay.push({ type: 'decay_candidate', subtype: 'superseded', slug, path: rel, tier, reason: `superseded_by: ${sup}`, superseded_by: sup });
    }
  }
  return { malformed, decay };
}

// ── near-dup gate + clusterer (PURE) ─────────────────────────────────────────────
function isProse(hit) {
  return !!hit && PROSE_TYPES.has(hit.type);
}

// A near-dup edge requires the dense cosine to clear the MEASURED threshold AND the dense arm to actually
// be present in `sources` (not just a stray semanticScore) — mirrors recall-surface's producer-drift
// defense. The fused RRF `score` is never consulted.
function nearDupQualifies(hit) {
  const sem = Number(hit && hit.semanticScore);
  const s = hit && hit.sources;
  const hasSemantic = Array.isArray(s) && s.includes('semantic');
  return Number.isFinite(sem) && hasSemantic && sem >= NEAR_DUP_THRESHOLD;
}

// Collapse pairwise near-dup edges into connected-component CLUSTERS (union-find), so a symmetric A↔B
// match is reported once and a transitive A-B-C chain is one cluster of three. Each cluster carries its
// sorted members + the STRONGEST edge similarity (the clearest dup signal). Singletons are not clusters.
function clusterNearDups(edges) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  for (const e of edges) {
    add(e.a);
    add(e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const node of parent.keys()) {
    const r = find(node);
    if (!groups.has(r)) groups.set(r, new Set());
    groups.get(r).add(node);
  }
  const groupScore = new Map();
  for (const e of edges) {
    const r = find(e.a);
    const cur = groupScore.has(r) ? groupScore.get(r) : -Infinity;
    if (e.score > cur) groupScore.set(r, e.score);
  }
  const clusters = [];
  for (const [r, members] of groups) {
    if (members.size < 2) continue;
    clusters.push({ members: [...members].sort(), score: Math.round((groupScore.get(r) || 0) * 1e4) / 1e4 });
  }
  return clusters.sort((a, b) => (a.members[0] < b.members[0] ? -1 : 1));
}

// ── the door (IO shell, injectable transport) — the recall-surface.cjs contract ──
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// Refuse a discovery file another user could have planted, or that is group/world-writable. lstat so a
// symlink's OWN ownership/mode is judged. Any fault → not trusted (treated as not-warm).
function endpointTrusted(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
  if ((st.mode & 0o022) !== 0) return false;
  return true;
}

// Discover the warm serve door from <root>/.recon-wrxn/serve-endpoint.json = {pid,port}. Returns
// {pid,port} only when the file is well-owned, present, well-formed, and the pid is alive — else null.
function discoverEndpoint(root) {
  const file = path.join(root, ENDPOINT_REL);
  if (!endpointTrusted(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const pid = Number(obj && obj.pid);
  const port = Number(obj && obj.port);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!pidAlive(pid)) return null;
  return { pid, port };
}

// Default transport: a real POST over http with a hard timeout. Resolves {statusCode, body}; rejects on
// socket error or timeout. Injectable so unit tests never touch the network (mirrors sync.cjs).
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
          if (total > MAX_RESPONSE_BYTES) { req.destroy(new Error('harvest door response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => done(resolve, { statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => done(reject, e));
      }
    );
    req.on('error', (e) => done(reject, e));
    req.setTimeout(deadline, () => req.destroy(new Error('harvest door timeout')));
    wall = setTimeout(() => req.destroy(new Error('harvest door wall-clock timeout')), deadline);
    req.write(payload);
    req.end();
  });
}

// IO shell: discover the door; if cold → { status:'unavailable' } (AC4). Otherwise query recon_find once
// per harvest-tier page with the page body, keep prose hits IN the 4 tiers that clear the threshold
// (excluding self), build pairwise edges, and cluster them. A per-page query that throws / returns
// non-200 / a malformed body contributes no edges (fail-soft per page) — the scan still completes.
async function nearDupFromDoor(root, { transport, timeoutMs } = {}) {
  const door = discoverEndpoint(root);
  if (!door) return { status: 'unavailable', clusters: [] }; // not warm → near-dup unavailable
  const pages = listProsePages(root);
  const edges = [];
  for (const p of pages) {
    let resp;
    try {
      resp = await (transport || httpTransport)({
        port: door.port,
        path: FIND_PATH,
        body: { query: p.query, limit: FETCH_LIMIT },
        timeoutMs: timeoutMs || TIMEOUT_MS,
      });
    } catch {
      continue; // timeout / connection refused → no edges from this page
    }
    if (!resp || resp.statusCode !== 200) continue;
    let parsed;
    try {
      parsed = JSON.parse(resp.body);
    } catch {
      continue; // malformed body → no edges from this page
    }
    const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
    for (const h of hits) {
      if (!isProse(h) || !isHarvestPath(h.file) || h.file === p.file) continue;
      if (!nearDupQualifies(h)) continue;
      edges.push({ a: p.file, b: h.file, score: Number(h.semanticScore) });
    }
  }
  return { status: 'ok', clusters: clusterNearDups(edges) };
}

// ── record assembly (PURE) ───────────────────────────────────────────────────────
// One JSON record per finding, each carrying enough to seed a downstream proposal (AC5). A cold door
// emits a single near_dup "unavailable" marker (AC4); malformed + decay always pass through.
function assembleRecords(ts, near, local) {
  const records = [];
  if (!near || near.status === 'unavailable') {
    records.push({ ts, type: 'near_dup', status: 'unavailable', reason: 'recon serve door not warm — near-dup detection skipped (malformed + decay scans still ran)' });
  } else {
    for (const c of near.clusters) {
      records.push({
        ts,
        type: 'near_dup',
        members: c.members.map((f) => ({ slug: slugOfPath(f), path: f, tier: tierOfPath(f) })),
        score: c.score,
        threshold: NEAR_DUP_THRESHOLD,
        reason: `semantic similarity >= ${NEAR_DUP_THRESHOLD} (measured near-dup band; dense cosine over the recon door)`,
      });
    }
  }
  for (const d of local.decay) records.push(Object.assign({ ts }, d));
  for (const m of local.malformed) records.push(Object.assign({ ts }, m));
  return records;
}

function harvestDir(root) {
  const dir = path.join(root, ...HARVEST_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A fresh, never-mutated timestamped report path (AC2). A same-millisecond collision bumps a counter.
function reportPath(dir, ts) {
  const base = ts.replace(/[:.]/g, '-');
  let file = path.join(dir, `${base}.jsonl`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}.jsonl`);
  return file;
}

// ── check: the IO orchestrator ───────────────────────────────────────────────────
// scanLocal (always) + nearDupFromDoor (degrades to unavailable when cold) → assemble → write the jsonl.
// REPORT-ONLY: the ONLY write is the report under .wrxn/harvest/. `transport` is injected in tests.
async function check(root, { transport, timeoutMs } = {}) {
  const local = scanLocal(root);
  let near;
  try {
    near = await nearDupFromDoor(root, { transport, timeoutMs });
  } catch {
    near = { status: 'unavailable', clusters: [] }; // belt-and-suspenders: never throws
  }
  const ts = new Date().toISOString();
  const records = assembleRecords(ts, near, local);
  const dir = harvestDir(root);
  const file = reportPath(dir, ts);
  fs.writeFileSync(file, records.length ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  const nearDupCount = near.status === 'unavailable' ? 0 : near.clusters.length;
  return {
    report: path.relative(root, file),
    records,
    summary: {
      nearDupStatus: near.status,
      findings: { near_dup: nearDupCount, decay_candidate: local.decay.length, malformed: local.malformed.length },
    },
  };
}

async function runCheck() {
  const root = installRoot();
  const res = await check(root, {});
  print({ report: res.report, summary: res.summary });
  process.exit(0);
}

// ════════════════════════════════════════════════════════════════════════════════
// MERGE (harvest-03 / H3) — the ONE sanctioned hard-delete: fold N near-dups into one survivor, then
// delete the absorbed. The SKILL (LLM) drafts the survivor (union of facts + union of evidence); THIS
// adapter GATES + writes. Reuses sync's propose→confirm by-reference spine (secret-scan, sha256 integrity,
// path-confinement) and dream's wiki-bridge indirection (the absorbed delete goes through wiki.cjs).
// ════════════════════════════════════════════════════════════════════════════════

// ── shared CLI/IO helpers (mirror sync.cjs / dream.cjs) ──────────────────────────
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

function isObj(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

// A wiki slug — the same kebab contract wiki.cjs enforces. A non-kebab absorbed slug would (a) inject a
// newline/colon into the survivor's `merged_from:` frontmatter and (b) fail wiki.cjs delete-page — reject it.
function isKebab(s) {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s);
}

// ── credential / secret scan (reused from dream.cjs / sync.cjs, security M2) ─────
// A merged survivor must never harden a session secret into recalled prose. Same patterns + case-sensitive
// scope as dream/sync — replicated because each install-only adapter is self-contained (node stdlib only).
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                    // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{36}/,           // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  /npm_[A-Za-z0-9]{36}/,                 // npm automation token
  /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style secret key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM private-key header
];

function secretScan(text) {
  const s = String(text || ''); // NOT lowercased — the token shapes are case-sensitive.
  for (const re of SECRET_PATTERNS) if (re.test(s)) return 'contains_secret';
  return null;
}

// ── path safety: a merge target may address ONLY a .md page under a KNOWLEDGE tier ─
// The survivor + every absorbed path is LLM/operator-controlled, so it is the trust boundary. This is
// sync's resolveSafeDoc TIGHTENED to the curation scope: the path must resolve to exactly
// .wrxn/wiki/<tier>/<slug>.md where tier ∈ HARVEST_TIERS (concepts/decisions/gotchas/_rules) — not the
// retired sessions tier, not the _slots focus slot, not anything outside the wiki subtree. Returns the
// abs path or null. Lexical (path.resolve never follows a symlink) — a planted symlink's STRING is judged.
function resolveSafeHarvestDoc(root, doc) {
  if (typeof doc !== 'string' || !doc.trim()) return null;
  const wikiRoot = path.join(root, ...WIKI_REL);
  const abs = path.resolve(root, doc);
  const rel = path.relative(wikiRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // escapes .wrxn/wiki/
  if (!abs.endsWith('.md')) return null; // prose pages only
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null; // must be exactly <tier>/<slug>.md — no nesting
  if (!HARVEST_TIERS.includes(parts[0])) return null; // not a knowledge tier (sessions / _slots / other)
  return abs;
}

// The integrity fingerprint captured at stage over the fields that DETERMINE the write+deletes (survivor
// target, its description+body, the absorbed set). Recomputed at the write boundary and compared to the
// staged value → a record whose body/target/absorbed-list was altered after staging cannot write or delete
// (AC2 tamper-refusal). absorbed is sorted so the hash is order-independent (mirrors sync's proposalHash).
function mergeHash(p) {
  const absorbed = (Array.isArray(p.absorbed) ? p.absorbed.map(String) : []).slice().sort();
  const canon = JSON.stringify({ survivor: String(p.survivor || ''), description: String(p.description || ''), body: String(p.body || ''), absorbed });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// ── the survivor page (PURE) — the net-new write transform ───────────────────────
// Compose a well-formed knowledge page (passes lintPage: name/description/tier) stamped with
// `merged_from: [<absorbed slugs>]` — the provenance lands on the SURVIVING page, NEVER on the deleted
// ones (you cannot stamp a deleted page). `superseded_by:` is H4's non-destructive op, not merge's. The
// absorbed slugs are kebab-validated before they reach here, so the inline list cannot inject frontmatter.
function composeSurvivor({ tier, slug, description, body, mergedFrom }) {
  return [
    '---',
    `name: ${slug}`,
    `description: ${description || ''}`,
    `tier: ${tier}`,
    'source: harvest-merge',
    `merged_from: [${mergedFrom.join(', ')}]`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

// ── the wiki delete bridge (dream.cjs indirection contract) ──────────────────────
function wikiAdapter() {
  return path.join(__dirname, 'wiki.cjs'); // sibling in the same install .wrxn/ dir
}

// Guard the harvest→wiki bridge against argv flag-injection (dream's security M3): a `--`-leading value
// would be parsed by wiki.cjs's flag scan as a flag. tier/slug are allowlisted/kebab so this is the
// defense-in-depth backstop at the exec boundary.
function guardArgv(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.startsWith('--')) {
      throw new Error(`flag-injection guard: refusing a --leading value at the wiki bridge: ${JSON.stringify(v.slice(0, 32))}`);
    }
  }
}

// Delete an absorbed page VIA the wiki adapter's delete-by-reference path (the indirection contract — we
// never unlink a .md directly). wiki.cjs confines the delete to the wiki subtree (tier allowlist + kebab
// slug); harvest has ALREADY confined to the knowledge tiers via resolveSafeHarvestDoc — defense in depth.
function wikiDeletePage(root, tier, slug) {
  guardArgv([tier, slug]);
  const args = [wikiAdapter(), 'delete-page', tier, slug, '--root', root];
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

// ── stage / commit by-reference (mirror sync's propose/confirm) ──────────────────
// Read .wrxn/harvest/staged.jsonl into a survivor → staged-record map (last staged wins). Malformed lines
// skip. A record needs a survivor key, a string body, and an absorbed array to be a usable merge.
function readStaged(root) {
  const map = new Map();
  let txt;
  try {
    txt = fs.readFileSync(path.join(root, ...HARVEST_DIR, STAGED_FILE), 'utf8');
  } catch {
    return map; // no staging trail yet → nothing to confirm by reference
  }
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && rec.survivor && typeof rec.body === 'string' && Array.isArray(rec.absorbed)) map.set(rec.survivor, rec);
    } catch {
      /* skip a malformed staging line */
    }
  }
  return map;
}

// Normalize commit input into the operator-approved SURVIVOR list (["survivor-path"…] or { approved:[…] }).
// An EMPTY list is the DECLINE — commit writes nothing, deletes nothing (AC3).
function approvedSurvivors(input) {
  if (Array.isArray(input)) return input.map(String);
  if (input && typeof input === 'object' && Array.isArray(input.approved)) return input.approved.map(String);
  return [];
}

// stage (PROPOSE): validate the drafted survivor + the absorbed cluster, secret-scan, then record the
// proposal by-reference under .wrxn/harvest/staged.jsonl with an integrity fingerprint. NEVER touches a
// knowledge page (the survivor is not written, the absorbed are not deleted) — mirrors sync's propose.
function runStage() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const p = isObj(input) ? input : {};

  const survAbs = resolveSafeHarvestDoc(root, p.survivor);
  if (!survAbs) fail('stage needs a "survivor" path under .wrxn/wiki/<knowledge-tier>/ ending in .md');
  if (!isKebab(slugOfPath(p.survivor))) fail('the survivor slug must be kebab-case ([a-z0-9-])');
  if (typeof p.body !== 'string' || !p.body.trim()) fail('stage needs a non-empty "body" — the synthesised survivor the skill drafted');
  if (p.body.length > BODY_MAX) fail(`stage rejected — body exceeds the ${BODY_MAX}-char cap (body_too_large); a durable merged page, not a dump`);

  const absorbed = Array.isArray(p.absorbed) ? p.absorbed.map(String) : [];
  if (absorbed.length === 0) fail('stage needs a non-empty "absorbed" list — the near-dup slugs folded into the survivor');
  for (const a of absorbed) {
    if (!resolveSafeHarvestDoc(root, a)) fail(`absorbed target escapes the knowledge tiers (must be .wrxn/wiki/<knowledge-tier>/<slug>.md): ${JSON.stringify(a)}`);
    if (!isKebab(slugOfPath(a))) fail(`absorbed slug must be kebab-case: ${JSON.stringify(a)}`);
    if (a === p.survivor) fail('the survivor cannot also be an absorbed (delete) target');
  }

  const description = p.description ? String(p.description) : '';
  const sec = secretScan(`${description}\n${p.body}`); // AC1: secret-scan BEFORE staging
  if (sec) fail(`stage rejected — the drafted survivor contains a credential (${sec}); never fold a session secret into knowledge`);

  const dir = harvestDir(root);
  const ts = new Date().toISOString();
  const record = {
    ts, op: 'stage',
    survivor: p.survivor, tier: tierOfPath(p.survivor), slug: slugOfPath(p.survivor),
    description, body: p.body, absorbed,
    hash: mergeHash({ survivor: p.survivor, description, body: p.body, absorbed }),
  };
  appendLine(path.join(dir, STAGED_FILE), record);
  appendLine(path.join(dir, AUDIT_FILE), { ts, op: 'stage', survivor: p.survivor, absorbed });
  return print({ staged: 1, survivor: p.survivor, absorbed, stagedFile: path.relative(root, path.join(dir, STAGED_FILE)) });
}

// commitOne: the write-boundary re-gate for ONE approved survivor. RE-VALIDATE (secret-scan → integrity →
// path-confine survivor AND every absorbed → survivor is new) BEFORE any mutation, so a tampered/altered
// proposal cannot write or delete (AC2). Then — and only then — WRITE THE SURVIVOR FIRST (knowledge
// preserved), THEN delete each absorbed (AC4 survivor-before-delete). Atomic on validation: if ANY target
// is unsafe the whole merge is refused (no partial delete). Returns { ok, ... } | { ok:false, reason }.
function commitOne(root, rec) {
  const description = rec.description ? String(rec.description) : '';
  const sec = secretScan(`${description}\n${rec.body}`); // re-scan at the write boundary
  if (sec) return { ok: false, reason: sec };
  if (mergeHash(rec) !== rec.hash) return { ok: false, reason: 'integrity_mismatch' }; // tamper → refuse

  const survAbs = resolveSafeHarvestDoc(root, rec.survivor);
  if (!survAbs) return { ok: false, reason: 'unsafe_survivor' };
  if (!isKebab(slugOfPath(rec.survivor))) return { ok: false, reason: 'unsafe_survivor' };
  // additive / refuse-overwrite: the survivor is a NEW page. lstat (not existsSync) so a planted symlink or
  // any pre-existing entry is caught — never clobber a curated page. This check runs BEFORE any delete, so a
  // refused survivor write means nothing is deleted (the structural proof of survivor-before-delete).
  try {
    fs.lstatSync(survAbs);
    return { ok: false, reason: 'survivor_exists' };
  } catch {
    /* nothing there → safe to create */
  }

  // confine + validate EVERY absorbed target up front (atomic) — one unsafe target refuses the whole merge.
  const targets = [];
  for (const a of rec.absorbed.map(String)) {
    const abs = resolveSafeHarvestDoc(root, a);
    if (!abs || !isKebab(slugOfPath(a))) return { ok: false, reason: 'unsafe_absorbed' };
    if (a === rec.survivor) return { ok: false, reason: 'survivor_in_absorbed' }; // never delete the survivor
    targets.push({ rel: a, tier: tierOfPath(a), slug: slugOfPath(a) });
  }

  // WRITE THE SURVIVOR FIRST — the merged knowledge exists on disk before any page is deleted (AC4).
  const mergedFrom = targets.map((t) => t.slug).slice().sort();
  const page = composeSurvivor({ tier: rec.tier, slug: rec.slug, description, body: rec.body, mergedFrom });
  fs.mkdirSync(path.dirname(survAbs), { recursive: true });
  fs.writeFileSync(survAbs, page);

  // THEN delete each absorbed — ONLY the staged cluster members (no free-form delete path) (AC4).
  const deleted = [];
  const deleteFailed = [];
  for (const t of targets) {
    try {
      wikiDeletePage(root, t.tier, t.slug);
      deleted.push(t.rel);
    } catch (e) {
      // the survivor is already written (knowledge preserved); a failed delete leaves a harmless leftover,
      // recorded for the operator — it never undoes the merge.
      deleteFailed.push({ target: t.rel, reason: String((e && e.message) || 'delete_failed').split('\n')[0] });
    }
  }
  return { ok: true, survivor: rec.survivor, merged_from: mergedFrom, deleted, deleteFailed };
}

// commit (CONFIRM): for each operator-approved survivor, look up its staged merge and run commitOne. An
// empty approval is the decline (nothing changes, AC3). Then append the outcome to the audit log.
function runCommit() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const approved = approvedSurvivors(input);
  const staged = readStaged(root);
  const merged = [];
  const skipped = [];
  for (const ref of approved) {
    const key = String(ref);
    const rec = staged.get(key);
    if (!rec) { skipped.push({ survivor: key, reason: 'not_staged' }); continue; }
    const res = commitOne(root, rec);
    if (res.ok) merged.push({ survivor: res.survivor, merged_from: res.merged_from, deleted: res.deleted, deleteFailed: res.deleteFailed });
    else skipped.push({ survivor: key, reason: res.reason });
  }
  appendLine(path.join(harvestDir(root), AUDIT_FILE), { ts: new Date().toISOString(), op: 'commit', merged: merged.map((m) => m.survivor), skipped });
  return print({ merged, skipped });
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'check':
      return runCheck();
    case 'stage':
      return runStage();
    case 'commit':
      return runCommit();
    default:
      process.stdout.write('Usage: node .wrxn/harvest.cjs <check [--root <dir>] | stage <proposal.json> | commit <approved.json>> [--root <dir>]\n');
      process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) {
  main().catch((err) => fail(err && err.message ? err.message : 'unexpected error'));
}

module.exports = {
  // pure
  lintPage,
  parseDerivedFrom,
  parseSupersededBy,
  scanLocal,
  isProse,
  nearDupQualifies,
  clusterNearDups,
  assembleRecords,
  tierOfPath,
  isHarvestPath,
  // io
  nearDupFromDoor,
  check,
  discoverEndpoint,
  httpTransport,
  pidAlive,
  findInstallRoot,
  // merge (harvest-03) — pure gate primitives
  secretScan,
  resolveSafeHarvestDoc,
  mergeHash,
  composeSurvivor,
  isKebab,
  // constants
  HARVEST_TIERS,
  NEAR_DUP_THRESHOLD,
  FIND_PATH,
};
