'use strict';

// WRXN ship — the autonomous promote path (gate-redesign gate-03).
//
// Replaces the WRXN_ACTIVE_AGENT / settings.local.json env-flag dance (a 2026-06-19 audit proved
// it a live no-op) with ONE command that pushes a reviewed branch, opens a PR, and arms
// auto-merge — GitHub then merges the instant the server-enforced CI gate is green. No env flag,
// no settings.local.json, no GitHub clicks.
//
// buildShipPlan() is PURE: branch/title in → the ordered git + gh command list out (no side
// effects). It mirrors lib/connect.cjs's split of a pure description from its invocation.
//
// lib/ship.cjs is package code (invoked via bin/wrxn.cjs), NOT payload — no manifest entry,
// consistent with lib/connect.cjs / lib/executor.cjs / lib/onboard.cjs.

const { spawnSync } = require('child_process');

const REMOTE = 'origin';
const DEFAULT_BASE = 'main';

/**
 * Build the ordered promote command list for a reviewed branch. PURE — no side effects.
 * branch → push (publish the branch to origin) → gh pr create → gh pr merge --auto --squash.
 * @returns {{ label:string, cmd:string, args:string[] }[]}
 * @throws when branch or title is missing/blank — a malformed promote is never runnable.
 */
function buildShipPlan({ branch, title, base = DEFAULT_BASE, body = '' } = {}) {
  const errors = [];
  if (typeof branch !== 'string' || branch.trim() === '') errors.push('branch is required (the reviewed branch to promote)');
  if (typeof title !== 'string' || title.trim() === '') errors.push('title is required (the PR title)');
  if (errors.length) throw new Error(`cannot build ship plan: ${errors.join('; ')}`);
  return [
    { label: 'push', cmd: 'git', args: ['push', '-u', REMOTE, branch] },
    { label: 'pr-create', cmd: 'gh', args: ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body || ''] },
    { label: 'auto-merge', cmd: 'gh', args: ['pr', 'merge', branch, '--auto', '--squash'] },
  ];
}

/**
 * The real command invoker — a single spawnSync, mirroring lib/connect.cjs's defaultInvoke. The
 * CLI layer wires this (a real git/gh invocation), which is what makes the promote "validated by
 * invocation". A step succeeds iff it actually ran (not ENOENT) and exited 0.
 * @returns {{ ok:boolean, detail:string, status?:number }}
 */
function defaultInvoke(step) {
  const r = spawnSync(step.cmd, step.args, { encoding: 'utf8' });
  if (r.error) {
    return { ok: false, detail: `${step.cmd} ${step.args.join(' ')} did not run: ${r.error.code || r.error.message}` };
  }
  const tail = r.stderr ? `: ${String(r.stderr).trim()}` : '';
  return { ok: r.status === 0, status: r.status, detail: `${step.cmd} ${step.args[0]} exited ${r.status}${tail}` };
}

/**
 * Run the promote plan through the injected invoker (defaults to the real defaultInvoke at the CLI
 * layer). Reuses lib/connect.cjs's injectable-invoker shape so unit tests stay deterministic.
 * @returns {{ ok:boolean, steps:{step:string,ok:boolean,detail:string}[], failed?:string }}
 */
function ship({ invoker, branch, title, base, body } = {}) {
  const plan = buildShipPlan({ branch, title, base, body });
  const run = invoker || defaultInvoke;
  const steps = [];
  for (const step of plan) {
    const r = run(step);
    steps.push({ step: step.label, ok: !!r.ok, detail: r.detail });
    if (!r.ok) return { ok: false, steps, failed: step.label };
  }
  return { ok: true, steps };
}

module.exports = { buildShipPlan, defaultInvoke, ship, REMOTE, DEFAULT_BASE };
