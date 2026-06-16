#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { init } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const worktree = require('../lib/worktree.cjs');
const executor = require('../lib/executor.cjs');
const onboard = require('../lib/onboard.cjs');
const connect = require('../lib/connect.cjs');
const statusline = require('../lib/statusline.cjs');
const { convert } = require('../lib/convert.cjs');
const { ingest } = require('../lib/ingest.cjs');

const PKG_ROOT = path.join(__dirname, '..');

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      args.flags.version = true;
    } else if (a === '--help' || a === '-h') {
      args.flags.help = true;
    } else if (a === '--project') {
      args.flags.profile = 'project';
    } else if (a === '--workspace') {
      args.flags.profile = 'workspace';
    } else if (a === '--root') {
      args.flags.root = argv[++i];
    } else if (a === '--base') {
      args.flags.base = argv[++i];
    } else if (a === '--path') {
      args.flags.path = argv[++i];
    } else if (a === '--executor') {
      args.flags.executor = argv[++i];
    } else if (a === '--transport') {
      args.flags.transport = argv[++i];
    } else if (a === '--command') {
      args.flags.command = argv[++i];
    } else if (a === '--args') {
      args.flags.args = argv[++i];
    } else if (a === '--scopes') {
      args.flags.scopes = argv[++i];
    } else if (a === '--credential') {
      args.flags.credential = argv[++i];
    } else if (a === '--owner') {
      args.flags.owner = argv[++i];
    } else if (a === '--probe') {
      args.flags.probe = argv[++i];
    } else if (a === '--distillation') {
      args.flags.distillation = argv[++i];
    } else if (a === '--check-report') {
      args.flags['check-report'] = true;
    } else if (a.startsWith('--')) {
      args.flags[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const USAGE = `wrxn — WRXN Kernel installer

Usage:
  wrxn --version                 print the kernel version
  wrxn init [--project] [--root <dir>]
                                 lay the kernel payload into <dir> (default: cwd).
                                 brownfield-safe: an existing file is never overwritten —
                                 it is preserved and reported as a collision.
  wrxn update [--root <dir>]     update an install: replace managed files, keep
                                 seeded + state; refuses a downgrade
  wrxn worktree <sub> [--root <repo>] [--base <branch>] [--path <dir>]
                                 worktree lifecycle (two faces, one engine):
      list                       show the repo's worktrees
      add <name>                 ephemeral AFK track on track/<name> (temp path, off base)
      new <name>                 named durable worktree on wt/<name> (persistent path)
      status <name>              clean/dirty + ahead/behind for a worktree
      integrate <name>          merge <name> back to base, then auto-prune
      prune <name> [--force]    remove a worktree + branch (refuses unmerged unless --force)
      check <tracks.json>       refuse an overlapping disjoint-file split
  wrxn dispatch <issue-file> [--executor <type>]
                                 print the dispatch spec for a ready-for-agent issue — the
                                 structured order a thin subagent of <type> follows (skill or
                                 instructions, ACs, isolation, boundary gates). <type> is one of:
                                 builder (default) | reviewer | security | qa-walker | researcher |
                                 devops. Only devops passes the push gate.
  wrxn dispatch --check-report <report.json> [--executor <type>]
                                 validate an executor's structured report against the contract +
                                 boundary gates (rejects a non-devops report that claims a push)

  wrxn connect <sub> [--root <dir>]
                                 connections registry — the workspace nervous system. MCP is the
                                 socket, CLI is the floor, credentials are state.
      add <name> --transport <mcp|cli> --command <cmd> [--args a,b] [--scopes a,b]
                 [--credential env:NAME|state:relpath] [--owner who] [--probe <arg>]
                                 register a tool only AFTER validating its interface by invocation;
                                 an unreachable interface is rejected. Stores the credential POINTER,
                                 never the secret (registry is per-install state, never shipped).
      list                       print all registered connections (agent-readable JSON)
      get <name>                 print one connection by name

  wrxn statusline [--inject [--path <script>]]
                                 SYNAPSE live-window writer. With no flag: report whether a statusline
                                 is configured (~/.claude/settings.json) + print the marker-bounded
                                 sidecar block + how to enable. With --inject: append the block to the
                                 resolved (or --path) statusline script, idempotently (append-only,
                                 never overwrites). init NEVER touches your statusline.

  wrxn convert <file> [--cpu]    convert a source file to Markdown and print it. Per-format routing:
                                 markitdown (html/docx/txt/pptx/xlsx) · docling (pdf, with automatic
                                 CPU fallback on a GPU arch-crash) · pure-JS floor when Python is
                                 absent. --cpu forces docling onto CPU from the first attempt.

  wrxn ingest <file> [--distillation <result.json>] [--root <dir>]
                                 distill a source into the memory wiki: convert (slice 05) → an LLM
                                 (the ingest skill) produces a summary + N note pages → write them
                                 to .wrxn/wiki/, each stamped derived_from the raw source, which is
                                 kept under .wrxn/raw/. ADDITIVE-ONLY: an existing page is never
                                 overwritten (re-runs are safe). --distillation feeds the skill's
                                 result JSON (summary,notes); without it, the harness points you at
                                 the ingest skill.

  wrxn onboard [--root <dir>]    scaffold the Day-1 operator file set under context/ from a filled
                                 aios-intake.md (the deterministic half of the onboard skill;
                                 workspace installs only). Idempotent.

Profiles: --project (default, the dev pipeline + intelligence + enforcement) |
          --workspace (adds the operator layer: onboard/audit/level-up + intake + decisions log +
          connections registry).`;

async function main(argv) {
  const args = parseArgs(argv);

  if (args.flags.version) {
    process.stdout.write(version() + '\n');
    return 0;
  }

  const cmd = args._[0];

  if (!cmd || args.flags.help) {
    process.stdout.write(USAGE + '\n');
    return cmd ? 0 : (args.flags.help ? 0 : 2);
  }

  // An explicit --root must carry a real path. An empty/missing value (e.g. an unset
  // shell var expanding to "") must NOT silently fall through to cwd — that footgun
  // writes into whatever dir you happen to be standing in. Shared by init + update.
  if ('root' in args.flags) {
    const r = args.flags.root;
    if (typeof r !== 'string' || r.trim() === '') {
      process.stderr.write('wrxn: --root requires a non-empty directory path\n');
      return 2;
    }
  }

  if (cmd === 'init') {
    const target = path.resolve(args.flags.root || process.cwd());
    const profile = args.flags.profile || 'project';
    const report = init({ pkgRoot: PKG_ROOT, target, profile });
    process.stdout.write(`wrxn init (${profile}) → ${target}\n`);
    for (const f of report.laid) {
      process.stdout.write(`  laid    [${f.class}] ${f.path}\n`);
    }
    for (const f of report.skipped) {
      process.stdout.write(`  skipped [${f.class}] ${f.path} (${f.collision ? 'collision — existing file preserved' : 'exists'})\n`);
    }
    for (const f of report.merged || []) {
      process.stdout.write(`  merged  [${f.class}] ${f.path} (recon-wrxn server added to your existing config)\n`);
    }
    process.stdout.write(`${report.laid.length} laid, ${report.skipped.length} unchanged${report.merged && report.merged.length ? `, ${report.merged.length} merged` : ''}.\n`);
    if (report.brownfield) {
      process.stdout.write(`brownfield install — ${report.collisions.length} existing file(s) preserved (never overwritten): ${report.collisions.map((c) => c.path).join(', ')}\n`);
    }
    if (report.adoptHint) {
      process.stdout.write(`${report.adoptHint}\n`);
    }
    if (report.statuslineHint) {
      process.stdout.write(`${report.statuslineHint}\n`);
    }
    return 0;
  }

  if (cmd === 'update') {
    const target = path.resolve(args.flags.root || process.cwd());
    let report;
    try {
      report = update({ pkgRoot: PKG_ROOT, target });
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
    process.stdout.write(`wrxn update ${report.from} → ${report.to} (${target})\n`);
    for (const f of report.updated) {
      process.stdout.write(`  ${f.reason === 'new-in-version' ? 'added  ' : 'updated'} [${f.class}] ${f.path}\n`);
    }
    for (const f of report.preserved) {
      process.stdout.write(`  kept    [${f.class}] ${f.path}\n`);
    }
    process.stdout.write(`${report.updated.length} updated, ${report.preserved.length} kept.\n`);
    if (report.migrationsRan && report.migrationsRan.length) {
      process.stdout.write(`migrations applied: ${report.migrationsRan.join(', ')}\n`);
    }
    return 0;
  }

  if (cmd === 'worktree') {
    const sub = args._[1];
    const repo = path.resolve(args.flags.root || process.cwd());
    const base = args.flags.base || 'main';
    const name = args._[2];
    // A name resolves to a named (wt/) worktree if one exists, else the ephemeral (track/) face.
    const detectPrefix = (n) => worktree.listWorktrees(repo).some((w) => w.branch === worktree.NAMED_PREFIX + n)
      ? worktree.NAMED_PREFIX : worktree.BRANCH_PREFIX;
    try {
      if (sub === 'list') {
        for (const w of worktree.listWorktrees(repo)) {
          process.stdout.write(`  ${w.branch || '(detached)'}\t${w.path}\n`);
        }
        return 0;
      }
      if (sub === 'add') {
        if (!name) { process.stderr.write('wrxn: worktree add requires <name>\n'); return 2; }
        const r = worktree.createWorktree(repo, name, { base, path: args.flags.path });
        process.stdout.write(`worktree ${r.branch} → ${r.path}\n`);
        return 0;
      }
      if (sub === 'new') {
        if (!name) { process.stderr.write('wrxn: worktree new requires <name>\n'); return 2; }
        const r = worktree.createNamedWorktree(repo, name, { base, path: args.flags.path });
        process.stdout.write(`named worktree ${r.branch} → ${r.path}\n`);
        return 0;
      }
      if (sub === 'status') {
        if (!name) { process.stderr.write('wrxn: worktree status requires <name>\n'); return 2; }
        const s = worktree.worktreeStatus(repo, name, { base, prefix: detectPrefix(name) });
        process.stdout.write(`${s.branch}\t${s.clean ? 'clean' : 'dirty'}\tahead ${s.ahead}, behind ${s.behind}\t${s.path || '(no worktree)'}\n`);
        return 0;
      }
      if (sub === 'integrate') {
        if (!name) { process.stderr.write('wrxn: worktree integrate requires <name>\n'); return 2; }
        const r = worktree.integrateWorktree(repo, name, { base, prefix: detectPrefix(name) });
        process.stdout.write(`integrated ${r.branch} → ${r.base}, worktree + branch pruned\n`);
        return 0;
      }
      if (sub === 'prune') {
        if (!name) { process.stderr.write('wrxn: worktree prune requires <name>\n'); return 2; }
        const r = worktree.pruneWorktree(repo, name, { base, force: !!args.flags.force, prefix: detectPrefix(name) });
        process.stdout.write(`pruned ${r.branch}${r.forced ? ' (forced)' : ''}\n`);
        return 0;
      }
      if (sub === 'check') {
        const spec = args._[2];
        if (!spec) { process.stderr.write('wrxn: worktree check requires <tracks.json>\n'); return 2; }
        const tracks = JSON.parse(fs.readFileSync(path.resolve(spec), 'utf8'));
        worktree.verifyDisjoint(tracks);
        process.stdout.write(`disjoint OK (${tracks.length} tracks)\n`);
        return 0;
      }
      process.stderr.write(`wrxn: unknown worktree subcommand "${sub || ''}"\n\n${USAGE}\n`);
      return 2;
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
  }

  if (cmd === 'dispatch') {
    const file = args._[1];
    if (!file) { process.stderr.write('wrxn: dispatch requires <issue-file> (or --check-report <report.json>)\n'); return 2; }
    const type = args.flags.executor || 'builder';
    if (!executor.EXECUTOR_TYPES.includes(type)) {
      process.stderr.write(`wrxn: unknown executor "${type}" (one of ${executor.EXECUTOR_TYPES.join(', ')})\n`);
      return 2;
    }
    // --check-report <report.json>: validate an executor's structured report against the contract + gates.
    if (args.flags['check-report']) {
      let report;
      try {
        report = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      } catch (err) {
        process.stderr.write(`wrxn: cannot read report: ${err.message}\n`);
        return 2;
      }
      const result = executor.validateReport(report, type);
      if (result.ok) {
        process.stdout.write('report OK\n');
        return 0;
      }
      process.stderr.write(`report INVALID:\n${result.errors.map((e) => `  - ${e}`).join('\n')}\n`);
      return 2;
    }
    // Default: print the dispatch spec for the issue (what the subagent of this type is ordered to do).
    let issueText;
    try {
      issueText = fs.readFileSync(path.resolve(file), 'utf8');
    } catch (err) {
      process.stderr.write(`wrxn: cannot read issue: ${err.message}\n`);
      return 2;
    }
    process.stdout.write(JSON.stringify(executor.buildDispatchSpec(issueText, type), null, 2) + '\n');
    return 0;
  }

  if (cmd === 'convert') {
    const file = args._[1];
    if (!file) { process.stderr.write('wrxn: convert requires <file>\n'); return 2; }
    try {
      const md = await convert(path.resolve(file), { gpu: args.flags.cpu ? false : undefined });
      process.stdout.write(md.endsWith('\n') ? md : md + '\n');
      return 0;
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
  }

  if (cmd === 'ingest') {
    const file = args._[1];
    if (!file) { process.stderr.write('wrxn: ingest requires <file>\n'); return 2; }
    const root = path.resolve(args.flags.root || process.cwd());
    // The distillation is the LLM step (the `ingest` skill). The CLI feeds its structured result via
    // --distillation <result.json>; without one, the harness's defaultDistill points back to the skill.
    let distill;
    if (args.flags.distillation) {
      const dpath = path.resolve(args.flags.distillation);
      distill = () => JSON.parse(fs.readFileSync(dpath, 'utf8'));
    }
    try {
      const report = await ingest(path.resolve(file), { root, ...(distill ? { distill } : {}) });
      process.stdout.write(`wrxn ingest ${report.source} → raw ${report.raw}\n`);
      for (const p of report.written) process.stdout.write(`  wrote   ${p}\n`);
      for (const p of report.skipped) process.stdout.write(`  skipped ${p} (exists — additive-only, never clobbered)\n`);
      process.stdout.write(`${report.written.length} written, ${report.skipped.length} skipped.\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
  }

  if (cmd === 'onboard') {
    const root = path.resolve(args.flags.root || process.cwd());
    let report;
    try {
      report = onboard.scaffold(root);
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
    process.stdout.write(`wrxn onboard → ${root}\n`);
    for (const f of report.scaffolded) process.stdout.write(`  scaffolded ${f}\n`);
    for (const f of report.skipped) process.stdout.write(`  skipped    ${f} (no filled intake answer)\n`);
    process.stdout.write(`${report.scaffolded.length} scaffolded, ${report.skipped.length} skipped.\n`);
    return 0;
  }

  if (cmd === 'connect') {
    const sub = args._[1];
    const root = path.resolve(args.flags.root || process.cwd());
    try {
      if (sub === 'add') {
        const name = args._[2];
        if (!name) { process.stderr.write('wrxn: connect add requires <name>\n'); return 2; }
        const entry = {
          name,
          transport: args.flags.transport,
          command: args.flags.command,
          scopes: args.flags.scopes ? String(args.flags.scopes).split(',').map((s) => s.trim()).filter(Boolean) : [],
          credential: args.flags.credential || null,
          owner: args.flags.owner || null,
        };
        if (args.flags.probe) entry.probe = args.flags.probe;
        // An mcp socket launcher usually needs args (e.g. `node <server> serve`). Comma-separated.
        if (args.flags.args) entry.args = String(args.flags.args).split(',').map((s) => s.trim()).filter(Boolean);
        const res = connect.registerConnection(root, entry);
        process.stdout.write(`connected ${res.entry.name} [${res.entry.transport}] — ${res.validated.detail}\n`);
        process.stdout.write(`  credential: ${res.entry.credential || '(none)'} → ${res.credential.resolved ? 'resolved' : 'UNRESOLVED'}\n`);
        return 0;
      }
      if (sub === 'list') {
        process.stdout.write(JSON.stringify(connect.listConnections(root), null, 2) + '\n');
        return 0;
      }
      if (sub === 'get') {
        const name = args._[2];
        if (!name) { process.stderr.write('wrxn: connect get requires <name>\n'); return 2; }
        const found = connect.findConnection(root, name);
        if (!found) { process.stderr.write(`wrxn: no connection named "${name}"\n`); return 2; }
        process.stdout.write(JSON.stringify(found, null, 2) + '\n');
        return 0;
      }
      process.stderr.write(`wrxn: unknown connect subcommand "${sub || ''}"\n\n${USAGE}\n`);
      return 2;
    } catch (err) {
      process.stderr.write(`wrxn: ${err.message}\n`);
      return 2;
    }
  }

  if (cmd === 'statusline') {
    const home = process.env.HOME || os.homedir();
    const detection = statusline.detectStatusLine(home);

    // --inject: append the sidecar block to the resolved (or --path) statusline script, idempotently.
    if (args.flags.inject) {
      const target = args.flags.path || detection.scriptPath;
      if (!target) {
        process.stderr.write('wrxn: no statusline script to inject into — pass --path <script>, or configure statusLine in ~/.claude/settings.json first\n');
        return 2;
      }
      try {
        const r = statusline.injectSnippet(target);
        process.stdout.write(r.injected
          ? `wrxn sidecar appended to ${r.path}\n`
          : `wrxn sidecar already present in ${r.path} — no change\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`wrxn: ${err.message}\n`);
        return 2;
      }
    }

    // Default: report detection + print the snippet + how to enable.
    if (detection.configured) {
      process.stdout.write(`statusline detected: ${detection.command}\n`);
      process.stdout.write(detection.scriptPath
        ? `  script: ${detection.scriptPath}\n`
        : '  (not a bash <path> command — cannot auto-resolve a script to inject into)\n');
    } else {
      process.stdout.write('no statusline configured in ~/.claude/settings.json\n');
    }
    process.stdout.write('\nThe SYNAPSE live-window block (host statusline must read stdin into $input and set $session_id):\n\n');
    process.stdout.write(statusline.snippet() + '\n');
    process.stdout.write(detection.scriptPath
      ? `Enable: wrxn statusline --inject   (appends idempotently to ${detection.scriptPath})\n`
      : 'Enable: wrxn statusline --inject --path <your-statusline-script>\n');
    return 0;
  }

  process.stderr.write(`wrxn: unknown command "${cmd}"\n\n${USAGE}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { process.stderr.write(`wrxn: ${err && err.message ? err.message : err}\n`); process.exit(1); }
);
