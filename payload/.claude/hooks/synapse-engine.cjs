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
const os = require('os');

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
    if (!t) continue;
    if (t.startsWith('-')) {
      out.push('  ' + t.replace(/^-\s*/, ''));
    } else if (out.length) {
      // A wrapped bullet's continuation line — fold it into the preceding bullet rather than drop it.
      out[out.length - 1] += ' ' + t;
    }
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

// ── token-base + forced handoff (06c) ────────────────────────────────────────────
//
// The handoff math must run on REAL token usage, not an assumed 200k (the original bug fired
// at ~37% of a 1M window). Both signals are portable into any install:
//   resident → the last assistant line's usage in the transcript (transcript_path is in the payload).
//   window   → ~/.claude.json projects[cwd].lastModelUsage KEYS carry the tagged id; [1m] ⇒ 1M else 200k.
// See memory `synapse-model-window-from-claude-json`.

// Resident tokens = the last assistant turn's input + cache_read + cache_creation (output EXCLUDED —
// it is not resident in the next prompt's context). Returns a number, or null when unreadable.
function readResidentTokens(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
      const u = msg.usage;
      return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    return null;
  } catch {
    return null;
  }
}

// The LIVE window for a session, published by the statusline. UserPromptSubmit hooks receive no
// model/context-window data, but the statusline payload carries context_window.context_window_size
// (resolved by Claude Code, refreshed every render — so it tracks a mid-session /model switch). The
// statusline writes it to a session-scoped /tmp sidecar; we read it back here by session_id.
// See statusline.sh and memory `handoff-window-defaults-200k`. Returns a positive number or null.
function readStatuslineWindow(sessionId) {
  if (!sessionId) return null;
  try {
    const p = path.join(os.tmpdir(), `claude-statusline-ctx-${sessionId}.json`);
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    const w = Number(o && o.context_window_size);
    return Number.isFinite(w) && w > 0 ? w : null;
  } catch {
    return null;
  }
}

// Model context window, resolved by an explicit precedence (issue 29 + dynamic statusline bridge).
// On [1m] sessions lastModelUsage is often EMPTY and the transcript model id lacks the [1m] tag, and
// the hook payload carries no model — so we lean on the statusline (which DOES know the live window):
//   1. env WRXN_CONTEXT_WINDOW — a positive finite number wins unconditionally (manual force).
//   2. statusline sidecar — the live per-session window; tracks mid-session model switches.
//   3. manifest CONTEXT_WINDOW — a positive finite value (when manifestText is supplied).
//   4. ~/.claude.json lastModelUsage KEYS — a [1m] tag ⇒ 1,000,000 (auto-detect, when present).
//   5. self-correcting net — resident already past the 200k default ⇒ window is necessarily larger.
//   6. fallback 200,000.
// homeDir/manifestText/sessionId/resident overrides keep it testable.
function modelWindow(cwd, homeDir, manifestText, sessionId, resident) {
  // 1. explicit env override.
  const envWin = Number(process.env.WRXN_CONTEXT_WINDOW);
  if (Number.isFinite(envWin) && envWin > 0) return envWin;

  // 2. statusline sidecar — the live, authoritative window (dynamic across /model switches).
  const scWin = readStatuslineWindow(sessionId);
  if (scWin) return scWin;

  // 3. manifest CONTEXT_WINDOW (the engine already reads scalar manifest values).
  if (manifestText != null) {
    const manWin = Number(manifestValue(manifestText, 'CONTEXT_WINDOW'));
    if (Number.isFinite(manWin) && manWin > 0) return manWin;
  }

  // 4. lastModelUsage [1m] auto-detect.
  try {
    const home = homeDir || process.env.HOME || os.homedir();
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const proj = (cfg.projects && cfg.projects[cwd]) || {};
    const keys = Object.keys(proj.lastModelUsage || {});
    if (keys.some((k) => /\[1m\]/i.test(k))) return 1000000;
  } catch {
    // fall through.
  }

  // 5. self-correcting net: resident past the 200k default ⇒ a larger (1M) window.
  if (Number.isFinite(resident) && resident > 200000) return 1000000;

  // 6. fallback.
  return 200000;
}

// Handoff threshold (fraction of the window): env WRXN_HANDOFF_PCT > manifest HANDOFF_PCT > 0.40.
function resolveHandoffPct(manifestText) {
  const env = Number(process.env.WRXN_HANDOFF_PCT);
  if (Number.isFinite(env) && env > 0) return env;
  const m = Number(manifestValue(manifestText, 'HANDOFF_PCT'));
  return Number.isFinite(m) && m > 0 ? m : 0.40;
}

// A CHEAP, fail-open presence-probe for curation debt — the debt-gate on the handoff harvest nudge
// (harvest-05). It does NOT recompute health: no recon-door query, no scan of the knowledge tiers (that
// is harvest.cjs `check`, an operator-invoked command far too heavy for a per-prompt hook). It reads ONLY
// the single latest `.wrxn/harvest/<ts>.jsonl` report a prior `check` already wrote and asks "did the last
// health-check find real debt?". Report filenames are timestamp-derived (ISO with `:`/`.` → `-`), so the
// lexically-greatest name is the newest report. A real finding = any record EXCEPT the near_dup
// "unavailable" marker (a cold-door "couldn't check", not debt); an empty report / only-unavailable / no
// reports / missing dir all read as no-debt → silent. Any fault → false (never a spurious nudge, never a
// throw). Only invoked when a handoff is actually firing, so the one extra file read is doubly bounded.
function hasCurationDebt(root) {
  try {
    const dir = path.join(root, '.wrxn', 'harvest');
    const reports = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    if (!reports.length) return false;
    const latest = reports.sort()[reports.length - 1];
    const text = fs.readFileSync(path.join(dir, latest), 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; } // a malformed line contributes nothing
      if (rec && rec.type && rec.status !== 'unavailable') return true;
    }
    return false;
  } catch {
    return false; // missing dir / unreadable report / any fault → fail-open: no debt, no throw
  }
}

// The starved-useful watchdog's EMISSION bar (kernel #15 / S4): the number of starved-useful pages at or
// above which the handoff carries the canary line. Distinct from the watchdog's MATH thresholds (R_HIGH /
// S_LOW live with the pure reward.starvedUseful) — this is the "how many before we bug the operator" bar.
// A PLACEHOLDER pending the lift gate (recorded with the gate verdict, like the decay half-life); it just
// keeps the canary quiet until a few pages have genuinely starved. Kept local so the engine never
// HARD-requires the reward sibling at module load (a missing sibling must not break constitution injection).
const STARVED_NUDGE_THRESHOLD = 3;

// The starved-useful WATCHDOG probe (kernel #15 / S4) — the sibling of hasCurationDebt for the learning
// moat. A CHEAP, fail-open, READ-ONLY read of the two STATE sidecars (.wrxn/reward.json per-page
// Beta-Bernoulli counts + .wrxn/surfaced.json per-session surfaced-log) → the pure reward.starvedUseful
// count (pages learned high-reward but rarely surfaced). The reward sibling is required LAZILY inside the
// try/catch so a (theoretically) absent sibling can never break the engine's constitution injection. Any
// fault (missing/corrupt sidecar, missing sibling) → 0 (no nudge, no throw). Only invoked when a handoff
// is actually firing, so the two extra reads are doubly bounded. CANARY: reads only — it never mutates a
// sidecar and never touches recall ranking or reward counts.
function starvedUsefulSignal(root) {
  try {
    const { starvedUseful } = require('./reward.cjs');
    const readMap = (rel) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, '.wrxn', rel), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {}; // absent / malformed → empty (fail-open)
      }
    };
    return starvedUseful(readMap('reward.json'), readMap('surfaced.json')).count;
  } catch {
    return 0; // any fault (incl. a missing reward sibling) → no signal, never a throw
  }
}

// The NON-BLOCKING forced-handoff directive (never refuses work — orders the agent to wrap up cleanly).
// `hasDebt` (harvest-05) appends a harvest curation nudge AFTER the dream line — emitted ONLY when the
// latest health-check found curation debt, so a clean knowledge set never sees it. Ordered after dream:
// dream consolidates the session first, then harvest curates the enlarged knowledge set. `starvedCount`
// (S4) appends ONE canary line LAST — emitted ONLY when the starved-useful count >= STARVED_NUDGE_THRESHOLD
// (below / omitted / garbage → silent, totality). The canary states the count and that it is (b)-pressure
// (data toward graduating a recon reward term); it is informational only and changes no recall/reward state.
function handoffDirective(consumed, pct, hasDebt, starvedCount) {
  const now = Math.round(consumed * 100);
  const thresh = Math.round(pct * 100);
  const lines = [
    '[HANDOFF REQUIRED]',
    `  Context is at ~${now}% of the model window (>= the ${thresh}% handoff threshold). NON-BLOCKING — do NOT stop work:`,
    '  1. Finish the current request.',
    '  2. Tell the operator to /clear and open a fresh session. No manual step: the continuity baton writes automatically when this session ends (the memory synth) and injects on resume.',
    '  Suggestion (optional): the session also auto-consolidates its durable learnings into wiki memory on close (auto-dream); to consolidate explicitly or mid-session, invoke the dream skill — a suggestion only, never required.',
  ];
  if (hasDebt) {
    lines.push('  Then (optional, only because the last health-check found curation debt): run the harvest skill to review the flagged near-dups / decay-candidates / malformed pages — a suggestion only; harvest never auto-deletes, every change is proposed for your confirmation.');
  }
  const starved = Number(starvedCount);
  if (Number.isFinite(starved) && starved >= STARVED_NUDGE_THRESHOLD) {
    lines.push(`  Watchdog (canary, informational): ${starved} starved-useful page(s) — learned high-reward but rarely surfaced, sitting below recon's floor where the kernel-side re-rank can't lift them. This is (b)-pressure: data toward graduating a recon reward term (option b). Informational only — nothing auto-changes; no recall or reward state is touched.`);
  }
  return lines.join('\n');
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
      sections.push({ name: 'CONSTITUTION', header: 'CONSTITUTION', text: `[CONSTITUTION] (NON-NEGOTIABLE)\n${body}`, always: true });
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

// Compose the full additionalContext for an UserPromptSubmit event at an install root, or '' to no-op.
function compose(root, event) {
  const ev = event || {};
  const { sections, manifestText } = buildSections(root, ev.prompt);
  if (!sections.length) return '';

  const always = sections.filter((s) => s.always);
  const trimmable = sections.filter((s) => !s.always);
  const { kept, trimmed } = applyBudget(trimmable, resolveBudget(manifestText));

  const out = [...always.map((s) => s.text), ...kept.map((s) => s.text)];
  if (trimmed.length) {
    out.push(`[SYNAPSE-RULES-TRIM] ${trimmed.join(', ')} dropped over the ${resolveBudget(manifestText)}-token rules budget`);
  }

  // 06c — forced handoff at >= threshold of REAL consumed context. Always-kept (outside the budget):
  // a handoff directive must never be trimmed. Silent when the token base is unreadable.
  if (ev.transcript_path) {
    const resident = readResidentTokens(ev.transcript_path);
    if (resident != null) {
      const window = modelWindow(ev.cwd || root, process.env.HOME || os.homedir(), manifestText, ev.session_id, resident);
      const consumed = resident / window;
      const pct = resolveHandoffPct(manifestText);
      if (consumed >= pct) out.push(handoffDirective(consumed, pct, hasCurationDebt(root), starvedUsefulSignal(root)));
    }
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
    additionalContext = compose(root, event);
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
  readResidentTokens,
  readStatuslineWindow,
  modelWindow,
  resolveHandoffPct,
  hasCurationDebt,
  starvedUsefulSignal,
  handoffDirective,
  STARVED_NUDGE_THRESHOLD,
};
