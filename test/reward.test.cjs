'use strict';

// Tests for the pure reward module (S2 / kernel #13). The learning-moat's value axis: a per-page
// Beta-Bernoulli store keyed by wiki-rel path, { "<wiki-rel>": { s, f } }. `updateReward` maps
// (counts, surfacedSet, signal) → counts′ once per session — +1 credits each surfaced page's `s`,
// −1 credits its `f`, neutral leaves counts untouched. It is PURE (no IO, no clock/signal read — the
// signal is injected), DETERMINISTIC, TOTAL (never throws on garbage), and BOUNDED (counts capped so
// one lucky page can't dominate). Black-box over the exported functions — the kernel's pure-scorer
// discipline (mirrors the recon decay-scorer: clock/signal injected, never reads them itself).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const REWARD = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'reward.cjs');
const reward = require('../payload/.claude/hooks/reward.cjs');
const { loadManifest } = require('../lib/manifest.cjs');
const { init } = require('../lib/install.cjs');

// ── the core update: +1 credits success, −1 credits failure, neutral is a no-op ──────

test('updateReward(+1): increments s for each surfaced page (new pages start from zero)', () => {
  const next = reward.updateReward({}, ['concepts/a.md', 'gotchas/b.md'], +1);
  assert.deepEqual(next, {
    'concepts/a.md': { s: 1, f: 0 },
    'gotchas/b.md': { s: 1, f: 0 },
  });
});

test('updateReward(+1): accumulates onto existing counts (good sessions add up)', () => {
  const prev = { 'concepts/a.md': { s: 2, f: 1 } };
  const next = reward.updateReward(prev, ['concepts/a.md'], +1);
  assert.deepEqual(next, { 'concepts/a.md': { s: 3, f: 1 } });
});

test('updateReward(−1): increments f for each surfaced page (bad sessions penalise)', () => {
  const prev = { 'concepts/a.md': { s: 2, f: 1 } };
  const next = reward.updateReward(prev, ['concepts/a.md'], -1);
  assert.deepEqual(next, { 'concepts/a.md': { s: 2, f: 2 } });
});

test('updateReward(neutral/0): leaves counts unchanged (no commits ⇒ no update)', () => {
  const prev = { 'concepts/a.md': { s: 2, f: 1 } };
  assert.deepEqual(reward.updateReward(prev, ['concepts/a.md'], 0), prev);
});

// ── PURE: never mutates the inputs (the caller's map is its own) ──────────────────────

test('updateReward is pure: the input counts object is not mutated', () => {
  const prev = { 'concepts/a.md': { s: 1, f: 0 } };
  const snapshot = JSON.parse(JSON.stringify(prev));
  reward.updateReward(prev, ['concepts/a.md'], +1);
  assert.deepEqual(prev, snapshot, 'the input is left untouched — a fresh object is returned');
});

// ── once per session: a page that appears twice in the surfaced set is credited once ──

test('updateReward credits a duplicated surfaced page only ONCE (equal-credit-once-per-session)', () => {
  const next = reward.updateReward({}, ['concepts/a.md', 'concepts/a.md'], +1);
  assert.deepEqual(next, { 'concepts/a.md': { s: 1, f: 0 } }, 'a dupe in the set is a single credit');
});

// ── TOTAL: never throws on garbage; a malformed prior slot reads as zero evidence ─────

test('updateReward is total: garbage inputs never throw and yield a sane map', () => {
  assert.doesNotThrow(() => reward.updateReward(null, null, +1));
  assert.deepEqual(reward.updateReward(null, null, +1), {}, 'no counts + no set → empty map');
  assert.deepEqual(reward.updateReward([], 'concepts/a.md', +1), {}, 'a string set is not iterated char-by-char');
  assert.deepEqual(reward.updateReward({}, ['', null, 0, '  '], +1), {}, 'empty/blank/null keys credit nobody');
  // a non-numeric signal is neutral (no update), never a throw
  assert.deepEqual(reward.updateReward({ 'x.md': { s: 1, f: 0 } }, ['x.md'], NaN), { 'x.md': { s: 1, f: 0 } });
});

test('updateReward rebuilds a malformed prior slot as zero evidence (totality), then applies the signal', () => {
  const prev = { 'concepts/a.md': 'corrupt', 'gotchas/b.md': { s: -5, f: 'nope' } };
  const next = reward.updateReward(prev, ['concepts/a.md', 'gotchas/b.md'], +1);
  assert.deepEqual(next, {
    'concepts/a.md': { s: 1, f: 0 }, // 'corrupt' → {0,0} then +1
    'gotchas/b.md': { s: 1, f: 0 }, // {-5,'nope'} → {0,0} then +1
  });
});

// ── BOUNDED: counts saturate at the cap (one page can't dominate once the factor is live) ──

test('updateReward is bounded: a count at the cap does not exceed it', () => {
  const prev = { 'concepts/a.md': { s: reward.COUNT_CAP, f: 0 } };
  const next = reward.updateReward(prev, ['concepts/a.md'], +1);
  assert.equal(next['concepts/a.md'].s, reward.COUNT_CAP, 's saturates at COUNT_CAP, never overflows');
});

// ── self-contained + shipped: node stdlib only, laid as managed payload into installs ──

test('the reward module imports nothing outside the node standard library', () => {
  const src = fs.readFileSync(REWARD, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — the reward sibling imports no kernel-lib/recon`);
  }
});

test('the reward module is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/reward.cjs');
  assert.ok(entry, 'reward.cjs is classified in the manifest (the installer refuses any unmanifested payload file)');
  assert.equal(entry.class, 'managed', 'kernel-owned hook code → managed');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wrxn-reward-laid-'));
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(
    fs.existsSync(path.join(target, '.claude', 'hooks', 'reward.cjs')),
    'the reward sibling is laid alongside the session-end shell so the require resolves in installs'
  );
});

// ── optional discount: prior counts decay toward neutral so a stale regime can be unlearned ──

test('updateReward with no discount opt leaves prior counts un-decayed (default behaviour)', () => {
  const prev = { 'concepts/a.md': { s: 4, f: 2 } };
  // default path: prior is carried as-is, then +1 to s
  assert.deepEqual(reward.updateReward(prev, ['concepts/a.md'], +1), { 'concepts/a.md': { s: 5, f: 2 } });
});

test('updateReward applies an optional discount to prior counts before the new signal (non-stationarity)', () => {
  const prev = { 'concepts/a.md': { s: 4, f: 2 }, 'gotchas/b.md': { s: 10, f: 0 } };
  // discount 0.5 halves every prior count, THEN +1 credits the surfaced page's s.
  const next = reward.updateReward(prev, ['concepts/a.md'], +1, { discount: 0.5 });
  assert.deepEqual(next, {
    'concepts/a.md': { s: 4 * 0.5 + 1, f: 2 * 0.5 }, // 3, 1
    'gotchas/b.md': { s: 10 * 0.5, f: 0 }, // 5, 0 — unsurfaced pages still decay (lifetime regime)
  });
});

test('updateReward neutral signal is a no-op EVEN with a discount (no update ⇒ no decay)', () => {
  const prev = { 'concepts/a.md': { s: 4, f: 2 } };
  assert.deepEqual(
    reward.updateReward(prev, ['concepts/a.md'], 0, { discount: 0.5 }),
    prev,
    'a neutral session neither credits nor decays — counts are unchanged'
  );
});

test('updateReward ignores an out-of-range or garbage discount (totality — falls back to no discount)', () => {
  const prev = { 'concepts/a.md': { s: 4, f: 2 } };
  for (const bad of [0, -1, 2, NaN, 'x', null]) {
    assert.deepEqual(
      reward.updateReward(prev, ['concepts/a.md'], +1, { discount: bad }),
      { 'concepts/a.md': { s: 5, f: 2 } },
      `discount ${String(bad)} is rejected → no decay`
    );
  }
});

// ── rewardFactor: the value axis (S3) — Laplace posterior mean → centered multiplicative factor ──
// `(s,f)` → posterior mean (s+1)/(s+f+2) ∈ (0,1) → factor 2·mean ∈ (0,2). A page with NO evidence
// (zero or missing counts) maps to factor EXACTLY 1 (neutral) so it cannot move a rank. PURE, total,
// bounded — the recon decay-scorer discipline (no clock/IO; garbage → neutral, never a throw).

test('rewardFactor: zero evidence → factor EXACTLY 1 (a no-record page is perfectly neutral)', () => {
  assert.equal(reward.rewardFactor({ s: 0, f: 0 }), 1, 's=f=0 → 2·(1/2) = 1 exactly');
  assert.equal(reward.rewardFactor({}), 1, 'an empty slot is zero evidence → neutral');
  assert.equal(reward.rewardFactor(undefined), 1, 'a missing slot (page not in the store) → neutral');
  assert.equal(reward.rewardFactor(null), 1, 'a null slot → neutral');
});

test('rewardFactor is monotonic: more good lifts above 1, more bad sinks below 1', () => {
  // success monotonically increases the factor (toward 2); each is strictly above the previous
  assert.ok(reward.rewardFactor({ s: 1, f: 0 }) > 1, 'one good session lifts above neutral');
  assert.ok(reward.rewardFactor({ s: 10, f: 0 }) > reward.rewardFactor({ s: 1, f: 0 }), 'more good ⇒ higher factor');
  // failure monotonically decreases the factor (toward 0); each is strictly below the previous
  assert.ok(reward.rewardFactor({ s: 0, f: 1 }) < 1, 'one bad session sinks below neutral');
  assert.ok(reward.rewardFactor({ s: 0, f: 10 }) < reward.rewardFactor({ s: 0, f: 1 }), 'more bad ⇒ lower factor');
  // a proven page outranks a disproven one — the mechanism the gate fixture locks
  assert.ok(reward.rewardFactor({ s: 9, f: 1 }) > reward.rewardFactor({ s: 1, f: 9 }), 'useful page beats useless page');
});

test('rewardFactor is bounded strictly inside (0,2) even at the count cap (no page can zero-out or double a rank)', () => {
  const hiGood = reward.rewardFactor({ s: reward.COUNT_CAP, f: 0 });
  const hiBad = reward.rewardFactor({ s: 0, f: reward.COUNT_CAP });
  assert.ok(hiGood > 1 && hiGood < 2, `maximal success stays below 2 (got ${hiGood})`);
  assert.ok(hiBad > 0 && hiBad < 1, `maximal failure stays above 0 (got ${hiBad})`);
});

test('rewardFactor is total: garbage slots read as zero evidence → neutral 1, never a throw', () => {
  for (const bad of ['corrupt', [], 42, NaN, { s: 'x', f: 'y' }, { s: -5, f: Infinity }]) {
    let v;
    assert.doesNotThrow(() => { v = reward.rewardFactor(bad); }, `garbage ${JSON.stringify(bad)} must not throw`);
    assert.equal(v, 1, `garbage ${JSON.stringify(bad)} reads as zero evidence → neutral`);
  }
});

// ── starvedUseful: the learning-moat watchdog (S4 / kernel #15) ───────────────────────
// Counts pages that are LEARNED-USEFUL but RARELY SURFACED — posterior ≥ R_HIGH AND surfaced-count
// ≤ S_LOW — over the (reward sidecar, surfaced-log) pair. The canary for option-(b) (a recon reward
// term): a page recall has learned is useful but rarely surfaces because it sits below recon's floor,
// where a kernel-side re-rank can't lift it. PURE, deterministic, TOTAL; reuses the SAME posterior the
// value axis uses (mean = rewardFactor(slot)/2 — never a second notion of "high reward").

test('starvedUseful counts pages with high posterior AND low surfaced-count, naming them', () => {
  const counts = {
    'concepts/starved.md': { s: 20, f: 0 },   // posterior ≈ 0.95 (high), never in the surfaced-log → starved
    'concepts/surfaced.md': { s: 20, f: 0 },  // posterior ≈ 0.95 (high) BUT surfaced in many sessions → not starved
    'concepts/neutral.md': { s: 0, f: 0 },    // posterior 0.5 → not high
    'concepts/useless.md': { s: 0, f: 20 },   // posterior ≈ 0.05 → not high
  };
  const surfaced = {
    s1: ['concepts/surfaced.md', 'concepts/neutral.md'],
    s2: ['concepts/surfaced.md'],
    s3: ['concepts/surfaced.md', 'concepts/useless.md'],
  };
  const out = reward.starvedUseful(counts, surfaced);
  assert.equal(out.count, 1, 'only the high-posterior, rarely-surfaced page is starved-useful');
  assert.deepEqual(out.pages, ['concepts/starved.md'], 'the starved page is named for the nudge text');
});

test('starvedUseful requires BOTH conditions: failing high-posterior OR low-surfaced excludes the page', () => {
  // Crisp thresholds via opts so the AND-gate is pinned independent of the default constants.
  const counts = {
    'a.md': { s: 20, f: 0 }, // high posterior, surfaced 0 times → starved (both hold)
    'b.md': { s: 20, f: 0 }, // high posterior BUT surfaced 5 times → fails low-surfaced
    'c.md': { s: 0, f: 0 },  // surfaced 0 times BUT posterior 0.5 → fails high-posterior
  };
  const surfaced = { s1: ['b.md'], s2: ['b.md'], s3: ['b.md'], s4: ['b.md'], s5: ['b.md'] };
  const out = reward.starvedUseful(counts, surfaced, { rHigh: 0.75, sLow: 1 });
  assert.deepEqual(out.pages, ['a.md'], 'only the page satisfying BOTH gates is starved-useful');
});

test('starvedUseful reuses the value-axis posterior: a zero-evidence page never qualifies (even at sLow huge)', () => {
  // rewardFactor({s:0,f:0}) = 1 ⇒ posterior 0.5 < any R_HIGH ∈ (0.5,1): never "learned useful".
  const out = reward.starvedUseful({ 'neutral.md': { s: 0, f: 0 } }, {}, { sLow: 1e6 });
  assert.equal(out.count, 0, 'a neutral (zero-evidence) page is never starved-useful — same posterior as rewardFactor');
});

test('starvedUseful is deterministic: pages come back sorted', () => {
  const counts = {
    'z.md': { s: 20, f: 0 },
    'a.md': { s: 20, f: 0 },
    'm.md': { s: 20, f: 0 },
  };
  const out = reward.starvedUseful(counts, {}); // none surfaced → all three starved
  assert.deepEqual(out.pages, ['a.md', 'm.md', 'z.md'], 'sorted order is deterministic for the nudge text');
});

test('starvedUseful is TOTAL: garbage reward/surfaced/opts never throw → { count: 0, pages: [] }', () => {
  for (const [r, s, o] of [
    [null, null, undefined],
    [undefined, undefined, undefined],
    [[], 'not-a-map', { rHigh: 'x', sLow: -1 }],
    [{ '': { s: 9, f: 0 }, '  ': { s: 9, f: 0 } }, { s1: 'not-an-array' }, { rHigh: 5 }], // blank keys credit nobody
    [{ 'a.md': 'corrupt' }, { s1: [42, null, {}] }, null], // malformed slot → zero evidence; non-string surfacings ignored
  ]) {
    let out;
    assert.doesNotThrow(() => { out = reward.starvedUseful(r, s, o); }, 'garbage must never throw');
    assert.deepEqual(out, { count: 0, pages: [] }, 'garbage in → empty starved set');
  }
});

test('starvedUseful thresholds are exported NAMED constants in sane ranges', () => {
  assert.equal(typeof reward.R_HIGH, 'number');
  assert.ok(reward.R_HIGH > 0.5 && reward.R_HIGH < 1, 'R_HIGH is a posterior-mean bar strictly inside (0.5, 1)');
  assert.equal(typeof reward.S_LOW, 'number');
  assert.ok(reward.S_LOW >= 0 && Number.isInteger(reward.S_LOW), 'S_LOW is a non-negative integer surfaced-count bar');
});

// ── selectRewardMode: the SHIP GATE (S5 / kernel #16) ─────────────────────────────────
// Mirrors recon's selectDecayMode(verdict) → SHIPPED_DECAY_MODE. The recall re-rank goes 'live' ONLY on
// a PASSING lift-gate verdict; a failing OR absent verdict stays 'shadow' (the safe default — never a
// silent enable). The shipped constant in recall-surface is selectRewardMode(RECORDED_REWARD_VERDICT).

test('selectRewardMode returns live ONLY on a passing verdict (pass === true)', () => {
  assert.equal(reward.selectRewardMode({ pass: true }), 'live', 'a passing lift verdict flips to live');
});

test('selectRewardMode returns shadow on a failing verdict', () => {
  assert.equal(reward.selectRewardMode({ pass: false }), 'shadow', 'a failed gate stays shadow');
});

test('selectRewardMode returns shadow on an ABSENT verdict (null/undefined) — the safe default', () => {
  assert.equal(reward.selectRewardMode(null), 'shadow', 'no recorded verdict → shadow');
  assert.equal(reward.selectRewardMode(undefined), 'shadow', 'no recorded verdict → shadow');
});

test('selectRewardMode is TOTAL: only a literal pass===true flips; all garbage → shadow', () => {
  for (const bad of [{}, { pass: 'yes' }, { pass: 1 }, { pass: 'true' }, 42, 'live', [], { ok: true }]) {
    assert.equal(reward.selectRewardMode(bad), 'shadow', `${JSON.stringify(bad)} is not a passing verdict → shadow`);
  }
});

test('RECORDED_REWARD_VERDICT is the current production verdict: NOT passing (insufficient real data)', () => {
  assert.equal(typeof reward.RECORDED_REWARD_VERDICT, 'object');
  assert.ok(reward.RECORDED_REWARD_VERDICT, 'the recorded verdict is present');
  assert.equal(reward.RECORDED_REWARD_VERDICT.pass, false, 'no real sessions accumulated yet → not a passing verdict');
  // The whole point of the slice: deriving the mode from THIS verdict yields shadow.
  assert.equal(
    reward.selectRewardMode(reward.RECORDED_REWARD_VERDICT),
    'shadow',
    'the recorded verdict derives the SHADOW mode — the shipped default'
  );
});
