#!/usr/bin/env node
'use strict';

// WRXN managed hook — Constitution Article I (Agent Authority).
// PreToolUse:Bash gate: a remote git op (push / PR / tag push) is allowed only when
// the session declares the devops role via WRXN_ACTIVE_AGENT=devops. A bare push runs
// as @unknown and is denied. Fails OPEN on any internal error (never over-blocks).
//
// Contract: reads a PreToolUse hook event as JSON on stdin, writes a decision to stdout.
//   allow → {} (exit 0)
//   deny  → { "decision": "block", "reason": "..." } (exit 0; the harness blocks the call)

const REMOTE_OP = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge)\b|\bgit\s+push\s+.*--tags\b/;

function main() {
  let input = '';
  try {
    input = require('fs').readFileSync(0, 'utf8');
  } catch {
    return emit({}); // no stdin → nothing to gate
  }

  let event;
  try {
    event = JSON.parse(input || '{}');
  } catch {
    return emit({}); // unparseable → fail open
  }

  const command = (event.tool_input && event.tool_input.command) || '';
  if (!REMOTE_OP.test(command)) {
    return emit({}); // not a remote op
  }

  if (process.env.WRXN_ACTIVE_AGENT === 'devops') {
    return emit({}); // authorized
  }

  return emit({
    decision: 'block',
    reason:
      'Remote git op is devops-exclusive (Constitution Art. I). Re-run with WRXN_ACTIVE_AGENT=devops, or delegate to the devops role.',
  });
}

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
}

main();
