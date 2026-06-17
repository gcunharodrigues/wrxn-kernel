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
//   stage  <batch.json>                   record the VALIDATED (accepted) batch into the audit trail
//          under .wrxn/dream/ as .jsonl (NEVER .md, so recon's prose ingestion never recalls a
//          staged-but-unapproved proposal). Nothing is written to the wiki.
//   commit <approved.json>                write operator-approved proposals additively to their tiers
//          VIA the wiki.cjs adapter (the indirection contract — no direct wiki .md writes), then append
//          the outcome to the .wrxn/dream/ audit log (.jsonl). Additive + dedup-SKIP: an approved page
//          that already exists is recorded skipped-existing and the batch still writes the rest.
//
// Flag: --root <dir> (override the install-root walk-up; mainly for tests).
//
// Proposal { kind:"concept"|"decision"|"gotcha"; tier:"concepts"|"decisions"|"gotchas"; slug; title;
//            body /* starts "# " */; confidence /*0–1*/; rationale; evidence:[{quote,source?}] }
// Verdict  { ok:boolean; reason?:string /* machine code on reject */ }
// (The `_rules`/`_slots` tiers + the `rule` kind arrive in later slices — this slice is the three
//  existing semantic tiers.)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// kind → tier is the contract; the tier must agree with the kind.
const KIND_TIER = { concept: 'concepts', decision: 'decisions', gotcha: 'gotchas' };
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

function wikiQuery(root, terms, opts) {
  const o = opts || {};
  const args = [wikiAdapter(), 'query', ...terms.map(String), '--root', root, '--limit', String(o.limit || 5000)];
  if (o.tier) args.push('--tier', o.tier);
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

function wikiWritePage(root, tier, slug, description, body) {
  const args = [wikiAdapter(), 'write-page', tier, slug, '--description', String(description || ''), '--body', String(body || ''), '--root', root];
  return JSON.parse(execFileSync('node', args, { encoding: 'utf8' }));
}

function normalizeTitle(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/\s+/g, ' ').trim();
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
  // a transient environment / setup failure — not a durable property of the system.
  { reason: 'negative_filter_transient_failure', re: /\b(econnrefused|enoent|eaddrinuse|etimedout|connection refused|connection reset|timed out|time-?out|flak(e|y|ey)|intermittent|transient|rate[- ]?limit(ed)?|http 5\d\d|50[234]|port (already )?in use|address already in use|network (error|issue|glitch)|dns (error|failure))\b/ },
  // a smoke / sanity / happy-path check — proves nothing durable.
  { reason: 'negative_filter_smoke_test', re: /\b(smoke[- ]?tests?|sanity[- ]?checks?|hello[- ]?world|happy path)\b/ },
  // a release / version marker — a one-time event, not durable knowledge.
  { reason: 'negative_filter_release_marker', re: /\b(release notes?|released|bump(ed|ing)? (the )?version|version bump|changelog|tagged v\d|published to npm|npm publish|cut (a|the) release)\b/ },
  // a one-off task narrative — "today I renamed/fixed-a-typo" is episodic, not semantic.
  { reason: 'negative_filter_one_off', re: /\b(one[- ]?off|just this once|one[- ]?time only|fixed a typo|typo fix|renamed (the )?(file|variable|function|method)|moved (the )?file|trivial (chore|fix|task)|quick chore)\b/ },
  // never memorialize wrxn itself (its own routing / skill / engine text) — the memory system must not pollute itself.
  { reason: 'negative_filter_wrxn_self', re: /\bsynapse\b|\bsynapse-engine\b|\.claude\/(skills|hooks)\b|\bskill\.md\b|\bwiki\.cjs\b|\bdream\.cjs\b|\bconstitution\.md\b|\b(routing|keyword[- ]?recall) domain\b|\bwrxn['’‛]?s?\s+(own|routing|skill|synapse|hook|constitution|manifest|payload|kernel|adapter)\b/ },
];

function negativeFilter(text) {
  const lc = String(text || '').toLowerCase();
  for (const f of NEGATIVE_FILTERS) if (f.re.test(lc)) return f.reason;
  return null;
}

// ── the pure per-proposal gate ────────────────────────────────────────────────
// Deterministic given (proposal, io). `io` injects the dedup IO so the gate stays a pure, unit-testable
// function (mirrors Phase-2 decideRecall): io.pathExists(tier,slug) / io.titleExists(title,tier,slug).
// Precedence: routing validity → quality → content safety → dedup (the last, most-expensive check).
function validateProposal(p, io) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'invalid_proposal' };
  if (!TIERS.includes(p.tier)) return { ok: false, reason: 'unsupported_tier' };
  if (KIND_TIER[p.kind] !== p.tier) return { ok: false, reason: 'kind_tier_mismatch' };
  if (typeof p.confidence !== 'number' || p.confidence < CONFIDENCE_FLOOR) return { ok: false, reason: 'confidence_below_threshold' };
  if (!Array.isArray(p.evidence) || p.evidence.length === 0 ||
      !p.evidence.every((e) => e && typeof e.quote === 'string' && e.quote.trim().length > 0)) {
    return { ok: false, reason: 'missing_evidence' };
  }
  if (typeof p.rationale !== 'string' || p.rationale.trim().length === 0) return { ok: false, reason: 'missing_rationale' };
  if (typeof p.body !== 'string' || !p.body.startsWith('# ')) return { ok: false, reason: 'body_missing_h1' };
  if (p.body.length > BODY_MAX) return { ok: false, reason: 'body_too_large' };
  const neg = negativeFilter(`${p.title || ''}\n${p.body}\n${p.rationale}`);
  if (neg) return { ok: false, reason: neg };
  if (io.pathExists(p.tier, p.slug)) return { ok: false, reason: 'duplicate_existing_path' };
  if (io.titleExists(p.title, p.tier, p.slug)) return { ok: false, reason: 'duplicate_existing_title' };
  return { ok: true };
}

// Run-level gate: restraint (empty/abstain ⇒ write nothing) + the ≤5 accepted cap.
function validateRun(proposals, io) {
  const accepted = [];
  const rejected = [];
  let acceptedCount = 0;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const v = validateProposal(p, io);
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
  if (isBatchInput(input)) {
    const { proposals, abstain } = normalizeBatch(input);
    if (abstain) return print({ abstained: true, accepted: [], rejected: [] });
    return print(validateRun(proposals, io));
  }
  return print(validateProposal(input, io)); // single proposal → single Verdict
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

function runCommit() {
  const input = readJson(positionalFile());
  const root = installRoot();
  const { proposals, abstain } = normalizeBatch(input);
  if (abstain) return print({ abstained: true, written: [], skipped: [] });

  const io = makeIo(root);
  const written = [];
  const skipped = [];
  for (const p of proposals) {
    if (!p || !TIERS.includes(p.tier) || !p.slug) {
      skipped.push({ slug: p && p.slug, reason: 'skipped-invalid' });
      continue;
    }
    // dedup-skip (path) — additive: an approved page that already exists is skipped, never clobbered.
    if (io.pathExists(p.tier, p.slug)) {
      skipped.push({ slug: p.slug, reason: 'skipped-existing' });
      continue;
    }
    try {
      const r = wikiWritePage(root, p.tier, p.slug, p.title, p.body);
      written.push({ slug: p.slug, tier: p.tier, file: r.written });
    } catch (err) {
      // wiki.cjs write-page does process.exit(2) on an existing page — catch the non-zero exit so a
      // TOCTOU collision (or any single write failure) is recorded and the rest of the batch STILL writes.
      const stderr = String((err && err.stderr) || '');
      const reason = /already exists/i.test(stderr) ? 'skipped-existing' : 'skipped-error';
      skipped.push({ slug: p.slug, reason });
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

main();
