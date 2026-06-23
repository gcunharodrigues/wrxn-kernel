#!/usr/bin/env node
'use strict';

// WRXN dream adapter — the install-local Validation gate + audit/commit CLI.
// Sibling to wiki.cjs. Self-contained: this ships INTO an install and MUST NOT import the kernel lib
// (node stdlib only). The dream SKILL (the LLM, dream-02) PROPOSES; THIS adapter JUDGES (a
// deterministic gate) and records — "bad memory is worse than no memory".
//
// In THIS slice the adapter is driven by hand-fed proposal JSON (no LLM). Three subcommands:
//   check  <proposal.json | batch.json>   run the Validation gate.
//          · a single Proposal object  → a single Verdict { ok, reason? }.
//          · an array / { proposals:[…] } / { abstain:true } → a batch result
//            { abstained, accepted[], rejected[{index,slug,reason}] } (applies the ≤5 run cap + restraint).
//          · --source <file> (optional, auto-memory-01): the session transcript blob. When present,
//            every evidence quote must verifiably appear in it (normalized substring) or the proposal
//            is rejected quote_not_in_source. Absent ⇒ no quote-verify (the trusted manual-dream path).
//   stage  <batch.json>                   record the VALIDATED (accepted) batch into the audit trail
//          under .wrxn/dream/ as .jsonl (NEVER .md, so recon's prose ingestion never recalls a
//          staged-but-unapproved proposal). Nothing is written to the wiki.
//   commit <approved.json>                write the operator-approved subset additively to their tiers,
//          BY REFERENCE: approved.json is the approved SLUG list (["slug-a",…] or { approved:[…] }). For
//          each slug we look up its staged proposal in staged.jsonl and RE-RUN the gate (validateProposal)
//          at the write boundary, writing ONLY those that still pass — VIA the wiki.cjs adapter (the
//          indirection contract). This binds committed == staged == presented: a gate-rejected proposal
//          can never reach recall even if its slug is force-approved. Additive + dedup-SKIP; a slug not
//          staged (not_staged) or one that fails re-validation is recorded skipped with the reason, and
//          the rest of the batch still writes. Then the outcome is appended to the .wrxn/dream/ audit log.
//          · --source <file> (optional, auto-memory-01): re-verifies every quote at the write boundary,
//            so a hallucinated proposal is blocked from recall even if its slug is force-approved.
//
// Flags: --root <dir> (override the install-root walk-up; mainly for tests).
//        --source <file> (check|commit only) — the transcript blob for quote-verification (auto-memory-01).
//
// Proposal { kind:"concept"|"decision"|"gotcha"|"rule"; tier:"concepts"|"decisions"|"gotchas"|"_rules";
//            slug; title; body /* starts "# " */; confidence /*0–1*/; rationale; evidence:[{quote,source?}] }
// Verdict  { ok:boolean; reason?:string /* machine code on reject */ }
// NOTE: `_slots` is NOT a knowledge-gate tier — KIND_TIER stays {concepts,decisions,gotchas,_rules}; a
//       knowledge proposal targeting `_slots` is rejected `unsupported_tier`. (The standing-focus slot and
//       its set-focus op were retired in auto-memory-05; the auto-handoff baton carries "where we are".)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// kind → tier is the contract; the tier must agree with the kind. `rule → _rules` (dream-03) joins the
// three semantic tiers — this single map auto-extends the tier allowlist (TIERS) and the kind↔tier gate.
const KIND_TIER = { concept: 'concepts', decision: 'decisions', gotcha: 'gotchas', rule: '_rules' };
const TIERS = Object.values(KIND_TIER);
const CONFIDENCE_FLOOR = 0.75;
const BODY_MAX = 32000; // size cap (chars) — a durable page, not a transcript dump.
const MAX_ACCEPTED = 5; // one run can't flood the wiki.
const DREAM_DIR = ['.wrxn', 'dream'];
const STAGED_FILE = 'staged.jsonl'; // the validated-but-unapproved batch (full proposals).
const AUDIT_FILE = 'audit.jsonl'; // the append-only outcome log (stage + commit events).

// ── install-root resolution (mirrors wiki.cjs / enforce-managed-guard.cjs) ─────
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
  process.stderr.write(`dream: ${msg}\n`);
  process.exit(2);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// The first positional after the subcommand (the JSON file path), up to the first --flag.
function positionalFile() {
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) break;
    return process.argv[i];
  }
  fail('missing <file.json> argument');
  return undefined;
}

// ── the wiki adapter (the indirection contract — we never read/write wiki .md files directly) ──
function wikiAdapter() {
  return path.join(__dirname, 'wiki.cjs'); // sibling in the same install .wrxn/ dir
}

// Guard the dream→wiki bridge against argv flag-injection (security M3): a user-controlled value
// beginning with `--` would be parsed by wiki.cjs's flag()/positionals() scan as a flag (e.g. a title
// "--root" redirects the write out of the wiki). The gate already rejects a `--`-leading slug
// (invalid_slug) and title (invalid_title); this is the defense-in-depth backstop at the exec boundary.
function guardArgv(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.startsWith('--')) {
      throw new Error(`flag-injection guard: refusing a --leading value at the wiki bridge: ${JSON.stringify(v.slice(0, 32))}`);
    }
  }
}

function wikiQuery(root, terms, opts) {
  const o = opts || {};
  guardArgv(terms.map(String));
  const args = [wikiAdapter(), 'query', ...terms.map(String), '--root', root, '--limit', String(o.limit || 5000)];
  if (o.tier) args.push('--tier', o.tier);
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

function wikiWritePage(root, tier, slug, description, body) {
  guardArgv([slug, String(description || ''), String(body || '')]);
  const args = [wikiAdapter(), 'write-page', tier, slug, '--description', String(description || ''), '--body', String(body || ''), '--root', root];
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

// Delete a page VIA the wiki adapter's delete-by-reference path (the indirection contract — dream never
// unlinks a .md directly; --revert reverses this run's pages through it). wiki.cjs confines the delete to
// the wiki subtree (tier allowlist + kebab slug); the audit-recorded tier/slug are dream-written, but the
// flag-injection guard is the defense-in-depth backstop at the exec boundary (harvest parity).
function wikiDeletePage(root, tier, slug) {
  guardArgv([String(tier), String(slug)]);
  const args = [wikiAdapter(), 'delete-page', String(tier), String(slug), '--root', root];
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

function normalizeTitle(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── importance stamp — the decay-weight PRODUCER (harvest-10) ──────────────────
// dream already scores each page (`confidence`, gate floor 0.75) but never PERSISTED it, so recon
// D1/D3's `recency × importance` recall weight collapsed to `recency × tier-prior`. On commit we persist
// that EXISTING score as a single `importance:` frontmatter scalar — we do NOT recompute or invent a new
// model. Clamped to [0,1] and rendered through Number() so it is one bare scalar that cannot inject a
// newline/colon (AC4, same discipline as sync.cjs's `synced_to:` watermark).
function clamp01(score) {
  const n = Number(score);
  if (Number.isNaN(n)) return 0; // a non-numeric/garbage score floors to 0 — never a raw string in the page
  return Math.max(0, Math.min(1, n));
}

// PURE in-place stamp (mirrors sync.cjs restampDoc): update `importance:` when present (no duplicate key),
// else append one frontmatter line; the body after the closing fence is preserved byte-for-byte (no churn).
// A page with no frontmatter fence is returned unchanged (defensive — wiki pages always carry one).
function stampImportance(content, score) {
  const text = String(content);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const lines = m[1].split(/\r?\n/);
  const value = clamp01(score);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^importance:\s*/.test(lines[i])) { lines[i] = `importance: ${value}`; found = true; break; }
  }
  if (!found) lines.push(`importance: ${value}`);
  // splice ONLY the frontmatter fence back; the body after the closing --- is byte-for-byte preserved.
  return text.slice(0, m.index) + ['---', lines.join('\n'), '---'].join('\n') + text.slice(m.index + m[0].length);
}

// Stamp the just-written wiki page in place (read → stampImportance → write). The page is reached by its
// tier+slug under .wrxn/wiki/ — the same page wiki.cjs just wrote — so the stamp never re-routes the write.
function stampPageImportance(root, tier, slug, score) {
  const file = path.join(root, '.wrxn', 'wiki', tier, `${slug}.md`);
  fs.writeFileSync(file, stampImportance(fs.readFileSync(file, 'utf8'), score));
}

// ── lineage stamp — the provenance PRODUCER (S3 / #22) ─────────────────────────
// Every committed page records WHO wrote it: origin_session (the session id), synth_run (the per-run id —
// the SAME value that keys this run's audit-log commit event, so --revert can resolve "this run's pages"),
// proposal_id (the staged proposal's stable id = its slug). Machine-written frontmatter only — the prose
// body is preserved byte-for-byte, like importance: (no churn). This is the seam sub-epic ② reuses for
// evidence citations (J = who wrote it). Values are sanitised to a single bare frontmatter scalar: a
// newline would inject an arbitrary key, a colon creates YAML ambiguity — both are collapsed to a space
// (same write-channel discipline as harvest's annotationValueProblem / importance's shape-safety).
const LINEAGE_KEYS = ['origin_session', 'synth_run', 'proposal_id'];

// One bare scalar — strip CR/LF/colon to a space so a hostile value can never inject a frontmatter key or
// YAML mapping (mirrors stampImportance's shape-safety). Empty/undefined → 'unknown' so the key is always
// present and parseable (a missing value must never silently drop a lineage key).
function lineageScalar(value) {
  const s = String(value == null ? '' : value).replace(/[\r\n:]+/g, ' ').trim();
  return s || 'unknown';
}

// PURE in-place stamp (mirrors stampImportance): set each lineage key when present (no duplicate key), else
// append it; the body after the closing fence is preserved byte-for-byte. A page with no frontmatter fence
// is returned unchanged (defensive — wiki pages always carry one).
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
  // splice ONLY the frontmatter fence back; the body after the closing --- is byte-for-byte preserved.
  return text.slice(0, m.index) + ['---', lines.join('\n'), '---'].join('\n') + text.slice(m.index + m[0].length);
}

// PURE resolver (deterministic given its injected IO): gather the evidence FACTS into { session, commit,
// symbols }. The git HEAD resolver + the touched set + the session anchor are all injected, so the core is
// unit-tested with no live repo (mirrors session-end-reward's gitFacts injection). FAIL-OPEN: a resolveHead
// that throws or returns nothing → commit null (stampEvidence omits it); a missing touched set → []. NEVER
// throws — a field that cannot be resolved must never break consolidation.
function resolveEvidence({ session, resolveHead, touched } = {}) {
  let commit = null;
  try {
    const head = typeof resolveHead === 'function' ? resolveHead() : null;
    commit = head ? String(head) : null;
  } catch {
    commit = null; // no git binary / not a repo / detached → no commit (fail-open)
  }
  return {
    session: session == null ? '' : String(session),
    commit,
    symbols: Array.isArray(touched) ? touched : [],
  };
}

// ── evidence production IO (the real resolvers resolveEvidence injects at the CLI boundary) ─────
// Resolve the install repo's current git HEAD sha — the citation's `commit`. Rooted at the install so a
// nested cwd can't resolve a different repo's HEAD. Fail-open: no git binary / not a repo / detached →
// null (commit omitted). Mirrors session-end-reward.cjs / session-start.cjs resolveGitHead byte-for-byte.
function resolveGitHead(root) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const sha = String(out || '').trim();
    return sha || null;
  } catch {
    return null; // no git binary / not a repo / detached with no commit → no commit (fail-open)
  }
}

// The session-id → filename transform — MUST match code-intel-push's safeId byte-for-byte, or the read
// targets the wrong .touched file (replicated here, no shared import — the self-contained discipline).
function safeSessionId(sid) {
  return String(sid || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
}

// Read this session's edited paths from <root>/.wrxn/history/<safeId>.touched — the list code-intel-push
// already maintains (REUSE; no new persistence path). Deduped, order preserved. FAIL-OPEN: an absent/
// unreadable file → [] (the citation simply carries no symbols). This is the citation's `symbols` set.
function readTouched(root, sessionId) {
  if (!root) return [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.wrxn', 'history', `${safeSessionId(sessionId)}.touched`), 'utf8');
  } catch {
    return []; // absent / unreadable → no edits this session
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

// Stamp the just-written wiki page's evidence in place (read → stampEvidence → write). Same page reach as
// stampPageImportance/Lineage — the stamp never re-routes the write (AC6: the existing stamp seam, not a new one).
function stampPageEvidence(root, tier, slug, evidence) {
  const file = path.join(root, '.wrxn', 'wiki', tier, `${slug}.md`);
  fs.writeFileSync(file, stampEvidence(fs.readFileSync(file, 'utf8'), evidence));
}

// Stamp the just-written wiki page's lineage in place (read → stampLineage → write). Same page reach as
// stampPageImportance — the stamp never re-routes the write.
function stampPageLineage(root, tier, slug, lineage) {
  const file = path.join(root, '.wrxn', 'wiki', tier, `${slug}.md`);
  fs.writeFileSync(file, stampLineage(fs.readFileSync(file, 'utf8'), lineage));
}

// ── evidence stamp — the forward citation PRODUCER (C3 / #36) ──────────────────
// Every committed page records the FACTS that make its citation resolvable: `session` (the quote-verified
// source anchor — the session id), `commit` (the real git HEAD at write time), `symbols` (the session's
// .touched set). This FREEZES the evidence-frontmatter contract recon-wrxn ②'s edge resolver reads to draw
// EVIDENCED_BY / DOCUMENTED_BY edges — every field is computed from ground truth, so the citation is
// inherently resolvable. Written as an `evidence:` MAPPING (nested under one key, distinct from the flat
// lineage/importance scalars). Machine-written frontmatter only — the prose body is preserved byte-for-byte.

// One bare nested scalar (session/commit) — strip CR/LF/colon to a space so a hostile value can never
// inject a frontmatter key or a YAML mapping (mirrors lineageScalar's shape-safety). Empty stays empty —
// the session sentinel + the commit/symbols omission are the caller-visible policy applied in stampEvidence.
function evidenceScalar(value) {
  return String(value == null ? '' : value).replace(/[\r\n:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// One symbol list item — additionally strip the inline-flow-list breakers ([ ] ,) so a path can never break
// the `symbols: [a, b]` list shape (defense in depth; .touched values are real paths without these chars).
function symbolScalar(value) {
  return String(value == null ? '' : value).replace(/[[\],\r\n:]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Drop any pre-existing `evidence:` mapping (its key line + the indented members beneath it) so a re-stamp
// updates in place with no duplicate block — the in-place discipline stampLineage gets for free with flat keys.
function stripEvidence(lines) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^evidence:/.test(line)) { inBlock = true; continue; }   // the mapping key line → drop
    if (inBlock && /^\s+\S/.test(line)) continue;                // an indented nested member → drop
    inBlock = false;
    out.push(line);
  }
  return out;
}

// PURE in-place stamp (mirrors stampLineage): append an `evidence:` mapping to the frontmatter fence; the
// body after the closing fence is preserved byte-for-byte. A page with no frontmatter fence is returned
// unchanged (defensive — wiki pages always carry one).
function stampEvidence(content, evidence) {
  const text = String(content);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return text;
  const ev = evidence || {};
  const lines = stripEvidence(m[1].split(/\r?\n/)); // in-place: remove any prior evidence block first
  lines.push('evidence:');
  // session — always present: an unresolvable anchor falls back to the 'unknown' sentinel (parseable key).
  lines.push(`  session: ${evidenceScalar(ev.session) || 'unknown'}`);
  // commit / symbols — FAIL-OPEN: a field that cannot be resolved (no git HEAD → empty; empty .touched → no
  // items) is OMITTED, never written blank. The block still writes with whatever facts ARE known.
  const commit = evidenceScalar(ev.commit);
  if (commit) lines.push(`  commit: ${commit}`);
  const symbols = (Array.isArray(ev.symbols) ? ev.symbols : []).map(symbolScalar).filter(Boolean);
  if (symbols.length) lines.push(`  symbols: [${symbols.join(', ')}]`);
  // splice ONLY the frontmatter fence back; the body after the closing --- is byte-for-byte preserved.
  return text.slice(0, m.index) + ['---', lines.join('\n'), '---'].join('\n') + text.slice(m.index + m[0].length);
}

// The current session id for a CLI-invoked adapter (no hook event payload exists here). The whole codebase
// keys provenance off the session id; hooks read event.session_id, the synth path reads the .pending stash,
// and Claude Code exports it to the environment — so a hand-run adapter resolves it from CLAUDE_SESSION_ID.
// Absent ⇒ 'unknown' (fail-open: a missing session id must never break consolidation).
function currentSession() {
  return lineageScalar(process.env.CLAUDE_SESSION_ID);
}

// The per-run id, derived deterministically from the run's ISO timestamp (the SAME ts that keys this run's
// audit-log commit event). No new clock read and no random/uuid — the run id IS the audit timestamp, which
// is exactly what binds a stamped page to its audit entry for --revert. Colons stripped so it is a clean
// frontmatter scalar (an ISO ts carries `:` in the time).
function runIdFromTs(ts) {
  return lineageScalar(ts);
}

// Read a committed page's full on-disk content (frontmatter + body). Reached by tier+slug under .wrxn/wiki/.
function pageContent(root, tier, slug) {
  return fs.readFileSync(path.join(root, '.wrxn', 'wiki', tier, `${slug}.md`), 'utf8');
}

// sha256 of a page's exact bytes — the integrity fingerprint --revert recomputes to detect a hand-edit
// (mirrors harvest's mergeHash/decayHash sha256 discipline).
function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

// ── anti-superstition negative filters ────────────────────────────────────────
// A mechanical backstop to the dream skill's prompt (the skill is the primary semantic filter; this is
// "reinforced where mechanical"). Each pattern catches a class of transient/false "memory" that, if
// hardened into a recalled page, would poison future sessions. Matched over the proposal's AUTHORED
// text (title + body + rationale) ONLY — never the verbatim evidence quotes, which legitimately may
// contain the very failure phrasing a durable gotcha records.
const NEGATIVE_FILTERS = [
  // "tool X is broken" — a broad negative tool claim hardens into a permanent false refusal.
  { reason: 'negative_filter_tool_broken', re: /\bis (currently |completely |totally |again |now )?broken\b|\b(are|was|were) broken\b|\b(does|do|did)(n['’‛]t| not) work\b|\bnot working\b|\bis (down|unusable|busted|borked|useless)\b|\b(always|constantly|keeps?|forever) (fail(s|ing)?|break(s|ing)?|crash(es|ing)?)\b/ },
  // a transient environment / setup failure — not a durable property of the system. (The bare adjectives
  // `transient`/`intermittent` are intentionally NOT here: they false-positive on DI-lifetime decisions
  // like "services are registered transient" — the concrete error codes below carry the failure intent.)
  { reason: 'negative_filter_transient_failure', re: /\b(econnrefused|enoent|eaddrinuse|etimedout|connection refused|connection reset|timed out|time-?out|flak(e|y|ey)|rate[- ]?limit(ed)?|http 5\d\d|50[234]|port (already )?in use|address already in use|network (error|issue|glitch)|dns (error|failure))\b/ },
  // a smoke / sanity / happy-path RESULT — proves nothing durable. Gated on a result word so a forward
  // decision ("we adopt smoke tests", "the happy path must stay fast") is NOT a false positive.
  { reason: 'negative_filter_smoke_test', re: /\bhello[- ]?world\b|\b(smoke[- ]?tests?|sanity[- ]?checks?|happy path)\s+(pass(ed|es|ing)?|ran|run|succeed(ed|s)?|works?|worked|green)\b/ },
  // a release / version EVENT — a one-time act, not durable knowledge. (Bare nouns `released`/`changelog`/
  // `version bump` are intentionally NOT here: they false-positive on release-POLICY decisions.)
  { reason: 'negative_filter_release_marker', re: /\b(release notes?|bump(ed|ing)? (the )?version|tagged v\d|published to npm|npm publish|cut (a|the) release)\b/ },
  // a one-off task narrative — "today I renamed/fixed-a-typo" is episodic, not semantic.
  { reason: 'negative_filter_one_off', re: /\b(one[- ]?off|just this once|one[- ]?time only|fixed a typo|typo fix|renamed (the )?(file|variable|function|method)|moved (the )?file|trivial (chore|fix|task)|quick chore)\b/ },
  // never memorialize wrxn itself (its own routing / skill / engine text) — the memory system must not
  // pollute itself. (The bare word `synapse` is intentionally NOT here — it false-positives on "Azure
  // Synapse" / "Matrix Synapse"; wrxn's OWN synapse is still caught by the qualified `wrxn…synapse` clause.)
  { reason: 'negative_filter_wrxn_self', re: /\bsynapse-engine\b|\.claude\/(skills|hooks)\b|\bskill\.md\b|\bwiki\.cjs\b|\bdream\.cjs\b|\bconstitution\.md\b|\b(routing|keyword[- ]?recall) domain\b|\bwrxn['’‛]?s?\s+(own|routing|skill|synapse|hook|constitution|manifest|payload|kernel|adapter)\b/ },
];

function negativeFilter(text) {
  const lc = String(text || '').toLowerCase();
  for (const f of NEGATIVE_FILTERS) if (f.re.test(lc)) return f.reason;
  return null;
}

// ── credential / secret scan (security M2) ────────────────────────────────────
// A durable page must never harden a session secret into recalled memory. Scanned over the AUTHORED
// text (title + body + rationale) — the same scope as the negative filters, and CASE-SENSITIVE (these
// token shapes are case-specific). Evidence quotes are audit-only (never written to a page) so they
// stay out of scope here, like the negative filters.
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

// ── source quote-verification (auto-memory-01 + F1 substantive floor) ──────────
// The single mechanical control that lets a NON-human proposer (auto-dream) write durable memory
// without poisoning recall: when a --source transcript blob is supplied, every evidence quote must be a
// SUBSTANTIVE verbatim span that VERIFIABLY appears in it, else the proposal is a hallucination. Matching
// is normalized — lowercased + whitespace-collapsed — so transcript formatting (line wraps, indentation,
// case) never causes a false reject, while the substantive quote text must still be present contiguously
// (we do NOT strip punctuation: the AC scopes normalization to whitespace + case only). When no source
// is supplied (the manual dream skill — a trusted main-agent proposer) this is a no-op, so behavior is
// byte-identical to today. A non-string quote never reaches here: the evidence-presence check rejects it.
//
// F1 (security MED): a bare substring match is satisfied by a trivially-present quote — "the" is a
// substring of essentially every transcript — so the proposer needed only ANY real word to clear the
// gate, under-delivering the PRD's load-bearing "a hallucination can't poison recall" claim. So a quote
// must FIRST be substantive before its presence counts: the NORMALIZED quote must be ≥ QUOTE_MIN_CHARS
// chars AND ≥ QUOTE_MIN_TOKENS whitespace-delimited word tokens, else quote_not_substantive. The token
// floor rejects single/two-word fragments ("the", "it works"); the char floor backstops it against tiny
// 3-token spans ("a b c"). The bar is low enough never to false-reject a terse real decision quote
// ("use pino logs"), and a proposer grounding a real decision can always cite a fuller span.
function normalizeForMatch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

// The substantive-quote floor (F1). Operates on the NORMALIZED quote so it is independent of transcript
// formatting/case. Tunable here; pinned in BOTH directions (reject "the"/"authentication"; admit
// "use pino logs") by test/dream.test.cjs.
const QUOTE_MIN_CHARS = 12;
const QUOTE_MIN_TOKENS = 3;

function isSubstantiveQuote(quote) {
  const norm = normalizeForMatch(quote);
  if (norm.length < QUOTE_MIN_CHARS) return false;
  return norm.split(' ').filter(Boolean).length >= QUOTE_MIN_TOKENS;
}

// Quote-verify (auto-memory-01 + F1): returns a reject reason or null. PRECEDENCE — substantiveness is a
// property of the quote ALONE, so it is a global precondition checked BEFORE any source-presence match:
// if ANY quote is non-substantive → quote_not_substantive; else if ANY quote is absent from the source →
// quote_not_in_source. (So quote_not_substantive is reported before quote_not_in_source.)
function verifyQuotes(p, source) {
  if (!p.evidence.every((e) => isSubstantiveQuote(e.quote))) return 'quote_not_substantive';
  const hay = normalizeForMatch(source);
  if (!p.evidence.every((e) => hay.includes(normalizeForMatch(e.quote)))) return 'quote_not_in_source';
  return null;
}

// ── the pure per-proposal gate ────────────────────────────────────────────────
// Deterministic given (proposal, io, source). `io` injects the dedup IO so the gate stays a pure,
// unit-testable function (mirrors Phase-2 decideRecall): io.pathExists(tier,slug) /
// io.titleExists(title,tier,slug). `source` (auto-memory-01) is the optional transcript blob: when a
// non-null string, every evidence quote must be substantive (quote_not_substantive) and verifiably appear
// in it (quote_not_in_source); when null (the manual dream path) the quote-verify is skipped — behavior is
// byte-identical to today.
// PRECEDENCE (deterministic, documented): routing validity (tier, kind↔tier) → confidence floor →
// evidence presence → SOURCE quote-verify [substantive floor (quote_not_substantive) BEFORE
// source-presence (quote_not_in_source)] → rationale → body → negative filters → secret-scan →
// identity → dedup. So the quote-verify reasons are reported AFTER the cheap structural checks the quote
// itself depends on (it needs evidence to exist) and the confidence floor, but BEFORE the negative
// filters, secret-scan, identity and the expensive dedup IO. Quote-verify composes with — never
// bypasses — every existing check: a proposal that passes quote-verify still faces all later gates.
function validateProposal(p, io, source) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'invalid_proposal' };
  if (!TIERS.includes(p.tier)) return { ok: false, reason: 'unsupported_tier' };
  if (KIND_TIER[p.kind] !== p.tier) return { ok: false, reason: 'kind_tier_mismatch' };
  if (typeof p.confidence !== 'number' || p.confidence < CONFIDENCE_FLOOR) return { ok: false, reason: 'confidence_below_threshold' };
  if (!Array.isArray(p.evidence) || p.evidence.length === 0 ||
      !p.evidence.every((e) => e && typeof e.quote === 'string' && e.quote.trim().length > 0)) {
    return { ok: false, reason: 'missing_evidence' };
  }
  // SOURCE quote-verify (auto-memory-01 + F1): runs ONLY when a --source blob is supplied. The evidence is
  // known present + non-blank here, so each quote must be a substantive span (quote_not_substantive) AND
  // normalize-substring-match the source (quote_not_in_source) or the proposal is a hallucination. Null
  // source (manual dream) ⇒ skipped ⇒ byte-identical to today.
  if (source != null) {
    const qr = verifyQuotes(p, source);
    if (qr) return { ok: false, reason: qr };
  }
  if (typeof p.rationale !== 'string' || p.rationale.trim().length === 0) return { ok: false, reason: 'missing_rationale' };
  if (typeof p.body !== 'string' || !p.body.startsWith('# ')) return { ok: false, reason: 'body_missing_h1' };
  if (p.body.length > BODY_MAX) return { ok: false, reason: 'body_too_large' };
  const authored = `${p.title || ''}\n${p.body}\n${p.rationale}`;
  const neg = negativeFilter(authored);
  if (neg) return { ok: false, reason: neg };
  const sec = secretScan(authored);
  if (sec) return { ok: false, reason: sec };
  // identity fields — gated BEFORE the (expensive) dedup IO so a bad/missing slug or a flag-injecting
  // title can never reach the wiki bridge (a no-slug proposal otherwise passes check then drops at commit).
  if (typeof p.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.slug)) return { ok: false, reason: 'invalid_slug' };
  if (typeof p.title !== 'string' || p.title.trim().length === 0) return { ok: false, reason: 'missing_title' };
  if (p.title.startsWith('--')) return { ok: false, reason: 'invalid_title' };
  if (io.pathExists(p.tier, p.slug)) return { ok: false, reason: 'duplicate_existing_path' };
  if (io.titleExists(p.title, p.tier, p.slug)) return { ok: false, reason: 'duplicate_existing_title' };
  return { ok: true };
}

// Run-level gate: restraint (empty/abstain ⇒ write nothing) + the ≤5 accepted cap. `source` threads
// the optional --source blob to every per-proposal quote-verify (auto-memory-01); null ⇒ legacy path.
function validateRun(proposals, io, source) {
  const accepted = [];
  const rejected = [];
  let acceptedCount = 0;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const v = validateProposal(p, io, source);
    if (v.ok) {
      acceptedCount += 1;
      if (acceptedCount > MAX_ACCEPTED) {
        rejected.push({ index: i, slug: p && p.slug, reason: 'max_proposals_exceeded' });
      } else {
        accepted.push(p);
      }
    } else {
      rejected.push({ index: i, slug: p && p.slug, reason: v.reason });
    }
  }
  return { abstained: false, accepted, rejected };
}

// Dedup IO backed by the wiki adapter's query (lazy — only fires for an otherwise-valid proposal).
function makeIo(root) {
  return {
    pathExists(tier, slug) {
      if (!slug || !TIERS.includes(tier)) return false;
      try {
        const res = wikiQuery(root, [slug], { tier, limit: 5000 });
        const page = `${tier}/${slug}.md`;
        return (res.hits || []).some((h) => h.file === page);
      } catch {
        return false;
      }
    },
    titleExists(title, tier, slug) {
      const want = normalizeTitle(title);
      if (!want) return false;
      try {
        const res = wikiQuery(root, [String(title)], { limit: 5000 });
        const ownPage = `${tier}/${slug}.md`;
        return (res.hits || []).some((h) => {
          const m = /^description:\s*(.*)$/i.exec(h.snippet || '');
          return m && normalizeTitle(m[1]) === want && h.file !== ownPage;
        });
      } catch {
        return false;
      }
    },
  };
}

// Normalize any check/stage/commit input into { proposals[], abstain }.
function normalizeBatch(input) {
  if (input && typeof input === 'object' && input.abstain === true) return { proposals: [], abstain: true };
  if (Array.isArray(input)) return { proposals: input, abstain: input.length === 0 };
  if (input && typeof input === 'object' && Array.isArray(input.proposals)) {
    return { proposals: input.proposals, abstain: input.proposals.length === 0 };
  }
  return { proposals: [input], abstain: false }; // a bare single proposal
}

function isBatchInput(input) {
  return Array.isArray(input) ||
    (input && typeof input === 'object' && (Array.isArray(input.proposals) || input.abstain === true));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read JSON from "${file}": ${err.message}`);
    return undefined;
  }
}

// Read the optional --source transcript blob (auto-memory-01). Absent ⇒ null (the legacy path, no
// quote-verify). PRESENT ⇒ it MUST carry a real, readable file value: a value-less / empty / --leading
// token (F2) or an unreadable path ⇒ HARD fail (exit 2). A missing source must NEVER silently disable the
// gate — that would let a malformed argv (or a broken file) turn off the one defense against a
// hallucinated memory. We read argv DIRECTLY here (not flag()): flag('source') collapses "flag absent"
// and "flag present-but-valueless" both to undefined, but only the former may fall through to legacy.
// The blob is raw text (the transcript), read as-is, not parsed.
function readSource() {
  const i = process.argv.indexOf('--source');
  if (i === -1) return null; // the flag is truly absent → legacy path (the trusted manual-dream proposer)
  const file = process.argv[i + 1];
  // --source WAS asked for, so it must not silently revert to no-verify: a trailing token (undefined), an
  // empty value, or another flag (e.g. `--root`) is a fail-CLOSED malformed argv, never "gate off" (F2).
  if (file === undefined || file === '' || file.startsWith('--')) {
    fail('--source was given without a readable file value — refusing to silently disable quote-verify');
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read --source file "${file}": ${err.message}`);
    return undefined;
  }
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function dreamDir(root) {
  const dir = path.join(root, ...DREAM_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── subcommands ───────────────────────────────────────────────────────────────
function runCheck() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const io = makeIo(root);
  const source = readSource(); // null ⇒ legacy path (no quote-verify); string ⇒ verify every quote
  if (isBatchInput(input)) {
    const { proposals, abstain } = normalizeBatch(input);
    if (abstain) return print({ abstained: true, accepted: [], rejected: [] });
    return print(validateRun(proposals, io, source));
  }
  return print(validateProposal(input, io, source)); // single proposal → single Verdict
}

function runStage() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const { proposals, abstain } = normalizeBatch(input);
  if (abstain) return print({ abstained: true, staged: 0 }); // restraint: write nothing

  const res = validateRun(proposals, makeIo(root));
  const dir = dreamDir(root);
  const ts = new Date().toISOString();
  const stagedPath = path.join(dir, STAGED_FILE);
  // staged.jsonl — the validated-but-unapproved proposals, full content, one JSON line each. NEVER .md
  // (recon walks all of .wrxn/ and prose-ingests *.md, so the audit trail must stay non-markdown).
  for (const p of res.accepted) appendLine(stagedPath, { ts, op: 'stage', slug: p.slug, tier: p.tier, proposal: p });
  // audit.jsonl — the append-only outcome log (accepted slugs + the rejection reasons).
  appendLine(path.join(dir, AUDIT_FILE), { ts, op: 'stage', accepted: res.accepted.map((p) => p.slug), rejected: res.rejected });
  return print({
    abstained: false,
    staged: res.accepted.length,
    rejected: res.rejected.length,
    stagedFile: res.accepted.length ? path.relative(root, stagedPath) : null,
  });
}

// Normalize commit input into the operator-approved SLUG list (["slug-a",…] or { approved:[…] }).
function approvedSlugs(input) {
  if (Array.isArray(input)) return input.map(String);
  if (input && typeof input === 'object' && Array.isArray(input.approved)) return input.approved.map(String);
  return [];
}

// Read staged.jsonl into a slug → staged-proposal map (last staged wins). Malformed lines are skipped.
function readStaged(root) {
  const map = new Map();
  let txt;
  try {
    txt = fs.readFileSync(path.join(root, ...DREAM_DIR, STAGED_FILE), 'utf8');
  } catch {
    return map; // no staged trail yet → nothing to commit by reference
  }
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && rec.slug && rec.proposal) map.set(rec.slug, rec.proposal);
    } catch {
      /* skip a malformed audit line */
    }
  }
  return map;
}

// commit BY REFERENCE: bind committed == staged == presented. For each operator-approved slug we look up
// its staged proposal and RE-RUN the full gate (validateProposal) at the write boundary — so a proposal
// the gate would reject can never reach recall, even if its slug is force-approved. A slug not staged, or
// one that fails re-validation (confidence, evidence, body H1, kind↔tier, secret-scan, negative filters,
// identity, dedup — all re-checked), is recorded skipped with the reason; the rest of the batch still writes.
function runCommit() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const approved = approvedSlugs(input);
  const io = makeIo(root);
  const source = readSource(); // null ⇒ legacy re-gate; string ⇒ re-verify every quote at the write boundary
  const staged = readStaged(root);
  // One ts per run: it keys this run's audit event AND derives synth_run, so a stamped page's synth_run is
  // byte-identical to the run id recorded in the audit log — the bind that lets --revert resolve this run.
  const ts = new Date().toISOString();
  const runId = runIdFromTs(ts);
  const session = currentSession();
  // C3 (#36): the forward citation FACTS, resolved ONCE per run from ground truth — the session anchor, the
  // real git HEAD, the session's .touched symbol set. Fail-open by construction (resolveEvidence never throws).
  const evidence = resolveEvidence({ session, resolveHead: () => resolveGitHead(root), touched: readTouched(root, session) });
  const written = [];
  const skipped = [];
  for (const slug of approved) {
    const key = String(slug);
    const p = staged.get(key);
    if (!p) {
      skipped.push({ slug: key, reason: 'not_staged' });
      continue;
    }
    const v = validateProposal(p, io, source); // the re-gate — additive + dedup-skip + quote-verify + every quality/safety check
    if (!v.ok) {
      skipped.push({ slug: key, reason: v.reason });
      continue;
    }
    try {
      const r = wikiWritePage(root, p.tier, p.slug, p.title, p.body);
      stampPageImportance(root, p.tier, p.slug, p.confidence); // persist dream's score as importance: (harvest-10)
      stampPageLineage(root, p.tier, p.slug, { origin_session: session, synth_run: runId, proposal_id: p.slug }); // S3 provenance
      stampPageEvidence(root, p.tier, p.slug, evidence); // C3 (#36): forward citation facts (session/commit/symbols)
      // capture the content hash of EXACTLY what this run wrote (after all stamps) so --revert can detect a
      // page hand-edited since (current hash ≠ this) and refuse to clobber it.
      const hash = sha256(pageContent(root, p.tier, p.slug));
      written.push({ slug: p.slug, tier: p.tier, file: r.written, hash });
    } catch (err) {
      // wiki.cjs write-page does process.exit(2) on an existing page — catch the non-zero exit so a
      // TOCTOU collision (or any single write failure) is recorded and the rest of the batch STILL writes.
      const stderr = String((err && err.stderr) || '');
      const reason = /already exists/i.test(stderr) ? 'duplicate_existing_path' : 'skipped_error';
      skipped.push({ slug: key, reason });
    }
  }
  // the audit commit event records this run's id + each written page's tier/slug/hash — the cross-check
  // ledger --revert reads to reverse exactly this run's pages and detect hand-edits (#22).
  appendLine(path.join(dreamDir(root), AUDIT_FILE), {
    ts, op: 'commit', synth_run: runId, origin_session: session,
    written: written.map((w) => w.slug),
    pages: written.map((w) => ({ slug: w.slug, tier: w.tier, hash: w.hash })),
    skipped,
  });
  return print({ written, skipped, synth_run: runId });
}

// ── revert (S3 / #22) — pull a bad consolidation batch back out ────────────────
// Resolve EXACTLY the pages a given synth_run wrote (the audit commit event is the source of truth — we
// never trust the on-disk synth_run stamp alone) and reverse them. SAFETY: a page hand-edited since the run
// wrote it (its current sha256 no longer matches the hash the audit recorded at commit) is REFUSED and
// reported, never clobbered; an unknown run id (no matching audit commit event) is REFUSED and reported.

// Read the append-only audit log into an array of parsed records (malformed lines skipped; absent → []).
function readAudit(root) {
  let txt;
  try {
    txt = fs.readFileSync(path.join(root, ...DREAM_DIR, AUDIT_FILE), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a malformed audit line */ }
  }
  return out;
}

// The pages this run committed, per the audit log (the cross-check ledger). Gathers every `commit` event
// whose synth_run matches, de-duplicating by tier/slug (a slug can't be committed twice in additive dream,
// but be defensive). Returns [] when no commit event matches the run id → the caller reports unknown_run.
function runPagesFromAudit(audit, runId) {
  const seen = new Set();
  const pages = [];
  for (const rec of audit) {
    if (!rec || rec.op !== 'commit' || rec.synth_run !== runId) continue;
    for (const pg of Array.isArray(rec.pages) ? rec.pages : []) {
      if (!pg || !pg.slug || !pg.tier) continue;
      const key = `${pg.tier}/${pg.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pages.push({ slug: String(pg.slug), tier: String(pg.tier), hash: String(pg.hash || '') });
    }
  }
  return pages;
}

// PURE revert planner (deterministic given the audit + a content reader). Classifies each audit page of the
// run: missing (already gone — nothing to reverse), edited (current hash ≠ audit hash — REFUSE), or
// reversible (hash matches → safe to delete). `readContent(tier, slug)` returns the page text or null when
// absent. Unknown run (no audit pages) → { unknown_run:true }. v1 is delete-only: dream commit is purely
// additive (it dedup-SKIPS a pre-existing slug, never overwrites — proven by the AC2-backward-safe test), so
// a reverted page had no prior version to restore; reversing == removing the page the run created.
function resolveRevert(audit, runId, readContent) {
  const pages = runPagesFromAudit(audit, runId);
  if (pages.length === 0) return { unknown_run: true, reversible: [], edited: [], missing: [] };
  const reversible = [];
  const edited = [];
  const missing = [];
  for (const pg of pages) {
    const content = readContent(pg.tier, pg.slug);
    if (content == null) { missing.push({ slug: pg.slug, tier: pg.tier }); continue; }
    if (sha256(content) !== pg.hash) { edited.push({ slug: pg.slug, tier: pg.tier }); continue; } // hand-edited → refuse
    reversible.push({ slug: pg.slug, tier: pg.tier });
  }
  return { unknown_run: false, reversible, edited, missing };
}

function runRevert() {
  const runId = positionalFile(); // the run id is the lone positional after `revert`
  const root = installRoot();
  const audit = readAudit(root);
  const plan = resolveRevert(audit, runId, (tier, slug) => {
    try { return pageContent(root, tier, slug); } catch { return null; }
  });
  if (plan.unknown_run) {
    print({ run: runId, reverted: [], refused: [], missing: [], reason: 'unknown_run' });
    process.exit(2); // an unknown run id is refused (and reported) — not a silent no-op success
  }
  const reverted = [];
  const failed = [];
  for (const pg of plan.reversible) {
    try {
      wikiDeletePage(root, pg.tier, pg.slug);
      reverted.push(pg.slug);
    } catch (e) {
      // a delete that fails (vanished page / wiki refusal) is recorded — never aborts the rest of the batch.
      failed.push({ slug: pg.slug, reason: String((e && e.message) || 'delete_failed').split('\n')[0] });
    }
  }
  const refused = plan.edited.map((p) => ({ slug: p.slug, reason: 'hand_edited' })); // hand-edited pages are NOT clobbered
  appendLine(path.join(dreamDir(root), AUDIT_FILE), {
    ts: new Date().toISOString(), op: 'revert', synth_run: runId,
    reverted, refused, missing: plan.missing.map((p) => p.slug), failed,
  });
  return print({ run: runId, reverted, refused, missing: plan.missing.map((p) => p.slug), failed });
}

function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'check':
      return runCheck();
    case 'stage':
      return runStage();
    case 'commit':
      return runCommit();
    case 'revert':
      return runRevert();
    default:
      process.stdout.write('Usage: node .wrxn/dream.cjs <check|stage|commit> <file.json> | revert <run_id> [--root <dir>]\n');
      process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { stampImportance, stampLineage, stampEvidence, resolveEvidence, lineageScalar, sha256, resolveRevert, runPagesFromAudit };
