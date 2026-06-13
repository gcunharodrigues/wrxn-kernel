#!/usr/bin/env node
'use strict';

// WRXN recall-surface hook — per-prompt recall nudge (wrxn-kernel-11).
// UserPromptSubmit. The symmetric RECALL half of reference-detect's CAPTURE: on each prompt it
// matches the prompt's SALIENT terms against the wiki knowledge tiers (concepts/decisions/gotchas)
// and, ONLY when a page matches, injects a <recall-surface> nudge — "you already have a page on X,
// recall it before re-deriving / re-asking the operator". Gated → silent on non-matching prompts.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only). The kernel
// wiki engine is substring (not BM25) — recall here is a deliberately simple distinct-salient-term
// count, ranked, top-N. Fail-open: any fault emits {} — the hook NEVER blocks a prompt.
//
// Contract: UserPromptSubmit event JSON on stdin → envelope JSON on stdout (exit 0).

const fs = require('fs');
const path = require('path');

const TIERS = ['concepts', 'decisions', 'gotchas']; // knowledge tiers; sessions (episodic) excluded
const TOP_N = 2;
const MIN_PROMPT_LEN = 8; // skip trivial prompts ("ok", "yes")
// A page must share >=2 DISTINCT salient terms with the prompt to surface — the substring engine has
// no BM25 score, so a single shared common word is too weak a signal (anti-noise). Tradeoff: a genuine
// single-strong-term recall is silenced (fail-silent — a missed nudge is safer than a false one).
const MIN_DISTINCT = 2;
const MAX_BLOCK_CHARS = 600;

// Drop stopwords + short tokens so common words don't match common page words (anti-noise).
const STOPWORDS = new Set(['about', 'after', 'again', 'against', 'because', 'before', 'being', 'between',
  'could', 'does', 'doing', 'down', 'during', 'each', 'from', 'further', 'have', 'having', 'here', 'how',
  'into', 'just', 'like', 'more', 'most', 'only', 'other', 'over', 'same', 'should', 'some', 'such',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
  'until', 'very', 'want', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your', 'today',
  'tell', 'show', 'give', 'make', 'need', 'know', 'help', 'please', 'thing', 'stuff', 'really', 'going']);

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

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

// De-duped salient content tokens (lowercased, >=4 chars, non-stopword).
function salientTerms(prompt) {
  const seen = new Set();
  for (const tok of (String(prompt || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])) {
    if (!STOPWORDS.has(tok)) seen.add(tok);
  }
  return [...seen];
}

// Score each wiki page by the count of DISTINCT salient terms it contains; keep pages with >=1.
function recall(root, terms) {
  const hits = [];
  for (const tier of TIERS) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue; // tier absent → skip
    }
    for (const name of names) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8').toLowerCase();
      } catch {
        continue;
      }
      const matched = terms.filter((t) => text.includes(t)).length;
      if (matched >= MIN_DISTINCT) hits.push({ slug: name.replace(/\.md$/, ''), tier, score: matched });
    }
  }
  // Highest distinct-term count first; ties broken by slug for determinism.
  hits.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return hits.slice(0, TOP_N);
}

function block(hits) {
  const lines = [
    '<recall-surface>',
    'You already have captured page(s) on this topic — READ before answering (do not re-derive, do',
    'not ask the operator to re-explain). Recall with: node .wrxn/wiki.cjs recall "<slug>"',
    ...hits.map((h) => `- ${h.slug} (${h.tier})`),
    '</recall-surface>',
  ].join('\n');
  return lines.length <= MAX_BLOCK_CHARS ? lines : `${lines.slice(0, MAX_BLOCK_CHARS - 18)}\n</recall-surface>`;
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    emit({});
  }

  const root = findInstallRoot();
  if (!root) emit({});

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  if (prompt.trim().length < MIN_PROMPT_LEN) emit({});

  const terms = salientTerms(prompt);
  if (!terms.length) emit({});

  const hits = recall(root, terms);
  if (!hits.length) emit({}); // no captured page matched → silent (the gate)

  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block(hits) } });
}

try {
  main();
} catch {
  emit({});
}
