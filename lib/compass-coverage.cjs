'use strict';

// compass coverage guard (wrxn-kernel flow-04).
// compass/SKILL.md carries a static ```buckets``` block routing every installed skill to a flow bucket
// (dev-pipeline / knowledge / setup-health / meta / cross-session). The runtime live-read in the skill
// body is the resilience layer; THIS is the drift-guard on the static map — an installed skill missing
// from every bucket is an orphan, i.e. the map fell behind a newly-added skill.
//
// Pure data transforms (no I/O), mirroring lib/executor.cjs: parseBuckets is the tolerant parser, the
// test reads the real SKILL.md + skills dir around them.

/**
 * Parse the fenced ```buckets``` block out of compass/SKILL.md into { bucket: [skill, …] }.
 * Each line is `bucket: a, b, c`. Tolerant: a missing block, blank lines, comment (#) lines, or
 * lines without a colon are skipped rather than thrown on.
 */
function parseBuckets(skillMd) {
  const text = String(skillMd || '');
  const m = text.match(/```buckets\s*\n([\s\S]*?)```/);
  if (!m) return {};

  const buckets = {};
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const bucket = trimmed.slice(0, idx).trim();
    const skills = trimmed
      .slice(idx + 1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (bucket) buckets[bucket] = skills;
  }
  return buckets;
}

/**
 * The coverage check: every installed skill must appear in some bucket. Returns { ok, orphans },
 * where orphans is the list of installed skills absent from every bucket (the static map drifted
 * behind a newly-added skill). Pure: the caller supplies the installed skill list and parsed buckets.
 */
function compassCoverage(installedSkills, buckets) {
  const routed = new Set();
  for (const skills of Object.values(buckets || {})) {
    for (const s of skills || []) routed.add(s);
  }
  const orphans = (installedSkills || []).filter((s) => !routed.has(s));
  return { ok: orphans.length === 0, orphans };
}

module.exports = { parseBuckets, compassCoverage };
