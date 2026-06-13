#!/usr/bin/env node
'use strict';

// WRXN managed hook — the review-gate: a push referencing an unreviewed issue BLOCKS.
// PreToolUse:Bash. On a `git push`, scans the pushed commit messages for bracketed issue ids
// `[id]` and requires a review marker `review-<id>.md` in the markers dir for each. Missing → block.
// Self-contained; shell-free git via execFileSync.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

function pushedMessages(cwd) {
  // Prefer an explicit range, then the upstream range, then the last commit as a floor.
  const ranges = [process.env.WRXN_PUSH_RANGE, '@{u}..HEAD'].filter(Boolean);
  for (const r of ranges) {
    try {
      return execFileSync('git', ['log', r, '--format=%B'], { cwd, encoding: 'utf8' });
    } catch {
      /* try next */
    }
  }
  try {
    return execFileSync('git', ['log', '-1', '--format=%B'], { cwd, encoding: 'utf8' });
  } catch {
    return '';
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return emit({});
  }

  const command = (event.tool_input && event.tool_input.command) || '';
  if (!/\bgit\s+push\b/.test(command)) return emit({});

  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const messages = pushedMessages(cwd);
  const ids = [...new Set((messages.match(/\[([a-z0-9][a-z0-9._-]*)\]/gi) || []).map((s) => s.slice(1, -1)))];
  if (ids.length === 0) return emit({}); // no issue referenced → nothing to gate

  const markersRel = process.env.WRXN_REVIEW_MARKERS_DIR || '.claude/ai/output';
  const dir = path.join(cwd, markersRel);
  const missing = ids.filter((id) => !fs.existsSync(path.join(dir, `review-${id}.md`)));
  if (missing.length === 0) return emit({});

  return emit({
    decision: 'block',
    reason: `Push blocked: issue id(s) ${missing.join(', ')} in the pushed commits have no review marker (expected review-<id>.md in ${markersRel}). Run the review and write the marker first.`,
  });
}

main();
