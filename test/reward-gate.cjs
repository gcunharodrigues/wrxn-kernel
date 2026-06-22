'use strict';

// The lift-replay harness — the learning-moat's offline ranking-evaluation core (S5 / kernel #16) and
// the SEED of the epic's reusable eval-harness item (L). It is the kernel analogue of recon's decay-gate
// harness (recon test/unit/decay-gate.ts): a PURE, deterministic measurement layer (no IO, no clock, no
// randomness) that replays a fixture corpus of logged sessions and reports a ranking metric WITH vs
// WITHOUT the reward factor, so the shadow→live flip is evidence-gated rather than guessed.
//
// It measures the EXACT transform production ships: it re-ranks each session's candidate hits with
// recall-surface's own rerankByReward (the same primitive the live recall path uses), exactly as recon's
// gate re-ranks a baseline with the production applyDecayRanking. The shipped selectRewardMode turns the
// computed verdict into a mode, so the harness can never disagree with what the hook would do.
//
// rev-F1 (S3 review) — ISOLATE reward lift from re-sort noise: in live mode an all-neutral reward.json
// still re-sorts the door order by base score (rerankByReward sorts by baseScore × factor, not the raw
// door order). If the "without reward" arm used the raw door order, that re-sort would be miscredited to
// reward. So the WITHOUT arm runs the SAME sort path with a NEUTRAL (all-1) lookup over the same keys —
// the re-sort artifact is then present in BOTH arms and cancels, leaving the measured delta attributable
// to the reward SIGNAL only. replayLift builds that neutral arm; replayDelta() asserts it cancels.
//
// Lives under test/ (not shipped to installs): like recon's gate harness it is repo-side eval tooling,
// not runtime code. node --test loads it as a 0-test module (it registers no tests), exactly as
// test/setup.cjs is loaded — harmless.

const { rerankByReward, wikiRelPath } = require('../payload/.claude/hooks/recall-surface.cjs');
const { selectRewardMode, rewardFactor } = require('../payload/.claude/hooks/reward.cjs');

const DEFAULT_K = 5;

// hit@k (binary): 1 if any relevant file lands in the top-k of the ranked list, else 0. TOTAL: a garbage
// ranking (non-array) is a miss. `relevant` may be a single path or a set of acceptable paths.
function hitAtK(rankedFiles, relevant, k) {
  const list = Array.isArray(rankedFiles) ? rankedFiles : [];
  const rel = new Set(Array.isArray(relevant) ? relevant : [relevant]);
  return list.slice(0, k).some((f) => rel.has(f)) ? 1 : 0;
}

// nDCG@k (binary relevance): DCG = Σ over the top-k of rel_i / log2(rank_i + 2); normalized by the IDCG
// (all relevant ranked first). ∈ [0,1]; 1 when a relevant page is first. TOTAL: garbage ranking → 0.
function ndcgAtK(rankedFiles, relevant, k) {
  const list = Array.isArray(rankedFiles) ? rankedFiles : [];
  const rel = new Set(Array.isArray(relevant) ? relevant : [relevant]);
  const topk = list.slice(0, k);
  let dcg = 0;
  topk.forEach((f, i) => {
    if (rel.has(f)) dcg += 1 / Math.log2(i + 2);
  });
  const ideal = Math.min(rel.size, Math.max(0, k | 0));
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

// A NEUTRAL twin of a reward lookup: the SAME keys, every factor forced to 1. rev-F1 cornerstone — the
// WITHOUT-reward arm re-ranks with this so it takes the EXACT same code path (same key set ⇒ same
// empty/non-empty branch in rerankByReward, same base-score re-sort) as the WITH arm, with the reward
// signal zeroed out. The re-sort artifact is therefore present in both arms and cancels in the delta.
function neutralize(rewardLookup) {
  const out = {};
  if (rewardLookup && typeof rewardLookup === 'object') {
    for (const k of Object.keys(rewardLookup)) out[k] = 1;
  }
  return out;
}

/**
 * Replay ONE logged session through both arms. A session = { query, candidates (door-ordered prose hits
 * carrying base scores + wiki-rel file paths), relevant (the known-good file path, or a set) }. Returns
 * the two re-ranked file lists and their hit@k / nDCG@k. The WITHOUT arm uses neutralize(rewardLookup),
 * NOT the raw door order, so the only difference from the WITH arm is the reward SIGNAL (rev-F1).
 */
function replayLift(session, rewardLookup, opts) {
  const k = (opts && Number.isFinite(opts.k) ? opts.k : DEFAULT_K);
  const candidates = session && Array.isArray(session.candidates) ? session.candidates : [];
  const relevant = session && session.relevant;
  const rankedWith = rerankByReward(candidates, rewardLookup).map((h) => h && h.file);
  const rankedWithout = rerankByReward(candidates, neutralize(rewardLookup)).map((h) => h && h.file);
  return {
    rankedWith,
    rankedWithout,
    withReward: { hitK: hitAtK(rankedWith, relevant, k), ndcg: ndcgAtK(rankedWith, relevant, k) },
    withoutReward: { hitK: hitAtK(rankedWithout, relevant, k), ndcg: ndcgAtK(rankedWithout, relevant, k) },
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Run the LIFT GATE over a corpus { rewardLookup, sessions, k?, tolerance? }. Mirrors recon's runGate:
 * compute baseline-vs-reward hit@k + nDCG@k across the corpus, decide a pass/fail verdict, and derive the
 * shipped mode via the production selectRewardMode (so a harness PASS is exactly what flips the hook).
 *   pass = reward IMPROVES ranking (higher hit@k, or equal hit@k with higher nDCG) AND does NOT regress
 *          the gold set (reward hit@k ≥ baseline hit@k − tolerance).
 * Returns a flat, deterministic result object (no clock, no randomness) — re-runnable in CI.
 */
function runLiftGate(corpus, opts) {
  const k = corpus && Number.isFinite(corpus.k) ? corpus.k
    : (opts && Number.isFinite(opts.k) ? opts.k : DEFAULT_K);
  const tolerance = corpus && Number.isFinite(corpus.tolerance) ? corpus.tolerance : 0;
  const sessions = corpus && Array.isArray(corpus.sessions) ? corpus.sessions : [];
  const rewardLookup = corpus && corpus.rewardLookup;

  const plays = sessions.map((s) => replayLift(s, rewardLookup, { k }));
  const baselineHitK = mean(plays.map((p) => p.withoutReward.hitK));
  const rewardHitK = mean(plays.map((p) => p.withReward.hitK));
  const baselineNdcg = mean(plays.map((p) => p.withoutReward.ndcg));
  const rewardNdcg = mean(plays.map((p) => p.withReward.ndcg));

  const improved = rewardHitK > baselineHitK || (rewardHitK === baselineHitK && rewardNdcg > baselineNdcg);
  const regressed = rewardHitK < baselineHitK - tolerance;
  const pass = improved && !regressed;
  const mode = selectRewardMode({ pass });

  return {
    k, tolerance, n: sessions.length,
    baselineHitK, rewardHitK, baselineNdcg, rewardNdcg,
    improved, regressed, pass, verdict: pass ? 'pass' : 'fail', mode,
  };
}

// ── self-validation fixtures + the durable gate doc (mirrors recon renderGateReport) ────────────────
// Canonical synthetic corpora that prove the harness MECHANISM (not real-world lift): a LIFT corpus the
// gate must flag pass⇒live, a REGRESSION corpus it must catch fail⇒shadow, and a NEUTRAL corpus where an
// all-1 reward over re-sorted door order yields ZERO lift (rev-F1) ⇒ shadow. Stable bytes ⇒ the rendered
// doc is a committed, diff-able record locked by the suite.

const H = (file, score) => ({ name: file, file, score, semanticScore: score, sources: ['bm25', 'semantic'], type: 'Page' });
const Wp = (slug) => '.wrxn/wiki/' + slug; // full hit path
const f3 = (n) => Number(n).toFixed(3);

const SELF_TEST = {
  lift: {
    rewardLookup: { 'concepts/rel.md': 1.9, 'concepts/distractor.md': 0.2 },
    sessions: [{ query: 'lift', relevant: Wp('concepts/rel.md'), candidates: [H(Wp('concepts/rel.md'), 0.4), H(Wp('concepts/distractor.md'), 0.9)] }],
    k: 1,
  },
  regression: {
    rewardLookup: { 'concepts/rel.md': 0.2, 'concepts/distractor.md': 1.9 },
    sessions: [{ query: 'regression', relevant: Wp('concepts/rel.md'), candidates: [H(Wp('concepts/rel.md'), 0.9), H(Wp('concepts/distractor.md'), 0.4)] }],
    k: 1,
  },
  neutral: {
    rewardLookup: { 'concepts/a.md': 1, 'concepts/b.md': 1 },
    sessions: [{ query: 'neutral', relevant: Wp('concepts/b.md'), candidates: [H(Wp('concepts/a.md'), 0.3), H(Wp('concepts/b.md'), 0.9)] }],
    k: 1,
  },
};

/** Run the harness over the canonical fixtures — the mechanism gate (posterior re-rank) + the three lift
 *  corpora. Pure + deterministic; the source of the durable doc's numbers. */
function selfValidate() {
  const mechCounts = { 'concepts/useful.md': { s: 20, f: 1 }, 'concepts/useless.md': { s: 1, f: 20 } };
  const mechLookup = {};
  for (const k of Object.keys(mechCounts)) mechLookup[k] = rewardFactor(mechCounts[k]);
  const mechCandidates = [H(Wp('concepts/useless.md'), 0.5), H(Wp('concepts/useful.md'), 0.5)]; // door puts useless first
  const mechRanked = rerankByReward(mechCandidates, mechLookup).map((h) => h.file);
  return {
    mechanism: { useful: 'concepts/useful.md', useless: 'concepts/useless.md', rankedUsefulFirst: mechRanked[0] === Wp('concepts/useful.md') },
    lift: runLiftGate(SELF_TEST.lift),
    regression: runLiftGate(SELF_TEST.regression),
    neutral: runLiftGate(SELF_TEST.neutral),
  };
}

/**
 * Render the durable, deterministic gate doc — the kernel analogue of recon's renderGateReport. Records
 * the recorded verdict (shadow), the metric definition, the rev-F1 re-sort isolation, the flip criteria
 * (passing lift on REAL data AND operator ratification of the git-only signal), and the harness
 * self-validation. No clock / locale → stable bytes, committed at docs/eval/0001-reward-lift-gate.md.
 */
function renderLiftGateDoc(recordedVerdict, sv) {
  const v = recordedVerdict && typeof recordedVerdict === 'object' ? recordedVerdict : {};
  const mode = selectRewardMode(v);
  const row = (name, what, r) => `| ${name} | ${what} | ${f3(r.rewardHitK)} | ${f3(r.baselineHitK)} | ${r.verdict} | ${r.mode} |`;
  const lines = [
    '# Reward-Lift Measurement Gate — wrxn-kernel learning-moat ① (S5 / kernel #16)',
    '',
    '> Durable record of the two-gate validation for the outcome-reinforced recall re-rank — the kernel',
    '> analogue of recon ADR 0005 (docs/eval/0005-decay-weight-gate.md). Generated by the lift-replay',
    '> harness (`test/reward-gate.cjs`) and verified by `test/reward-gate.test.cjs` on every run.',
    '> `SHIPPED_REWARD_MODE` in `payload/.claude/hooks/recall-surface.cjs` is locked to this recorded',
    '> verdict via `selectRewardMode(RECORDED_REWARD_VERDICT)`. Regenerate with:',
    '> `node -e "const g=require(\'./test/reward-gate.cjs\'),r=require(\'./payload/.claude/hooks/reward.cjs\'),fs=require(\'fs\');fs.writeFileSync(\'docs/eval/0001-reward-lift-gate.md\',g.renderLiftGateDoc(r.RECORDED_REWARD_VERDICT,g.selfValidate()))"`',
    '',
    `## Verdict: ${mode.toUpperCase()} — re-rank ships ${mode === 'live' ? 'ON' : 'OFF'} (${v.reason || 'n/a'})`,
    '',
    `- Recorded verdict: **${mode}** (\`pass: ${v.pass === true}\`, reason: \`${v.reason || 'n/a'}\`).`,
    '- No real session corpus has accrued yet, so the lift gate cannot be run on production data. The',
    '  re-rank ships in SHADOW: Beta-Bernoulli counts accrue every session but the reward factor NEVER',
    '  moves a recall rank — recall is byte-identical to pre-reward behaviour.',
    '',
    '## Metric definition',
    '',
    '- **hit@k** (primary): the fraction of replayed sessions whose known-relevant page lands in the',
    '  top-k after re-ranking. **nDCG@k** (tie-break): rank-discounted gain, binary relevance.',
    '- **with vs without reward**: both arms run the SAME production re-rank (`rerankByReward`). The',
    '  WITHOUT arm uses a NEUTRAL (all-1) reward lookup over the same keys — NOT the raw door order — so',
    '  the base-score re-sort is present in both arms and CANCELS; the measured delta is the reward SIGNAL',
    '  only (S3 review rev-F1). Defaults: k = 5, tolerance = 0 (no gold-set regression permitted).',
    '',
    '## Flip criteria (shadow → live)',
    '',
    'The re-rank flips to **live** ONLY when BOTH hold:',
    '1. A **passing lift verdict** on a corpus of REAL accumulated sessions — reward improves hit@k',
    '   (nDCG@k as the tie-break) WITHOUT regressing the gold set.',
    '2. **Operator ratification** of the git-only outcome signal. The production signal is git-only (new',
    '   non-revert commit(s) ⇒ good; a later revert ⇒ bad); the `suite green` conjunct was dropped, so the',
    '   signal is unsound for `--no-verify` / suite-less installs. The flip must be operator-ratified,',
    '   never automatic (S2 review rev-F1).',
    '',
    'A failing or absent verdict stays shadow — never a silent enable (`selectRewardMode`).',
    '',
    '## Harness self-validation (synthetic fixtures — proves the MECHANISM, not real lift)',
    '',
    `- Mechanism gate: the Beta-Bernoulli posterior ranks a known-useful page (\`${sv.mechanism.useful}\`) above`,
    `  a known-useless one (\`${sv.mechanism.useless}\`) through the production re-rank — **${sv.mechanism.rankedUsefulFirst ? 'PASS' : 'FAIL'}**.`,
    '',
    '| fixture | what it proves | reward hit@k | baseline hit@k | verdict | would-ship |',
    '|---|---|---:|---:|:--:|:--:|',
    row('lift', 'reward pulls a starved gold page into the top-k', sv.lift),
    row('regression', 'reward must NOT sink the gold page', sv.regression),
    row('neutral-isolation (rev-F1)', 'a neutral reward yields ZERO lift (re-sort cancels)', sv.neutral),
    '',
    'The lift fixture WOULD flip live while the regression and neutral fixtures stay shadow — so the',
    'harness detects real lift, catches a regression (mirroring the decay gate\'s fallback), and never',
    'mistakes the base-score re-sort for reward lift.',
    '',
    '## L-seed (reusable recall eval)',
    '',
    'This replay harness is the reusable core of the epic\'s eval-harness item (L): a pure, deterministic',
    'recall-ranking evaluator (hit@k / nDCG@k, with-vs-without any re-rank signal) that any future ranking',
    'change can be gated against. It is repo-side eval tooling (under `test/`), never shipped to installs.',
    '',
  ];
  return lines.join('\n');
}

module.exports = {
  hitAtK,
  ndcgAtK,
  neutralize,
  replayLift,
  runLiftGate,
  selfValidate,
  renderLiftGateDoc,
  SELF_TEST,
  DEFAULT_K,
  rerankByReward,
  wikiRelPath,
  selectRewardMode,
};
