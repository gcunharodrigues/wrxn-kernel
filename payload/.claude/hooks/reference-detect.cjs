#!/usr/bin/env node
'use strict';

// WRXN reference-detect hook — the capture-nudge (wrxn-kernel-11).
// UserPromptSubmit. Scans the prompt for reference SIGNALS (URLs + explicit source markers) and,
// ONLY when one is present, injects a <reference-candidate> nudge telling the agent to OFFER to
// capture the reference into the wiki WITH provenance. PROPOSE-then-CONFIRM — it never ingests
// anything itself (the operator's chosen mode). Gated → silent on the vast majority of prompts.
//
// Self-contained: ships into installs, MUST NOT import the kernel lib (node stdlib only).
// Fail-open: any fault emits {} — the hook NEVER blocks a prompt.
//
// Contract: UserPromptSubmit event JSON on stdin → envelope JSON on stdout (exit 0).

const fs = require('fs');
const path = require('path');

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]]+/gi;
// Single-word markers are colon-anchored so "open source" / "for reference" do NOT trigger.
const MARKER_RE = /(?:\b(?:source|reference|cite)\s*:|\b(?:per the|according to|this is from|based on)\b)/i;
const MAX_URLS = 5;
const MAX_BLOCK_CHARS = 500;

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope));
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

function detect(prompt) {
  const text = String(prompt || '');
  const urls = (text.match(URL_RE) || []).map((u) => u.replace(/[.,;:!?"']+$/, ''));
  return { urls: [...new Set(urls)].slice(0, MAX_URLS), hasMarker: MARKER_RE.test(text) };
}

function nudge(sig) {
  const parts = [];
  if (sig.urls.length) parts.push(`URL(s): ${sig.urls.join(', ')}`);
  if (sig.hasMarker) parts.push('an explicit source/reference marker');
  const block = [
    '<reference-candidate>',
    `Detected ${parts.join(' + ')} in this prompt.`,
    'If the operator means these as references to KEEP, OFFER to capture them into the wiki WITH',
    'provenance (propose-then-confirm — NEVER auto-ingest). On confirmation:',
    '  node .wrxn/wiki.cjs write-page concepts <slug> --description "<what>" --body "source: <url-or-origin>"',
    '</reference-candidate>',
  ].join('\n');
  return block.length <= MAX_BLOCK_CHARS ? block : `${block.slice(0, MAX_BLOCK_CHARS - 24)}\n…\n</reference-candidate>`;
}

function main() {
  let event = {};
  try {
    const stdin = fs.readFileSync(0, 'utf8');
    if (stdin.trim()) event = JSON.parse(stdin);
  } catch {
    emit({});
  }

  if (!findInstallRoot()) emit({}); // install-scoped — silent outside an install

  const prompt = typeof event.prompt === 'string' ? event.prompt : '';
  const sig = detect(prompt);
  if (!sig.urls.length && !sig.hasMarker) emit({}); // no signal → silent (the gate)

  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: nudge(sig) } });
}

try {
  main();
} catch {
  emit({});
}
