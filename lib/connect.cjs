'use strict';

// WRXN connect + connections registry (wrxn-kernel-21) — the workspace nervous system.
//
// A schema'd registry of every interface the AIOS can reach, plus a `connect` command that
// REGISTERS a tool only after VALIDATING its interface by invocation. The governing rule:
//   MCP is the socket, CLI is the floor, credentials are state.
// - transport 'mcp'  → a socket: a stdio launch command that must spawn (the socket opens).
// - transport 'cli'  → a floor: a binary that must run when probed.
// - credential       → a POINTER into state (env:NAME | state:relpath), never the secret value.
//                      The secret is NEVER stored in the registry and NEVER shipped.
//
// The registry lives in the install's STATE tier (.wrxn/connections.json) — never in the payload,
// so it is per-install and never published. It is agent-readable structured JSON (lookup, not a
// briefing): findConnection / listConnections.
//
// lib/connect.cjs is package code (invoked via bin/wrxn.cjs), NOT payload — no manifest entry,
// consistent with lib/executor.cjs and lib/onboard.cjs.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TRANSPORTS = ['mcp', 'cli'];
const REGISTRY_REL = path.join('.wrxn', 'connections.json');
const PROBE_TIMEOUT_MS = 5000;

/**
 * Validate a registry entry against the schema.
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateEntry(entry) {
  const errors = [];
  const e = entry || {};
  if (typeof e.name !== 'string' || e.name.trim() === '') {
    errors.push('name is required (non-empty string)');
  }
  if (!TRANSPORTS.includes(e.transport)) {
    errors.push(`transport must be one of ${TRANSPORTS.join('|')} (got ${JSON.stringify(e.transport)})`);
  }
  if (typeof e.command !== 'string' || e.command.trim() === '') {
    errors.push('command is required (the mcp socket launcher or the cli binary to invoke)');
  }
  if ('scopes' in e && !Array.isArray(e.scopes)) {
    errors.push('scopes must be an array of strings');
  }
  if ('credential' in e && e.credential != null && typeof e.credential !== 'string') {
    errors.push('credential must be a pointer string (env:NAME | state:relpath)');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a credential POINTER to its location in state — never the secret value itself.
 * - "env:NAME"      → { kind:'env',   ref:'NAME', resolved: NAME is set in the environment }
 * - "state:relpath" → { kind:'state', ref:'relpath', resolved: the file exists under root }
 * - falsy / absent  → { kind:'none',  ref:null, resolved:true } (no credential required)
 * The secret VALUE is deliberately never read or returned.
 */
function resolveCredential(pointer, root) {
  if (!pointer) return { kind: 'none', ref: null, resolved: true };
  const idx = pointer.indexOf(':');
  const kind = idx === -1 ? pointer : pointer.slice(0, idx);
  const ref = idx === -1 ? '' : pointer.slice(idx + 1);
  if (kind === 'env') {
    return { kind: 'env', ref, resolved: Object.prototype.hasOwnProperty.call(process.env, ref) && process.env[ref] !== '' };
  }
  if (kind === 'state') {
    return { kind: 'state', ref, resolved: fs.existsSync(path.join(root, ref)) };
  }
  return { kind: 'unknown', ref: pointer, resolved: false };
}

/**
 * Default interface invoker — proves the interface by invocation.
 * cli: spawn `command <probe>`; reachable iff it actually ran (not ENOENT).
 * mcp: spawn `command [args]`; reachable iff the socket launcher spawned (not ENOENT). The process
 *      is killed immediately — we only confirm the socket opens, we do not drive a session.
 * @returns {{ ok: boolean, detail: string }}
 */
function defaultInvoke(entry) {
  if (entry.transport === 'cli') {
    const probe = entry.probe || '--version';
    const r = spawnSync(entry.command, [probe], { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore' });
    if (r.error) {
      return { ok: false, detail: `cli "${entry.command} ${probe}" did not run: ${r.error.code || r.error.message}` };
    }
    return { ok: true, detail: `cli "${entry.command}" responded (exit ${r.status})` };
  }
  // mcp — confirm the socket launcher spawns, then kill it.
  const args = Array.isArray(entry.args) ? entry.args : [];
  const r = spawnSync(entry.command, args, { timeout: PROBE_TIMEOUT_MS, stdio: 'ignore', killSignal: 'SIGKILL' });
  if (r.error && r.error.code === 'ENOENT') {
    return { ok: false, detail: `mcp socket "${entry.command}" not found: ENOENT` };
  }
  if (r.error && r.error.code !== 'ETIMEDOUT') {
    return { ok: false, detail: `mcp socket "${entry.command}" failed to launch: ${r.error.code || r.error.message}` };
  }
  // A timeout means the launcher is alive and waiting on the stdio socket — that IS reachable.
  return { ok: true, detail: `mcp socket "${entry.command}" launched` };
}

/**
 * Probe an interface. The invoker is injectable so unit tests are deterministic; the CLI layer
 * wires defaultInvoke (a real spawn) — that is what makes registration "validated by invocation".
 * @returns {{ ok: boolean, detail: string }}
 */
function probeInterface(entry, { invoke } = {}) {
  return (invoke || defaultInvoke)(entry);
}

function registryPath(root) {
  return path.join(root, REGISTRY_REL);
}

/** Read the registry; a missing file is an empty registry (not an error). */
function readRegistry(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(root), 'utf8'));
    return Array.isArray(parsed.connections) ? parsed : { connections: [] };
  } catch {
    return { connections: [] };
  }
}

function writeRegistry(root, registry) {
  const dir = path.dirname(registryPath(root));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(root), JSON.stringify(registry, null, 2) + '\n');
}

/** List all registered connections (agent lookup). */
function listConnections(root) {
  return readRegistry(root).connections;
}

/** Find one connection by name, or null (agent lookup, not a briefing). */
function findConnection(root, name) {
  return readRegistry(root).connections.find((c) => c.name === name) || null;
}

/**
 * Register (or re-register) a connection. Schema is validated first, then the interface is probed
 * by invocation — an unreachable interface is REJECTED with a useful error. Only the credential
 * POINTER is stored; the secret value is never read or persisted.
 * @returns {{ entry: object, validated: {ok, detail}, credential: {kind, ref, resolved} }}
 * @throws on schema error or unreachable interface.
 */
function registerConnection(root, entry, { invoke } = {}) {
  const schema = validateEntry(entry);
  if (!schema.ok) {
    throw new Error(`invalid connection: ${schema.errors.join('; ')}`);
  }
  const validated = probeInterface(entry, { invoke });
  if (!validated.ok) {
    throw new Error(`interface unreachable — ${validated.detail} (not registered)`);
  }
  const stored = {
    name: entry.name,
    transport: entry.transport,
    command: entry.command,
    scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
    credential: entry.credential || null, // POINTER only — never the secret value
    owner: entry.owner || null,
  };
  if (Array.isArray(entry.args) && entry.args.length) stored.args = entry.args;

  const registry = readRegistry(root);
  const i = registry.connections.findIndex((c) => c.name === stored.name);
  if (i === -1) registry.connections.push(stored);
  else registry.connections[i] = stored; // upsert by name
  writeRegistry(root, registry);

  return { entry: stored, validated, credential: resolveCredential(stored.credential, root) };
}

module.exports = {
  TRANSPORTS,
  REGISTRY_REL,
  validateEntry,
  resolveCredential,
  probeInterface,
  defaultInvoke,
  readRegistry,
  listConnections,
  findConnection,
  registerConnection,
  registryPath,
};
