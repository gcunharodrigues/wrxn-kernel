#!/usr/bin/env node
'use strict';

// WRXN SYNAPSE engine — the per-prompt context-injection core (the layered port).
// UserPromptSubmit. Assembles the active domains into a <synapse-rules> block and injects it
// as additionalContext so every prompt carries the constitution + operational rules.
//
// Self-contained: this hook ships into installs and CANNOT import the kernel lib/. It reads the
// install's own .synapse/ domains + .claude/constitution.md + the manifest. Silent / fail-open:
// any fault emits {} (no injection) — the engine NEVER blocks a prompt.
//
// Contract: UserPromptSubmit event JSON on stdin → envelope JSON on stdout (exit 0).
//   inject → { "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "<synapse-rules>…" } }
//   no-op  → {}
//
// Layers (faithful to the WRXN-OS SYNAPSE model, reimplemented standalone):
//   L0 Constitution — always, sourced from .claude/constitution.md, NEVER trimmed.
//   L1 Global / Pipeline — always-on domains (.synapse/<domain>, KEY=VALUE rules).
//   L6 Keyword-recall — domains that fire only when a trigger word appears in the prompt (06b).

const fs = require('fs');
const path = require('path');

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
  process.exit(0);
}

// Walk up from CLAUDE_PROJECT_DIR (or cwd) to the install root carrying wrxn.install.json.
// Same resolution as the managed-guard hook — the receipt marks an install root.
function findInstallRoot(startDir) {
  let dir = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function readFileOr(p, fallback) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

// ── parsing ────────────────────────────────────────────────────────────────────

// Parse the flat KEY=VALUE .synapse/manifest into a domain map:
//   { GLOBAL: { state, alwaysOn, recall:[...] }, ROUTING: {...}, ... }
// Per-domain keys: <DOMAIN>_STATE, <DOMAIN>_ALWAYS_ON, <DOMAIN>_RECALL. Non-domain keys
// (RULES_BUDGET_TOKENS, HANDOFF_PCT) are left for the caller to read raw.
function parseSynapseManifest(text) {
  const domains = {};
  const ensure = (name) => (domains[name] || (domains[name] = { state: '', alwaysOn: false, recall: [] }));
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    let m;
    if ((m = key.match(/^(.+)_STATE$/))) ensure(m[1]).state = val;
    else if ((m = key.match(/^(.+)_ALWAYS_ON$/))) ensure(m[1]).alwaysOn = val === 'true';
    else if ((m = key.match(/^(.+)_RECALL$/))) ensure(m[1]).recall = val.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return domains;
}

// Read a single scalar key from the flat manifest (e.g. RULES_BUDGET_TOKENS), or '' if absent.
function manifestValue(text, key) {
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1);
  }
  return '';
}

// Extract <DOMAIN>_RULE_N values from a domain file, ordered by N ascending.
function domainRules(domainUpper, text) {
  const re = new RegExp(`^${domainUpper}_RULE_(\\d+)=(.*)$`);
  const found = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(re);
    if (m) found.push({ n: Number(m[1]), v: m[2] });
  }
  found.sort((a, b) => a.n - b.n);
  return found.map((x) => x.v);
}

// ── rendering ────────────────────────────────────────────────────────────────────

// Render constitution.md into the always-kept L0 section. Keep article headings + their bullets,
// drop the prose preamble so the injection stays compact. Returns the section body (no header).
function renderConstitution(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let inArticle = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inArticle = true;
      out.push(line.replace(/^##\s+/, '').trim());
      continue;
    }
    if (!inArticle) continue;
    if (/^#\s/.test(line)) { inArticle = false; continue; }
    const t = line.trim();
    if (t.startsWith('- ')) out.push('  ' + t.slice(2).trim());
    else if (t.startsWith('-')) out.push('  ' + t.slice(1).trim());
  }
  return out.join('\n');
}

// A rules domain section: a `[HEADER]` line followed by numbered rules.
function renderRulesSection(header, rules) {
  const body = rules.map((r, i) => `  ${i + 1}. ${r}`).join('\n');
  return `[${header}]\n${body}`;
}

function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

// ── budget governor ────────────────────────────────────────────────────────────

// Bound the trimmable sections by a token budget. The constitution is OUTSIDE the budget and
// always kept. Trimmable sections are dropped lowest-priority-LAST first (the array is in priority
// order; we drop from the end) until the kept set fits. Returns { kept:[...], trimmed:[names] }.
function applyBudget(trimmable, budget) {
  const kept = trimmable.slice();
  const trimmed = [];
  const total = () => kept.reduce((sum, s) => sum + estimateTokens(s.text), 0);
  while (kept.length && total() > budget) {
    const dropped = kept.pop();
    trimmed.unshift(dropped.name);
  }
  return { kept, trimmed };
}

// ── assembly ────────────────────────────────────────────────────────────────────

// Build the active section list for a prompt. Returns ordered sections:
//   [{ name, header, text, always }]  — `always` marks the never-trimmed constitution.
function buildSections(root, prompt) {
  const manifestText = readFileOr(path.join(root, '.synapse', 'manifest'), '');
  const domains = parseSynapseManifest(manifestText);
  const promptLower = String(prompt || '').toLowerCase();
  const sections = [];

  // L0 — Constitution (always; from constitution.md). Skip silently if the file/domain is absent.
  if (domains.CONSTITUTION && domains.CONSTITUTION.state === 'active') {
    const body = renderConstitution(readFileOr(path.join(root, '.claude', 'constitution.md'), ''));
    if (body.trim()) {
      sections.push({ name: 'CONSTITUTION', header: 'CONSTITUTION] (NON-NEGOTIABLE', text: `[CONSTITUTION] (NON-NEGOTIABLE)\n${body}`, always: true });
    }
  }

  // L1/L6 — every other active domain, in manifest order. always-on loads unconditionally;
  // a recall domain loads only when one of its trigger words appears in the prompt (06b).
  for (const [name, d] of Object.entries(domains)) {
    if (name === 'CONSTITUTION' || d.state !== 'active') continue;
    const fires = d.alwaysOn || (d.recall.length > 0 && d.recall.some((w) => promptLower.includes(w.toLowerCase())));
    if (!fires) continue;
    const domainText = readFileOr(path.join(root, '.synapse', name.toLowerCase()), '');
    const rules = domainRules(name, domainText);
    if (!rules.length) continue;
    const header = d.alwaysOn ? name : `RECALL: ${name.toLowerCase()}`;
    sections.push({ name, header, text: renderRulesSection(header, rules), always: false });
  }

  return { sections, manifestText };
}

function resolveBudget(manifestText) {
  const env = Number(process.env.WRXN_RULES_BUDGET);
  if (Number.isFinite(env) && env > 0) return env;
  const m = Number(manifestValue(manifestText, 'RULES_BUDGET_TOKENS'));
  return Number.isFinite(m) && m > 0 ? m : 600;
}

// Compose the full additionalContext for a prompt at an install root, or '' to no-op.
function compose(root, prompt) {
  const { sections, manifestText } = buildSections(root, prompt);
  if (!sections.length) return '';

  const always = sections.filter((s) => s.always);
  const trimmable = sections.filter((s) => !s.always);
  const { kept, trimmed } = applyBudget(trimmable, resolveBudget(manifestText));

  const out = [...always.map((s) => s.text), ...kept.map((s) => s.text)];
  if (trimmed.length) {
    out.push(`[SYNAPSE-RULES-TRIM] ${trimmed.join(', ')} dropped over the ${resolveBudget(manifestText)}-token rules budget`);
  }
  return `<synapse-rules>\n\n${out.join('\n\n')}\n\n</synapse-rules>`;
}

// ── entrypoint ────────────────────────────────────────────────────────────────────

function main() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return emit({}); // unparseable → fail open (no injection)
  }

  const root = findInstallRoot(event.cwd);
  if (!root) return emit({}); // not inside a wrxn install → nothing to inject

  let additionalContext = '';
  try {
    additionalContext = compose(root, event.prompt);
  } catch {
    return emit({}); // any assembly fault → fail open
  }
  if (!additionalContext) return emit({});

  return emit({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
  });
}

if (require.main === module) main();

module.exports = {
  parseSynapseManifest,
  manifestValue,
  domainRules,
  renderConstitution,
  renderRulesSection,
  estimateTokens,
  applyBudget,
  buildSections,
  compose,
  findInstallRoot,
};
