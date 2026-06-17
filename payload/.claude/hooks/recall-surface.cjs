#!/usr/bin/env node
'use strict';

// WRXN recall-surface hook — proactive PROSE Recall via the warm Brain door (recon-brain-recall-04).
// UserPromptSubmit. Replaces the old wiki-substring engine: on each prompt it discovers recon-wrxn's
// warm serve door, POSTs a prose-scoped hybrid query, and — ONLY when a hit clears the relevance gate
// — injects a compact <recall-surface> block. Implements ADR 0002.
//
// The gate (per arm, NEVER the fused RRF score): a prose hit qualifies on the semantic cosine FLOOR
// (>= 0.4) OR on CONSENSUS (it surfaced in both the BM25 and the dense arm). Nothing clears ⇒ Abstain.
// Prose only — hits are post-filtered to Page/Section, so code symbols never surface here (they stay
// on the agent's on-demand recon_* / `wrxn brain query` path).
//
// Self-contained: ships into installs, MUST NOT import the kernel lib or recon — node stdlib ONLY
// (http / fs / path). Fail-open SILENT: a cold/missing/dead door, a slow door, a non-200, malformed
// JSON, or ANY fault emits {} — the hook NEVER blocks a prompt and never delays it past the hard
// client timeout. There is NO substring fallback (a weak fallback can itself harm — ADR 0002).
//
// Contract: UserPromptSubmit event JSON on stdin → envelope JSON on stdout (exit 0).
//   inject → { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<recall-surface>…" } }
//   abstain → {}

const fs = require('fs');
const http = require('http');
const path = require('path');

const MIN_PROMPT_LEN = 8;          // skip trivial prompts ("ok", "yes")
const MAX_QUERY_CHARS = 512;       // trim the prompt before querying the door
const FETCH_LIMIT = 15;            // ask the door WIDE — fetch is decoupled from inject so prose ranked
                                   // below the whole-brain code hits is not truncated before we filter
const TIMEOUT_MS = 150;            // hard client budget — never delay a prompt past this
const MAX_RESPONSE_BYTES = 256 * 1024; // hard cap on an accumulated door response body (anti-flood)
const TOP_N = 3;                   // inject at most 3 hits (the wide fetch is post-filtered down to this)
const MAX_BLOCK_CHARS = 600;       // injection size cap (ADR 0002: inject little, high-signal)
const SEMANTIC_FLOOR = 0.4;        // dense cosine floor (reused from P1.5)
const PROSE_TYPES = new Set(['Page', 'Section']); // prose scope — drop code symbols
const ENDPOINT_REL = path.join('.recon-wrxn', 'serve-endpoint.json');
const FIND_PATH = '/api/tools/recon_find';
const REINFORCE_REL = path.join('.wrxn', 'reinforce.json'); // coalesced access-recency sidecar (STATE)
const WIKI_PREFIX = '.wrxn/wiki/'; // the wiki root — stripped to form the D1 join key

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

// Walk up from cwd / CLAUDE_PROJECT_DIR to the install root carrying wrxn.install.json.
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

// ── the gate (PURE) ────────────────────────────────────────────────────────────────

function isProse(hit) {
  return !!hit && PROSE_TYPES.has(hit.type);
}

// Consensus = the hit surfaced in BOTH the BM25 and the dense arm (the find response's `sources`
// provenance). A consensus hit qualifies even below the cosine floor.
function hasConsensus(hit) {
  const s = hit && hit.sources;
  return Array.isArray(s) && s.includes('bm25') && s.includes('semantic');
}

// Qualify on the PER-ARM signal only: the semantic cosine floor OR consensus. NEVER the fused
// `score` (RRF is a rank-based consensus, not a relevance magnitude — ADR 0002). The floor clause
// requires the dense arm to actually be PRESENT in `sources` (not just a stray semanticScore) —
// today these co-occur, but this is a defense against a future producer emitting a score without the
// 'semantic' tag. An absent/NaN semanticScore can never clear the floor; only consensus rescues it.
function qualifies(hit) {
  const sem = Number(hit && hit.semanticScore);
  const s = hit && hit.sources;
  const hasSemantic = Array.isArray(s) && s.includes('semantic');
  const floorOk = Number.isFinite(sem) && sem >= SEMANTIC_FLOOR && hasSemantic;
  return floorOk || hasConsensus(hit);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// A stable slug for a hit: the prose file's basename (sans extension), else a slugified name.
function slugOf(hit) {
  if (hit.file) {
    const base = path.basename(String(hit.file)).replace(/\.[^.]+$/, '');
    if (base) return base.slice(0, 48);
  }
  return slugify(hit.name) || 'untitled';
}

// The one-line descriptor. NOTE: a recon FindHit carries NO body text — only name/file/line/scores —
// so the snippet is the hit's NAME (the page title / section heading), the most descriptive line
// available. (Follow-up: if the door later surfaces a per-hit text excerpt, prefer it here.)
function snippetOf(hit) {
  const s = String(hit.name || hit.file || '').replace(/\s+/g, ' ').trim();
  return s.length > 100 ? s.slice(0, 99) + '…' : s;
}

// Render the qualifying hits into the <recall-surface> block, guaranteed <= MAX_BLOCK_CHARS and
// always closed. Drops trailing bullets first, then hard-truncates the last line if it still overflows.
function renderBlock(hits) {
  const head = '<recall-surface>';
  const intro = 'Knowledge already in your Brain, recalled for this prompt — read it before re-deriving or re-asking the operator:';
  const foot = '</recall-surface>';
  const bullets = hits.map((h) => `- ${slugOf(h)} — ${snippetOf(h)}`);
  const assemble = (bs) => [head, intro, ...bs, foot].join('\n');
  const kept = bullets.slice();
  while (kept.length > 1 && assemble(kept).length > MAX_BLOCK_CHARS) kept.pop();
  let block = assemble(kept);
  if (block.length > MAX_BLOCK_CHARS) {
    block = block.slice(0, MAX_BLOCK_CHARS - foot.length - 1).replace(/\s+\S*$/, '').trimEnd() + '\n' + foot;
  }
  return block;
}

// PURE: the prose hits that clear the gate, capped at TOP_N — exactly the hits decideRecall renders
// (and the pages reinforce stamps). Factored out so the IO shell can stamp the surfaced pages by path.
function qualifyingHits(hits) {
  const list = Array.isArray(hits) ? hits : [];
  return list.filter((h) => isProse(h) && qualifies(h)).slice(0, TOP_N);
}

// PURE: prose-filter → gate → top-N → format. Returns the block string, or null (Abstain).
function decideRecall(hits) {
  const qualified = qualifyingHits(hits);
  if (!qualified.length) return null;
  return renderBlock(qualified);
}

// ── reinforce: the coalesced access-recency sidecar (harvest-08 / D2) ─────────────────
//
// When Recall actually surfaces prose pages, stamp each page's "last used" day into
// <root>/.wrxn/reinforce.json — a COMPACT MAP { "<wiki-rel-path>": "YYYY-MM-DD" }, NOT page frontmatter
// (no churn) and NOT an append log (no growth). recon harvest-07/D1 reads this sidecar to compute
// recency for decay-weighted retrieval; the join key MUST be the wiki-root-relative path on BOTH sides
// (a slug-vs-path mismatch silently breaks recency). COALESCED to <= 1 write per page per day: when
// every surfaced page already carries today's date the map is unchanged and NOTHING is written.
// BEST-EFFORT + NON-BLOCKING: this is a pure side effect of recall — any fault (absent dir, malformed
// existing sidecar, unwritable path) is swallowed so the surfacing always proceeds.

// The wiki-root-relative join key for a prose hit's file: tolerate a leading './', normalize separators,
// then strip the '.wrxn/wiki/' prefix → e.g. 'concepts/foo.md'. Returns null when the file is not under
// the wiki root (no join key — never stamped).
function wikiRelPath(file) {
  const f = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const i = f.indexOf(WIKI_PREFIX);
  if (i === -1) return null;
  return f.slice(i + WIKI_PREFIX.length) || null;
}

// A day-granular UTC stamp (YYYY-MM-DD): the coalescing grain AND D1's recency value. Injectable clock
// (`now` = a Date/ms/iso, default real time) so day-granularity is deterministic under test.
function dayStamp(now) {
  const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
  return d.toISOString().slice(0, 10);
}

// Stamp each surfaced prose hit's wiki-rel path → today into <root>/.wrxn/reinforce.json. Writes only
// when the map actually changes (coalesced). Wholly best-effort: never throws, never blocks recall.
function reinforce(root, hits, now) {
  try {
    const list = Array.isArray(hits) ? hits : [];
    if (!root || !list.length) return;
    const file = path.join(root, REINFORCE_REL);
    let map = {};
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null; // absent → fresh map (normal, not a fault)
    }
    if (raw !== null) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed existing sidecar → skip silently, leave it untouched (never clobber)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return; // not a map → skip
      map = parsed;
    }
    const day = dayStamp(now);
    let changed = false;
    for (const h of list) {
      const key = wikiRelPath(h && h.file);
      if (!key) continue; // not under the wiki root → no D1 join key
      if (map[key] !== day) {
        map[key] = day;
        changed = true;
      }
    }
    if (!changed) return; // coalesced no-op → file stays byte-identical (<= 1 write/page/day)
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
  } catch {
    /* best-effort: a reinforce fault must NEVER alter or break the recall surfacing */
  }
}

// ── the door (IO shell, injectable transport) ───────────────────────────────────────

// A pid is alive unless process.kill(pid,0) throws ESRCH. EPERM means it exists (owned by another
// user) — still alive. Mirrors the cross-repo discovery contract.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// Refuse a discovery file another user could have planted, or that is group/world-writable — trusting
// it would let a hostile workspace point the door host/port at an exfil/injection sink (the hook feeds
// the door's response into the prompt context). lstat (not stat) so a symlink's OWN ownership/mode is
// judged. A platform without getuid skips the uid check but still enforces the mode check. Any fault →
// not trusted (treated as not-warm).
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
// alive — else null (not warm).
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
// on socket error or timeout. Injectable so unit tests never touch the network (mirrors connect.cjs).
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
          if (total > MAX_RESPONSE_BYTES) { req.destroy(new Error('recall door response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => done(resolve, { statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => done(reject, e));
      }
    );
    req.on('error', (e) => done(reject, e));
    // Idle timeout (no bytes for `deadline`) AND an independent wall-clock: the latter bounds a trickle
    // attacker that dribbles bytes to keep the idle timer from ever firing past the hook budget.
    req.setTimeout(deadline, () => req.destroy(new Error('recall door timeout')));
    wall = setTimeout(() => req.destroy(new Error('recall door wall-clock timeout')), deadline);
    req.write(payload);
    req.end();
  });
}

// IO shell: discover the door, POST the prose query, gate the hits. Returns the block string or null.
// `transport` is injected in tests; production uses httpTransport. Sends NO `type` (recon_find takes a
// single NodeType, not an array) — prose scope is enforced by decideRecall's post-filter.
async function recallFromDoor(root, prompt, { transport, timeoutMs, now } = {}) {
  const door = discoverEndpoint(root);
  if (!door) return null; // not warm → Abstain (silent)
  const query = String(prompt || '').trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return null;
  let resp;
  try {
    resp = await (transport || httpTransport)({
      port: door.port,
      path: FIND_PATH,
      body: { query, limit: FETCH_LIMIT },
      timeoutMs: timeoutMs || TIMEOUT_MS,
    });
  } catch {
    return null; // timeout / connection refused / abort → silent
  }
  if (!resp || resp.statusCode !== 200) return null;
  let parsed;
  try {
    parsed = JSON.parse(resp.body);
  } catch {
    return null; // malformed body → silent
  }
  const hits = Array.isArray(parsed.hits) ? parsed.hits : [];
  const block = decideRecall(hits);
  // Side effect: stamp access-recency for the pages we actually surfaced (best-effort, never blocks).
  if (block) reinforce(root, qualifyingHits(hits), now);
  return block;
}

// ── entrypoint ──────────────────────────────────────────────────────────────────────

async function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    return emit({});
  }

  const root = findInstallRoot(event.cwd);
  if (!root) return emit({});

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.trim().length < MIN_PROMPT_LEN) return emit({});

  let block = null;
  try {
    block = await recallFromDoor(root, prompt.trim());
  } catch {
    return emit({});
  }
  if (!block) return emit({}); // nothing cleared the gate → Abstain

  return emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block } });
}

if (require.main === module) {
  main().catch(() => emit({}));
}

module.exports = {
  decideRecall,
  qualifyingHits,
  recallFromDoor,
  reinforce,
  wikiRelPath,
  dayStamp,
  discoverEndpoint,
  httpTransport,
  pidAlive,
  isProse,
  hasConsensus,
  qualifies,
  renderBlock,
  findInstallRoot,
  SEMANTIC_FLOOR,
  PROSE_TYPES,
};
