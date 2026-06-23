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
//   · decay_candidate an orphaned page (its `derived_from:` source FILE is gone) that is NOT yet annotated.
//                     A page already carrying `stale:` or `superseded_by:` is RESOLVED (the curated end
//                     state) and excluded, so a fully-curated tree reads clean. A LOCAL scan — no door.
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
const AUDIT_FILE = 'audit.jsonl'; // append-only outcome log (stage + commit + decay events).
const DECAY_STAGED_FILE = 'decay-staged.jsonl'; // harvest-04: proposed-but-unconfirmed decay annotations (by-reference). Distinct fixed name from merge's staged.jsonl; both non-.md so recon never recalls a staged-but-unconfirmed op.
// Bounded retention for the timestamped <ts>.jsonl check reports (phase-4.5-04). `check` writes a fresh
// report every run; without a cap the dir grows without bound on a long-lived install. Keep the N most-recent
// (ISO timestamps sort lexically = chronologically — no clock read). 20 is a generous trailing window of
// recent checks for trend/diff while strictly bounding growth; env override (clamped >= 1 so the just-written
// report is never pruned) mirrors synapse's WRXN_HANDOFF_PCT precedent. REPORT_RE matches ONLY a timestamped
// report — the fixed-name state files (staged/audit/decay-staged.jsonl) + .gitkeep never match, never prune.
const REPORT_RETAIN_DEFAULT = 20;
const REPORT_RE = /^\d{4}-\d{2}-\d{2}T.*\.jsonl$/;
const BODY_MAX = 32000; // survivor body cap (chars) — a durable merged page, not a dump (dream/sync parity).
const WIKI_REL = ['.wrxn', 'wiki']; // all merge targets confine under <root>/.wrxn/wiki/<knowledge-tier>/.
const WIKI_PREFIX = '.wrxn/wiki/'; // stripped to form the reinforce.json wiki-rel join key (recall-surface parity).
const REINFORCE_REL = path.join('.wrxn', 'reinforce.json'); // the coalesced access-recency sidecar (harvest-08 / D2) — STATE.
// The reinforced-exclusion window (AC4). 30 days is the project's established staleness boundary (the
// ai-memory briefing buckets activity at 7d/30d and treats >30d as stale): a page surfaced in Recall
// within the last month is demonstrably LIVE knowledge and must never be flagged stale/superseded, while a
// page un-surfaced for over a month is fair game for a decay annotation. Day-granular (the sidecar's grain).
const REINFORCE_WINDOW_DAYS = 30;
const VALUE_MAX = 256; // cap on a decay annotation VALUE (a path) — a frontmatter write channel, not a body.
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

// The `superseded_by:` forward-link, or null — the supersession convention H4 writes. Exported pure helper;
// NOT consulted by scanLocal, which treats a `superseded_by:` page as the RESOLVED end state, not debt.
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

      // An already-annotated page (carries stale: or superseded_by:) is RESOLVED — its decay was already
      // actioned: a superseded_by: forward-link is the desired end state (PRD US3, "forward-linked, not
      // deleted"), and a stale: stamp is the resolution harvest offers for an orphan. Re-emitting it as a
      // decay_candidate would re-arm the handoff debt nudge over a fully-curated tree forever (harvest-05
      // AC2/AC8: clean set → silent). Skip the decay scan for it (the malformed lint above still applies).
      if (hasFrontmatterKey(text, 'stale') || hasFrontmatterKey(text, 'superseded_by')) continue;

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

// Order clusters by a STABLE total order so an unchanged tree yields a byte-identical report every run
// (phase-4.5-04). Primary key = the lexically-first member. The old `(a,b) => a.members[0] < b.members[0]
// ? -1 : 1` returned 1 for BOTH compare(a,b) AND compare(b,a) on an equal leading member — non-antisymmetric,
// so V8's sort could resolve tied clusters by input permutation → non-reproducible reports. Clusters are
// disjoint connected components, so leading members never collide TODAY; the secondary keys make this a
// proper total order regardless (defense in depth): larger cluster first, then the stronger edge score, then
// the full member list — and two truly-identical clusters compare EQUAL (return 0).
function compareClusters(a, b) {
  if (a.members[0] !== b.members[0]) return a.members[0] < b.members[0] ? -1 : 1;
  if (a.members.length !== b.members.length) return b.members.length - a.members.length; // larger cluster first
  if (a.score !== b.score) return b.score - a.score; // stronger dup signal first
  const ja = a.members.join(' ');
  const jb = b.members.join(' ');
  return ja < jb ? -1 : ja > jb ? 1 : 0; // full member list; identical clusters → 0
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
  return clusters.sort(compareClusters);
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

// The effective report-retention bound: the WRXN_HARVEST_RETAIN env override (clamped to a whole number >= 1
// so a bogus/zero value can never prune away the just-written report), else the sane default (phase-4.5-04).
function reportRetention() {
  const env = Number(process.env.WRXN_HARVEST_RETAIN);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : REPORT_RETAIN_DEFAULT;
}

// Prune the timestamped check reports under .wrxn/harvest/ to the retention bound, keeping the `keep` most-
// recent (phase-4.5-04). ISO timestamps sort lexically = chronologically, so the oldest are the lexical
// prefix — no clock is read. ONLY <ts>.jsonl reports are eligible (REPORT_RE); the fixed-name state files
// (staged/audit/decay-staged.jsonl) + .gitkeep never match, so curation/merge/decay trails are never touched.
// Fail-soft: an unreadable dir or a failed unlink is swallowed — retention is hygiene, never the point of check.
function pruneReports(dir, keep, protect) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no report dir yet → nothing to prune
  }
  const reports = names.filter((n) => REPORT_RE.test(n)).sort(); // lexical = chronological (oldest first)
  // Delete the oldest down to the `keep` bound, but NEVER the just-written report (`protect`): a same-
  // millisecond collision names it `<base>-N.jsonl`, which collates BEFORE its `<base>.jsonl` sibling, so a
  // blind oldest-prefix prune could delete the fresh report `check` is about to return (phase-4.5-04 review).
  let toDelete = reports.length - keep;
  for (let i = 0; i < reports.length && toDelete > 0; i++) {
    if (reports[i] === protect) continue; // the fresh report is retained and counts toward `keep`
    try {
      fs.unlinkSync(path.join(dir, reports[i]));
    } catch {
      /* fail-soft — a vanished/locked report never breaks the check run */
    }
    toDelete--;
  }
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
  pruneReports(dir, reportRetention(), path.basename(file)); // phase-4.5-04: bound the report dir, never pruning the fresh report
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

// The first positional at-or-after `start` (up to the first --flag), or undefined when none. Used by the
// two-word `decay propose|confirm` grammar (the sub-verb is argv[3], so its file argument starts at argv[4]).
function positionalAfter(start) {
  for (let i = start; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    return process.argv[i];
  }
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
  // EXPLICIT tier-resolves invariant (harvest-review). path.resolve above COLLAPSES `..`, so a NON-CANONICAL
  // form like `.wrxn/wiki/concepts/../concepts/x.md` survives the confinement check yet tierOfPath() returns
  // null on that raw string — and the merge/decay callers stamp tier/slug from this SAME string (tierOfPath/
  // slugOfPath), yielding a malformed `tier: null` survivor page on the ONE destructive (delete) path. Require
  // the path the callers stamp from to tier-resolve cleanly, so the page written and the recorded tier always
  // agree. tierOfPath only matches a clean `.wrxn/wiki/<tier>/<slug>.md` → a non-canonical path is refused.
  if (!tierOfPath(doc)) return null; // non-canonical / not tier-resolvable → fail-closed (no tier:null page, no delete)
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

// ── the survivor frontmatter write-channel sanitiser (PURE) ──────────────────────
// composeSurvivor interpolates the LLM/operator-drafted `description` VERBATIM as `description: <value>`
// on one frontmatter line. A newline injects an arbitrary extra frontmatter key (e.g. a poisoned
// `importance:` that hijacks decay-weighted recall — harvest never stamps importance: itself); a colon
// creates YAML mapping ambiguity. Reject both — the same write-channel discipline decay's
// annotationValueProblem applies, here WITHOUT its path-length cap + non-empty check (a description is
// optional free prose). name/tier/merged_from in the same fence are kebab/allowlist-validated already, so
// `description` is the lone free-text frontmatter field. Returns a problem code or null.
function descriptionProblem(value) {
  if (/[\r\n:]/.test(String(value == null ? '' : value))) return 'malformed_description';
  return null;
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

// ── lineage stamp — the provenance PRODUCER (S3 / #22, mirrors dream.cjs) ───────
// A merged survivor is a net-new durable page, so it records WHO wrote it: origin_session (the session id),
// synth_run (the per-run id = this run's audit ts), proposal_id (the survivor slug). Machine-written
// frontmatter only — the survivor body is preserved byte-for-byte (no churn). Replicated here (not imported)
// because each install-only adapter is self-contained (node stdlib only) — same discipline as secretScan.
const LINEAGE_KEYS = ['origin_session', 'synth_run', 'proposal_id'];

// One bare frontmatter scalar — strip CR/LF/colon to a space so a value can never inject a key or YAML
// mapping (composeSurvivor's frontmatter write-channel discipline). Empty → 'unknown' (the key is always present).
function lineageScalar(value) {
  const s = String(value == null ? '' : value).replace(/[\r\n:]+/g, ' ').trim();
  return s || 'unknown';
}

// PURE in-place stamp: set each lineage key (no duplicate key) in the frontmatter fence; the body after the
// closing fence is preserved byte-for-byte. No fence → returned unchanged (defensive — wiki pages carry one).
function stampLineage(content, lineage) {
  const text = String(content);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const lines = m[1].split(/\r?\n/);
  for (const key of LINEAGE_KEYS) {
    const value = lineageScalar(lineage && lineage[key]);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^${key}:\\s*`).test(lines[i])) { lines[i] = `${key}: ${value}`; found = true; break; }
    }
    if (!found) lines.push(`${key}: ${value}`);
  }
  return text.slice(0, m.index) + ['---', lines.join('\n'), '---'].join('\n') + text.slice(m.index + m[0].length);
}

// The current session id for this CLI-invoked adapter — Claude Code exports it; absent ⇒ 'unknown' (fail-open).
function currentSession() {
  return lineageScalar(process.env.CLAUDE_SESSION_ID);
}

// ── forward evidence stamp — the citation PRODUCER (C3 / #36, mirrors dream.cjs) ─
// A merged survivor records the FACTS that make its citation resolvable: session (the consolidating
// session id), commit (the real git HEAD at write time), symbols (the session's .touched set). The same
// evidence-frontmatter contract recon-wrxn ②'s edge resolver reads. Replicated here (not imported) — each
// install-only adapter is self-contained (node stdlib only), the same discipline as secretScan/stampLineage.

// A bare nested scalar (session/commit) — strip CR/LF/colon so a value can never inject a key or YAML mapping.
function evidenceScalar(value) {
  return String(value == null ? '' : value).replace(/[\r\n:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A symbol list item — also strip the inline-flow-list breakers ([ ] ,) so a path can never break the list shape.
function symbolScalar(value) {
  return String(value == null ? '' : value).replace(/[[\],\r\n:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Drop any pre-existing `evidence:` mapping (key line + indented members) so a re-stamp has no duplicate block.
function stripEvidence(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^evidence:/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\s+\S/.test(line)) continue;
    inBlock = false;
    out.push(line);
  }
  return out;
}

// PURE in-place stamp (mirrors stampLineage): append an `evidence:` mapping to the frontmatter fence; the body
// after the closing fence is preserved byte-for-byte. No fence → returned unchanged. FAIL-OPEN: an empty
// commit/symbols field is OMITTED; session falls back to the 'unknown' sentinel so the key is always present.
function stampEvidence(content, evidence) {
  const text = String(content);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const ev = evidence || {};
  const lines = stripEvidence(m[1].split(/\r?\n/));
  lines.push('evidence:');
  lines.push(`  session: ${evidenceScalar(ev.session) || 'unknown'}`);
  const commit = evidenceScalar(ev.commit);
  if (commit) lines.push(`  commit: ${commit}`);
  const symbols = (Array.isArray(ev.symbols) ? ev.symbols : []).map(symbolScalar).filter(Boolean);
  if (symbols.length) lines.push(`  symbols: [${symbols.join(', ')}]`);
  return text.slice(0, m.index) + ['---', lines.join('\n'), '---'].join('\n') + text.slice(m.index + m[0].length);
}

// PURE resolver (deterministic given injected IO): gather the evidence facts. The git HEAD resolver + touched
// set + session anchor are injected, so the core is unit-tested with no live repo. FAIL-OPEN: a resolveHead
// that throws/returns nothing → commit null; a missing touched set → []. NEVER throws.
function resolveEvidence({ session, resolveHead, touched } = {}) {
  let commit = null;
  try {
    const head = typeof resolveHead === 'function' ? resolveHead() : null;
    commit = head ? String(head) : null;
  } catch {
    commit = null; // no git binary / not a repo / detached → no commit (fail-open)
  }
  return { session: session == null ? '' : String(session), commit, symbols: Array.isArray(touched) ? touched : [] };
}

// Resolve the install repo's current git HEAD — the citation's `commit`. Rooted at the install. Fail-open:
// no git / not a repo → null (mirrors dream.cjs / session-end-reward.cjs resolveGitHead).
function resolveGitHead(root) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = String(out || '').trim();
    return sha || null;
  } catch {
    return null;
  }
}

// The session-id → filename transform — MUST match code-intel-push's safeId byte-for-byte (replicated, no import).
function safeSessionId(sid) {
  return String(sid || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
}

// Read this session's edited paths from <root>/.wrxn/history/<safeId>.touched — the citation's `symbols` set
// (REUSE the list code-intel-push maintains). Deduped, order preserved. FAIL-OPEN: absent/unreadable → [].
function readTouched(root, sessionId) {
  if (!root) return [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.wrxn', 'history', `${safeSessionId(sessionId)}.touched`), 'utf8');
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
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
  if (descriptionProblem(description)) fail('stage rejected — the survivor description must not contain a newline or colon (frontmatter-injection guard)');

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
function commitOne(root, rec, lineage, evidence) {
  const description = rec.description ? String(rec.description) : '';
  const sec = secretScan(`${description}\n${rec.body}`); // re-scan at the write boundary
  if (sec) return { ok: false, reason: sec };
  if (descriptionProblem(description)) return { ok: false, reason: 'malformed_description' }; // re-check the frontmatter write channel — a tampered staged record (valid hash) can't smuggle an injected key through
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
  // S3 (#22): stamp the survivor's lineage (origin_session/synth_run/proposal_id) into its frontmatter at
  // compose time — proposal_id is the survivor slug. The body is preserved byte-for-byte (no churn).
  const stamped = stampLineage(page, {
    origin_session: (lineage && lineage.origin_session) || currentSession(),
    synth_run: (lineage && lineage.synth_run) || 'unknown',
    proposal_id: rec.slug,
  });
  // C3 (#36): stamp the forward citation evidence (session/commit/symbols) at compose time — beside lineage,
  // before the write. The body is preserved byte-for-byte (no churn); fail-open omits any unresolved field.
  const withEvidence = stampEvidence(stamped, evidence);
  fs.mkdirSync(path.dirname(survAbs), { recursive: true });
  fs.writeFileSync(survAbs, withEvidence);

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
  // One ts per run: it keys this run's audit event AND is the survivors' synth_run, so a survivor's stamped
  // synth_run is byte-identical to the run id in the audit log (S3 #22 provenance binding, dream parity).
  const ts = new Date().toISOString();
  const lineage = { origin_session: currentSession(), synth_run: lineageScalar(ts) };
  // C3 (#36): the forward citation FACTS, resolved ONCE per run from ground truth (session/git HEAD/.touched).
  const evidence = resolveEvidence({ session: lineage.origin_session, resolveHead: () => resolveGitHead(root), touched: readTouched(root, lineage.origin_session) });
  for (const ref of approved) {
    const key = String(ref);
    const rec = staged.get(key);
    if (!rec) { skipped.push({ survivor: key, reason: 'not_staged' }); continue; }
    const res = commitOne(root, rec, lineage, evidence);
    if (res.ok) merged.push({ survivor: res.survivor, merged_from: res.merged_from, deleted: res.deleted, deleteFailed: res.deleteFailed });
    else skipped.push({ survivor: key, reason: res.reason });
  }
  appendLine(path.join(harvestDir(root), AUDIT_FILE), { ts, op: 'commit', synth_run: lineageScalar(ts), origin_session: lineage.origin_session, merged: merged.map((m) => m.survivor), skipped });
  return print({ merged, skipped });
}

// ════════════════════════════════════════════════════════════════════════════════
// DECAY / SUPERSESSION (harvest-04 / H4) — the NON-destructive curation op: ANNOTATE a superseded or
// orphaned page so Recall + the operator know its status, WITHOUT ever deleting it (provenance survives —
// Letta eviction-not-delete). Two annotation kinds, each landing as ONE forward-link key in the page
// FRONTMATTER (the body is never touched):
//   · stale: <missing-source-path>   — an orphaned page whose `derived_from:` source FILE is gone. Auto-
//                                       derived from H2's scanLocal (mechanical — no judgment needed).
//   · superseded_by: <path>          — a page replaced by another. A skill/operator JUDGMENT drafted into
//                                       a proposal file (auto-scan cannot invent the replacement target).
// Reuses sync-06 / merge's propose→confirm by-reference spine (secret-scan, sha256 integrity, path-
// confinement) and the sync restampDoc spirit (an in-place single-key frontmatter stamp that preserves all
// other frontmatter). There is NO delete path here — decay only annotates (delete is H3 alone).
// ════════════════════════════════════════════════════════════════════════════════

// ── the reinforced-exclusion reader (AC4) — read the coalesced recency sidecar ────
// A day-granular UTC stamp (YYYY-MM-DD) — the reinforce.json grain (recall-surface.cjs dayStamp parity).
// Injectable clock so the window is deterministic under test.
function dayStamp(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return d.toISOString().slice(0, 10);
}

// The window cutoff: today minus REINFORCE_WINDOW_DAYS, as a YYYY-MM-DD string. ISO dates sort lexically,
// so a string `>=` against this cutoff is the within-window test.
function cutoffDay(now) {
  const base = now instanceof Date ? new Date(now.getTime()) : new Date(now == null ? Date.now() : now);
  base.setUTCDate(base.getUTCDate() - REINFORCE_WINDOW_DAYS);
  return base.toISOString().slice(0, 10);
}

// The wiki-root-relative join key for a page path: tolerate a leading './', normalize separators, strip the
// '.wrxn/wiki/' prefix → e.g. 'concepts/foo.md'. IDENTICAL to recall-surface.cjs wikiRelPath (the reinforce
// sidecar is keyed this way on the writer side — a slug-vs-path mismatch would silently break the exclusion).
function wikiRelOf(file) {
  const f = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const i = f.indexOf(WIKI_PREFIX);
  if (i === -1) return null;
  return f.slice(i + WIKI_PREFIX.length) || null;
}

// Read <root>/.wrxn/reinforce.json → the Set of wiki-rel paths surfaced within the window (AC4). Wholly
// graceful: an absent sidecar (the common case — D2 may not have run yet), a corrupt body, or a non-map
// shape all yield an EMPTY set (nothing treated as reinforced) and NEVER throw.
function reinforcedSet(root, now) {
  const out = new Set();
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, REINFORCE_REL), 'utf8');
  } catch {
    return out; // absent sidecar → nothing reinforced (graceful)
  }
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    return out; // corrupt → nothing reinforced (never clobber, never throw)
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out; // not a map → nothing reinforced
  const cutoff = cutoffDay(now);
  for (const [key, val] of Object.entries(map)) {
    if (typeof val !== 'string') continue;
    const day = val.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day >= cutoff) out.add(key); // within the window (inclusive)
  }
  return out;
}

// ── the annotation value sanitiser (write-channel safety, sync's fingerprintProblem analog) ──
// The value lands VERBATIM as `<key>: <value>` on one frontmatter line — a write channel the page-confine
// gate doesn't cover. Reject a newline (frontmatter injection), a colon (YAML mapping ambiguity — and a
// legit stale/superseded_by value is a plain POSIX path with neither), empty, oversize; then secret-scan
// (a credential must never harden into recalled frontmatter). Returns a problem code or null.
function annotationValueProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'malformed_value';
  if (/[\r\n:]/.test(value)) return 'malformed_value'; // newline → injection; colon → YAML ambiguity
  if (value.length > VALUE_MAX) return 'malformed_value';
  return secretScan(value); // 'contains_secret' (value is a write channel) | null
}

// The integrity fingerprint over the fields that DETERMINE the write (the page target, the annotation key,
// and the value). Recomputed at the write boundary and compared to the staged value → a record whose
// page/key/value was altered after staging cannot write (AC2 tamper-refusal). The reason is operator-facing
// metadata only (never written into the page), so it is deliberately OUT of the hash.
function decayHash(p) {
  const canon = JSON.stringify({ page: String(p.page || ''), key: String(p.key || ''), value: String(p.value || '') });
  return crypto.createHash('sha256').update(canon).digest('hex');
}

// ── the in-place frontmatter annotation (PURE) — the sync restampDoc spirit ───────
// True when the page's frontmatter ALREADY carries `<key>:` — the idempotency probe (AC5). No fence → false.
function hasFrontmatterKey(content, key) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content));
  if (!m) return false;
  return new RegExp(`^${key}:\\s*`, 'm').test(m[1]);
}

// Append `<key>: <value>` to the page's frontmatter, preserving every other frontmatter line AND the body
// BYTE-FOR-BYTE (the body is sliced off the original and re-appended unchanged — decay never rewrites it).
// A page with no frontmatter fence cannot carry a forward-link → returns null (the caller skips it). The
// caller MUST hasFrontmatterKey-guard first (idempotency) — this function unconditionally appends.
function annotateFrontmatter(content, key, value) {
  const src = String(content);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return null; // no frontmatter fence → not annotatable
  return `---\n${m[1]}\n${key}: ${value}\n---${src.slice(m[0].length)}`; // m[0] excludes the trailing newline → body verbatim
}

// ── propose-side candidate assembly (PURE-ish: scanLocal reads fs) ────────────────
// Auto-derive a `stale:` proposal for each ORPHANED decay candidate (H2's scanLocal — the same detection
// H2 reports, re-run fresh so a since-fixed page never lingers from a stale report). superseded is a
// JUDGMENT (which page replaced which) auto-scan cannot make → those arrive via the drafted proposal file.
function autoStaleProposals(root) {
  const { decay } = scanLocal(root);
  const out = [];
  const seen = new Set();
  for (const d of decay) {
    if (d.subtype !== 'orphaned' || seen.has(d.path)) continue; // one stale annotation per page (first missing source)
    seen.add(d.path);
    out.push({ page: d.path, key: 'stale', value: d.missing_source, reason: d.reason });
  }
  return out;
}

// Normalize the OPTIONAL skill-drafted proposal file into a {page,key,value,reason}[] (a single object, an
// array, or { proposals:[…] }). The skill drafts these from H2's report — chiefly superseded_by judgments.
function normalizeDraftProposals(input) {
  let arr;
  if (Array.isArray(input)) arr = input;
  else if (input && Array.isArray(input.proposals)) arr = input.proposals;
  else if (isObj(input)) arr = [input];
  else arr = [];
  return arr
    .filter(isObj)
    .map((p) => ({ page: String(p.page || ''), key: String(p.key || ''), value: p.value == null ? '' : String(p.value), reason: p.reason ? String(p.reason) : '' }));
}

// Read .wrxn/harvest/decay-staged.jsonl into a page → staged-record map (last proposed wins). Malformed
// lines skip. A usable record needs a page, a key, and a string value.
function readStagedDecay(root) {
  const map = new Map();
  let txt;
  try {
    txt = fs.readFileSync(path.join(root, ...HARVEST_DIR, DECAY_STAGED_FILE), 'utf8');
  } catch {
    return map; // no decay staging trail yet → nothing to confirm by reference
  }
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && rec.page && rec.key && typeof rec.value === 'string') map.set(rec.page, rec);
    } catch {
      /* skip a malformed staging line */
    }
  }
  return map;
}

// Normalize confirm input into the operator-approved PAGE list (["page"…] or { approved:[…] }). An EMPTY
// list is the DECLINE — confirm annotates nothing (AC3).
function approvedPages(input) {
  if (Array.isArray(input)) return input.map(String);
  if (input && typeof input === 'object' && Array.isArray(input.approved)) return input.approved.map(String);
  return [];
}

// decay propose (STAGE): assemble candidates (auto-scanned orphaned → stale + the optional skill-drafted
// proposals), then GATE each — page path-confined to a knowledge tier + present, key allowlisted, value
// sanitised + secret-scanned, the page NOT reinforced (AC4), the page NOT already annotated (AC5) — and
// record the survivors by-reference with an integrity hash. NEVER touches a knowledge page (mirrors merge's
// stage / sync's propose).
function runDecayPropose() {
  const root = installRoot();
  const fileArg = positionalAfter(4); // optional proposal file (absent → auto-scan only)
  const drafted = fileArg ? normalizeDraftProposals(readJson(fileArg)) : [];

  // skill-drafted entries override the auto-scanned one for the same page (the operator's judgment wins).
  const byPage = new Map();
  for (const p of autoStaleProposals(root)) byPage.set(p.page, p);
  for (const p of drafted) byPage.set(p.page, p);

  const reinforced = reinforcedSet(root); // wiki-rel paths surfaced within the window
  const staged = [];
  const skipped = [];
  for (const p of byPage.values()) {
    if (p.key !== 'stale' && p.key !== 'superseded_by') { skipped.push({ page: p.page, reason: 'bad_key' }); continue; }
    const abs = resolveSafeHarvestDoc(root, p.page);
    if (!abs || !isKebab(slugOfPath(p.page))) { skipped.push({ page: p.page, reason: 'unsafe_page' }); continue; }
    const vp = annotationValueProblem(p.value);
    if (vp) { skipped.push({ page: p.page, reason: vp }); continue; }
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ page: p.page, reason: 'missing_page' }); continue; // annotate only an existing page
    }
    const rel = wikiRelOf(p.page);
    if (rel && reinforced.has(rel)) { skipped.push({ page: p.page, reason: 'reinforced' }); continue; } // AC4: live knowledge is never flagged
    if (hasFrontmatterKey(content, p.key)) { skipped.push({ page: p.page, reason: 'already_annotated' }); continue; } // AC5
    staged.push({ page: p.page, tier: tierOfPath(p.page), slug: slugOfPath(p.page), key: p.key, value: p.value, reason: p.reason || '', hash: decayHash(p) });
  }

  const dir = harvestDir(root);
  const ts = new Date().toISOString();
  const stagedFile = path.join(dir, DECAY_STAGED_FILE);
  for (const rec of staged) appendLine(stagedFile, Object.assign({ ts, op: 'decay-propose' }, rec));
  appendLine(path.join(dir, AUDIT_FILE), { ts, op: 'decay-propose', staged: staged.map((s) => ({ page: s.page, key: s.key, value: s.value })), skipped });
  return print({ staged, skipped, stagedFile: path.relative(root, stagedFile) });
}

// decayConfirmOne: the write-boundary re-gate for ONE approved page. RE-VALIDATE (key → value sanitise +
// secret-scan → integrity → path-confine + kebab → page present + not a symlink → not already annotated)
// BEFORE any write, so a tampered/seeded/declined record cannot write (AC2). Then — and only then — the
// in-place single-key frontmatter stamp (body preserved verbatim). NEVER deletes. Returns { ok, … }.
function decayConfirmOne(root, rec) {
  if (rec.key !== 'stale' && rec.key !== 'superseded_by') return { ok: false, reason: 'bad_key' };
  const vp = annotationValueProblem(rec.value); // re-sanitise + re-secret-scan at the write boundary
  if (vp) return { ok: false, reason: vp };
  if (decayHash(rec) !== rec.hash) return { ok: false, reason: 'integrity_mismatch' }; // tamper → refuse
  const abs = resolveSafeHarvestDoc(root, rec.page);
  if (!abs || !isKebab(slugOfPath(rec.page))) return { ok: false, reason: 'unsafe_page' };
  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return { ok: false, reason: 'missing_page' }; // the page vanished since staging
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: 'symlink_page' }; // refuse following a planted symlink out of the tree
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, reason: 'missing_page' };
  }
  // AC4 re-check at the write boundary: a page that became reinforced (surfaced by Recall) in the
  // propose→confirm window is live knowledge and must never be flagged stale/superseded. The integrity
  // hash covers page/key/value only, so it cannot catch a reinforce-state change — re-read the sidecar,
  // mirroring the propose-side reinforcedSet check.
  const rel = wikiRelOf(rec.page);
  if (rel && reinforcedSet(root).has(rel)) return { ok: false, reason: 'reinforced' };
  if (hasFrontmatterKey(content, rec.key)) return { ok: false, reason: 'already_annotated' }; // AC5: idempotent no-op, no churn
  const next = annotateFrontmatter(content, rec.key, rec.value);
  if (next == null) return { ok: false, reason: 'no_frontmatter' };
  fs.writeFileSync(abs, next); // the in-place annotation — body byte-identical, page never deleted
  return { ok: true, page: rec.page, key: rec.key, value: rec.value };
}

// decay confirm (COMMIT-by-reference): for each operator-approved page, look up its staged decay record and
// run decayConfirmOne. An empty approval is the decline (nothing changes, AC3). Then audit the outcome.
function runDecayConfirm() {
  const fileArg = positionalAfter(4);
  if (!fileArg) fail('decay confirm needs <approved.json> — the page path(s) the operator confirms');
  const input = readJson(fileArg);
  const root = installRoot();
  const approved = approvedPages(input);
  const staged = readStagedDecay(root);
  const annotated = [];
  const skipped = [];
  for (const ref of approved) {
    const key = String(ref);
    const rec = staged.get(key);
    if (!rec) { skipped.push({ page: key, reason: 'not_staged' }); continue; }
    const res = decayConfirmOne(root, rec);
    if (res.ok) annotated.push({ page: res.page, key: res.key, value: res.value });
    else skipped.push({ page: key, reason: res.reason });
  }
  appendLine(path.join(harvestDir(root), AUDIT_FILE), { ts: new Date().toISOString(), op: 'decay-confirm', annotated: annotated.map((a) => a.page), skipped });
  return print({ annotated, skipped });
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
    case 'decay': {
      const sub = process.argv[3];
      if (sub === 'propose') return runDecayPropose();
      if (sub === 'confirm') return runDecayConfirm();
      process.stdout.write('Usage: node .wrxn/harvest.cjs decay <propose [proposal.json] | confirm <approved.json>> [--root <dir>]\n');
      return process.exit(2); // a bare/unknown sub-verb is an incomplete command, not a help request
    }
    default:
      process.stdout.write('Usage: node .wrxn/harvest.cjs <check [--root <dir>] | stage <proposal.json> | commit <approved.json> | decay <propose [proposal.json]|confirm <approved.json>>> [--root <dir>]\n');
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
  compareClusters,
  clusterNearDups,
  pruneReports,
  reportRetention,
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
  descriptionProblem,
  composeSurvivor,
  isKebab,
  // evidence stamp (C3 / #36) — pure citation primitives
  stampEvidence,
  resolveEvidence,
  // decay (harvest-04) — pure gate + annotation primitives
  reinforcedSet,
  dayStamp,
  cutoffDay,
  wikiRelOf,
  annotationValueProblem,
  decayHash,
  hasFrontmatterKey,
  annotateFrontmatter,
  autoStaleProposals,
  // constants
  HARVEST_TIERS,
  NEAR_DUP_THRESHOLD,
  FIND_PATH,
  REINFORCE_WINDOW_DAYS,
  REPORT_RETAIN_DEFAULT,
};
