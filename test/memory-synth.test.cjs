'use strict';

// Tests for the auto-memory synthesis core (auto-memory-02) — payload/.wrxn/memory-synth.cjs.
// The reusable synth both later tasks (handoff, dream) call: resolve the engine per task
// (primary → fallback), invoke it, return text. Every LLM/network/spawn call is behind an
// INJECTABLE invoker (prior art: lib/protect.cjs defaultInvoke + fake; test/dream.test.cjs injected io),
// so the orchestration is unit-tested with a fake invoker — a REAL `claude -p` or Gemini call is
// NEVER issued here (same discipline as protect's tests never issuing a real `gh`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const synth = require('../payload/.wrxn/memory-synth.cjs');
const { loadManifest } = require('../lib/manifest.cjs');

const PKG_ROOT = path.join(__dirname, '..');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── config parse + defaults ───────────────────────────────────────────────────
// memory.config.json holds per-task {primary,fallback} of {engine,model}; defaults are
// gemini/gemini-3.1-flash-lite primary, claude/claude-sonnet-4-6 fallback (the shipped default tiering).

test('loadConfig returns the default tiering when no memory.config.json is present', () => {
  const root = tmp('wrxn-synth-cfg-');
  const cfg = synth.loadConfig(root);
  const handoff = synth.resolveTask(cfg, 'handoff');
  assert.deepEqual(handoff.primary, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.deepEqual(handoff.fallback, { engine: 'claude', model: 'claude-sonnet-4-6' });
  const dream = synth.resolveTask(cfg, 'dream');
  assert.deepEqual(dream.primary, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.deepEqual(dream.fallback, { engine: 'claude', model: 'claude-sonnet-4-6' });
});

test('loadConfig deep-merges a partial operator override over the defaults so every task still resolves both engines', () => {
  const root = tmp('wrxn-synth-cfg-merge-');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  // an operator overrides ONE field of ONE task — just the handoff primary model.
  fs.writeFileSync(
    path.join(root, '.wrxn', 'memory.config.json'),
    JSON.stringify({ tasks: { handoff: { primary: { model: 'gemini-3.1-pro' } } } }),
  );

  const cfg = synth.loadConfig(root);

  // the overridden field wins; the rest of that pair keeps its default (engine unchanged).
  const handoff = synth.resolveTask(cfg, 'handoff');
  assert.deepEqual(handoff.primary, { engine: 'gemini', model: 'gemini-3.1-pro' }, 'override merges over the default primary');
  assert.deepEqual(handoff.fallback, { engine: 'claude', model: 'claude-sonnet-4-6' }, 'the un-touched fallback survives');

  // a task the operator never mentioned is still fully resolved from the defaults.
  const dream = synth.resolveTask(cfg, 'dream');
  assert.deepEqual(dream.primary, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.deepEqual(dream.fallback, { engine: 'claude', model: 'claude-sonnet-4-6' });
});

// ── transcript-blob builder ─────────────────────────────────────────────────────
// Adapted from the proven aimem-handoff-synth.sh python: one chunk per JSONL line, prefixed `[role] `;
// content parts become text / `[thinking] …` (≤600) / `[tool_use NAME] {input}` (≤300) /
// `[tool_result] …` (≤200). Malformed lines are skipped, never thrown on.

test('buildTranscriptBlob renders prompts + assistant text + thinking + tool_use + tool_result, one chunk per line', () => {
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'weighing options' },
          { type: 'text', text: 'Here is the answer' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'file output here' }] }] },
    }),
  ].join('\n');

  const blob = synth.buildTranscriptBlob(jsonl);
  const lines = blob.split('\n');
  assert.equal(lines[0], '[user] do the thing');
  assert.match(lines[1], /^\[assistant\] /);
  assert.match(lines[1], /\[thinking\] weighing options/);
  assert.match(lines[1], /Here is the answer/);
  assert.match(lines[1], /\[tool_use Bash\] \{"command":"ls"\}/);
  assert.equal(lines[2], '[user] [tool_result] file output here');
});

test('buildTranscriptBlob truncates a long thinking block to keep tokens bounded, and skips malformed lines', () => {
  const long = 'A'.repeat(1000);
  const jsonl = [
    'not json at all',
    '',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: long }] } }),
  ].join('\n');

  const blob = synth.buildTranscriptBlob(jsonl);
  const chunks = blob.split('\n').filter(Boolean);
  assert.equal(chunks.length, 1, 'the non-JSON and empty lines are skipped, never thrown on');
  assert.ok(blob.includes('A'.repeat(600)), 'the first 600 chars of thinking are kept');
  assert.ok(!blob.includes('A'.repeat(601)), 'thinking is truncated at 600 chars');
});

// ── claude engine: arg construction (pure spec) ─────────────────────────────────
// `claude -p --model <id>`, the prompt+blob on stdin, WRXN_MEMORY_SYNTH=1 in env (the recursion
// sentinel), a bounded timeout, the operator's CLI auth (NO key). The spec is pure so the contract is
// pinned without spawning anything.

test('buildClaudeSpec constructs `claude -p --model <id>` with prompt+blob on stdin and the recursion sentinel', () => {
  const spec = synth.buildClaudeSpec({ model: 'claude-sonnet-4-6', prompt: 'SYSTEM PROMPT', blob: 'the session' });
  assert.equal(spec.engine, 'claude');
  assert.equal(spec.cmd, 'claude');
  assert.deepEqual(spec.args, ['-p', '--model', 'claude-sonnet-4-6']);
  assert.ok(spec.input.includes('SYSTEM PROMPT'), 'the system prompt is on stdin');
  assert.ok(spec.input.includes('the session'), 'the transcript blob is on stdin');
  assert.equal(spec.env.WRXN_MEMORY_SYNTH, '1', 'the recursion sentinel is set on the spawn env');
  assert.ok(typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0, 'a bounded timeout is set');
  assert.ok(!('x-goog-api-key' in (spec.headers || {})) && !spec.apiKey, 'no API key — claude uses CLI auth');
});

// ── gemini engine: request shape (pure spec) ────────────────────────────────────
// Mirrors the proven aimem-handoff-synth.sh call: POST to `…/v1beta/models/<model>:generateContent`
// with the `x-goog-api-key` header, system_instruction = the task prompt, user content = the blob.

test('buildGeminiSpec POSTs to <model>:generateContent with x-goog-api-key and the blob as user content', () => {
  const spec = synth.buildGeminiSpec({ model: 'gemini-3.1-flash-lite', prompt: 'SYSTEM PROMPT', blob: 'the session', apiKey: 'KEY-123' });
  assert.equal(spec.engine, 'gemini');
  assert.equal(spec.method, 'POST');
  assert.equal(
    spec.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
    'the generateContent endpoint carries the configured model',
  );
  assert.equal(spec.headers['x-goog-api-key'], 'KEY-123', 'the key rides the x-goog-api-key header (mirrors aimem)');
  assert.equal(spec.headers['Content-Type'], 'application/json');
  assert.equal(spec.body.system_instruction.parts[0].text, 'SYSTEM PROMPT', 'the task prompt is the system instruction');
  assert.equal(spec.body.contents[0].role, 'user');
  assert.ok(spec.body.contents[0].parts[0].text.includes('the session'), 'the transcript blob is the user content');
  assert.ok(spec.body.generationConfig && typeof spec.body.generationConfig.maxOutputTokens === 'number', 'output is bounded');
  assert.ok(typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0, 'a bounded timeout is set');
});

// ── synthesize: primary → fallback selection through the INJECTABLE invoker ───────
// The one seam. The fake records every spec it receives and returns canned text per engine — NO real
// `claude -p`, NO network, NO spawn ever runs in the suite.

function fakeInvoke(byEngine) {
  const calls = [];
  const invoke = async (spec) => {
    calls.push(spec);
    const r = byEngine[spec.engine];
    return typeof r === 'function' ? r(spec) : r || { ok: false };
  };
  return { invoke, calls };
}

const DEFAULT_CFG = synth.DEFAULTS;

// A no-op injected sleep so the transient-spawn retry (synth-handoff-fix-01) runs instantly here — a
// failing engine is now retried before fallback, so these contract tests inject the sleep to stay fast.
const noSleep = () => {};

test('synthesize falls back to the secondary engine when the primary fails, in order', async () => {
  const { invoke, calls } = fakeInvoke({ gemini: { ok: false }, claude: { ok: true, text: 'FALLBACK HANDOFF' } });
  const text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.equal(text, 'FALLBACK HANDOFF', 'the fallback engine text is returned');
  // gemini is exhausted (it is retried on a transient failure) BEFORE claude is reached, and claude wins.
  const seq = calls.map((c) => c.engine);
  const firstClaude = seq.indexOf('claude');
  assert.ok(firstClaude > 0, 'claude (the fallback) is tried, and only after gemini');
  assert.ok(seq.slice(0, firstClaude).every((e) => e === 'gemini'), 'every attempt before the fallback was the gemini primary');
  assert.equal(seq[seq.length - 1], 'claude', 'the fallback engine is the last one tried');
});

test('synthesize short-circuits on a successful primary — the fallback is never attempted', async () => {
  const { invoke, calls } = fakeInvoke({ gemini: { ok: true, text: 'PRIMARY HANDOFF' }, claude: { ok: true, text: 'FB' } });
  const text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke });
  assert.equal(text, 'PRIMARY HANDOFF');
  assert.deepEqual(calls.map((c) => c.engine), ['gemini'], 'no fallback call once the primary returns text');
});

// ── task-aware engine success (#50): the dream fallback fires on UNUSABLE primary output ─────────
// A dream PRIMARY returning non-empty-but-unparseable prose must NOT "win": the gate would parse zero
// proposals from it and write nothing while a healthy fallback sat unused. Engine success is task-aware —
// dream output is usable only if the gate (parseProposals) reads ≥1 proposal (or it's an explicit abstain),
// so an unusable primary exhausts its retries and synthesizeDetailed advances to the fallback. Handoff
// stays permissive: any non-empty text is a usable handoff, so it short-circuits on the primary as before.

const DREAM_PROSE = 'Here is a prose summary of the session with no structured proposals whatsoever.';
const DREAM_JSON = JSON.stringify({ proposals: [{ slug: 'log-with-pino' }] });

test('dream falls back when the primary returns unusable (unparseable) text — the fallback JSON reaches the caller', async () => {
  // apiKey set so the gemini PRIMARY actually runs (and returns prose); the claude FALLBACK returns valid JSON.
  const { invoke, calls } = fakeInvoke({ gemini: { ok: true, text: DREAM_PROSE }, claude: { ok: true, text: DREAM_JSON } });
  const text = await synth.synthesize({ task: 'dream', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.equal(text, DREAM_JSON, 'the fallback engine valid proposals-JSON is what the caller receives (the prose primary did NOT win)');
  assert.ok(synth.parseProposals(text).length > 0, 'and the returned text parses to ≥1 proposal');
  // the gemini primary was attempted (and rejected) and the claude fallback was reached last.
  const seq = calls.map((c) => c.engine);
  assert.ok(seq.includes('gemini'), 'the prose primary was attempted first');
  assert.equal(seq[seq.length - 1], 'claude', 'the fallback engine is the last one tried');
});

test('handoff stays permissive (#50): a non-empty primary short-circuits — no fallback, even for prose', async () => {
  const { invoke, calls } = fakeInvoke({ gemini: { ok: true, text: DREAM_PROSE }, claude: { ok: true, text: 'FB' } });
  const text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.equal(text, DREAM_PROSE, 'any non-empty primary text is a usable handoff — it wins');
  assert.deepEqual(calls.map((c) => c.engine), ['gemini'], 'the handoff never reaches the fallback (permissive, unchanged)');
});

// ── #52: the dream abstain check is STRUCTURED, not a bare-word substring ─────────
// The dream validator used to accept ANY text containing "abstain" (a broad /abstain/i substring), so a
// model that merely WROTE the word in prose would "win" as an abstain while the gate parsed zero proposals.
// Tightened to a structured signal (isAbstain — the text must actually carry {abstain:true}, mirroring
// parseProposals' first-balanced-JSON-span extraction). Bare-word prose is therefore UNUSABLE → it exhausts
// the primary and the fallback is reached, exactly like any other unparseable output. A real structured
// abstain still validates (a deliberate "nothing to record" must NOT churn the fallback).
const DREAM_ABSTAIN_PROSE = 'On reflection I will abstain from recording anything durable this session.';
const DREAM_ABSTAIN_JSON = JSON.stringify({ abstain: true });

test('dream does NOT treat the bare word "abstain" in prose as a valid answer — it falls through to the fallback (#52)', async () => {
  // OLD behavior (broad /abstain/i): the prose "wins" as an abstain and the fallback is never reached.
  const { invoke, calls } = fakeInvoke({ gemini: { ok: true, text: DREAM_ABSTAIN_PROSE }, claude: { ok: true, text: DREAM_JSON } });
  const text = await synth.synthesize({ task: 'dream', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.equal(text, DREAM_JSON, 'bare-word "abstain" prose is unusable → the fallback JSON reaches the caller');
  const seq = calls.map((c) => c.engine);
  assert.equal(seq[seq.length - 1], 'claude', 'the fallback was reached (the prose did NOT validate as a structured abstain)');
});

test('dream treats a STRUCTURED {abstain:true} as a valid answer — no fallback churn (#52)', async () => {
  const { invoke, calls } = fakeInvoke({ gemini: { ok: true, text: DREAM_ABSTAIN_JSON }, claude: { ok: true, text: DREAM_JSON } });
  const text = await synth.synthesize({ task: 'dream', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.equal(text, DREAM_ABSTAIN_JSON, 'a real structured abstain validates on the primary');
  assert.deepEqual(calls.map((c) => c.engine), ['gemini'], 'a structured abstain short-circuits — the fallback is never reached');
});

test('isAbstain accepts ONLY a structured abstain (clean / fenced / prose-wrapped), never the bare word (#52)', () => {
  assert.equal(synth.isAbstain(DREAM_ABSTAIN_JSON), true, 'a clean {abstain:true} is an abstain');
  assert.equal(synth.isAbstain('```json\n{"abstain": true}\n```'), true, 'a fenced structured abstain is an abstain');
  assert.equal(synth.isAbstain('No durable learnings this time.\n{"abstain":true}'), true, 'a prose-wrapped structured abstain is an abstain');
  assert.equal(synth.isAbstain(DREAM_ABSTAIN_PROSE), false, 'the bare word "abstain" in prose is NOT a structured abstain');
  assert.equal(synth.isAbstain('{"abstain": false}'), false, '{abstain:false} is not an abstain');
  assert.equal(synth.isAbstain('[{"abstain":true}]'), false, 'an array is not an abstain object');
  assert.equal(synth.isAbstain(''), false, 'empty text is not an abstain');
  assert.equal(synth.isAbstain('plain prose, no json at all'), false, 'no JSON span → not an abstain');
  assert.doesNotThrow(() => synth.isAbstain(null), 'total — never throws on a non-string');
});

// ── graceful degradation: missing CLI / missing key / invoker error → null (never throws) ──

test('synthesize degrades to null when the CLI is unavailable AND there is no key — and never issues a keyless gemini call', async () => {
  const { invoke, calls } = fakeInvoke({ claude: { ok: false }, gemini: { ok: true, text: 'WOULD-LEAK' } });
  let text;
  await assert.doesNotReject(async () => {
    text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: undefined, invoke, sleep: noSleep });
  });
  assert.equal(text, null, 'no engine available → null, so the caller writes nothing');
  // gemini (the keyless primary) is NEVER reached without a key (no key → no request); only the claude fallback is exhausted (retried).
  assert.ok(calls.length >= 1 && calls.every((c) => c.engine === 'claude'), 'only the claude fallback is ever invoked; gemini (the keyless primary) is never invoked without an API key');
});

test('synthesize never throws when an engine invoker throws — it degrades to the next engine, then to null', async () => {
  const boom = () => { throw new Error('network down'); };
  const { invoke } = fakeInvoke({ claude: boom, gemini: boom });
  let text;
  await assert.doesNotReject(async () => {
    text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  });
  assert.equal(text, null);
});

// ── .env read: the gemini key lives in a gitignored .env (PRD config/secret split) ──

test('loadEnv reads GEMINI_API_KEY from the install .env — undefined when absent, never throws', () => {
  const root = tmp('wrxn-synth-env-');
  assert.equal(synth.loadEnv(root).GEMINI_API_KEY, undefined, 'no .env → no key (gemini engine then fails → fallback/null)');
  fs.writeFileSync(path.join(root, '.env'), '# my secrets\nGEMINI_API_KEY=secret-xyz\nOTHER=ignored\n');
  assert.equal(synth.loadEnv(root).GEMINI_API_KEY, 'secret-xyz', 'the key is parsed from .env');
});

// ── gemini response contract (pure) — extract text without a real network round-trip ──

test('parseGeminiResponse pulls candidates[0].content.parts[0].text; an error/junk body → null', () => {
  const ok = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'HELLO FROM GEMINI' }] } }] });
  assert.equal(synth.parseGeminiResponse(ok), 'HELLO FROM GEMINI');
  assert.equal(synth.parseGeminiResponse('not json at all'), null, 'unparseable body → null (engine fails → fallback)');
  assert.equal(synth.parseGeminiResponse(JSON.stringify({ error: { code: 403, message: 'no key' } })), null, 'an API error payload → null');
});

// ── manual CLI: the slice demo (a transcript file + task → printed handoff), fake invoke ──

test('run() prints the synthesized handoff for a transcript file, feeding the engine the handoff prompt + blob', async () => {
  const root = tmp('wrxn-synth-cli-');
  const tx = path.join(root, 'session.jsonl');
  fs.writeFileSync(tx, JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship the engine layer' } }) + '\n');

  let printed = '';
  const out = { write: (s) => { printed += s; } };
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: '**TL;DR** resumed at the engine layer' } });

  const code = await synth.run(['--task', 'handoff', tx, '--root', root], { invoke, out, err: out });
  assert.equal(code, 0, 'exit 0 on a successful synthesis');
  assert.match(printed, /TL;DR/, 'the synthesized handoff is printed to stdout');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].input.includes('HANDOFF'), 'the engine is fed the handoff system prompt');
  assert.ok(calls[0].input.includes('ship the engine layer'), 'the engine is fed the transcript blob');
});

test('run() exits 2 on a missing transcript file and on an unknown task (dream is now wired, slice 04)', async () => {
  let errd = '';
  const sink = { write: (s) => { errd += s; } };
  const noCall = { invoke: async () => { throw new Error('engine must not be reached on a usage error'); }, out: sink, err: sink };

  assert.equal(await synth.run(['--task', 'handoff'], noCall), 2, 'no transcript file → usage error');
  assert.match(errd, /Usage/);

  // `dream` is a known task as of slice 04; an UNKNOWN task name still exits 2 (the unsupported-task guard).
  errd = '';
  assert.equal(await synth.run(['--task', 'harvest', '/tmp/whatever.jsonl'], noCall), 2, 'an unknown task → unsupported task');
  assert.match(errd, /unsupported task "harvest"/);
});

test('run() exits 1 and prints nothing when no engine produces output (fail-safe demo)', async () => {
  const root = tmp('wrxn-synth-cli-noeng-');
  const tx = path.join(root, 's.jsonl');
  fs.writeFileSync(tx, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
  let printed = '';
  let errd = '';
  const { invoke } = fakeInvoke({ claude: { ok: false }, gemini: { ok: false } }); // claude CLI down + no .env key → gemini skipped → null
  const code = await synth.run(['--task', 'handoff', tx, '--root', root], {
    invoke,
    out: { write: (s) => { printed += s; } },
    err: { write: (s) => { errd += s; } },
  });
  assert.equal(code, 1);
  assert.equal(printed, '', 'nothing is written to stdout when synthesis yields nothing');
  assert.match(errd, /no engine produced output/);
});

// ── seeded config + manifest registration (managed-integrity stays consistent) ──

test('the seeded payload memory.config.json parses to the default tiering', () => {
  const seeded = path.join(PKG_ROOT, 'payload', '.wrxn', 'memory.config.json');
  assert.ok(fs.existsSync(seeded), 'the seeded config ships in the payload');
  const root = tmp('wrxn-synth-seed-');
  fs.mkdirSync(path.join(root, '.wrxn'), { recursive: true });
  fs.copyFileSync(seeded, path.join(root, '.wrxn', 'memory.config.json'));
  const handoff = synth.resolveTask(synth.loadConfig(root), 'handoff');
  assert.deepEqual(handoff.primary, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
  assert.deepEqual(handoff.fallback, { engine: 'claude', model: 'claude-sonnet-4-6' });
});

test('the manifest registers memory-synth.cjs (managed) and memory.config.json (seeded, preserved on update)', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const byPath = (p) => manifest.files.find((f) => f.path === p);

  const adapter = byPath('.wrxn/memory-synth.cjs');
  assert.ok(adapter, 'the synth adapter is registered');
  assert.equal(adapter.class, 'managed', 'the adapter is managed (overwritten on update)');
  assert.equal(adapter.profile, 'project');

  const cfg = byPath('.wrxn/memory.config.json');
  assert.ok(cfg, 'the config is registered');
  assert.equal(cfg.class, 'seeded', 'the config is seeded — an operator edit survives wrxn update');
  assert.equal(cfg.profile, 'project');
});

test('.env.example ships in the payload, documents GEMINI_API_KEY, and is loadEnv-parseable', () => {
  const example = path.join(PKG_ROOT, 'payload', '.env.example');
  assert.ok(fs.existsSync(example), '.env.example ships in the payload');
  const body = fs.readFileSync(example, 'utf8');
  assert.match(body, /^GEMINI_API_KEY=/m, 'it documents the GEMINI_API_KEY the gemini synth engine reads');
  // it is parseable by the same loadEnv the synth uses to read the real .env (the config/secret split).
  const root = tmp('wrxn-env-example-');
  fs.copyFileSync(example, path.join(root, '.env'));
  assert.ok('GEMINI_API_KEY' in synth.loadEnv(root), 'loadEnv parses the documented key (KEY=value, # comments ok)');
});

test('the manifest registers .env.example (managed, project) so init/update lay it', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.env.example');
  assert.ok(entry, '.env.example is registered in the manifest');
  assert.equal(entry.class, 'managed', '.env.example is managed (refreshed on update)');
  assert.equal(entry.profile, 'project');
});

// ── thinking-model robustness (#30): thinkingConfig + thought-part + output cap + 400 retry ──
// The gemini engine must work with BOTH thinking-default and non-thinking models, with no per-model code
// change. Four hardenings, all behind the existing invoke seam (NO real network): disable thinking by
// default (thinkingConfig.thinkingBudget=0), skip dropped `thought` parts in the parser, raise the output
// cap, and retry-without-thinkingConfig for forced-thinking models that reject the directive (HTTP 400).

// AC2 + AC6 — parseGeminiResponse stays pure + total: it EXCLUDES any `thought` part and concatenates the
// text of the REMAINING parts (not just parts[0]), so a model that emits its reasoning as a separate thought
// part first still yields the answer. Unexpected shapes / no answer text → null, never throws.
test('parseGeminiResponse excludes thought parts and concatenates the remaining answer parts (#30)', () => {
  // a thought part FIRST (the answer is parts[1]) — the old parts[0] reader would have returned the reasoning.
  const thoughtFirst = JSON.stringify({
    candidates: [{ content: { parts: [{ thought: true, text: 'let me reason about this' }, { text: 'THE ANSWER' }] } }],
  });
  assert.equal(synth.parseGeminiResponse(thoughtFirst), 'THE ANSWER', 'the thought part is dropped; only the answer is returned');

  // a multi-part answer (split across parts) is concatenated whole, not truncated to parts[0].
  const multi = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'AB' }, { text: 'CD' }] } }] });
  assert.equal(synth.parseGeminiResponse(multi), 'ABCD', 'all non-thought answer parts are concatenated');

  // a response that is ONLY a thought (no answer text) → null (no usable answer).
  const thoughtOnly = JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: 'only reasoning, no answer' }] } }] });
  assert.equal(synth.parseGeminiResponse(thoughtOnly), null, 'a thought-only response yields no answer → null');

  // total: missing parts / junk still → null (never throws).
  assert.equal(synth.parseGeminiResponse(JSON.stringify({ candidates: [{ content: {} }] })), null, 'missing parts → null');
  assert.equal(synth.parseGeminiResponse('not json'), null, 'unparseable → null, never throws');
});

// AC1 + AC4 + the AC3 testability seam — buildGeminiSpec disables thinking by DEFAULT
// (generationConfig.thinkingConfig.thinkingBudget=0: a verified HTTP-200 no-op on non-thinking models,
// disables thinking on thinking-default ones), and can OMIT the directive (thinkingBudget:null, #59) so the
// AC3 retry can re-issue the request for a forced-thinking model that rejects thinkingConfig.
test('buildGeminiSpec sets thinkingConfig.thinkingBudget=0 by default and omits it when thinkingBudget:null (#30/#59)', () => {
  const on = synth.buildGeminiSpec({ model: 'm', prompt: 'P', blob: 'B', apiKey: 'K' });
  assert.deepEqual(on.body.generationConfig.thinkingConfig, { thinkingBudget: 0 }, 'thinking is disabled by default');
  // the existing knobs are preserved alongside the new directive (no regression to temperature / cap).
  assert.equal(on.body.generationConfig.temperature, 0.2, 'temperature is preserved');
  assert.ok(typeof on.body.generationConfig.maxOutputTokens === 'number', 'the output cap is still set');

  const off = synth.buildGeminiSpec({ model: 'm', prompt: 'P', blob: 'B', apiKey: 'K', thinkingBudget: null });
  assert.ok(!('thinkingConfig' in off.body.generationConfig), 'thinkingBudget:null omits thinkingConfig (the AC3 retry-without path)');
});

// AC1 + AC5(c) — the output cap is raised so reasoning tokens + a rich dream JSON (~4.3k chars observed) no
// longer truncate the answer (1200 truncated even a non-thinking model on a dense session).
test('buildGeminiSpec raises the output cap past the old 1200 so a rich answer is not truncated (#30)', () => {
  const spec = synth.buildGeminiSpec({ model: 'm', prompt: 'P', blob: 'B', apiKey: 'K' });
  assert.ok(spec.body.generationConfig.maxOutputTokens >= 4096, 'the output cap is at least 4096 (was 1200)');
});

// ── #59: buildGeminiSpec reads PER-ENGINE reasoning config (thinkingBudget + maxOutputTokens) ──
// #30's hardcoded thinkingConfig:{thinkingBudget:0} + global cap are generalized to per-engine params, so a
// task can run ANY budget (0 off / -1 dynamic / N>0 bounded) and size its own output cap. A NUMBER sets
// generationConfig.thinkingConfig.thinkingBudget (incl 0 and -1); an ABSENT budget defaults to 0 (preserves
// #30's safe default); an explicit `null` OMITS thinkingConfig (the AC3 retry-without path). This REPLACES
// the old `thinking:boolean` param.
test('buildGeminiSpec carries a per-engine thinkingBudget (0/-1/N), defaults absent to 0, omits on null, and honors maxOutputTokens (#59)', () => {
  const gc = (args) => synth.buildGeminiSpec({ model: 'm', prompt: 'P', blob: 'B', apiKey: 'K', ...args }).body.generationConfig;

  assert.equal(gc({ thinkingBudget: -1 }).thinkingConfig.thinkingBudget, -1, 'dynamic reasoning (-1) flows through');
  assert.equal(gc({ thinkingBudget: 0 }).thinkingConfig.thinkingBudget, 0, 'reasoning off (0) flows through');
  assert.equal(gc({ thinkingBudget: 256 }).thinkingConfig.thinkingBudget, 256, 'a bounded budget (N>0) flows through');
  assert.equal(gc({}).thinkingConfig.thinkingBudget, 0, 'an ABSENT thinkingBudget defaults to 0 (preserves #30 safe default)');
  assert.ok(!('thinkingConfig' in gc({ thinkingBudget: null })), 'an explicit null OMITS thinkingConfig (the AC3 retry-without path)');

  assert.equal(gc({ maxOutputTokens: 8192 }).maxOutputTokens, 8192, 'the configured output cap flows through');
  assert.equal(gc({}).maxOutputTokens, 4096, 'an absent maxOutputTokens defaults to 4096');
  assert.equal(gc({ thinkingBudget: -1 }).temperature, 0.2, 'temperature is preserved');
});

// AC3 (real-invoker contract) — the real Gemini invoker must emit a DISTINGUISHABLE signal when the model
// rejects the thinkingConfig directive (HTTP 400 mentioning thinking), so the orchestration knows to retry
// WITHOUT it. parseGeminiResult is the pure status-aware classifier invokeGemini uses, unit-tested with no
// network: a 200 with text → ok; a 400-thinking body → thinkingUnsupported; any other failure → plain ok:false.
test('parseGeminiResult flags a 400 thinking-unsupported body and stays a plain failure otherwise (#30)', () => {
  const okBody = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'HELLO' }] } }] });
  assert.deepEqual(synth.parseGeminiResult(200, okBody), { ok: true, text: 'HELLO' }, 'a 200 with text → ok');

  const tb = JSON.stringify({ error: { code: 400, message: 'Thinking budget is not supported by this model.' } });
  const r = synth.parseGeminiResult(400, tb);
  assert.equal(r.ok, false);
  assert.equal(r.thinkingUnsupported, true, 'a 400 thinking-unsupported body is flagged for the retry-without path');

  // a non-thinking 400 (or any other error) is a PLAIN failure — never mis-flagged as thinking-unsupported.
  const other = synth.parseGeminiResult(400, JSON.stringify({ error: { code: 400, message: 'invalid argument: bad blob' } }));
  assert.equal(other.ok, false);
  assert.ok(!other.thinkingUnsupported, 'an unrelated 400 is not flagged thinking-unsupported');
  assert.equal(synth.parseGeminiResult(403, JSON.stringify({ error: { message: 'no key' } })).thinkingUnsupported, undefined, 'a 403 is a plain failure');
});

// AC3 + AC5(b) — a forced-thinking model that rejects thinkingConfig still SUCCEEDS: the gemini branch
// issues the thinking spec, sees the thinkingUnsupported signal, rebuilds WITHOUT thinkingConfig, and issues
// once more — that second call wins, no fallback needed, no throw. Simulated entirely behind the fake invoke.
test('synthesize retries without thinkingConfig when the model rejects it, and succeeds (#30)', async () => {
  // the fake simulates a forced-thinking model: any spec carrying thinkingConfig → 400 thinking-unsupported;
  // the SAME request without thinkingConfig → the real answer.
  const geminiThinkingGate = (answer) => (spec) => {
    const sentThinking = !!(spec.body && spec.body.generationConfig && spec.body.generationConfig.thinkingConfig);
    return sentThinking ? { ok: false, thinkingUnsupported: true } : { ok: true, text: answer };
  };
  const { invoke, calls } = fakeInvoke({ gemini: geminiThinkingGate('**TL;DR** resumed despite forced thinking') });

  let text;
  await assert.doesNotReject(async () => {
    text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  });
  assert.match(text, /TL;DR/, 'the retry-without-thinkingConfig call produced the answer');

  // the FIRST gemini call carried thinkingConfig (rejected); a SECOND omitted it (won) — claude never reached.
  const geminiCalls = calls.filter((c) => c.engine === 'gemini');
  assert.ok(geminiCalls.length >= 2, 'a second gemini call was issued');
  assert.ok(geminiCalls[0].body.generationConfig.thinkingConfig, 'the first gemini call carried thinkingConfig');
  assert.ok(!geminiCalls[1].body.generationConfig.thinkingConfig, 'the retry omitted thinkingConfig');
  assert.ok(!calls.some((c) => c.engine === 'claude'), 'the retry-without succeeded, so the claude fallback was never reached');
});

// AC1 — a thinking-default model returns USABLE output via synthesize(): with thinking disabled it emits a
// COMPLETE handoff (starts **TL;DR) and a COMPLETE dream JSON the gate parses (parseProposals>0). The fake
// encodes the live precondition — a thinking-default model only returns full output when thinkingBudget=0 was
// sent (without it the answer truncates) — so this is red until buildGeminiSpec disables thinking by default.
test('AC1: with thinking disabled, a thinking-default model yields a complete handoff and a parseable dream (#30)', async () => {
  const handoff = '**TL;DR** shipped the engine fix; next is the rollout.';
  const dreamJson = JSON.stringify({ proposals: [{ kind: 'decision', tier: 'decisions', slug: 's', title: 'T', body: '# T', confidence: 0.9, evidence: [{ quote: 'a verbatim span here' }] }] });
  const gemini = (spec) => {
    const gc = spec.body.generationConfig;
    const disabled = gc.thinkingConfig && gc.thinkingConfig.thinkingBudget === 0;
    if (!disabled) return { ok: true, text: 'tiny' }; // a thinking-default model truncates when thinking is NOT disabled.
    return { ok: true, text: spec.body.system_instruction.parts[0].text.includes('HANDOFF') ? handoff : dreamJson };
  };
  const { invoke } = fakeInvoke({ gemini });

  const h = await synth.synthesize({ task: 'handoff', prompt: synth.PROMPTS.handoff, blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.ok(h.startsWith('**TL;DR'), 'the handoff is complete and starts at the TL;DR (thinking was disabled)');

  const d = await synth.synthesize({ task: 'dream', prompt: synth.PROMPTS.dream, blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke, sleep: noSleep });
  assert.ok(synth.parseProposals(d).length > 0, 'the dream output is complete and parses to ≥1 proposal (no truncation)');
});

// ── #59: the per-engine reasoning config flows config → runEngine → the gemini spec ──
// The resolved engine's thinkingBudget + maxOutputTokens must reach the ACTUAL gemini request. Captured via
// the fake-invoke seam: a configured task yields a spec carrying the configured values; an engine that omits
// the fields falls back (thinkingBudget→0, maxOutputTokens→4096) — the absent-field default, end to end.
test('the per-engine thinkingBudget + maxOutputTokens flow from task config through runEngine into the gemini spec (#59)', async () => {
  const cfgWith = {
    tasks: {
      handoff: {
        primary: { engine: 'gemini', model: 'gemini-3.5-flash', thinkingBudget: -1, maxOutputTokens: 8192 },
        fallback: { engine: 'claude', model: 'claude-sonnet-4-6' },
      },
    },
  };
  const withFake = fakeInvoke({ gemini: { ok: true, text: '**TL;DR** ok' } });
  await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: cfgWith, apiKey: 'KEY', invoke: withFake.invoke, sleep: noSleep });
  const g1 = withFake.calls.find((c) => c.engine === 'gemini');
  assert.ok(g1, 'the gemini primary was invoked');
  assert.equal(g1.body.generationConfig.thinkingConfig.thinkingBudget, -1, 'the configured thinkingBudget reaches the spec');
  assert.equal(g1.body.generationConfig.maxOutputTokens, 8192, 'the configured maxOutputTokens reaches the spec');

  // a gemini engine with NEITHER field set falls back to the safe defaults (0 / 4096) — the absent-field default.
  const cfgBare = {
    tasks: {
      handoff: {
        primary: { engine: 'gemini', model: 'gemini-3.1-flash-lite' },
        fallback: { engine: 'claude', model: 'claude-sonnet-4-6' },
      },
    },
  };
  const bareFake = fakeInvoke({ gemini: { ok: true, text: '**TL;DR** ok' } });
  await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: cfgBare, apiKey: 'KEY', invoke: bareFake.invoke, sleep: noSleep });
  const g2 = bareFake.calls.find((c) => c.engine === 'gemini');
  assert.equal(g2.body.generationConfig.thinkingConfig.thinkingBudget, 0, 'an absent thinkingBudget defaults to 0 (preserves #30)');
  assert.equal(g2.body.generationConfig.maxOutputTokens, 4096, 'an absent maxOutputTokens defaults to 4096');
});
