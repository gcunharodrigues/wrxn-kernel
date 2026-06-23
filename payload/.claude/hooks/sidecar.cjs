'use strict';

// WRXN shared coalesced-sidecar helper (kernel #12 / S1). The common mechanism behind recall-surface's
// runtime STATE sidecars (.wrxn/reinforce.json, .wrxn/surfaced.json): read a JSON object map → let the
// caller mutate it → REWRITE (not append) the whole map back, but ONLY when it actually changed
// (coalesced: <= 1 write per real change, the file never grows on a no-op).
//
// Self-contained: ships into installs alongside the hooks — node stdlib ONLY (fs / path), NO kernel-lib
// or recon import. FAIL-OPEN SILENT: any fault (absent dir, malformed existing sidecar, unwritable path)
// is swallowed so the caller's primary effect always proceeds and nothing ever throws.

const fs = require('fs');
const path = require('path');

// secretScan — replicated here because each self-contained install-only module imports no shared
// kernel-lib (node stdlib only), exactly as it is duplicated across dream.cjs / sync.cjs. CASE-SENSITIVE:
// the token shapes are case-specific. A coalesced sidecar must never harden a credential onto disk.
const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,                    // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{36}/,           // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_)
  /npm_[A-Za-z0-9]{36}/,                 // npm automation token
  /sk-[A-Za-z0-9]{20,}/,                 // OpenAI-style secret key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,  // PEM private-key header
];

function secretScan(text) {
  const s = String(text || ''); // NOT lowercased — the token shapes are case-sensitive.
  for (const re of SECRET_PATTERNS) if (re.test(s)) return 'contains_secret';
  return null;
}

// redactSecrets — scrub known secret shapes OUT of free text before it is persisted, built on the SAME
// SECRET_PATTERNS as secretScan (one source of truth: when a shape is added, both detection and redaction
// follow). Every match is replaced with a fixed placeholder while the surrounding text is preserved
// (metadata-grade redaction, not a whole-value drop) — so a persisted prompt stays useful for analysis
// yet never hardens a credential onto disk. Global-flagged clones of the patterns so EVERY occurrence on a
// line is scrubbed, not just the first; String#replace resets a global regex's lastIndex per call, so
// reusing these module-level clones is safe. TOTAL: a non-string coerces (null/undefined → '').
const SECRET_PATTERNS_GLOBAL = SECRET_PATTERNS.map((re) => new RegExp(re.source, 'g'));
const SECRET_PLACEHOLDER = '[redacted]';

function redactSecrets(text) {
  let s = String(text == null ? '' : text); // NOT lowercased — the token shapes are case-sensitive.
  for (const re of SECRET_PATTERNS_GLOBAL) s = s.replace(re, SECRET_PLACEHOLDER);
  return s;
}

// Read the JSON object map at `file`, hand it to `mutate(map)`, and rewrite the file iff mutate signals
// a change (returns truthy). Returns true when a write happened, false otherwise (including every
// fail-open path). `mutate` mutates the map in place and returns whether it changed it. The fully
// serialized map is secret-scanned before the write: if any value would harden a credential onto disk,
// the write is REFUSED (fail-open — the sidecar stays as it was, the caller proceeds).
function coalesceSidecar(file, mutate) {
  try {
    let map = {};
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null; // absent → fresh map (normal, not a fault)
    }
    if (raw !== null) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return false; // malformed existing sidecar → skip silently, leave it untouched (never clobber)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false; // not a map → skip
      map = parsed;
    }
    if (!mutate(map)) return false; // nothing changed → coalesced no-op, no write
    const body = JSON.stringify(map, null, 2) + '\n';
    if (secretScan(body)) return false; // never harden a credential onto disk → refuse the write
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return true;
  } catch {
    return false; // best-effort: a sidecar fault must never alter or break the caller
  }
}

module.exports = { coalesceSidecar, secretScan, redactSecrets };
