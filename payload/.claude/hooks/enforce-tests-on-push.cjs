#!/usr/bin/env node
'use strict';

// WRXN managed hook — Quality-First (Art. III): a red suite blocks a push.
// PreToolUse:Bash. On a `git push`, runs the configured test command in the install root and
// blocks on a non-zero exit. WRXN_TEST_CMD (default "npm test") is OPERATOR config, not event
// data — it is intentionally a shell command line, so a shell is appropriate here.

const fs = require('fs');
const { execSync } = require('child_process');

function emit(decision) {
  process.stdout.write(JSON.stringify(decision));
  process.exit(0);
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

  const testCmd = process.env.WRXN_TEST_CMD || 'npm test';
  try {
    execSync(testCmd, { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), stdio: 'ignore' });
    return emit({});
  } catch {
    return emit({
      decision: 'block',
      reason: `Push blocked: the test suite is red (\`${testCmd}\` exited non-zero). Green it first (Constitution Art. III, Quality-First).`,
    });
  }
}

main();
