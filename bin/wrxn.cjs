#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { init } = require('../lib/install.cjs');

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

  if (cmd === 'init') {
    // An explicit --root must carry a real path. An empty/missing value (e.g. an
    // unset shell var expanding to "") must NOT silently fall through to cwd — that
    // footgun lays the payload into whatever dir you happen to be standing in.
    if ('root' in args.flags) {
      const r = args.flags.root;
      if (typeof r !== 'string' || r.trim() === '') {
        process.stderr.write('wrxn: --root requires a non-empty directory path\n');
        return 2;
      }
    }
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

  process.stderr.write(`wrxn: unknown command "${cmd}"\n\n${USAGE}\n`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
