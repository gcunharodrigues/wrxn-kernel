#!/usr/bin/env node
'use strict';

// WRXN memory-synth — the reusable synthesis core for auto-memory (auto-memory-02).
// Sibling to dream.cjs / wiki.cjs. Self-contained: this ships INTO an install and MUST NOT import the
// kernel lib (node stdlib only). Given a task (`handoff` | `dream`), a prompt, and a transcript blob it
// resolves the engine per task (primary → fallback) and returns the synthesized text.
//
// THE ONE SEAM is the injectable engine `invoke(spec)` (default real; tests inject a fake), mirroring
// lib/protect.cjs's `defaultInvoke` + fake-invoker pattern. Every LLM / network / process-spawn call is
// behind it, so the orchestration (config resolve, primary→fallback, graceful degradation, blob build)
// is unit-tested with NO real `claude -p`, NO network, NO spawn.
//
// Engines: `claude` → `claude -p --model <id>`, prompt on stdin, `WRXN_MEMORY_SYNTH=1` in env, bounded
// timeout, the operator's CLI auth (no key). `gemini` → HTTPS POST to `…:generateContent` with
// `x-goog-api-key` from `.env` (mirrors the proven aimem-handoff-synth call). A missing key fails the
// gemini engine (→ fallback / null), never throws. Both fail → null (the caller writes nothing).
//
// Manual CLI (the slice demo, no hooks): `node .wrxn/memory-synth.cjs --task handoff <transcript> [--root <dir>]`.
// The spawn hook, session-start hold, and dream wiring land in later slices.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

// ── default tiering (PRD) ──────────────────────────────────────────────────────
// handoff + dream default to claude/claude-sonnet-4-6, falling back to gemini/gemini-3.1-flash-lite.
// The seeded memory.config.json is this object serialized; an operator edits it and `wrxn update`
// preserves it (seeded class).
const DEFAULT_TASK = {
  primary: { engine: 'claude', model: 'claude-sonnet-4-6' },
  fallback: { engine: 'gemini', model: 'gemini-3.1-flash-lite' },
};
const DEFAULTS = {
  tasks: {
    handoff: clone(DEFAULT_TASK),
    dream: clone(DEFAULT_TASK),
  },
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

const CONFIG_REL = ['.wrxn', 'memory.config.json'];

// ── task system prompts ─────────────────────────────────────────────────────────
// The handoff prompt is adapted verbatim (fidelity rules preserved) from the proven
// aimem-handoff-synth.sh: a faithful, dense, self-contained handoff for a cold next agent. The dream
// task/prompt + gate wiring land in slice 04; PROMPTS gains `dream` then.
const HANDOFF_PROMPT = `You write the HANDOFF of a work session for the NEXT AI agent (and the human) who will RESUME this work cold, with no memory of this session. Your handoff is the only bridge between the two sessions.

FIDELITY (critical):
- Use ONLY facts present in the transcript. Never invent files, decisions, numbers, commands, or paths.
- Preserve VERBATIM: file paths, commands, IDs, flags, values, proper names.
- If something is uncertain or unfinished, mark it "to confirm". Do not guess.
- Capture the REASONING and the WHY behind decisions - not just what was done - so the next agent does not re-debate or repeat dead ends.

STYLE:
- US English. Dense and factual, no fluff. Bullets > prose.
- Write for someone who saw NOTHING: explicit and self-contained.
- At most ~400 words. If the session was trivial, output only the TL;DR.

FORMAT (markdown, exactly these sections; omit one only if empty):
**TL;DR** - one sentence: where we stopped + next step.
**Goal** - what this session was trying to achieve.
**Current state** - where things stand now, concrete (what works, what's left).
**Decisions + why** - decisions made and the reason (so they aren't re-litigated).
**Files/artifacts** - created/changed, with exact path.
**Next step** - the immediate, concrete next action.
**Open / to confirm** - pending items, blockers, questions.
**Don't repeat** - dead ends already tried / gotchas discovered.`;

const PROMPTS = { handoff: HANDOFF_PROMPT };

/**
 * Load the per-task engine config from `<root>/.wrxn/memory.config.json`, merged over DEFAULTS so a
 * partial (or absent / unparseable) config still resolves every task. Never throws — a broken config
 * degrades to the defaults.
 * @param {string} root install root
 * @returns {{ tasks: object }}
 */
function loadConfig(root) {
  const cfg = clone(DEFAULTS);
  try {
    const raw = fs.readFileSync(path.join(root, ...CONFIG_REL), 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = parsed && parsed.tasks;
    if (tasks && typeof tasks === 'object') {
      for (const name of Object.keys(tasks)) {
        const t = tasks[name] || {};
        cfg.tasks[name] = cfg.tasks[name] || clone(DEFAULT_TASK);
        if (t.primary) cfg.tasks[name].primary = { ...cfg.tasks[name].primary, ...t.primary };
        if (t.fallback) cfg.tasks[name].fallback = { ...cfg.tasks[name].fallback, ...t.fallback };
      }
    }
  } catch {
    // absent / unreadable / unparseable → the defaults stand.
  }
  return cfg;
}

/**
 * Parse the install's gitignored `.env` into a flat key→value object (the PRD config/secret split:
 * config in memory.config.json, the GEMINI_API_KEY secret in .env). A minimal `KEY=value` parser —
 * blank/`#` lines skipped, `export ` prefix tolerated, surrounding quotes stripped. Never throws; an
 * absent .env yields `{}` (the gemini engine then fails → fallback / null).
 * @param {string} root install root
 * @returns {object}
 */
function loadEnv(root) {
  const env = {};
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return env;
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/**
 * Resolve a task's `{ primary, fallback }` engine pair, falling back to the default tiering for an
 * unknown task name.
 */
function resolveTask(config, task) {
  const t = (config && config.tasks && config.tasks[task]) || DEFAULTS.tasks[task] || clone(DEFAULT_TASK);
  return { primary: t.primary, fallback: t.fallback };
}

// ── transcript-blob builder ─────────────────────────────────────────────────────
// Adapted (python → node) from the proven aimem-handoff-synth.sh: one chunk per JSONL line, prefixed
// `[role] `; per content part → raw text / `[thinking] …` (≤600) / `[tool_use NAME] {input}` (≤300) /
// `[tool_result] …` (≤200). Truncation keeps the prompt-token budget bounded; malformed lines are
// skipped (never thrown on) so a partial/corrupt transcript still summarizes.
const THINK_MAX = 600;
const TOOL_USE_MAX = 300;
const TOOL_RESULT_MAX = 200;

/**
 * Build a bounded plain-text blob from a Claude Code transcript (JSONL string).
 * @param {string} jsonlText the raw transcript file contents
 * @returns {string} newline-joined `[role] …` chunks
 */
function buildTranscriptBlob(jsonlText) {
  const chunks = [];
  for (const rawLine of String(jsonlText || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = (o && o.message) || {};
    const role = (o && o.type) || m.role || '?';
    const c = m.content;
    const parts = [];
    if (typeof c === 'string') {
      parts.push(c);
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text') {
          parts.push(p.text || '');
        } else if (p.type === 'thinking') {
          parts.push('[thinking] ' + String(p.thinking || '').slice(0, THINK_MAX));
        } else if (p.type === 'tool_use') {
          parts.push(`[tool_use ${p.name || ''}] ` + JSON.stringify(p.input || {}).slice(0, TOOL_USE_MAX));
        } else if (p.type === 'tool_result') {
          let r = p.content || '';
          if (Array.isArray(r)) {
            r = r.map((x) => (x && typeof x === 'object' ? x.text || '' : '')).join(' ');
          }
          parts.push('[tool_result] ' + String(r).slice(0, TOOL_RESULT_MAX));
        }
      }
    }
    const txt = parts.filter((x) => x && x.trim()).join(' ').trim();
    if (txt) chunks.push(`[${role}] ${txt}`);
  }
  return chunks.join('\n');
}

/** Read a transcript file and build its blob; an unreadable file yields an empty blob (never throws). */
function readTranscriptBlob(transcriptPath) {
  let raw = '';
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  return buildTranscriptBlob(raw);
}

// ── engine specs (pure) ─────────────────────────────────────────────────────────
// Each engine spec is a pure execution descriptor the injectable invoker consumes. Keeping spec
// construction pure pins the `claude` arg contract and the `gemini` request shape without spawning or
// any network. Bounded timeouts keep the session-start hold short (handoff) and cap the fallback.
const CLAUDE_TIMEOUT_MS = 120000; // headless sonnet handoff/dream — generous but bounded.
const GEMINI_TIMEOUT_MS = 30000; // mirrors the proven aimem `curl -m 30` fallback.
const SENTINEL = 'WRXN_MEMORY_SYNTH'; // recursion guard: set on every engine spawn (the spawn hook no-ops when it sees it).
// 1200 (vs the aimem reference's 900): the handoff prompt self-caps at ~400 words, so the extra
// headroom is for the denser `dream` consolidation that shares this engine (lands in slice 04).
const GEMINI_MAX_OUTPUT_TOKENS = 1200;

/** Assemble the model input: the task system prompt, then the transcript blob (mirrors the reference). */
function assemblePrompt(prompt, blob) {
  return `${prompt || ''}\n\nTRANSCRIPT:\n${blob || ''}`;
}

/**
 * Build the `claude` engine spec: `claude -p --model <id>`, prompt+blob on stdin, WRXN_MEMORY_SYNTH=1
 * in env, a bounded timeout. Uses the operator's CLI auth — no key in the spec. PURE.
 */
function buildClaudeSpec({ model, prompt, blob }) {
  return {
    engine: 'claude',
    cmd: 'claude',
    args: ['-p', '--model', model],
    input: assemblePrompt(prompt, blob),
    env: { [SENTINEL]: '1' },
    timeoutMs: CLAUDE_TIMEOUT_MS,
  };
}

/**
 * Build the `gemini` engine spec: a POST to `…/v1beta/models/<model>:generateContent` with the
 * `x-goog-api-key` header, the task prompt as `system_instruction` and the blob as user content
 * (mirrors the proven aimem-handoff-synth call). PURE.
 */
function buildGeminiSpec({ model, prompt, blob, apiKey }) {
  return {
    engine: 'gemini',
    method: 'POST',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: {
      system_instruction: { parts: [{ text: prompt || '' }] },
      contents: [{ role: 'user', parts: [{ text: `TRANSCRIPT:\n${blob || ''}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
    },
    timeoutMs: GEMINI_TIMEOUT_MS,
  };
}

/**
 * Extract the model text from a Gemini `generateContent` response body
 * (`candidates[0].content.parts[0].text`). An error payload, unexpected shape, or unparseable body →
 * null, so the engine fails cleanly (→ fallback / null). PURE — pins the response contract with no
 * network round-trip.
 */
function parseGeminiResponse(bodyString) {
  try {
    const d = JSON.parse(bodyString);
    const t = d && d.candidates && d.candidates[0] && d.candidates[0].content
      && d.candidates[0].content.parts && d.candidates[0].content.parts[0]
      && d.candidates[0].content.parts[0].text;
    return typeof t === 'string' && t.trim() ? t : null;
  } catch {
    return null;
  }
}

// ── defaultInvoke: the REAL engine invoker (the production path behind the seam) ──
// Mirrors lib/protect.cjs's defaultInvoke: the single real-call site. The suite NEVER reaches here — it
// injects a fake. `claude` → spawnSync `claude -p`; `gemini` → an HTTPS POST. Both judge success by the
// engine's own signal and never throw (errors surface as `{ ok:false }`).

/** Real `claude -p` spawn. A child that never ran (ENOENT) → ok:false; else ok = exit 0, text = stdout. */
function invokeClaude(spec) {
  const r = spawnSync(spec.cmd, spec.args, {
    input: spec.input,
    env: { ...process.env, ...spec.env },
    encoding: 'utf8',
    timeout: spec.timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error && r.status == null) {
    return { ok: false, text: '', detail: r.error.code || r.error.message };
  }
  return { ok: r.status === 0, text: r.stdout || '', detail: r.status === 0 ? '' : String(r.stderr || '').trim().split('\n')[0] };
}

/** Real Gemini `generateContent` HTTPS POST (node stdlib only). Resolves `{ ok, text }`; never rejects. */
function invokeGemini(spec) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(spec.url);
    } catch {
      resolve({ ok: false, text: '', detail: 'bad url' });
      return;
    }
    const body = JSON.stringify(spec.body);
    const req = https.request(
      { method: spec.method || 'POST', hostname: u.hostname, path: u.pathname + u.search, headers: { ...spec.headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          const text = parseGeminiResponse(data);
          resolve(text ? { ok: true, text } : { ok: false, text: '', detail: `gemini http ${res.statusCode}` });
        });
      },
    );
    req.setTimeout(spec.timeoutMs || GEMINI_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, text: '', detail: e.message }));
    req.write(body);
    req.end();
  });
}

/** Dispatch the real call by engine. Tests never reach this — they inject a fake invoke. */
async function defaultInvoke(spec) {
  if (spec.engine === 'claude') return invokeClaude(spec);
  if (spec.engine === 'gemini') return invokeGemini(spec);
  return { ok: false, text: '', detail: `unknown engine ${spec.engine}` };
}

// ── synthesize: resolve engine per task, primary → fallback, return text ──────────
// PURE orchestration over the injectable invoker. Tries the task's primary engine, then its fallback;
// the first engine that returns non-empty text wins. Both fail (or no engine available) → null, so the
// caller writes nothing (fail-safe). NEVER throws — an invoker error / missing key / missing CLI is a
// per-engine failure that degrades to the next engine, then to null.

/**
 * Run a single engine through the invoker; return its text or null. A `gemini` engine with no API key
 * fails WITHOUT calling the invoker (no key → no request). An invoker that throws is caught → null.
 */
async function runEngine(engine, { prompt, blob, apiKey, invoke }) {
  if (!engine || !engine.engine) return null;
  try {
    let spec;
    if (engine.engine === 'claude') {
      spec = buildClaudeSpec({ model: engine.model, prompt, blob });
    } else if (engine.engine === 'gemini') {
      if (!apiKey) return null; // missing key fails this engine (→ fallback / null), never throws.
      spec = buildGeminiSpec({ model: engine.model, prompt, blob, apiKey });
    } else {
      return null; // unknown engine name → skip.
    }
    const r = await invoke(spec);
    const text = r && r.ok && typeof r.text === 'string' ? r.text.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Synthesize text for `task` from `prompt` + `blob`, resolving the engine per task (primary → fallback).
 * @param {{ task:string, prompt:string, blob:string, config?:object, apiKey?:string, invoke?:Function }} opts
 * @returns {Promise<string|null>} the synthesized text, or null if no engine produced any.
 */
async function synthesize({ task, prompt, blob, config, apiKey, invoke = defaultInvoke }) {
  const { primary, fallback } = resolveTask(config || DEFAULTS, task);
  for (const engine of [primary, fallback]) {
    const text = await runEngine(engine, { prompt, blob, apiKey, invoke });
    if (text) return text;
  }
  return null;
}

// ── the handoff path (auto-memory-03): stash → blob → synth → baton → clear marker ──
// What the detached SessionEnd child does. Reads the `.pending` stash for the transcript_path, builds
// the bounded blob, runs the `handoff` task through the injectable invoker, writes the baton ATOMICALLY
// (temp + rename — the continuity-doctrine single writer), then clears its markers. Markers are cleared
// on EVERY exit (success / null synthesis / trivial / fault) so SessionStart never hangs past the cap.
// A trivial/empty transcript writes nothing and spends no model call (the caller still clears markers).

const CONTINUITY_REL = ['.wrxn', 'continuity'];
const BATON = 'latest.md';
const PENDING = '.pending';
const PENDING_HANDOFF = '.pending-handoff';
// Below this many chars of blob the session is trivial/empty — write nothing, no model spend (PRD story 18).
const TRIVIAL_BLOB_MIN = 40;

function continuityPath(root, ...rel) {
  return path.join(root, ...CONTINUITY_REL, ...rel);
}

// ── secret redaction (PRD story 19) ─────────────────────────────────────────────
// A model can echo a credential it saw in the transcript into its handoff. Scrub the body before it
// becomes the durable baton. Pattern-based (high-signal vendor token shapes, JWTs incl. Bearer
// payloads, and `KEY/TOKEN/SECRET/PASSWORD=value` assignments); each match → `[REDACTED]`. Conservative
// by design: it never rewrites ordinary prose, only well-known credential shapes.
const REDACTIONS = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / refresh / server tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-style secret keys
  /\bAIza[0-9A-Za-z._-]{10,}\b/g, // Google / Gemini API keys
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/g, // JWTs (incl. Bearer payloads): the discriminating `eyJ…` header gates it
  /\bnpm_[A-Za-z0-9]{20,}\b/g, // npm publish / automation tokens (≥20 covers the 36-char granular form + variable-length CI tokens)
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PATs
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, // Stripe live/test secret keys
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, // OpenAI project-scoped keys (underscore form not caught by sk-…)
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, // PEM private-key blocks
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, // opaque Bearer tokens (non-JWT)
  /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)\b\s*[:=]\s*\S+/gi, // KEY/TOKEN/SECRET = value
];

/**
 * Redact common secret shapes from `text`, replacing each match with `[REDACTED]`. PURE. Ordinary prose
 * is preserved verbatim — only credential-looking substrings are scrubbed.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let out = String(text || '');
  for (const re of REDACTIONS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Best-effort unlink — a missing file is fine; never throws (marker cleanup must always run). */
function rmQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Read + parse the `.pending` stash the spawn hook wrote; {} if absent/corrupt (never throws). */
function readPending(root) {
  try {
    return JSON.parse(fs.readFileSync(continuityPath(root, PENDING), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * Atomically write the baton: a temp file in the same dir, then rename over latest.md (rename is atomic
 * within a filesystem, so a reader never sees a half-written baton). The temp name is unique per call.
 */
function writeBatonAtomic(root, body) {
  const dir = continuityPath(root);
  fs.mkdirSync(dir, { recursive: true });
  const tmpName = path.join(dir, `.${BATON}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpName, body);
  fs.renameSync(tmpName, path.join(dir, BATON));
}

/**
 * The synth's handoff path. Builds the blob from the stashed transcript, synthesizes the handoff, writes
 * the baton atomically, and ALWAYS clears the pending + handoff markers (success or not). A trivial blob
 * skips synthesis entirely (no model spend). The injectable invoker keeps this unit-tested with no real
 * engine. Never throws — a fault still clears the markers so session-start is released.
 * @param {{ root:string, invoke?:Function }} opts
 * @returns {Promise<{ wrote:boolean, reason?:string }>}
 */
async function runHandoff({ root, invoke = defaultInvoke }) {
  let wrote = false;
  let reason;
  try {
    const stash = readPending(root);
    const blob = stash.transcript_path ? readTranscriptBlob(stash.transcript_path) : '';
    if (blob.trim().length < TRIVIAL_BLOB_MIN) {
      reason = 'trivial'; // empty/near-empty session — write nothing, spend no model call.
    } else {
      const config = loadConfig(root);
      const apiKey = loadEnv(root).GEMINI_API_KEY;
      const safeBlob = redactSecrets(blob); // scrub BEFORE the blob egresses to the external model (claude -p / off-box gemini POST).
      const text = await synthesize({ task: 'handoff', prompt: PROMPTS.handoff, blob: safeBlob, config, apiKey, invoke });
      if (text && text.trim()) {
        const body = redactSecrets(text); // scrub secrets BEFORE the durable baton is written.
        writeBatonAtomic(root, body.endsWith('\n') ? body : body + '\n');
        wrote = true;
      } else {
        reason = 'no-engine'; // claude CLI down + no key → null; fail-safe, no baton.
      }
    }
  } catch (e) {
    reason = `error: ${(e && e.message) || e}`;
  } finally {
    // Clear the handoff gate FIRST (releases SessionStart), then the pending marker. Always runs.
    rmQuiet(continuityPath(root, PENDING_HANDOFF));
    rmQuiet(continuityPath(root, PENDING));
  }
  return reason ? { wrote, reason } : { wrote };
}

// ── manual CLI (the slice demo, no hooks) ────────────────────────────────────────
// `node .wrxn/memory-synth.cjs --task handoff <transcript-file> [--root <dir>]` → prints the
// synthesized text. Real engines run via defaultInvoke; tests inject a fake invoke + capture streams.

/** Walk up from `start` to the install root (the dir holding wrxn.install.json); null if none. */
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

/**
 * Parse the CLI args: `--from-spawn` (the detached SessionEnd-child mode), `--task <name>`,
 * `--root <dir>`, and the first positional (the transcript file for the manual demo).
 */
function parseArgs(args) {
  const parsed = { task: 'handoff', root: undefined, file: undefined, fromSpawn: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from-spawn') parsed.fromSpawn = true;
    else if (a === '--task') parsed.task = args[++i];
    else if (a === '--root') parsed.root = args[++i];
    else if (!a.startsWith('--') && parsed.file === undefined) parsed.file = a;
  }
  return parsed;
}

/**
 * The testable CLI core. Reads the transcript file → blob, resolves config + the gemini key from .env,
 * synthesizes the task's text, prints it. Returns an exit code: 0 (printed), 2 (usage / unsupported
 * task), 1 (no engine produced output). Streams + invoker are injectable so the demo is unit-tested
 * with a fake invoke (no real `claude -p`, no network).
 * @param {string[]} args CLI args (process.argv.slice(2))
 * @param {{ invoke?:Function, out?:{write:Function}, err?:{write:Function} }} [io]
 * @returns {Promise<number>} exit code
 */
async function run(args, { invoke = defaultInvoke, out = process.stdout, err = process.stderr } = {}) {
  const { task, root: rootArg, file, fromSpawn } = parseArgs(args || []);

  // The detached SessionEnd child: read the spawn-hook's stash, write the baton, clear the markers.
  // Always exits 0 (fail-safe: a missing engine / trivial session is graceful, never an error code, so
  // the background child never surfaces a failure that could matter).
  if (fromSpawn) {
    const root = rootArg || findInstallRoot() || process.cwd();
    await runHandoff({ root, invoke });
    return 0;
  }

  const prompt = PROMPTS[task];
  if (!prompt) {
    err.write(`memory-synth: unsupported task "${task}" — known tasks: ${Object.keys(PROMPTS).join(', ')}\n`);
    return 2;
  }
  if (!file) {
    err.write('Usage: node .wrxn/memory-synth.cjs --task handoff <transcript-file> [--root <dir>]\n');
    return 2;
  }
  const root = rootArg || findInstallRoot(path.dirname(path.resolve(file))) || process.cwd();
  const blob = readTranscriptBlob(file);
  const config = loadConfig(root);
  const apiKey = loadEnv(root).GEMINI_API_KEY;
  const text = await synthesize({ task, prompt, blob, config, apiKey, invoke });
  if (!text) {
    err.write('memory-synth: no engine produced output (claude CLI unavailable and no Gemini key?) — wrote nothing\n');
    return 1;
  }
  out.write(text.endsWith('\n') ? text : text + '\n');
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2), { invoke: defaultInvoke })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(String((e && e.stack) || e) + '\n');
      process.exit(1);
    });
}

module.exports = {
  DEFAULTS,
  HANDOFF_PROMPT,
  PROMPTS,
  loadConfig,
  loadEnv,
  resolveTask,
  buildTranscriptBlob,
  readTranscriptBlob,
  buildClaudeSpec,
  buildGeminiSpec,
  parseGeminiResponse,
  defaultInvoke,
  synthesize,
  runHandoff,
  redactSecrets,
  run,
};
