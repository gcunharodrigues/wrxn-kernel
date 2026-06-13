#!/usr/bin/env node
'use strict';

// WRXN session-history hook — the turn-trail recorder (wrxn-kernel-10).
// UserPromptSubmit. Appends one `<iso>\t<first-line>` record per turn to the session's trail
// at .wrxn/history/<sid>.trail. SessionEnd reads this trail to build the durable session page.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Pass-through recorder: it NEVER injects context and NEVER blocks — always emits {} (exit 0).
// Fail-open: any fault still emits {}.
//
// Contract: UserPromptSubmit event JSON on stdin → {} on stdout (exit 0). Side effect: trail append.

const fs = require('fs');
const path = require('path');

function emitEmpty() {
  process.stdout.write('{}');
  process.exit(0);
}

function findInstallRoot(startDir) {
  let dir = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'wrxn.install.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function nowISO() {
  return process.env.WRXN_NOW || new Date().toISOString();
}

function safeId(sid) {
  return String(sid || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    emitEmpty();
  }

  const root = findInstallRoot();
  if (!root) emitEmpty();

  const sid = safeId(event.session_id);
  const prompt = String(event.prompt || '').split('\n')[0].slice(0, 200).replace(/\t/g, ' ').trim();
  if (prompt) {
    try {
      const dir = path.join(root, '.wrxn', 'history');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${sid}.trail`), `${nowISO()}\t${prompt}\n`);
    } catch {
      /* trail append is best-effort — never block the prompt */
    }
  }

  emitEmpty();
}

try {
  main();
} catch {
  emitEmpty();
}
