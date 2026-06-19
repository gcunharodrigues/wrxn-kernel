'use strict';

// WRXN universal CI checks — the pure-node predicates the `wrxn-ci` workflow runs on every PR so CI
// is never a vacuous `true`, even on a repo with no project suite. Each predicate is a deterministic
// function over the install tree returning { name, ok, failures: string[], detail }. The thin
// `wrxn ci` CLI (bin/wrxn.cjs) runs them in the install cwd and exits non-zero on any failure, so the
// SAME tested logic runs in the kernel and in every install. No side effects, node stdlib only.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDeepStrictEqual } = require('util');

const { RECEIPT, MCP_PATH } = require('./install.cjs');
const { loadManifest, inProfile } = require('./manifest.cjs');

function result(name, failures, detail) {
  return { name, ok: failures.length === 0, failures, detail };
}

function readReceipt(root) {
  return JSON.parse(fs.readFileSync(path.join(root, RECEIPT), 'utf8'));
}

// ── managed-integrity ────────────────────────────────────────────────────────
//
// The server-side replacement for the demoted local managed-guard hook: every kernel-managed file must
// byte-match its canonical source in the kernel package payload — i.e. it has not drifted from
// kernel-owned content. The managed SET is anchored to the kernel `manifest.json` (the source of
// truth), NOT to the install's `wrxn.install.json` receipt (CF-2): the receipt is itself unprotected
// and never integrity-checked, so deriving the set from it let an attacker edit a managed file and
// drop/reclassify its receipt entry to pass the check (security MED-1; HIGH if an install ever takes
// untrusted fork PRs). The receipt is trusted only for the install PROFILE (project|workspace), which
// selects which managed files were laid. `.mcp.json` is the one file that is byte-DIVERGENT yet still
// checked: it is managed but operator-MERGED (init/update fold the recon-wrxn server into the
// operator's other servers rather than overwrite), so a blanket byte-equality is wrong AND a blanket
// skip is a hole — an injected/swapped MCP `command` auto-executes on session open (security MED-2 /
// SEC-MED-1, issue 10). Instead it is validated merge-aware (`mcpServerFailures`): every KERNEL-MANAGED
// server entry (the keys in payload/.mcp.json, e.g. recon-wrxn) must deep-equal the payload — the exact
// post-condition of install.cjs `mergeMcpServer` — while operator-ADDED servers (keys not in the
// payload) are the operator's own repo content and pass. A repo with no receipt is not a wrxn install
// (nothing managed to verify) → passes; an UNREADABLE receipt is a real defect → fails.
function managedIntegrity(root, opts) {
  const pkgRoot = (opts && opts.pkgRoot) || path.join(__dirname, '..');
  const receiptPath = path.join(root, RECEIPT);
  if (!fs.existsSync(receiptPath)) {
    return result('managed-integrity', [], 'no wrxn.install.json — not a wrxn install, nothing to verify');
  }
  let receipt;
  try {
    receipt = readReceipt(root);
  } catch (err) {
    return result('managed-integrity', [`${RECEIPT} is unreadable: ${err.message}`], 'receipt corrupt');
  }
  let manifest;
  try {
    manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
  } catch (err) {
    return result('managed-integrity', [`kernel manifest is unreadable: ${err.message}`], 'manifest missing');
  }

  const profile = receipt.profile || 'project';
  const managed = manifest.files.filter((f) => f.class === 'managed');
  const failures = [];
  let checked = 0;
  for (const f of managed) {
    const installed = path.join(root, f.path);
    const canonical = path.join(pkgRoot, 'payload', f.path);
    if (!fs.existsSync(canonical)) continue; // no kernel source to compare against → cannot be drift
    if (!fs.existsSync(installed)) {
      // An in-profile managed file MUST be present; an out-of-profile one is legitimately absent (a
      // project install does not lay workspace files). The profile comes from the receipt, but it can
      // only EXCLUDE a missing-file check — it can never suppress a present, drifted file (below).
      if (inProfile(f.profile, profile)) {
        failures.push(`${f.path} — managed file is missing from the install`);
      }
      continue;
    }
    // Present on disk → it must match the kernel source REGARDLESS of the claimed profile, so a flipped
    // receipt profile cannot hide a tampered workspace-managed file (CF-2 defense-in-depth). `.mcp.json`
    // is operator-MERGED so byte-equality is wrong → validate its kernel-managed server entries instead.
    checked++;
    if (f.path === MCP_PATH) {
      failures.push(...mcpServerFailures(installed, canonical));
    } else if (!fs.readFileSync(installed).equals(fs.readFileSync(canonical))) {
      failures.push(`${f.path} — drifted from the kernel-owned source`);
    }
  }
  return result('managed-integrity', failures, `${checked} managed file(s) checked`);
}

// Merge-aware integrity for the operator-MERGED `.mcp.json`: assert each KERNEL-MANAGED server entry
// (a key present in the payload `.mcp.json`, e.g. recon-wrxn) is present in the install and deep-equals
// the payload — the exact post-condition install.cjs `mergeMcpServer` writes — so a swapped/injected
// launch `command` on a kernel server is caught. Operator-ADDED server keys (absent from the payload)
// are the operator's own repo content and are intentionally NOT judged (no false positive). Corrupt
// install JSON fails closed here too (jsonValidity also catches it). The payload is kernel-trusted; a
// thrown payload parse propagates to the entrypoint (exit non-zero) — fail-closed by design.
function mcpServerFailures(installed, canonical) {
  let install;
  try {
    install = JSON.parse(fs.readFileSync(installed, 'utf8'));
  } catch (err) {
    return [`${MCP_PATH} — invalid JSON: ${err.message}`];
  }
  const payloadServers = (JSON.parse(fs.readFileSync(canonical, 'utf8')) || {}).mcpServers || {};
  const installServers = (install && install.mcpServers) || {};
  const failures = [];
  for (const key of Object.keys(payloadServers)) {
    if (!(key in installServers)) {
      failures.push(`${MCP_PATH} — kernel-managed MCP server "${key}" is missing`);
    } else if (!isDeepStrictEqual(installServers[key], payloadServers[key])) {
      failures.push(`${MCP_PATH} — kernel-managed MCP server "${key}" drifted from the kernel-owned source`);
    }
  }
  return failures;
}

// ── wiki-lint ─────────────────────────────────────────────────────────────────
//
// Every human-prose wiki page must carry a well-formed frontmatter block with the required keys
// (name / description / tier) — the same contract the session-close wiki-lint hook flags, enforced
// here server-side. The machine-written `_rules`/`_slots` tiers are deliberately out of scope (they
// are not human-prose frontmatter). An empty/absent wiki tree passes. Re-implemented inline rather
// than importing the payload hook so lib stays free of payload dependencies.
const WIKI_TIERS = ['concepts', 'decisions', 'gotchas', 'sessions'];
const WIKI_REQUIRED_KEYS = ['name', 'description', 'tier'];

// Return the reason a page is malformed, or null when it is well-formed.
function lintWikiPage(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return 'no frontmatter';
  const end = src.indexOf('\n---', 3);
  if (end < 0) return 'unterminated frontmatter';
  const fm = src.slice(3, end);
  const missing = WIKI_REQUIRED_KEYS.filter((k) => !new RegExp(`^${k}\\s*:`, 'm').test(fm));
  if (missing.length) return `missing ${missing.join('/')}`;
  return null;
}

function wikiLint(root) {
  const failures = [];
  for (const tier of WIKI_TIERS) {
    const dir = path.join(root, '.wrxn', 'wiki', tier);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
    } catch {
      continue; // missing tier → nothing to lint
    }
    for (const name of names) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const reason = lintWikiPage(text);
      if (reason) failures.push(`${tier}/${name} — ${reason}`);
    }
  }
  return result('wiki-lint', failures, failures.length ? `${failures.length} malformed page(s)` : 'wiki frontmatter clean');
}

// ── synapse-manifest lint ─────────────────────────────────────────────────────
//
// The SYNAPSE engine reads `.synapse/manifest` (flat KEY=VALUE) on every prompt and, for each active
// domain, loads its rules from the sibling file `.synapse/<domain-lowercased>`. A manifest that marks
// a domain active but ships no domain file is a silent divergence — the engine reads nothing. This
// lint enforces the contract: the manifest exists and parses, and every active domain (except the
// special CONSTITUTION, whose body is sourced from .claude/constitution.md) has its domain file.
function synapseManifestLint(root) {
  const manifestPath = path.join(root, '.synapse', 'manifest');
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return result('synapse-manifest', ['.synapse/manifest is absent or unreadable'], 'no manifest');
  }

  // Collect the active domains: a line `<NAME>_STATE=active` marks NAME active.
  const active = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(.+)_STATE=(.*)$/);
    if (m && m[2].trim() === 'active') active.add(m[1]);
  }

  if (active.size === 0) {
    return result('synapse-manifest', ['.synapse/manifest declares no active domain'], 'empty manifest');
  }

  const failures = [];
  for (const name of active) {
    if (name === 'CONSTITUTION') continue; // sourced from .claude/constitution.md, not a domain file
    const domainFile = path.join(root, '.synapse', name.toLowerCase());
    if (!fs.existsSync(domainFile)) {
      failures.push(`${name} — active in the manifest but .synapse/${name.toLowerCase()} is missing`);
    }
  }
  return result('synapse-manifest', failures, `${active.size} active domain(s) checked`);
}

// ── JSON validity ─────────────────────────────────────────────────────────────
//
// Every wrxn-owned JSON file in the install must parse. Scope is bounded to the install receipt plus
// the `.json` paths in the manifest (e.g. .mcp.json, .recon-wrxn.json) — never the whole tree, so it
// can't false-positive on node_modules or an operator's own fixtures. A corrupt receipt or a
// hand-broken config is a real defect CI should catch.
function jsonPaths(pkgRoot) {
  const paths = [RECEIPT];
  try {
    const manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
    for (const entry of manifest.files) {
      if (entry.path.endsWith('.json')) paths.push(entry.path);
    }
  } catch {
    /* no manifest reachable → still validate the receipt */
  }
  return paths;
}

function jsonValidity(root, opts) {
  const pkgRoot = (opts && opts.pkgRoot) || path.join(__dirname, '..');
  const failures = [];
  for (const rel of jsonPaths(pkgRoot)) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      failures.push(`${rel} — invalid JSON: ${err.message}`);
    }
  }
  return result('json-validity', failures, `${jsonPaths(pkgRoot).length} json path(s) checked`);
}

// ── node --check syntax ───────────────────────────────────────────────────────
//
// Every wrxn-shipped `.cjs` (the hooks + the .wrxn adapters) must parse — a broken hook fails open
// silently in production, so a syntax error must never reach an install un-caught. Scope is the
// manifest's `.cjs` entries present in the install; each is verified with a real `node --check` (parse
// only, never executed). Returns ok when all parse, else names each offender.
function checkSyntax(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || 'parse error').split('\n').find(Boolean) || 'parse error';
    return detail.trim();
  }
}

function cjsPaths(pkgRoot) {
  try {
    const manifest = loadManifest(path.join(pkgRoot, 'manifest.json'));
    return manifest.files.filter((e) => e.path.endsWith('.cjs')).map((e) => e.path);
  } catch {
    return [];
  }
}

function nodeCheck(root, opts) {
  const pkgRoot = (opts && opts.pkgRoot) || path.join(__dirname, '..');
  const failures = [];
  let checked = 0;
  for (const rel of cjsPaths(pkgRoot)) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    checked++;
    const err = checkSyntax(p);
    if (err) failures.push(`${rel} — ${err}`);
  }
  return result('node-check', failures, `${checked} .cjs file(s) parsed`);
}

// ── the universal gate ────────────────────────────────────────────────────────
//
// Run every universal check over an install root. This is the gate the `wrxn ci` CLI (and thus the
// wrxn-ci workflow) invokes — independent of any project suite, so even a no-suite repo gets a real,
// fail-able check. ok is the AND of all checks. The project `WRXN_TEST_CMD` runs as its own workflow
// step (skipped when `true`/empty), NOT here — these are the kernel-universal checks only.
function runChecks(root, opts) {
  const o = opts || {};
  const results = [
    managedIntegrity(root, o),
    wikiLint(root),
    synapseManifestLint(root),
    jsonValidity(root, o),
    nodeCheck(root, o),
  ];
  return { ok: results.every((r) => r.ok), results };
}

module.exports = { managedIntegrity, wikiLint, synapseManifestLint, jsonValidity, nodeCheck, runChecks };
