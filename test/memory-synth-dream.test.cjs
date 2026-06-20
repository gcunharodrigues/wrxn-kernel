'use strict';

// Tests for the synth's DREAM PATH (auto-memory-04) — the background dream consolidation the detached
// SessionEnd child does AFTER the handoff baton is written: take the in-memory transcript blob → engine
// `dream` task (≤5 evidence-backed concept/decision/gotcha/rule proposals, each quote a SUBSTANTIVE
// VERBATIM span of the transcript) → run them through the gate VIA dream.cjs `check --source <blob>` →
// stage the accepted set → `commit --source <blob>` (the commit re-gates + re-verifies quotes). Auto-
// approval = exactly the gate's accepted set; NO human approval step.
//
// The engine is behind the SAME injectable invoker proven in slices 02/03: a fake invoker returns canned
// dream-proposal JSON — NO real `claude -p`, NO network, NO spawn. The --source quote-verify gate is what
// makes a NON-human proposer safe: a fabricated quote (absent from the transcript) is rejected and never
// reaches the recall surface.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const { init } = require('../lib/install.cjs');
const synth = require('../payload/.wrxn/memory-synth.cjs');

function batonPath(root) {
  return path.join(root, '.wrxn', 'continuity', 'latest.md');
}
function handoffMarker(root) {
  return path.join(root, '.wrxn', 'continuity', '.pending-handoff');
}
function pendingPath(root) {
  return path.join(root, '.wrxn', 'continuity', '.pending');
}

// Stage a SessionEnd exactly as the spawn hook does: a transcript file + the stash + both markers.
function stageSession(root, jsonl) {
  const dir = path.join(root, '.wrxn', 'continuity');
  fs.mkdirSync(dir, { recursive: true });
  const tx = path.join(root, 'session.jsonl');
  fs.writeFileSync(tx, jsonl);
  fs.writeFileSync(pendingPath(root), JSON.stringify({ session_id: 'sid-d', transcript_path: tx, cwd: root }));
  fs.writeFileSync(handoffMarker(root), String(Date.now()));
  return tx;
}

// A fake invoker that routes by TASK: the handoff and dream specs both hit the claude engine, so we
// branch on the system prompt carried in the spec input (HANDOFF vs the dream JSON instruction).
function taskRoutedInvoke(handoffText, dreamText_) {
  const calls = [];
  const invoke = async (spec) => {
    calls.push(spec);
    const input = String(spec.input || '');
    if (input.includes('HANDOFF')) return { ok: true, text: handoffText };
    return { ok: true, text: dreamText_ };
  };
  return { invoke, calls };
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// runDream commits THROUGH dream.cjs → wiki.cjs, which resolve the install root by walking up to a
// wrxn.install.json. So the dream path needs a REAL install (unlike the handoff path, which only touches
// .wrxn/continuity). A fresh install gives us the dream/wiki adapters + the wiki tiers on disk.
function freshInstall(prefix) {
  const target = tmp(prefix);
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  return target;
}

function wikiPage(root, tier, slug) {
  return path.join(root, '.wrxn', 'wiki', tier, `${slug}.md`);
}

// A fake invoker (same shape as slices 02/03): canned text per engine, records the specs it received.
// For the dream task the canned text is the proposals JSON the model would emit.
function fakeInvoke(byEngine) {
  const calls = [];
  const invoke = async (spec) => {
    calls.push(spec);
    const r = byEngine[spec.engine];
    return typeof r === 'function' ? r(spec) : r || { ok: false };
  };
  return { invoke, calls };
}

// A transcript blob with a substantive, verbatim decision span the proposal can cite.
const BLOB = [
  '[user] we debated the logging stack at length today',
  '[assistant] after weighing options we decided to log with pino for structured logs everywhere',
  '[user] good, lock that in',
].join('\n');

// A schema-valid dream proposal whose evidence quote is a SUBSTANTIVE verbatim span present in BLOB.
function proposal(over) {
  return Object.assign(
    {
      kind: 'decision',
      tier: 'decisions',
      slug: 'log-with-pino',
      title: 'Log with pino',
      body: '# Log with pino\n\nWe standardize on pino for structured logs across services.',
      confidence: 0.9,
      rationale: 'Locks the logging stack so future sessions know why pino was chosen.',
      evidence: [{ quote: 'we decided to log with pino for structured logs' }],
    },
    over || {}
  );
}

// The model emits proposals as JSON text; the fake returns that string as the dream engine's output.
function dreamText(proposals) {
  return JSON.stringify({ proposals });
}

// ── AC1 + AC4: an accepted proposal (substantive quote present in the blob) is committed ──

test('runDream commits a proposal whose substantive quote is present in the transcript blob', async () => {
  const root = freshInstall('wrxn-dream-accept-');
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: dreamText([proposal()]) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.ok(fs.existsSync(wikiPage(root, 'decisions', 'log-with-pino')), 'the accepted dream page reached the recall surface');
  assert.match(fs.readFileSync(wikiPage(root, 'decisions', 'log-with-pino'), 'utf8'), /pino for structured logs/);
  assert.deepEqual(res.written, ['log-with-pino'], 'the committed slug is reported');
  // the engine was fed the dream system prompt + the in-memory blob (NOT a re-read of the stash).
  assert.equal(calls.length, 1, 'the dream engine ran once');
  assert.ok(calls[0].input.includes('we decided to log with pino'), 'the in-memory blob reached the engine');
});

// ── AC2 + AC6 (the load-bearing safety property): a fabricated quote is rejected, never written ──
// Auto-dream is unattended; the ONLY thing keeping a hallucinated memory out of permanent recall is the
// --source quote-verify. A proposal whose evidence quote is NOT in the transcript must be dropped and
// never reach the wiki.

test('runDream drops a proposal whose quote is NOT in the transcript (fabrication blocked)', async () => {
  const root = freshInstall('wrxn-dream-fabricated-');
  const fabricated = proposal({
    slug: 'invented-decision',
    title: 'Invented decision',
    body: '# Invented decision\n\nA memory the session never actually established.',
    evidence: [{ quote: 'a substantive sentence that was never spoken in this session' }],
  });
  const { invoke } = fakeInvoke({ claude: { ok: true, text: dreamText([fabricated]) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, [], 'nothing was committed (the fabricated quote was rejected)');
  assert.ok(!fs.existsSync(wikiPage(root, 'decisions', 'invented-decision')), 'the hallucinated page never reached the recall surface');
});

// ── AC3: the existing gate is honored end-to-end — a below-floor proposal is dropped, the rest writes ──
// A mixed batch proves the gate composes through runDream: the valid proposal commits while the one below
// the 0.75 confidence floor is rejected and never written (a partial-commit, never an all-or-nothing).

test('runDream honors the confidence floor: a below-0.75 proposal is dropped, the valid one is committed', async () => {
  const root = freshInstall('wrxn-dream-floor-');
  const good = proposal(); // confidence 0.9, quote present
  const weak = proposal({
    slug: 'low-confidence-note',
    title: 'Low confidence note',
    body: '# Low confidence note\n\nA shaky guess about the stack.',
    confidence: 0.5, // below the 0.75 floor → rejected by the gate
    evidence: [{ quote: 'we decided to log with pino for structured logs' }],
  });
  const { invoke } = fakeInvoke({ claude: { ok: true, text: dreamText([good, weak]) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, ['log-with-pino'], 'only the proposal above the confidence floor is committed');
  assert.ok(fs.existsSync(wikiPage(root, 'decisions', 'log-with-pino')), 'the valid page is written');
  assert.ok(!fs.existsSync(wikiPage(root, 'decisions', 'low-confidence-note')), 'the below-floor page is dropped');
});

// ── AC3: the secret-scan is honored — a proposal hardening a credential is dropped ──
// A durable page must never harden a session secret into recalled memory. The gate's secret-scan must
// reject a proposal whose body carries a credential, even with a real, present quote.

test('runDream honors the secret-scan: a proposal whose body contains a credential is dropped', async () => {
  const root = freshInstall('wrxn-dream-secret-');
  const leaky = proposal({
    slug: 'leaked-credential',
    title: 'Leaked credential',
    body: '# Leaked credential\n\nThe access key is AKIAIOSFODNN7EXAMPLE, do not lose it.',
    evidence: [{ quote: 'we decided to log with pino for structured logs' }],
  });
  const { invoke } = fakeInvoke({ claude: { ok: true, text: dreamText([leaky]) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, [], 'the secret-bearing proposal is rejected by the gate');
  assert.ok(!fs.existsSync(wikiPage(root, 'decisions', 'leaked-credential')), 'no credential is hardened into recall');
});

// ── AC7: the engine abstains → nothing is written, and no dream/stage/commit work runs ──

test('runDream writes nothing when the engine abstains ({abstain:true})', async () => {
  const root = freshInstall('wrxn-dream-abstain-');
  const { invoke } = fakeInvoke({ claude: { ok: true, text: JSON.stringify({ abstain: true }) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, [], 'an abstain commits nothing');
  assert.equal(res.reason, 'abstain', 'the skip reason is abstain');
  // no wiki page was created in any tier (the dir holds only its .gitkeep).
  assert.deepEqual(fs.readdirSync(path.join(root, '.wrxn', 'wiki', 'decisions')).filter((f) => f.endsWith('.md')), [], 'no decision page written');
});

test('runDream writes nothing when the engine returns no usable proposals (empty/garbage)', async () => {
  const root = freshInstall('wrxn-dream-noprops-');
  const { invoke } = fakeInvoke({ claude: { ok: true, text: 'I could not find anything durable to record.' } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, [], 'non-JSON / no-proposal output commits nothing');
  assert.equal(res.reason, 'abstain', 'an unparseable/empty proposal set is treated as abstain');
});

// ── a trivial blob → no dream, no model call ────────────────────────────────────
// The handoff already skipped a trivial session; the dream path must too — and spend no model call.

test('runDream skips a trivial blob: no model call, nothing written', async () => {
  const root = freshInstall('wrxn-dream-trivial-');
  const { invoke, calls } = fakeInvoke({ claude: { ok: true, text: dreamText([proposal()]) } });

  const res = await synth.runDream({ root, blob: 'hi', invoke });

  assert.deepEqual(res.written, [], 'a trivial blob writes nothing');
  assert.equal(res.reason, 'trivial', 'the skip reason is trivial');
  assert.equal(calls.length, 0, 'the engine is never invoked for a trivial blob (no model spend)');
});

// A real session transcript whose assistant text carries the substantive verbatim span the dream proposal
// cites — so the handoff is non-trivial AND the dream quote verifies against the same blob.
const REAL_SESSION = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'we debated the logging stack at length today' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'after weighing options we decided to log with pino for structured logs everywhere' }] } }),
].join('\n');

// ── AC1 + AC5 end-to-end: --from-spawn writes the baton (handoff) THEN commits accepted dream pages ──
// The detached SessionEnd child runs `memory-synth.cjs --from-spawn`. After this slice it must, in order:
// write the handoff baton, clear the handoff marker (release session-start), THEN run dream on the SAME
// in-memory blob and commit the accepted set. Proven through the testable run() core with a task-routed
// fake invoker — no real spawn / engine.

test('run --from-spawn writes the baton AND commits accepted dream pages (handoff then dream)', async () => {
  const root = freshInstall('wrxn-dream-fromspawn-');
  stageSession(root, REAL_SESSION);
  const { invoke, calls } = taskRoutedInvoke(
    '**TL;DR** decided to log with pino\n**Next step** wire the appender',
    dreamText([proposal()]),
  );

  const code = await synth.run(['--from-spawn', '--root', root], { invoke });

  assert.equal(code, 0, 'the from-spawn path exits 0');
  // handoff: the baton is written from the transcript.
  assert.match(fs.readFileSync(batonPath(root), 'utf8'), /log with pino/, 'the handoff baton was written');
  // dream: the accepted page reached the recall surface.
  assert.ok(fs.existsSync(wikiPage(root, 'decisions', 'log-with-pino')), 'the accepted dream page was committed');
  // both tasks ran through the engine (handoff + dream), in that order.
  assert.ok(calls.length >= 2, 'both the handoff and the dream engine calls happened');
  assert.ok(String(calls[0].input).includes('HANDOFF'), 'the handoff ran FIRST');
  assert.ok(calls.slice(1).some((c) => !String(c.input).includes('HANDOFF')), 'the dream ran after the handoff');
  // the markers are cleared (session-start released, no synth-in-flight left behind).
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is cleared');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is cleared');
});

// ── AC5: dream runs only AFTER the handoff marker is cleared (it can never extend the hold) ──
// The SessionStart hold waits on the handoff marker. Dream must run strictly after runHandoff has cleared
// it, so dream work can never delay session start. We assert the marker is already gone by the time the
// dream engine call is made, by clearing it at the handoff call and checking at the dream call.

test('run --from-spawn: the handoff marker is already cleared before the dream engine runs (no hold extension)', async () => {
  const root = freshInstall('wrxn-dream-order-');
  stageSession(root, REAL_SESSION);
  const markerClearedAtDream = { value: null };
  const calls = [];
  const invoke = async (spec) => {
    calls.push(spec);
    const input = String(spec.input || '');
    if (input.includes('HANDOFF')) return { ok: true, text: '**TL;DR** decided to log with pino' };
    // by the time the DREAM engine call is made, runHandoff must have cleared the handoff marker.
    markerClearedAtDream.value = !fs.existsSync(handoffMarker(root));
    return { ok: true, text: dreamText([proposal()]) };
  };

  await synth.run(['--from-spawn', '--root', root], { invoke });

  assert.equal(markerClearedAtDream.value, true, 'the handoff marker was already cleared when dream ran (hold released first)');
});

// ── slice-03 regression: runHandoff's marker lifecycle + return shape are unchanged ──
// runDream must NOT change the handoff contract: the baton is still written, both markers still cleared,
// and the return still carries `wrote` (slice-04 only ADDS a `blob` field, never removes one).

test('REGRESSION (slice-03): runHandoff still writes the baton, clears both markers, and returns wrote:true', async () => {
  const root = freshInstall('wrxn-dream-handoff-regression-');
  stageSession(root, REAL_SESSION);
  const { invoke } = taskRoutedInvoke('**TL;DR** done', dreamText([proposal()]));

  const res = await synth.runHandoff({ root, invoke });

  assert.equal(res.wrote, true, 'the baton was written (handoff contract intact)');
  assert.ok(fs.existsSync(batonPath(root)), 'the baton exists');
  assert.ok(!fs.existsSync(handoffMarker(root)), 'the handoff marker is cleared (session-start released)');
  assert.ok(!fs.existsSync(pendingPath(root)), 'the pending marker is cleared');
});

// ── AC4: auto-commit writes net-new pages ADDITIVELY (dedup-skip), never clobbering a curated page ──

test('runDream dedup-skips a proposal whose page already exists (additive, no clobber)', async () => {
  const root = freshInstall('wrxn-dream-dedup-');
  // a curated page already lives at the proposal's slug.
  const existing = wikiPage(root, 'decisions', 'log-with-pino');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, '---\nname: log-with-pino\ndescription: Log with pino\ntier: decisions\n---\n\n# Log with pino\n\nCURATED original body.\n');
  const { invoke } = fakeInvoke({ claude: { ok: true, text: dreamText([proposal()]) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.deepEqual(res.written, [], 'the duplicate proposal is dedup-skipped, not written');
  assert.match(fs.readFileSync(existing, 'utf8'), /CURATED original body/, 'the curated page is NOT clobbered (additive)');
});

// ── AC3: the ≤5 run cap is honored end-to-end ──────────────────────────────────

test('runDream honors the ≤5 cap: a 6-proposal batch commits at most 5', async () => {
  const root = freshInstall('wrxn-dream-cap-');
  const six = [];
  for (let i = 0; i < 6; i++) {
    six.push(proposal({
      kind: 'concept', tier: 'concepts', slug: `pino-note-${i}`, title: `Pino note ${i}`,
      body: `# Pino note ${i}\n\nA durable detail number ${i} about the logging stack.`,
      evidence: [{ quote: 'we decided to log with pino for structured logs' }],
    }));
  }
  const { invoke } = fakeInvoke({ claude: { ok: true, text: dreamText(six) } });

  const res = await synth.runDream({ root, blob: BLOB, invoke });

  assert.equal(res.written.length, 5, 'at most 5 pages are committed in one run');
});

// ── parseProposals: the tolerant proposal-JSON parser (a real model wraps JSON in prose / ```json fences) ──

test('parseProposals reads a clean {proposals:[…]} object', () => {
  const out = synth.parseProposals(JSON.stringify({ proposals: [proposal()] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'log-with-pino');
});

test('parseProposals reads a bare array', () => {
  assert.equal(synth.parseProposals(JSON.stringify([proposal()])).length, 1);
});

test('parseProposals tolerates a ```json-fenced / prose-wrapped payload (extracts the JSON span)', () => {
  const fenced = 'Here are the proposals:\n```json\n' + JSON.stringify({ proposals: [proposal()] }) + '\n```\nThat is all.';
  assert.equal(synth.parseProposals(fenced).length, 1);
});

test('parseProposals returns [] for an abstain, empty, or non-JSON output (write nothing)', () => {
  assert.deepEqual(synth.parseProposals(JSON.stringify({ abstain: true })), []);
  assert.deepEqual(synth.parseProposals(''), []);
  assert.deepEqual(synth.parseProposals('no json at all here'), []);
});
