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
      written.push({ slug: p.slug, tier: p.tier, file: r.written });
    } catch (err) {
      // wiki.cjs write-page does process.exit(2) on an existing page — catch the non-zero exit so a
      // TOCTOU collision (or any single write failure) is recorded and the rest of the batch STILL writes.
      const stderr = String((err && err.stderr) || '');
      const reason = /already exists/i.test(stderr) ? 'duplicate_existing_path' : 'skipped_error';
      skipped.push({ slug: key, reason });
    }
  }
  appendLine(path.join(dreamDir(root), AUDIT_FILE), { ts: new Date().toISOString(), op: 'commit', written: written.map((w) => w.slug), skipped });
  return print({ written, skipped });
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
    default:
      process.stdout.write('Usage: node .wrxn/dream.cjs <check|stage|commit> <file.json> [--root <dir>]\n');
      process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { stampImportance };
