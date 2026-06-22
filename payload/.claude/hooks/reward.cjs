'use strict';

// WRXN reward module — the learning-moat's value axis (kernel #13 / S2). A per-page Beta-Bernoulli
// store keyed by wiki-rel page path: { "<wiki-rel>": { s, f } } = good / bad sessions in which the page
// surfaced. `updateReward(counts, surfacedSet, signal)` is the PURE, deterministic, TOTAL update applied
// ONCE PER SESSION: +1 credits each surfaced page's success count `s`, −1 credits its failure count `f`,
// neutral (0) leaves counts untouched. The signal is INJECTED (the math never reads git/clock itself —
// the impure session-end shell derives ±1 and passes it), mirroring the recon decay-scorer's discipline.
//
// SHADOW (S2): this module only WRITES counts. It does NOT compute a reward factor or touch recall
// ranking — the re-rank is S3, behind a recorded mode constant. Keeping the factor out of S2 makes
// "shipping S2 is a recall no-op" true by construction.
//
// Self-contained: ships into installs alongside the hooks — node stdlib ONLY, NO kernel-lib / recon
// import (mirrors sidecar.cjs). The update is pure (no IO); only the shell that calls it does git/fs.

// Counts are bounded by construction so one lucky (or unlucky) page can't dominate every recall once the
// factor goes live in S3: each of s/f saturates at COUNT_CAP. The exact cap is a placeholder pending the
// lift gate (the PRD records caps as gate-tuned, not guessed — like the decay half-life); it exists now
// only so the store is bounded from day one, never as a tuned value.
const COUNT_CAP = 1e6;

// A valid join key is a wiki-rel page path: a STRING with non-whitespace content (e.g. 'concepts/a.md').
// Strictly string-typed (a coerced number like 0 is not a path) and non-blank, so garbage in the
// surfaced set credits nobody. This is also the sec-F3 posture: the value is treated only as a discrete
// page-identity key, never decomposed or used as anything but a map key.
function isWikiRelKey(k) {
  return typeof k === 'string' && k.trim().length > 0;
}

// A non-negative finite integer-ish count, defaulting to 0 (totality: garbage in a slot reads as 0).
function asCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Read an existing { s, f } slot defensively (totality: a malformed slot reads as zero evidence).
function readSlot(counts, key) {
  const slot = counts && typeof counts === 'object' ? counts[key] : null;
  if (!slot || typeof slot !== 'object') return { s: 0, f: 0 };
  return { s: asCount(slot.s), f: asCount(slot.f) };
}

/**
 * The pure Beta-Bernoulli update, applied ONCE PER SESSION (the caller passes the session's surfaced set
 * exactly once). Returns a FRESH counts map — the input is never mutated.
 *   signal > 0  → s += 1 for each surfaced page (a good session: new commits, green suite by construction)
 *   signal < 0  → f += 1 for each surfaced page (a bad session: a later revert / correction)
 *   signal == 0 → no change (neutral: no new commits — nothing to attribute)
 * Equal credit to every page in the surfaced set (attribution v1). TOTAL: any garbage (non-array set,
 * non-object counts, non-numeric signal, malformed slots) yields a sane map and never throws.
 *
 * Optional `opts.discount` ∈ (0,1) decays EVERY prior count toward neutral before this session's signal
 * (non-stationarity: a stale regime is unlearned over the page's lifetime). Out-of-range / garbage →
 * no decay (totality). Off by default — the exact value is gate-tuned, not guessed (PRD).
 *
 * @param {Record<string,{s:number,f:number}>} counts  prior per-page counts (treated read-only)
 * @param {Iterable<string>} surfacedSet  wiki-rel page keys surfaced this session
 * @param {number} signal  +1 good / −1 bad / 0 neutral (injected; never read from git/clock here)
 * @param {{discount?:number}} [opts]  optional decay factor in (0,1) applied to prior counts
 * @returns {Record<string,{s:number,f:number}>} a fresh updated counts map
 */
function updateReward(counts, surfacedSet, signal, opts) {
  // A well-formed, fresh defensive copy of the prior counts (every slot normalized to {s,f} numbers).
  const copyPrior = () => {
    const m = {};
    if (counts && typeof counts === 'object' && !Array.isArray(counts)) {
      for (const k of Object.keys(counts)) {
        if (!isWikiRelKey(k)) continue;
        m[k] = readSlot(counts, k);
      }
    }
    return m;
  };

  const dir = Number(signal);
  if (!Number.isFinite(dir) || dir === 0) return copyPrior(); // neutral → no update (and no decay)

  // A discount strictly inside (0,1) decays prior counts toward neutral BEFORE this session's signal;
  // anything else (incl. 1, 0, NaN) → no decay. Applied only on a real (non-neutral) session.
  const d = Number(opts && opts.discount);
  const discount = Number.isFinite(d) && d > 0 && d < 1 ? d : 1;
  const out = copyPrior();
  if (discount !== 1) {
    for (const k of Object.keys(out)) {
      out[k] = { s: out[k].s * discount, f: out[k].f * discount };
    }
  }

  // A surfaced SET is a collection of page keys. A bare string is NOT a set — Array.from would split it
  // into single characters and credit each as a page (corrupting the store); so anything that isn't an
  // array or a non-string iterable credits nobody (totality), never throws.
  let iterable;
  if (Array.isArray(surfacedSet)) {
    iterable = surfacedSet;
  } else if (surfacedSet != null && typeof surfacedSet !== 'string' && typeof surfacedSet[Symbol.iterator] === 'function') {
    try {
      iterable = Array.from(surfacedSet);
    } catch {
      iterable = [];
    }
  } else {
    iterable = [];
  }

  const seen = new Set();
  for (const raw of iterable) {
    if (!isWikiRelKey(raw)) continue; // non-string / blank → not a page key, credit nobody (totality)
    const key = raw;
    if (seen.has(key)) continue; // once per page per session (a dupe in the set is a single credit)
    seen.add(key);
    const slot = out[key] || { s: 0, f: 0 };
    if (dir > 0) slot.s = Math.min(slot.s + 1, COUNT_CAP);
    else slot.f = Math.min(slot.f + 1, COUNT_CAP);
    out[key] = slot;
  }
  return out;
}

/**
 * The reward VALUE AXIS (S3): map a page's Beta-Bernoulli slot `{s,f}` to a centered multiplicative
 * factor for the recall re-rank. Laplace-smoothed posterior mean `(s+1)/(s+f+2)` ∈ (0,1) (neutral 1/2
 * at zero evidence) → factor `2·mean` ∈ (0,2): a proven page (s≫f) lifts toward 2, a disproven page
 * (f≫s) sinks toward 0, and a page with NO evidence maps to EXACTLY 1 so it never moves a rank.
 *
 * BOUNDED by construction: s,f are finite non-negative (and saturate at COUNT_CAP in updateReward), so
 * the mean is strictly inside (0,1) and the factor strictly inside (0,2) — it can never reach 0 or 2,
 * so one lucky page can neither zero out nor double a rank. PURE + TOTAL: garbage / missing slot reads
 * as zero evidence → neutral 1, never a throw, never reads a clock. The same posterior the mechanism
 * gate fixtures lock (a known-useful page outranks a known-useless one).
 *
 * @param {{s:number,f:number}} [slot]  a page's reward counts (missing/garbage → zero evidence)
 * @returns {number} the centered reward factor in (0,2); exactly 1 at zero evidence
 */
function rewardFactor(slot) {
  const s = asCount(slot && slot.s);
  const f = asCount(slot && slot.f);
  const mean = (s + 1) / (s + f + 2); // Laplace posterior mean ∈ (0,1), exactly 1/2 at s=f=0
  return 2 * mean; // centered factor ∈ (0,2), exactly 1 at zero evidence
}

// ── starvedUseful: the learning-moat WATCHDOG (S4) ───────────────────────────────────
// A pure, deterministic, TOTAL canary over the (reward, surfaced-log) sidecar pair. It counts the
// STARVED-USEFUL set: pages the reward signal has learned are useful (high posterior) yet recall RARELY
// surfaces (low surfaced-count) — because they sit below recon's floor, where a kernel-side re-rank
// cannot lift them. A growing set means the cheap kernel-side approach has hit its ceiling; the count is
// the data-driven signal toward graduating a recon reward term (option b). This module only COMPUTES the
// count — the handoff emission lives in the session-end shell (synapse-engine), the SAME channel as
// harvest's curation-debt nudge. Read-only: it never mutates the sidecars or touches recall ranking.

// "High reward" REUSES the value axis's posterior (rewardFactor = 2·mean ⇒ mean = factor/2 — never a
// second notion). R_HIGH is the posterior-mean bar for "learned useful"; S_LOW the surfaced-count bar
// for "rarely surfaced". Both are PLACEHOLDERS pending the lift gate — recorded with the gate verdict,
// exactly like COUNT_CAP and the decay half-life (the PRD records thresholds as gate-tuned, not guessed).
// They exist now only so the canary is bounded and deterministic from day one, never as tuned values.
const R_HIGH = 0.75; // posterior mean ≥ 0.75 (⇔ rewardFactor ≥ 1.5) — clearly net-positive evidence
const S_LOW = 1; // surfaced in ≤ 1 recorded session — recall almost never brings it up

// Build a { page → number-of-sessions-that-surfaced-it } map from the surfaced-log
// ({ "<session_id>": ["<wiki-rel>", …] }). Each session credits a page AT MOST ONCE (a within-session
// dupe is one surfacing), mirroring recall-surface's per-session de-dup. TOTAL: a non-object log, a
// non-array session entry, or a non-string/blank page key contributes nothing — never throws.
function surfacedCounts(surfaced) {
  const counts = Object.create(null);
  if (!surfaced || typeof surfaced !== 'object' || Array.isArray(surfaced)) return counts;
  for (const sid of Object.keys(surfaced)) {
    const entry = surfaced[sid];
    if (!Array.isArray(entry)) continue;
    const seen = new Set();
    for (const raw of entry) {
      if (!isWikiRelKey(raw) || seen.has(raw)) continue;
      seen.add(raw);
      counts[raw] = (counts[raw] || 0) + 1;
    }
  }
  return counts;
}

/**
 * PURE watchdog: count the STARVED-USEFUL pages over the (reward, surfaced) sidecar pair. A page is
 * starved-useful when BOTH hold:
 *   · posterior(reward[page]) ≥ rHigh   — learned useful (the SAME posterior the value axis uses)
 *   · surfaced-count(page)    ≤ sLow    — rarely surfaced across the log (sits below recon's floor)
 * Returns { count, pages } with `pages` sorted (DETERMINISTIC) and `count = pages.length`. TOTAL: any
 * garbage (non-object reward/surfaced, malformed slot, garbage opts) yields { count: 0, pages: [] } and
 * never throws. Thresholds default to the named constants R_HIGH / S_LOW; opts may override them for the
 * gate's tuning (out-of-range / non-finite → the constant default).
 *
 * @param {Record<string,{s:number,f:number}>} reward  per-page Beta-Bernoulli counts (read-only)
 * @param {Record<string,string[]>} surfaced           per-session surfaced-log (read-only)
 * @param {{rHigh?:number, sLow?:number}} [opts]        optional threshold overrides (gate-tuned)
 * @returns {{count:number, pages:string[]}}
 */
function starvedUseful(reward, surfaced, opts) {
  const rh = Number(opts && opts.rHigh);
  const rHigh = Number.isFinite(rh) && rh > 0 && rh < 1 ? rh : R_HIGH;
  const sl = Number(opts && opts.sLow);
  const sLow = Number.isFinite(sl) && sl >= 0 ? sl : S_LOW;

  const counts = surfacedCounts(surfaced);
  const pages = [];
  if (reward && typeof reward === 'object' && !Array.isArray(reward)) {
    for (const key of Object.keys(reward)) {
      if (!isWikiRelKey(key)) continue;
      const posterior = rewardFactor(reward[key]) / 2; // SAME posterior as the value axis (factor = 2·mean)
      if (posterior < rHigh) continue; // not learned-useful
      if ((counts[key] || 0) > sLow) continue; // surfaced often enough — recall already reaches it
      pages.push(key);
    }
  }
  pages.sort();
  return { count: pages.length, pages };
}

module.exports = { updateReward, rewardFactor, starvedUseful, COUNT_CAP, R_HIGH, S_LOW };
