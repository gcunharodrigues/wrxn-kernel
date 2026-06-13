#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { init } = require('../lib/install.cjs');
const { update } = require('../lib/update.cjs');
const worktree = require('../lib/worktree.cjs');

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
                                 lay the kernel payload into <dir> (default: cwd)
  wrxn update [--root <dir>]     update an install: replace managed files, keep
                                 seeded + state; refuses a downgrade
  wrxn worktree <sub> [--root <repo>] [--base <branch>]
                                 ephemeral AFK track lifecycle:
      list                       show the repo's worktrees
      add <name>                 create an ephemeral worktree on track/<name> off base
      integrate <name>          merge track/<name> back to base, then auto-prune
      prune <name> [--force]    remove a worktree + branch (refuses unmerged unless --force)
      check <tracks.json>       refuse an overlapping disjoint-file split

Profiles: --project (default). --workspace lands in a later release.`;

function main(argv) {
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
    if (profile === 'workspace') {
      process.stderr.write('wrxn: --workspace profile is not in this release; use --project\n');
      return 2;
    }
    const report = init({ pkgRoot: PKG_ROOT, target, profile });
    process.stdout.write(`wrxn init (${profile}) → ${target}\n`);
    for (const f of report.laid) {
      process.stdout.write(`  laid    [${f.class}] ${f.path}\n`);
    }
    for (const f of report.skipped) {
      process.stdout.write(`  skipped [${f.class}] ${f.path} (exists)\n`);
    }
    process.stdout.write(`${report.laid.length} laid, ${report.skipped.length} unchanged.\n`);
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
    return 0;
  }

  if (cmd === 'worktree') {
    const sub = args._[1];
    const repo = path.resolve(args.flags.root || process.cwd());
    const base = args.flags.base || 'main';
    const name = args._[2];
    try {
      if (sub === 'list') {
        for (const w of worktree.listWorktrees(repo)) {
          process.stdout.write(`  ${w.branch || '(detached)'}\t${w.path}\n`);
        }
        return 0;
      }
      if (sub === 'add') {
        if (!name) { process.stderr.write('wrxn: worktree add requires <name>\n'); return 2; }
        const r = worktree.createWorktree(repo, name, { base });
        process.stdout.write(`worktree ${r.branch} → ${r.path}\n`);
        return 0;
      }
      if (sub === 'integrate') {
        if (!name) { process.stderr.write('wrxn: worktree integrate requires <name>\n'); return 2; }
        const r = worktree.integrateWorktree(repo, name, { base });
        process.stdout.write(`integrated ${r.branch} → ${r.base}, worktree + branch pruned\n`);
        return 0;
      }
      if (sub === 'prune') {
        if (!name) { process.stderr.write('wrxn: worktree prune requires <name>\n'); return 2; }
        const r = worktree.pruneWorktree(repo, name, { force: !!args.flags.force });
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

  process.stderr.write(`wrxn: unknown command "${cmd}"\n\n${USAGE}\n`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
