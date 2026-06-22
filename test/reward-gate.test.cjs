'use strict';

// Two-gate validation for the learning-moat reward re-rank (S5 / kernel #16) — the kernel analogue of
// recon's decay-weight gate (docs/eval/0005-decay-weight-gate.md). Two gates decide whether the re-rank
// may ship LIVE:
//   1. MECHANISM gate (CI, deterministic, in the suite): a synthetic fixture proves the Beta-Bernoulli
//      posterior — applied through the REAL production re-rank seam (recall-surface.rerankByReward) —
//      ranks a known-useful page (high s, low f) ABOVE a known-useless one (low s, high f).
//   2. LIFT gate (offline replay): a PURE harness (test/reward-gate.cjs — the epic's eval-harness L-seed)
//      replays a fixture corpus of logged sessions and computes hit@k / nDCG WITH vs WITHOUT the reward
//      factor; the flip is allowed only if reward improves ranking without regressing the gold set.
//
// The shipped mode is DERIVED from the recorded verdict (reward.selectRewardMode(RECORDED_REWARD_VERDICT))
// and stays SHADOW — no real session corpus has accrued yet. These gates prove the MECHANISM on synthetic
// data; the production flip additionally needs a passing lift verdict on REAL sessions + operator
// ratification of the git-only signal (docs/eval/0001-reward-lift-gate.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const recall = require('../payload/.claude/hooks/recall-surface.cjs');
const reward = require('../payload/.claude/hooks/reward.cjs');
const gate = require('./reward-gate.cjs'); // the pure lift-replay harness (L-seed)

const DOC = path.join(__dirname, '..', 'docs', 'eval', '0001-reward-lift-gate.md');

// A minimal door-shaped prose hit: rerankByReward keys the reward lookup by wikiRelPath(file) and ranks by
// baseScore(hit) × factor, so only `file` + `score` are load-bearing here.
function hit(file, score) {
  return { name: file, file, score, semanticScore: score, sources: ['bm25', 'semantic'], type: 'Page' };
}
const order = (hits) => hits.map((h) => h.file);

// ── GATE 1: the CI mechanism fixture (AC: posterior ranks known-useful above known-useless) ─────────
// Deterministic, in-suite. Two EQUALLY-relevant candidates (identical base score) in DOOR order
// [useless, useful]; the ONLY differentiator is each page's reward counts. The lookup is built from those
// counts through the REAL posterior (reward.rewardFactor), then the REAL production re-rank
// (recall.rerankByReward) is applied. The known-useful page must end up first — the mechanism's
// correctness, locked regardless of real-world lift (PRD story 15).

test('MECHANISM gate: the reward posterior re-ranks a known-useful page ABOVE a known-useless one', () => {
  const useful = '.wrxn/wiki/concepts/useful.md';   // high s, low f → posterior ≫ 0.5 → factor > 1
  const useless = '.wrxn/wiki/concepts/useless.md';  // low s, high f → posterior ≪ 0.5 → factor < 1
  const counts = { 'concepts/useful.md': { s: 20, f: 1 }, 'concepts/useless.md': { s: 1, f: 20 } };

  // Build the lookup the SAME way the live shell does: per-page reward factor from the posterior.
  const lookup = {};
  for (const k of Object.keys(counts)) lookup[k] = reward.rewardFactor(counts[k]);

  // DOOR order deliberately puts the useless page first; the posterior must overturn it.
  const candidates = [hit(useless, 0.5), hit(useful, 0.5)];
  const ranked = order(recall.rerankByReward(candidates, lookup));
  assert.deepEqual(ranked, [useful, useless], 'the proven page outranks the disproven one — through the real re-rank');

  // Control: with NO posterior evidence (both pages zero-count → factor exactly 1) the re-rank is the
  // identity — proving it is the POSTERIOR, not the re-rank itself, that moved the useful page up.
  const neutralLookup = { 'concepts/useful.md': reward.rewardFactor({ s: 0, f: 0 }), 'concepts/useless.md': reward.rewardFactor({ s: 0, f: 0 }) };
  assert.deepEqual(order(recall.rerankByReward(candidates, neutralLookup)), [useless, useful], 'zero evidence → door order preserved');
});

// ── GATE 2 metrics: hit@k and nDCG@k are correct + deterministic ───────────────────────────────────
// The ranking metrics the lift gate measures. hit@k = did a relevant page land in the top-k (binary).
// nDCG@k = rank-discounted gain (binary relevance): 1/log2(rank+2) summed over relevant top-k, normalized
// by the ideal. Both pure + deterministic — the same arithmetic on the same input forever.

test('hitAtK: relevant in top-k → 1, outside top-k → 0', () => {
  assert.equal(gate.hitAtK(['a', 'b', 'c'], 'a', 3), 1, 'relevant at rank 0 is a hit');
  assert.equal(gate.hitAtK(['x', 'b', 'rel'], 'rel', 3), 1, 'relevant at rank 2 is a hit@3');
  assert.equal(gate.hitAtK(['x', 'b', 'rel'], 'rel', 2), 0, 'relevant at rank 2 is NOT a hit@2');
  assert.equal(gate.hitAtK(['x', 'y'], 'rel', 5), 0, 'no relevant in the list → miss');
  assert.equal(gate.hitAtK(['x', 'rel2', 'y'], ['rel1', 'rel2'], 3), 1, 'any of a relevant SET counts');
});

test('ndcgAtK: rank-discounted, normalized to the ideal, deterministic', () => {
  assert.equal(gate.ndcgAtK(['rel', 'x', 'y'], 'rel', 3), 1, 'relevant first → perfect nDCG = 1');
  assert.equal(gate.ndcgAtK(['x', 'x', 'rel'], 'rel', 3), 0.5, 'relevant at rank 2 → 1/log2(4) / 1 = 0.5');
  assert.ok(Math.abs(gate.ndcgAtK(['x', 'rel', 'y'], 'rel', 3) - 1 / Math.log2(3)) < 1e-12, 'rank 1 → 1/log2(3), normalized');
  assert.equal(gate.ndcgAtK(['x', 'y', 'z'], 'rel', 3), 0, 'relevant absent from top-k → 0');
  // a deeper-but-present relevant beats an absent one, and a higher rank beats a lower one (monotone)
  assert.ok(gate.ndcgAtK(['rel', 'x'], 'rel', 5) > gate.ndcgAtK(['x', 'rel'], 'rel', 5), 'earlier rank scores higher');
});

test('hitAtK / ndcgAtK are TOTAL: garbage rankings never throw → 0', () => {
  for (const bad of [null, undefined, 'not-an-array', 42, {}]) {
    assert.doesNotThrow(() => gate.hitAtK(bad, 'rel', 3));
    assert.doesNotThrow(() => gate.ndcgAtK(bad, 'rel', 3));
    assert.equal(gate.hitAtK(bad, 'rel', 3), 0, 'garbage ranking → miss');
    assert.equal(gate.ndcgAtK(bad, 'rel', 3), 0, 'garbage ranking → 0');
  }
});

// ── replayLift: one session through both arms, isolating reward lift from re-sort noise (rev-F1) ─────
// A logged session = { query, candidates (door-ordered hits with base scores), relevant (the known-good
// page) }. replayLift re-ranks it WITH the reward lookup and WITHOUT (a neutral, all-1 lookup over the
// same keys — NOT the raw door order). rev-F1: when reward is neutral both arms must be IDENTICAL (the
// base-score re-sort is present in both and cancels), yet both must DIFFER from the raw door order — so
// any measured delta is the reward SIGNAL only, never the re-sort artifact.
const W = (slug) => '.wrxn/wiki/' + slug; // a hit's full file path
const K = (slug) => slug;                  // the wiki-rel reward key

test('rev-F1: replayLift WITHOUT-arm is the neutral re-sort (NOT door order); neutral reward ⇒ arms identical, delta 0', () => {
  // Door order [A, B] but base-score order is [B, A] (B scores higher). A neutral reward must NOT change
  // the ranking relative to the baseline arm — and the baseline arm itself re-sorts to [B, A].
  const session = {
    query: 'q',
    candidates: [hit(W('concepts/a.md'), 0.3), hit(W('concepts/b.md'), 0.9)],
    relevant: W('concepts/a.md'),
  };
  const neutral = { 'concepts/a.md': 1, 'concepts/b.md': 1 };
  const r = gate.replayLift(session, neutral, { k: 5 });

  assert.deepEqual(r.rankedWithout, [W('concepts/b.md'), W('concepts/a.md')], 'the WITHOUT arm re-sorts by base score (NOT raw door order)');
  assert.notDeepEqual(r.rankedWithout, order(session.candidates), 'the WITHOUT arm is NOT the raw door order — the re-sort IS present in the baseline');
  assert.deepEqual(r.rankedWith, r.rankedWithout, 'neutral reward ⇒ WITH arm equals WITHOUT arm — the re-sort artifact cancels');
  assert.equal(r.withReward.hitK - r.withoutReward.hitK, 0, 'neutral reward ⇒ ZERO hit@k delta (no spurious lift from the re-sort)');
});

test('replayLift measures real lift: a high-reward relevant page is pulled into the top-k it missed at baseline', () => {
  // Base-score order ranks the distractor first → relevant misses hit@1; reward lifts it in.
  const session = {
    query: 'q',
    candidates: [hit(W('concepts/rel.md'), 0.4), hit(W('concepts/distractor.md'), 0.9)],
    relevant: W('concepts/rel.md'),
  };
  const lookup = { [K('concepts/rel.md')]: 1.8, [K('concepts/distractor.md')]: 0.3 };
  const r = gate.replayLift(session, lookup, { k: 1 });
  assert.equal(r.withoutReward.hitK, 0, 'baseline (base-score) misses the relevant page at k=1');
  assert.equal(r.withReward.hitK, 1, 'reward pulls the proven relevant page into the top-1');
  assert.equal(r.rankedWith[0], W('concepts/rel.md'), 'reward ranks the relevant page first');
});

// ── runLiftGate: the verdict over a corpus (lift ⇒ pass⇒live; regression ⇒ fail⇒shadow; neutral ⇒ shadow) ──
// Mirrors recon runGate: it computes baseline-vs-reward hit@k/nDCG over the corpus, decides pass/fail, and
// derives the mode through the SHIPPED selectRewardMode — so a harness PASS is exactly what would flip the
// hook. pass = reward improves ranking AND does not regress the gold set.

test('runLiftGate: a corpus where reward lifts the gold page ⇒ verdict PASS ⇒ mode live', () => {
  const corpus = {
    rewardLookup: { [K('concepts/rel.md')]: 1.9, [K('concepts/distractor.md')]: 0.2 },
    sessions: [{
      query: 'q', relevant: W('concepts/rel.md'),
      candidates: [hit(W('concepts/rel.md'), 0.4), hit(W('concepts/distractor.md'), 0.9)],
    }],
    k: 1,
  };
  const r = gate.runLiftGate(corpus);
  assert.ok(r.rewardHitK > r.baselineHitK, 'reward improves hit@k over the baseline');
  assert.equal(r.regressed, false, 'no gold-set regression');
  assert.equal(r.pass, true);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.mode, 'live', 'a passing lift verdict derives live via the SHIPPED selectRewardMode');
});

test('runLiftGate: a corpus where reward SINKS the gold page ⇒ verdict FAIL ⇒ mode shadow (mirrors decay→fallback)', () => {
  const corpus = {
    rewardLookup: { [K('concepts/rel.md')]: 0.2, [K('concepts/distractor.md')]: 1.9 },
    sessions: [{
      query: 'q', relevant: W('concepts/rel.md'),
      candidates: [hit(W('concepts/rel.md'), 0.9), hit(W('concepts/distractor.md'), 0.4)],
    }],
    k: 1,
  };
  const r = gate.runLiftGate(corpus);
  assert.ok(r.rewardHitK < r.baselineHitK, 'reward regresses hit@k below the baseline');
  assert.equal(r.regressed, true);
  assert.equal(r.pass, false);
  assert.equal(r.mode, 'shadow', 'a regression keeps shadow — never a silent enable');
});

test('runLiftGate (rev-F1 at the gate): an all-NEUTRAL reward over re-sorted door order ⇒ no lift ⇒ shadow', () => {
  // Door order differs from base-score order, but reward is neutral. The re-sort cancels across arms, so
  // there is ZERO measured lift and the gate must NOT mistake the re-sort for improvement.
  const corpus = {
    rewardLookup: { 'concepts/a.md': 1, 'concepts/b.md': 1 },
    sessions: [{
      query: 'q', relevant: W('concepts/a.md'),
      candidates: [hit(W('concepts/a.md'), 0.3), hit(W('concepts/b.md'), 0.9)],
    }],
    k: 1,
  };
  const r = gate.runLiftGate(corpus);
  assert.equal(r.rewardHitK, r.baselineHitK, 'neutral reward ⇒ identical hit@k across arms (re-sort cancels)');
  assert.equal(r.rewardNdcg, r.baselineNdcg, 'neutral reward ⇒ identical nDCG across arms');
  assert.equal(r.pass, false, 'no improvement ⇒ no flip');
  assert.equal(r.mode, 'shadow');
});

test('runLiftGate is deterministic: same corpus ⇒ byte-identical result', () => {
  const corpus = {
    rewardLookup: { [K('concepts/rel.md')]: 1.9, [K('concepts/distractor.md')]: 0.2 },
    sessions: [{ query: 'q', relevant: W('concepts/rel.md'), candidates: [hit(W('concepts/rel.md'), 0.4), hit(W('concepts/distractor.md'), 0.9)] }],
    k: 1,
  };
  assert.deepEqual(gate.runLiftGate(corpus), gate.runLiftGate(corpus), 'pure + deterministic — re-runnable in CI');
});

// ── the durable gate doc (mirrors recon docs/eval/0005) — recorded verdict locked to the render ─────
// selfValidate() runs the harness over canonical synthetic fixtures (mechanism + lift + regression +
// neutral-isolation), proving the harness DETECTS lift, CATCHES regression, and does not miscredit the
// re-sort. renderLiftGateDoc renders the durable record; the committed doc is locked to that render so
// the recorded verdict (shadow) can never silently drift from what ships.

test('selfValidate: fixtures prove mechanism⇒useful-first, lift⇒live, regression⇒shadow, neutral(rev-F1)⇒shadow', () => {
  const sv = gate.selfValidate();
  assert.equal(sv.mechanism.rankedUsefulFirst, true, 'mechanism: the posterior ranks useful above useless');
  assert.equal(sv.lift.mode, 'live', 'a lift fixture WOULD flip live (the harness detects real lift)');
  assert.equal(sv.regression.mode, 'shadow', 'a regression fixture stays shadow (the harness catches a sink)');
  assert.equal(sv.neutral.mode, 'shadow', 'a neutral-reward fixture stays shadow (no spurious lift)');
  assert.equal(sv.neutral.rewardHitK, sv.neutral.baselineHitK, 'rev-F1: neutral reward ⇒ arms equal, the re-sort cancels');
});

test('the gate doc records SHADOW, the metric definition, the rev-F1 isolation, and operator ratification', () => {
  const doc = gate.renderLiftGateDoc(reward.RECORDED_REWARD_VERDICT, gate.selfValidate());
  assert.match(doc, /SHADOW/, 'the recorded verdict is shadow');
  assert.match(doc, /insufficient/i, 'the reason is insufficient real data');
  assert.match(doc, /hit@k/i, 'the primary metric is hit@k');
  assert.match(doc, /nDCG/i, 'the tie-break metric is nDCG');
  assert.match(doc, /re-sort|cancel|rev-F1/i, 'the rev-F1 re-sort isolation is documented');
  assert.match(doc, /operator ratif/i, 'flipping live requires operator ratification of the git-only signal (rev-F1 S2)');
  assert.match(doc, /\bL\b.*seed|eval-harness/i, 'documented as the reusable L-seed');
});

test('the committed gate doc is LOCKED to renderLiftGateDoc(RECORDED_REWARD_VERDICT, selfValidate) — no drift', () => {
  const expected = gate.renderLiftGateDoc(reward.RECORDED_REWARD_VERDICT, gate.selfValidate());
  const actual = fs.readFileSync(DOC, 'utf8');
  assert.equal(
    actual,
    expected,
    'docs/eval/0001-reward-lift-gate.md must equal the rendered verdict — regenerate with the writeDoc one-liner in the harness header'
  );
});
