'use strict';

/**
 * The CD type-gate: decide whether a merge to main publishes, and at what bump, by conventional-commit
 * type. Pure — no I/O. The release.yml workflow reads commit messages from the merged range and gates
 * the OIDC publish on `release`.
 */

// Bump precedence: a mixed set releases at the highest applicable bump.
const RANK = { major: 3, minor: 2, patch: 1 };

/** Classify one commit message → 'major' | 'minor' | 'patch' | null (no release). */
function classify(message) {
  const text = String(message);
  // A `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer is a breaking change regardless of type — major.
  // Spec-correct: it starts a footer line, so anchor to a line start to avoid prose false-positives.
  if (/^BREAKING[ -]CHANGE:/m.test(text)) return 'major';
  const subject = text.split('\n')[0];
  const m = subject.match(/^([a-z]+)(\([^)]*\))?(!)?:/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  // The `!` marker (feat!, fix(api)!, refactor!) is a breaking change on ANY type — major.
  if (m[3] === '!') return 'major';
  if (type === 'feat') return 'minor';
  if (type === 'fix' || type === 'perf') return 'patch';
  return null;
}

/**
 * shouldRelease(commits) → { release, bump }. Given the merged commit messages, return whether a merge
 * publishes and the highest applicable bump.
 */
function shouldRelease(commits) {
  const list = Array.isArray(commits) ? commits : [];
  let best = null;
  for (const c of list) {
    const bump = classify(c);
    if (bump && (best === null || RANK[bump] > RANK[best])) best = bump;
  }
  return { release: best !== null, bump: best };
}

/**
 * Split NUL-delimited `git log --format=%B%x00 <range>` output into trimmed commit messages. Pure: the
 * git read stays at the CLI layer; this just parses what it returns. Empty/blank entries are dropped.
 */
function parseLog(raw) {
  return String(raw).split('\0').map((s) => s.trim()).filter(Boolean);
}

module.exports = { shouldRelease, parseLog };
