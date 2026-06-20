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
// claude/claude-sonnet-4-6 primary, gemini/gemini-3.1-flash-lite fallback (PRD default tiering).

test('loadConfig returns the default tiering when no memory.config.json is present', () => {
  const root = tmp('wrxn-synth-cfg-');
  const cfg = synth.loadConfig(root);
  const handoff = synth.resolveTask(cfg, 'handoff');
  assert.deepEqual(handoff.primary, { engine: 'claude', model: 'claude-sonnet-4-6' });
  assert.deepEqual(handoff.fallback, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
  const dream = synth.resolveTask(cfg, 'dream');
  assert.deepEqual(dream.primary, { engine: 'claude', model: 'claude-sonnet-4-6' });
  assert.deepEqual(dream.fallback, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
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

test('synthesize falls back to the secondary engine when the primary fails, in order', async () => {
  const { invoke, calls } = fakeInvoke({ claude: { ok: false }, gemini: { ok: true, text: 'FALLBACK HANDOFF' } });
  const text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke });
  assert.equal(text, 'FALLBACK HANDOFF', 'the fallback engine text is returned');
  assert.deepEqual(calls.map((c) => c.engine), ['claude', 'gemini'], 'primary (claude) tried before fallback (gemini)');
});

test('synthesize short-circuits on a successful primary — the fallback is never attempted', async () => {
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: 'PRIMARY HANDOFF' }, gemini: { ok: true, text: 'FB' } });
  const text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke });
  assert.equal(text, 'PRIMARY HANDOFF');
  assert.deepEqual(calls.map((c) => c.engine), ['claude'], 'no fallback call once the primary returns text');
});

// ── graceful degradation: missing CLI / missing key / invoker error → null (never throws) ──

test('synthesize degrades to null when the CLI is unavailable AND there is no key — and never issues a keyless gemini call', async () => {
  const { invoke, calls } = fakeInvoke({ claude: { ok: false }, gemini: { ok: true, text: 'WOULD-LEAK' } });
  let text;
  await assert.doesNotReject(async () => {
    text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: undefined, invoke });
  });
  assert.equal(text, null, 'no engine available → null, so the caller writes nothing');
  assert.deepEqual(calls.map((c) => c.engine), ['claude'], 'gemini is never invoked without an API key (key missing fails that engine)');
});

test('synthesize never throws when an engine invoker throws — it degrades to the next engine, then to null', async () => {
  const boom = () => { throw new Error('network down'); };
  const { invoke } = fakeInvoke({ claude: boom, gemini: boom });
  let text;
  await assert.doesNotReject(async () => {
    text = await synth.synthesize({ task: 'handoff', prompt: 'P', blob: 'B', config: DEFAULT_CFG, apiKey: 'KEY', invoke });
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

test('run() exits 2 on a missing transcript file and on an unsupported task (dream lands in slice 04)', async () => {
  let errd = '';
  const sink = { write: (s) => { errd += s; } };
  const noCall = { invoke: async () => { throw new Error('engine must not be reached on a usage error'); }, out: sink, err: sink };

  assert.equal(await synth.run(['--task', 'handoff'], noCall), 2, 'no transcript file → usage error');
  assert.match(errd, /Usage/);

  errd = '';
  assert.equal(await synth.run(['--task', 'dream', '/tmp/whatever.jsonl'], noCall), 2, 'dream is not wired in this slice → unsupported task');
  assert.match(errd, /unsupported task "dream"/);
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
  assert.deepEqual(handoff.primary, { engine: 'claude', model: 'claude-sonnet-4-6' });
  assert.deepEqual(handoff.fallback, { engine: 'gemini', model: 'gemini-3.1-flash-lite' });
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
