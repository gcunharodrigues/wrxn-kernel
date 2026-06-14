'use strict';

const fs = require('fs');
const path = require('path');

// The sidecar block is marker-bounded so injection is idempotent: the START marker's presence in a
// host statusline means the block is already there. The canonical text lives in the managed payload
// doc (single source of truth) — snippet() extracts the marker region from it, so the doc and the
// injected block can never drift.
const MARKER_START = '# >>> wrxn sidecar >>>';
const MARKER_END = '# <<< wrxn sidecar <<<';

// The one-line adopt-hint `wrxn init` surfaces. init must NEVER modify a statusline; it only points
// the operator at the opt-in command.
const STATUSLINE_HINT = 'SYNAPSE live-window: run `wrxn statusline` to enable';

// The canonical doc inside the package payload (ships in dev and in the installed package alike).
const DOC_PATH = path.join(__dirname, '..', 'payload', 'docs', 'statusline-sidecar.sh');

/** The marker-bounded sidecar block, extracted from the canonical payload doc. */
function snippet(docPath) {
  const text = fs.readFileSync(docPath || DOC_PATH, 'utf8');
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error('statusline doc is missing its sidecar markers');
  }
  return text.slice(start, end + MARKER_END.length) + '\n';
}

/**
 * Resolve the statusline script path from a settings `statusLine.command`.
 * Returns a path for a bare `<path>` or a `bash <path>` / `sh <path>` command; null for any other
 * shape (an inline command, a node script, a multi-token bare command) — we only auto-inject into a
 * shell script we can unambiguously identify.
 */
function resolveScriptPath(command, home) {
  const parts = command.split(/\s+/).filter(Boolean);
  let candidate = null;
  if ((parts[0] === 'bash' || parts[0] === 'sh') && parts.length === 2) {
    candidate = parts[1];
  } else if (parts.length === 1) {
    candidate = parts[0];
  } else {
    return null;
  }
  if (candidate.startsWith('~/')) candidate = path.join(home, candidate.slice(2));
  return candidate;
}

/**
 * Inspect `<home>/.claude/settings.json` for a configured statusline.
 * @returns {{ configured: boolean, command: string|null, scriptPath: string|null }}
 */
function detectStatusLine(home) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  } catch {
    return { configured: false, command: null, scriptPath: null };
  }
  const sl = settings && settings.statusLine;
  const command = sl && typeof sl.command === 'string' && sl.command.trim() ? sl.command.trim() : null;
  if (!command) return { configured: false, command: null, scriptPath: null };
  return { configured: true, command, scriptPath: resolveScriptPath(command, home) };
}

/**
 * Append the sidecar block to an existing statusline script — APPEND-ONLY and idempotent.
 * No-op if the marker is already present; never rewrites or reorders existing content. The script
 * must already exist (we never conjure a statusline — that would risk shadowing the operator's own).
 * @returns {{ injected: boolean, reason?: string, path: string }}
 */
function injectSnippet(scriptPath, docPath) {
  if (!scriptPath) throw new Error('injectSnippet requires a script path');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`statusline script not found: ${scriptPath} — create it (or configure a statusline) first`);
  }
  const current = fs.readFileSync(scriptPath, 'utf8');
  if (current.includes(MARKER_START)) {
    return { injected: false, reason: 'already-present', path: scriptPath };
  }
  const sep = current.length && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(scriptPath, `${sep}\n${snippet(docPath)}`);
  return { injected: true, path: scriptPath };
}

module.exports = {
  snippet,
  detectStatusLine,
  injectSnippet,
  resolveScriptPath,
  MARKER_START,
  MARKER_END,
  STATUSLINE_HINT,
  DOC_PATH,
};
