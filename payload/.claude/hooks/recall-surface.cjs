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
const { coalesceSidecar } = require('./sidecar.cjs'); // shared coalesced read/rewrite/fail-open/secret-scan
const { rewardFactor, selectRewardMode, RECORDED_REWARD_VERDICT } = require('./reward.cjs'); // S3 re-rank + S5 verdict-derived mode

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
const SURFACED_REL = path.join('.wrxn', 'surfaced.json'); // per-session surfaced-log sidecar (STATE)
const WIKI_PREFIX = '.wrxn/wiki/'; // the wiki root — stripped to form the D1 join key
const REWARD_REL = path.join('.wrxn', 'reward.json'); // per-page Beta-Bernoulli store (STATE) — read-only here

// The single shipped mode gating the reward re-rank (mirrors recon's SHIPPED_DECAY_MODE). It is DERIVED
// from the recorded lift-gate verdict via selectRewardMode — never hard-coded — so the live state is never
// a silent default. Today RECORDED_REWARD_VERDICT is NOT passing (no real session corpus accrued yet), so
// this resolves to 'shadow': reward counts accrue at session-end but the factor NEVER moves a recall rank
// — recall output is byte-identical to pre-reward behaviour. It flips to 'live' ONLY when the recorded
// verdict passes (the offline lift gate proves lift on real data AND the operator ratifies the git-only
// signal — docs/eval/0001-reward-lift-gate.md). Tests force 'live' via the recallFromDoor option.
const SHIPPED_REWARD_MODE = selectRewardMode(RECORDED_REWARD_VERDICT);

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

// ── S3 reward re-rank (PURE) ─────────────────────────────────────────────────────────
//
// The learning-moat's value axis applied to recall: a per-page reward factor (∈(0,2), neutral 1) from
// the Beta-Bernoulli store re-ranks the qualifying prose candidates by `base relevance × factor` BEFORE
// the top-N cut, so a page that has preceded good sessions rises and one that preceded nothing fades.
// The factor is INJECTED as a lookup { <wiki-rel-path>: factor } (the impure shell reads .wrxn/reward.json
// and pre-computes factors via reward.cjs's rewardFactor) — decideRecall stays pure and reward-math-free.
//
// SHADOW BY DEFAULT: the re-rank only fires when a NON-EMPTY lookup is passed. An absent / empty lookup
// is the IDENTITY — the door order is preserved byte-for-byte, exactly today's behaviour. The shell
// passes a lookup only in 'live' mode (SHIPPED_REWARD_MODE), so the shipped default is a provable no-op.

// The relevance magnitude the reward factor modulates: the door's fused score, with the dense cosine as
// a fallback when a hit carries no fused score (totality), else 0.
function baseScore(hit) {
  const sc = Number(hit && hit.score);
  if (Number.isFinite(sc)) return sc;
  const sem = Number(hit && hit.semanticScore);
  return Number.isFinite(sem) ? sem : 0;
}

// A hit's reward factor from the lookup, keyed by its wiki-rel path. A page absent from the lookup, a
// non-wiki hit, or a non-positive / garbage factor → neutral 1 (fail-open: reward never zeroes a rank).
function factorFor(lookup, hit) {
  const key = wikiRelPath(hit && hit.file);
  const f = key ? Number(lookup[key]) : NaN;
  return Number.isFinite(f) && f > 0 ? f : 1;
}

// Re-rank prose candidates by base relevance × reward factor, descending. STABLE: equal effective
// scores keep door order (so an all-neutral lookup is the exact identity). An absent / empty / non-object
// lookup short-circuits to the identity — the shadow no-op, by construction byte-identical to today.
function rerankByReward(prose, rewardLookup) {
  if (!rewardLookup || typeof rewardLookup !== 'object' || !Object.keys(rewardLookup).length) return prose;
  return prose
    .map((h, i) => ({ h, i, eff: baseScore(h) * factorFor(rewardLookup, h) }))
    .sort((a, b) => b.eff - a.eff || a.i - b.i)
    .map((x) => x.h);
}

// PURE: the prose hits that clear the gate, reward-re-ranked, capped at TOP_N — exactly the hits
// decideRecall renders (and the pages reinforce stamps). The optional reward lookup is injected; absent
// → door order (shadow). Factored out so the IO shell can stamp the surfaced pages by path.
function qualifyingHits(hits, rewardLookup) {
  const list = Array.isArray(hits) ? hits : [];
  const prose = list.filter((h) => isProse(h) && qualifies(h));
  return rerankByReward(prose, rewardLookup).slice(0, TOP_N);
}

// PURE: prose-filter → gate → reward re-rank → top-N → format. Returns the block string, or null
// (Abstain). The reward lookup is optional and injected; with none (the shadow default) the output is
// byte-identical to the pre-reward behaviour.
function decideRecall(hits, rewardLookup) {
  const qualified = qualifyingHits(hits, rewardLookup);
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
  const list = Array.isArray(hits) ? hits : [];
  if (!root || !list.length) return;
  // The whole read/parse/coalesce/rewrite/fail-open/secret-scan mechanism lives in coalesceSidecar; here
  // we supply only the domain mutation — stamp each surfaced prose hit's wiki-rel join key to today,
  // reporting whether the map actually changed (so an all-already-today recall is a coalesced no-op). The
  // day-stamp is computed INSIDE the mutate so an invalid clock is caught by the helper's fail-open envelope.
  coalesceSidecar(path.join(root, REINFORCE_REL), (map) => {
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
    return changed;
  });
}

// ── surfaced-log: the per-session record of what recall surfaced (S1 / kernel #12) ────
//
// When Recall surfaces prose pages, record THIS session's surfaced (qualifying) page-paths into
// <root>/.wrxn/surfaced.json — a compact map { "<session_id>": ["<wiki-rel-path>", …] } via the shared
// coalesced-sidecar helper. The value uses the SAME wiki-root-relative join key reinforce stamps (a
// slug/path mismatch silently breaks downstream consumers). Coalesced: re-surfacing the identical set
// for a session rewrites nothing. Best-effort + non-blocking — the helper swallows every fault, so a
// surfaced-log write can never alter or break the recall surfacing.

// Map the surfaced hits to their wiki-rel join keys, de-duplicated, order preserved. (qualifyingHits
// has already prose-filtered + gated + capped; here we only project to the path key and drop non-wiki
// hits / dupes.)
function surfacedPaths(hits) {
  const list = Array.isArray(hits) ? hits : [];
  const seen = new Set();
  const out = [];
  for (const h of list) {
    const key = wikiRelPath(h && h.file);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Record `paths(hits)` under `sessionId` in the surfaced-log. No session id or no surfaced paths → no
// write. Coalesced: an unchanged set for the session leaves the file byte-identical.
function surfacedLog(root, sessionId, hits) {
  if (!root || !sessionId) return;
  const paths = surfacedPaths(hits);
  if (!paths.length) return;
  coalesceSidecar(path.join(root, SURFACED_REL), (map) => {
    const prev = map[sessionId];
    if (Array.isArray(prev) && prev.length === paths.length && prev.every((v, i) => v === paths[i])) {
      return false; // identical surfaced set for this session → coalesced no-op
    }
    map[sessionId] = paths;
    return true;
  });
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

// Read the reward sidecar (.wrxn/reward.json = { "<wiki-rel-path>": { s, f } }) and pre-compute each
// page's reward factor → { "<wiki-rel-path>": factor } for the live re-rank. FAIL-OPEN: a missing /
// corrupt / non-object store → null (a neutral lookup → recall unaffected). The keys are treated ONLY
// as join keys (map lookups against wikiRelPath), NEVER as filesystem paths (sec posture). rewardFactor
// is total, so a malformed per-page slot reads as zero evidence → neutral 1.
function readRewardLookup(root) {
  if (!root) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, REWARD_REL), 'utf8');
  } catch {
    return null; // absent → neutral (the common case before the gate flips, and on any read fault)
  }
  let counts;
  try {
    counts = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON → neutral, recall proceeds unchanged
  }
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return null;
  const lookup = {};
  for (const key of Object.keys(counts)) lookup[key] = rewardFactor(counts[key]);
  return lookup;
}

// IO shell: discover the door, POST the prose query, gate the hits. Returns the block string or null.
// `transport` is injected in tests; production uses httpTransport. Sends NO `type` (recon_find takes a
// single NodeType, not an array) — prose scope is enforced by decideRecall's post-filter.
async function recallFromDoor(root, prompt, { transport, timeoutMs, now, sessionId, rewardMode } = {}) {
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
  // SHADOW (shipped default): pass NO lookup → decideRecall is the identity (door order), byte-identical
  // to pre-reward recall regardless of what sits in reward.json. LIVE (gate-flipped / test-forced): read
  // the reward sidecar and re-rank the qualifying candidates by reward factor before the top-N cut.
  const mode = rewardMode || SHIPPED_REWARD_MODE;
  const rewardLookup = mode === 'live' ? readRewardLookup(root) : null;
  const block = decideRecall(hits, rewardLookup);
  // Side effects on a surfacing (both best-effort, never block): stamp access-recency for the pages we
  // surfaced, and record this session's surfaced set in the per-session surfaced-log. Use the SAME lookup
  // so the recorded set matches the re-ranked top-N that was rendered.
  if (block) {
    const surfaced = qualifyingHits(hits, rewardLookup);
    reinforce(root, surfaced, now);
    surfacedLog(root, sessionId, surfaced);
  }
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
    block = await recallFromDoor(root, prompt.trim(), { sessionId: event.session_id });
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
  rerankByReward,
  recallFromDoor,
  readRewardLookup,
  reinforce,
  surfacedLog,
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
  SHIPPED_REWARD_MODE,
};
