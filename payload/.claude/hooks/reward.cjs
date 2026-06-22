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

module.exports = { updateReward, COUNT_CAP };
