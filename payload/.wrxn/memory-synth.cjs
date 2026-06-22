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
**Don't repeat** - dead ends already tried / gotchas discovered.

OUTPUT (critical — this text becomes the durable handoff verbatim):
- Output ONLY the handoff document itself: start at the first "**TL;DR**" line.
- NO preamble, NO commentary, NO thinking, NO "Let me…"/"Here is…" lead-in, NO closing remarks, NO code fences around the document. Emit the markdown and nothing else.`;

// The dream task: propose durable wiki pages from the session, each grounded in a SUBSTANTIVE VERBATIM
// quote copied from the transcript. The quote rule is load-bearing: auto-dream is unattended, so the only
// thing that keeps a hallucinated "memory" out of permanent recall is dream.cjs's `--source` quote-verify
// (every quote must be a ≥12-char, ≥3-token span that appears in the transcript). We instruct the model
// explicitly so its quotes survive the gate; a quote it cannot ground verbatim must be dropped, not
// invented. Output is STRICT JSON the synth parses — no prose, no fences.
const DREAM_PROMPT = `You consolidate the DURABLE learnings of a work session into wiki pages for long-term recall. You are an UNATTENDED proposer: there is no human to approve your output, and a hardened gate will REJECT any page whose evidence quote is not literally in the transcript. Propose ONLY what you can ground verbatim.

WHAT TO PROPOSE (at most 5, fewer is better — restraint beats noise):
- A "concept" (durable how-it-works), "decision" (a choice + why it stands), "gotcha" (a non-obvious trap), or "rule" (an always/never convention).
- DURABLE only: a fact future sessions need. NEVER a one-off task, a release/version event, a smoke-test result, a transient failure, or anything about the wrxn tooling itself — the gate drops these.

EVIDENCE (critical — your page is rejected without it):
- Each proposal carries evidence: a list of { "quote": "…" }.
- Each quote MUST be a SUBSTANTIVE span copied VERBATIM from the transcript: at least 12 characters AND at least 3 words. Single words or tiny fragments ("the", "it works") are rejected.
- Copy the quote exactly as it appears; do not paraphrase, summarize, or invent. If you cannot find a real ≥3-word span that grounds a learning, DROP that learning.

If the session has no durable learning, output {"abstain": true}.

OUTPUT (STRICT JSON only — no markdown, no code fences, no commentary):
{"proposals":[{"kind":"decision","tier":"decisions","slug":"kebab-case-slug","title":"Short title","body":"# Short title\\n\\nOne or two dense paragraphs.","confidence":0.0,"rationale":"why this is durable","evidence":[{"quote":"a verbatim span of at least three words from the transcript"}]}]}
TIERS: kind "concept"→tier "concepts", "decision"→"decisions", "gotcha"→"gotchas", "rule"→"_rules". The body MUST start with "# " (its title as an H1). confidence is your 0–1 certainty; only ≥0.75 is kept.`;

const PROMPTS = { handoff: HANDOFF_PROMPT, dream: DREAM_PROMPT };

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

// ── transient-spawn retry (synth-handoff-fix-01) ────────────────────────────────
// The detached SessionEnd child's FIRST `claude -p` call after the parent session tears down
// intermittently returns no output (`ok:false`), so a single flaky call used to cost the whole handoff
// baton (the dream call moments later succeeds). We retry the engine SPAWN at this single seam, so both
// the handoff and the dream calls are hardened by one change. A transient failure returns fast, so the
// bounded retries stay well within the 180s session-start hold-cap. Only a transient `ok:false` is
// retried — the `gemini`-no-key early-out below still fails immediately (no key → no request).
const ENGINE_ATTEMPTS = 3; // total attempts (1 try + 2 retries).
const ENGINE_BACKOFF_MS = 1500; // fixed short backoff between attempts.

// The real backoff (the production path). Atomics.wait blocks without a busy-spin (node stdlib). Tests
// inject a no-op sleep and never reach this. Mirrors session-start.cjs's sleepMs.
function defaultSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable → degrade to no wait (the bounded attempt count still caps us) */
  }
}

/**
 * Run a single engine through the invoker; return `{ text, attempts }` (text null when no output). A
 * `gemini` engine with no API key fails WITHOUT calling the invoker (no key → no request, attempts 0). A
 * transient `ok:false` is retried up to ENGINE_ATTEMPTS with a fixed backoff via the injected sleep; the
 * first non-empty text wins. An invoker that throws is caught → counts as a failed attempt, then null.
 * @returns {Promise<{ text: string|null, attempts: number }>}
 */
async function runEngine(engine, { prompt, blob, apiKey, invoke, sleep = defaultSleep }) {
  if (!engine || !engine.engine) return { text: null, attempts: 0 };
  let spec;
  if (engine.engine === 'claude') {
    spec = buildClaudeSpec({ model: engine.model, prompt, blob });
  } else if (engine.engine === 'gemini') {
    if (!apiKey) return { text: null, attempts: 0 }; // missing key fails this engine (→ fallback / null), no request, no retry.
    spec = buildGeminiSpec({ model: engine.model, prompt, blob, apiKey });
  } else {
    return { text: null, attempts: 0 }; // unknown engine name → skip.
  }
  let attempts = 0;
  for (let i = 0; i < ENGINE_ATTEMPTS; i++) {
    attempts += 1;
    let text = null;
    try {
      const r = await invoke(spec);
      const t = r && r.ok && typeof r.text === 'string' ? r.text.trim() : '';
      text = t || null;
    } catch {
      text = null; // an invoker throw is a transient failure for this attempt (degrade, never throw).
    }
    if (text) return { text, attempts };
    if (i < ENGINE_ATTEMPTS - 1) sleep(ENGINE_BACKOFF_MS); // back off before the next attempt (not after the last). sleep is synchronous (Atomics.wait / injected no-op) — no await.
  }
  return { text: null, attempts };
}

/**
 * Synthesize text for `task` from `prompt` + `blob`, resolving the engine per task (primary → fallback),
 * also reporting WHICH engine produced the text and HOW MANY attempts the producing engine spent (the
 * total attempts across all engines tried when none produced output) — the diagnosability the synth log
 * records. The transient-spawn retry lives in runEngine, so both engines are hardened here.
 * @param {{ task:string, prompt:string, blob:string, config?:object, apiKey?:string, invoke?:Function, sleep?:Function }} opts
 * @returns {Promise<{ text:string|null, engine:string|null, attempts:number }>}
 */
async function synthesizeDetailed({ task, prompt, blob, config, apiKey, invoke = defaultInvoke, sleep }) {
  const { primary, fallback } = resolveTask(config || DEFAULTS, task);
  let attempts = 0;
  for (const engine of [primary, fallback]) {
    const r = await runEngine(engine, { prompt, blob, apiKey, invoke, sleep });
    attempts += r.attempts;
    if (r.text) return { text: r.text, engine: engine && engine.engine, attempts };
  }
  return { text: null, engine: null, attempts };
}

/**
 * Synthesize text for `task` from `prompt` + `blob`, resolving the engine per task (primary → fallback).
 * Thin text-only wrapper over synthesizeDetailed (preserves the slice-02/04 contract).
 * @param {{ task:string, prompt:string, blob:string, config?:object, apiKey?:string, invoke?:Function, sleep?:Function }} opts
 * @returns {Promise<string|null>} the synthesized text, or null if no engine produced any.
 */
async function synthesize(opts) {
  const { text } = await synthesizeDetailed(opts);
  return text;
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
// One outcome line per synth run lands here so a missed baton is never silent (synth-handoff-fix-01).
// Install state under .wrxn/continuity/ — gitignored by `wrxn init`, NEVER shipped in the payload manifest.
const SYNTH_LOG = '.synth.log';
// Below this many chars of blob the session is trivial/empty — write nothing, no model spend (PRD story 18).
const TRIVIAL_BLOB_MIN = 40;

function continuityPath(root, ...rel) {
  return path.join(root, ...CONTINUITY_REL, ...rel);
}

// The session id comes from the untrusted `.pending` stash (transcript-adjacent). A control char in it
// (newline/tab) would inject extra rows into the tab-separated .synth.log — forging fake outcomes and
// wrecking the log's whole purpose (trustworthy diagnosability). Strip ALL C0/C1 control chars and cap
// the length before the id enters the line. PURE and total — it never throws (so it can't break the
// best-effort log) and only touches the log field (never the baton).
const LOG_FIELD_MAX = 64;
function sanitizeLogField(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, LOG_FIELD_MAX);
}

/**
 * Append exactly one tab-separated outcome line to `.wrxn/continuity/.synth.log` — timestamp, session id
 * (or `-`), task, engine (or `-`), attempts, outcome (`wrote`|`trivial`|`no-engine`|`error…`). Best-effort
 * and FAIL-OPEN: a logging fault is swallowed so it can NEVER affect the handoff (the diagnosability log
 * must not become a new failure mode). One `appendFileSync` per run. The untrusted session id is
 * control-char-stripped + length-capped so a hostile id can't forge extra log rows.
 * @param {{ sessionId?:string, task:string, engine?:string|null, attempts?:number, outcome:string }} rec
 */
function appendSynthLog(root, { sessionId, task, engine, attempts, outcome }) {
  try {
    const dir = continuityPath(root);
    fs.mkdirSync(dir, { recursive: true });
    const id = sanitizeLogField(sessionId) || '-'; // untrusted stash value — strip control chars, cap length.
    const line = [
      new Date().toISOString(),
      id,
      task || '-',
      engine || '-',
      `attempts=${attempts || 0}`,
      outcome || '-',
    ].join('\t');
    fs.appendFileSync(path.join(dir, SYNTH_LOG), line + '\n');
  } catch {
    /* the log is best-effort — a write fault must never affect the handoff */
  }
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
 *
 * Returns the REDACTED blob it built so the caller (the --from-spawn route) can run dream on the SAME
 * in-memory transcript without re-reading the stash (auto-memory-04). It is the scrubbed blob (matching
 * what the engine saw) so a secret never re-egresses through the dream path; '' when the session was
 * trivial / had no transcript.
 * @param {{ root:string, invoke?:Function }} opts
 * @returns {Promise<{ wrote:boolean, blob:string, reason?:string }>}
 */
async function runHandoff({ root, invoke = defaultInvoke, sleep }) {
  let wrote = false;
  let reason;
  let safeBlob = ''; // the redacted blob, returned so dream can reuse it in memory (auto-memory-04).
  let engine = null; // which engine produced the baton (for the synth log).
  let attempts = 0; // total engine attempts spent (retries included) — for the synth log.
  let sessionId; // the session id from the stash, if present (for the synth log).
  try {
    const stash = readPending(root);
    sessionId = stash.session_id;
    const blob = stash.transcript_path ? readTranscriptBlob(stash.transcript_path) : '';
    if (blob.trim().length < TRIVIAL_BLOB_MIN) {
      reason = 'trivial'; // empty/near-empty session — write nothing, spend no model call.
    } else {
      const config = loadConfig(root);
      const apiKey = loadEnv(root).GEMINI_API_KEY;
      safeBlob = redactSecrets(blob); // scrub BEFORE the blob egresses to the external model (claude -p / off-box gemini POST).
      const r = await synthesizeDetailed({ task: 'handoff', prompt: PROMPTS.handoff, blob: safeBlob, config, apiKey, invoke, sleep });
      engine = r.engine;
      attempts = r.attempts;
      if (r.text && r.text.trim()) {
        const body = redactSecrets(r.text); // scrub secrets BEFORE the durable baton is written.
        writeBatonAtomic(root, body.endsWith('\n') ? body : body + '\n');
        wrote = true;
      } else {
        reason = 'no-engine'; // claude CLI down + no key → null; fail-safe, no baton.
      }
    }
  } catch (e) {
    reason = `error: ${(e && e.message) || e}`;
  } finally {
    // One outcome line per synth run, so a missed baton is never silent (best-effort/fail-open).
    appendSynthLog(root, { sessionId, task: 'handoff', engine, attempts, outcome: wrote ? 'wrote' : (reason || 'no-engine') });
    // Clear the handoff gate FIRST (releases SessionStart), then the pending marker. Always runs.
    rmQuiet(continuityPath(root, PENDING_HANDOFF));
    rmQuiet(continuityPath(root, PENDING));
  }
  return reason ? { wrote, blob: safeBlob, reason } : { wrote, blob: safeBlob };
}

// ── the dream path (auto-memory-04): blob → proposals → gate (--source) → commit ──
// What the detached SessionEnd child does AFTER the handoff baton is written (so dream never extends the
// session-start hold — the handoff marker is already cleared). Given the SAME transcript blob the handoff
// built (passed IN MEMORY, never re-read from the stash), it asks the engine for ≤5 evidence-backed dream
// proposals, then drives the EXISTING dream.cjs gate by reference:
//   1. write the blob to a temp source file + the proposals to a temp batch file;
//   2. `dream.cjs check --source <blob>` → learn the gate's accepted set (the auto-approval set);
//   3. `dream.cjs stage <accepted-batch>` → record the accepted proposals (commit is BY REFERENCE);
//   4. `dream.cjs commit --source <blob> <accepted-slugs>` → the commit RE-GATES + re-verifies every quote
//      at the write boundary and writes net-new pages additively (dedup-skip).
// Auto-approval = exactly the gate's accepted set; NO human approval step. A trivial blob, an engine
// abstain, or no proposals → write nothing. The gate (confidence floor, secret-scan, anti-superstition
// filters, dedup, ≤5, and the --source quote-verify) is honored end-to-end. NEVER throws.

const PENDING_DREAM_PREFIX = '.dream'; // temp file prefix under .wrxn/continuity for the blob + batches.

/** The sibling dream adapter in the same install .wrxn/ dir (the indirection contract — we never write wiki .md directly). */
function dreamAdapter() {
  return path.join(__dirname, 'dream.cjs');
}

/**
 * Parse the engine's dream output into a proposals array. The model is asked for STRICT JSON, but a real
 * model may wrap it in prose or ```json fences — so we extract the first balanced {...} / [...] span and
 * parse it. An `{ abstain:true }` or anything unparseable / shapeless yields [] (write nothing). PURE.
 * @param {string} text the engine output
 * @returns {Array} the proposals (possibly empty)
 */
function parseProposals(text) {
  const s = String(text || '');
  let parsed = null;
  try {
    parsed = JSON.parse(s);
  } catch {
    // tolerate prose/fences around the JSON: grab the first { … } or [ … ] span and try that.
    const start = s.search(/[[{]/);
    if (start === -1) return [];
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end <= start) return [];
    try {
      parsed = JSON.parse(s.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (parsed && typeof parsed === 'object' && parsed.abstain === true) return [];
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.proposals)) return parsed.proposals;
  return [];
}

/** Run a dream.cjs subcommand in-process-but-separate (spawnSync node), rooted at the install. Parses its
 * JSON stdout; a non-zero exit / unparseable output → null (the caller treats it as "no result"). */
function runDreamCli(root, args) {
  const r = spawnSync('node', [dreamAdapter(), ...args, '--root', root], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout || '');
  } catch {
    return null;
  }
}

/** Write a temp file under .wrxn/continuity and return its path. Unique per call (pid+time+tag). */
function writeTemp(root, tag, content) {
  const dir = continuityPath(root);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${PENDING_DREAM_PREFIX}.${tag}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(p, content);
  return p;
}

/**
 * The synth's dream path. Asks the engine for dream proposals from the in-memory blob, runs them through
 * the dream.cjs gate (check → stage accepted → commit, all `--source`-verified against the blob), and
 * returns the committed slugs. Writes nothing on a trivial blob / abstain / empty-or-rejected set. Cleans
 * up its temp files. Never throws (a fault degrades to "wrote nothing").
 * @param {{ root:string, blob:string, invoke?:Function }} opts
 * @returns {Promise<{ written:string[], reason?:string }>}
 */
async function runDream({ root, blob, invoke = defaultInvoke }) {
  const temps = [];
  try {
    if (!blob || blob.trim().length < TRIVIAL_BLOB_MIN) return { written: [], reason: 'trivial' };
    const config = loadConfig(root);
    const apiKey = loadEnv(root).GEMINI_API_KEY;
    const safeBlob = redactSecrets(blob); // scrub BEFORE the blob egresses to the external model.
    const text = await synthesize({ task: 'dream', prompt: PROMPTS.dream, blob: safeBlob, config, apiKey, invoke });
    const proposals = parseProposals(text);
    if (proposals.length === 0) return { written: [], reason: 'abstain' };

    // the --source blob the gate verifies every quote against (the SAFE blob, matching what the engine saw).
    const sourceFile = writeTemp(root, 'src', safeBlob);
    temps.push(sourceFile);
    const batchFile = writeTemp(root, 'batch', JSON.stringify({ proposals }));
    temps.push(batchFile);

    // 1. check --source → the gate's accepted set (the auto-approval set).
    const checked = runDreamCli(root, ['check', batchFile, '--source', sourceFile]);
    const accepted = (checked && Array.isArray(checked.accepted)) ? checked.accepted : [];
    if (accepted.length === 0) return { written: [], reason: 'none-accepted' };

    // 2. stage the accepted proposals (commit is BY REFERENCE — it reads staged.jsonl).
    const stageFile = writeTemp(root, 'stage', JSON.stringify({ proposals: accepted }));
    temps.push(stageFile);
    runDreamCli(root, ['stage', stageFile]);

    // 3. commit --source the accepted slugs → the commit RE-GATES + re-verifies quotes at the write boundary.
    const approvedFile = writeTemp(root, 'approved', JSON.stringify(accepted.map((p) => p.slug)));
    temps.push(approvedFile);
    const committed = runDreamCli(root, ['commit', approvedFile, '--source', sourceFile]);
    const written = (committed && Array.isArray(committed.written)) ? committed.written.map((w) => w.slug) : [];
    return { written };
  } catch (e) {
    return { written: [], reason: `error: ${(e && e.message) || e}` };
  } finally {
    for (const p of temps) rmQuiet(p);
  }
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

  // The detached SessionEnd child: read the spawn-hook's stash, write the baton, clear the markers, THEN
  // run dream on the SAME in-memory blob. Dream runs AFTER runHandoff has cleared the handoff marker, so
  // the SessionStart hold (which waits only on that marker) is already released — dream can never extend
  // it (auto-memory-04, AC5). Always exits 0 (fail-safe: a missing engine / trivial session / dream fault
  // is graceful, never an error code, so the background child never surfaces a failure that could matter).
  if (fromSpawn) {
    const root = rootArg || findInstallRoot() || process.cwd();
    const { blob } = await runHandoff({ root, invoke });
    // Reuse the redacted blob the handoff built (no re-read of the stash, which the handoff already
    // cleared). A trivial blob → runDream self-skips; the guard just avoids the needless call.
    if (blob && blob.trim().length >= TRIVIAL_BLOB_MIN) {
      await runDream({ root, blob, invoke });
    }
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
  DREAM_PROMPT,
  PROMPTS,
  loadConfig,
  loadEnv,
  resolveTask,
  buildTranscriptBlob,
  readTranscriptBlob,
  buildClaudeSpec,
  buildGeminiSpec,
  parseGeminiResponse,
  parseProposals,
  defaultInvoke,
  synthesize,
  runHandoff,
  runDream,
  redactSecrets,
  run,
};
