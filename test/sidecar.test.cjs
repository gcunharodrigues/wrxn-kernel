'use strict';

// Tests for the shared coalesced-sidecar helper (S1 / kernel #12). recall-surface.cjs's reinforce
// writer is refactored onto this; the per-session surfaced-log reuses it. The helper must be
// SELF-CONTAINED (node stdlib only — it ships inside installs alongside the hooks), COALESCED
// (read → mutate → rewrite-not-append, writing only when the map actually changes, never growing),
// FAIL-OPEN (any fault leaves the caller unchanged and never throws), and SECRET-SAFE (it never
// writes a value that looks like a secret). Black-box over the exported function.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_ROOT = path.join(__dirname, '..');
const SIDECAR = path.join(PKG_ROOT, 'payload', '.claude', 'hooks', 'sidecar.cjs');
const sidecar = require('../payload/.claude/hooks/sidecar.cjs');
const fake = require('./helpers/fake-secrets.cjs'); // runtime-assembled secret-shaped fixtures (#70)
const { loadManifest } = require('../lib/manifest.cjs');
const { init } = require('../lib/install.cjs');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── coalesce: read → mutate → rewrite-not-append, write only on change ───────────────

test('coalesceSidecar: a mutate that sets a key writes the rewritten map (created if absent)', () => {
  const dir = tmp('wrxn-sidecar-create-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    map['a'] = '1';
    return true; // signal the map changed
  });
  assert.equal(wrote, true, 'a changed map is written');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: '1' }, 'the rewritten map is on disk');
});

test('coalesceSidecar: mutate sees the existing map; an unchanged map is a no-op (byte-identical, no write)', () => {
  const dir = tmp('wrxn-sidecar-coalesce-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ a: '1' }, null, 2) + '\n');
  const before = fs.readFileSync(file);
  let saw;
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    saw = { ...map };
    return false; // caller decided nothing changed
  });
  assert.deepEqual(saw, { a: '1' }, 'mutate receives the existing on-disk map');
  assert.equal(wrote, false, 'an unchanged map is not written');
  assert.ok(before.equals(fs.readFileSync(file)), 'the file is left byte-identical (coalesced, no growth)');
});

// ── fail-open: never throw, never clobber ────────────────────────────────────────────

test('coalesceSidecar: a malformed existing sidecar → no write, no throw, left untouched (never clobbered)', () => {
  const dir = tmp('wrxn-sidecar-corrupt-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json{ broken');
  let called = false;
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { called = true; map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'a corrupt sidecar is not overwritten');
  assert.equal(called, false, 'mutate is never invoked over an unparseable file');
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json{ broken', 'the corrupt sidecar is left byte-for-byte');
});

test('coalesceSidecar: an existing JSON array (not a map) → no write, no throw, left untouched', () => {
  const dir = tmp('wrxn-sidecar-array-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[1,2,3]');
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'a non-object sidecar is skipped, not clobbered');
  assert.equal(fs.readFileSync(file, 'utf8'), '[1,2,3]', 'left untouched');
});

test('coalesceSidecar: an unwritable path (a dir where the file should be) → false, no throw', () => {
  const dir = tmp('wrxn-sidecar-unwritable-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  fs.mkdirSync(file, { recursive: true }); // the file PATH is a directory → read/write raise EISDIR
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => { map['a'] = '1'; return true; });
  });
  assert.equal(wrote, false, 'the write fault is swallowed (best-effort)');
});

// ── secret-scan: a secret value is never written ─────────────────────────────────────

test('coalesceSidecar: a mutate that injects a secret-shaped value is NOT written (no-secret guarantee)', () => {
  const dir = tmp('wrxn-sidecar-secret-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  let wrote;
  assert.doesNotThrow(() => {
    wrote = sidecar.coalesceSidecar(file, (map) => {
      map['leak'] = fake.npm(); // an npm token shape (36 base62 chars)
      return true;
    });
  });
  assert.equal(wrote, false, 'a map carrying a secret value is refused, not written');
  assert.equal(fs.existsSync(file), false, 'no sidecar file is created when a secret would be written');
});

test('coalesceSidecar: a clean map writes even when a sibling secret-free value resembles a path', () => {
  // Guard against an over-broad scanner: ordinary wiki-rel paths / dates must still write fine.
  const dir = tmp('wrxn-sidecar-clean-');
  const file = path.join(dir, '.wrxn', 'thing.json');
  const wrote = sidecar.coalesceSidecar(file, (map) => {
    map['concepts/some-page.md'] = '2026-06-22';
    return true;
  });
  assert.equal(wrote, true, 'a secret-free map writes normally');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'concepts/some-page.md': '2026-06-22' });
});

// ── redactSecrets: scrub known secret shapes from free text (the event source reuses it, S2 / #35) ──
// The metadata-grade event source (emit-event.cjs) persists REDACTED prompt text. Rather than reinvent
// secret shapes it reuses THIS module's primitive: redactSecrets must scrub the exact same SECRET_PATTERNS
// secretScan already detects (one source of truth), replacing every match in place while preserving the
// surrounding text — so a recalled prompt stays useful but never hardens a credential onto disk.

const FAKE_NPM = fake.npm(); // npm-token shape, assembled at runtime (test/helpers/fake-secrets.cjs)
const FAKE_AWS = fake.aws(); // AWS access-key-id shape, assembled at runtime

test('redactSecrets scrubs a known secret shape but preserves the surrounding text', () => {
  const out = sidecar.redactSecrets(`before ${FAKE_NPM} after`);
  assert.ok(!out.includes(FAKE_NPM), 'the secret token is gone');
  assert.match(out, /^before .+ after$/, 'the non-secret text around the secret is preserved');
});

test('redactSecrets scrubs EVERY occurrence and MULTIPLE shapes on one line (global, multi-pattern)', () => {
  const out = sidecar.redactSecrets(`${FAKE_NPM} x ${FAKE_AWS} x ${FAKE_NPM}`);
  assert.ok(!out.includes(FAKE_NPM), 'no npm-shape survives (global replace)');
  assert.ok(!out.includes(FAKE_AWS), 'no aws-shape survives (every pattern applied)');
});

test('redactSecrets reuses the SAME shapes as secretScan — a redacted string no longer scans as a secret', () => {
  const dirty = `key=${FAKE_NPM}`;
  assert.equal(sidecar.secretScan(dirty), 'contains_secret', 'sanity: the scanner flags the raw secret');
  assert.equal(sidecar.secretScan(sidecar.redactSecrets(dirty)), null, 'after redaction the same scanner finds nothing — one source of shapes');
});

test('redactSecrets leaves secret-free text byte-identical and coerces non-strings (total)', () => {
  assert.equal(sidecar.redactSecrets('a normal prompt about foo.cjs'), 'a normal prompt about foo.cjs', 'clean text unchanged');
  assert.equal(sidecar.redactSecrets(null), '', 'null → empty string');
  assert.equal(sidecar.redactSecrets(undefined), '', 'undefined → empty string');
});

// #39: sidecar adopts the ONE canonical set — it gains the vendor shapes it lacked (Slack / Google /
// Stripe / GitHub-PAT / OpenAI-project), on TOP of its own broader extras (kept, asserted elsewhere).
test('secretScan + redactSecrets gain the consolidated canonical shapes sidecar lacked (#39)', () => {
  const cases = [
    fake.slack(),
    fake.google(),
    fake.stripe(),
    fake.githubPat(),
    fake.openaiProj(),
  ];
  for (const s of cases) {
    assert.equal(sidecar.secretScan(s), 'contains_secret', `gate flags: ${s}`);
    assert.ok(!sidecar.redactSecrets(`x ${s} y`).includes(s), `redacted: ${s}`);
  }
});

// #39 security MEDIUM: the canonical assignment shape (#14) must keep its leading \b — dropping it made
// it QUADRATIC (~12.7s @100k word chars), reachable through the uncapped raw-prompt sink
// emit-event.cjs → sidecar.redactSecrets. A pathological 100k run of '_' isolates the canonical
// assignment shape — '_' is in its [A-Za-z0-9_] class but matches no other canonical shape nor any
// sidecar extra — so this guards #14 specifically and must complete fast, never hang.
test('redactSecrets handles the assignment-shape pathological run in linear time (#39 ReDoS guard)', () => {
  const pathological = '_'.repeat(100000);
  const t = process.hrtime.bigint();
  sidecar.redactSecrets(pathological);
  const elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(elapsedMs < 1000, `the assignment shape over 100k word chars must stay linear (ReDoS guard); took ${elapsedMs.toFixed(0)}ms`);
});

// #39 security LOW: the PEM label was narrowed from [A-Z ]* to (?:[A-Z ]+ )?, which stops matching a
// malformed double-space label. AC1 says no existing match may weaken — the broadest [A-Z ]* form must
// still flag every standard descriptor AND the malformed double-space / unlabeled forms.
test('secretScan flags every PEM private-key label incl. malformed double-space (#39 no narrowing)', () => {
  // each entry is the label segment that follows "-----BEGIN " (with its trailing space); '' = unlabeled
  // (PKCS#8), ' ' = the malformed DOUBLE-space the narrowed (?:[A-Z ]+ )? form stopped matching.
  const labelSegments = ['RSA ', 'DSA ', 'EC ', 'OPENSSH ', 'PGP ', 'ENCRYPTED ', '', ' '];
  for (const seg of labelSegments) {
    const header = `-----BEGIN ${seg}PRIVATE KEY-----`;
    assert.equal(sidecar.secretScan(header), 'contains_secret', `must flag PEM header: ${JSON.stringify(header)}`);
  }
});

// ── #38 F2: broaden redaction to common secret shapes the 5-pattern set missed ──────────
// C2 is the slice that newly persists RAW prompt text (emit-event.cjs → .wrxn/events/<sid>.jsonl), so
// redaction must also scrub bearer tokens, password=/pwd= assignments, URI connection strings with inline
// creds, JWTs, and the FULL PEM private-key block (not just its header line). Each shape is fabricated
// (repeated chars / "notreal" — never a live token) so the assertions never harden a real credential and
// never trip push protection. Broadening is ADDITIVE: secretScan's gate consumers must not regress (see
// the false-positive regression below).

// fabricated, obviously-not-real tokens (clear the length floors; not live secrets)
const FAKE_BEARER = 'A'.repeat(40);

test('redactSecrets scrubs a Bearer token, case-insensitively (#38 F2)', () => {
  const out = sidecar.redactSecrets(`Authorization: Bearer ${FAKE_BEARER}`);
  assert.ok(!out.includes(FAKE_BEARER), 'the capitalized Bearer token is gone');
  assert.match(out, /^Authorization: /, 'the surrounding header text is preserved');

  // a lowercase scheme must redact too — this PROVES the global redaction clone preserves the /i flag
  // (the SECRET_PATTERNS_GLOBAL map must not drop case-insensitivity, or detection and redaction diverge)
  const lower = `authorization: bearer ${FAKE_BEARER}`;
  assert.ok(!sidecar.redactSecrets(lower).includes(FAKE_BEARER), 'a lowercase bearer token is redacted too');
  assert.equal(sidecar.secretScan(lower), 'contains_secret', 'and the scanner gate flags the lowercase form');
});

test('redactSecrets scrubs password=/pwd= assignments (=, :, and quoted-JSON forms) (#38 F2)', () => {
  const cases = [
    ['password=NotARealSecret123', 'NotARealSecret123'],
    ['PWD = fakefakefakevalue', 'fakefakefakevalue'],
    ['passwd: notrealcolonvalue', 'notrealcolonvalue'],
    ['{"password": "notrealjsonvalue"}', 'notrealjsonvalue'],
  ];
  for (const [dirty, secret] of cases) {
    const out = sidecar.redactSecrets(dirty);
    assert.ok(!out.includes(secret), `the credential value is redacted in: ${dirty}`);
    assert.equal(sidecar.secretScan(dirty), 'contains_secret', `the scanner gate flags: ${dirty}`);
  }
});

test('redactSecrets scrubs a URI connection string with inline creds (#38 F2)', () => {
  const cases = [
    'postgres://dbuser:notrealdbpass@db.example.com:5432/app',
    'mongodb://admin:notrealmongo@cluster.example.net/db',
    'redis://user:notrealredis@127.0.0.1:6379',
  ];
  for (const dirty of cases) {
    const out = sidecar.redactSecrets(dirty);
    assert.ok(!/notreal\w*/.test(out), `the inline credential is redacted in: ${dirty}`);
    assert.equal(sidecar.secretScan(dirty), 'contains_secret', `the scanner gate flags: ${dirty}`);
  }
  // a credential-free URL is NOT a connection-string secret — it must survive untouched
  assert.equal(sidecar.redactSecrets('see https://github.com/org/repo'), 'see https://github.com/org/repo', 'a plain URL is left intact');
});

test('redactSecrets scrubs a JWT (three base64url parts) (#38 F2)', () => {
  const FAKE_JWT = fake.jwt(); // JWT shape, assembled at runtime
  const out = sidecar.redactSecrets(`token=${FAKE_JWT} end`);
  assert.ok(!out.includes(FAKE_JWT), 'the JWT is redacted');
  assert.match(out, / end$/, 'the surrounding text is preserved');
  assert.equal(sidecar.secretScan(FAKE_JWT), 'contains_secret', 'the scanner gate flags a JWT');
});

test('redactSecrets scrubs the FULL PEM private-key block, not just the header line (#38 F2)', () => {
  const block = fake.pemBlock();
  const out = sidecar.redactSecrets(`before\n${block}\nafter`);
  assert.ok(!out.includes(fake.PEM_BLOCK_BODY), 'the key BODY is redacted, not left exposed below a redacted header');
  assert.ok(!out.includes(fake.PEM_BLOCK_END), 'the END boundary is consumed too');
  assert.match(out, /^before/, 'leading text preserved');
  assert.match(out, /after$/, 'trailing text preserved');

  // a lone/truncated header (no END) still trips the gate via the retained header-line fallback
  assert.equal(sidecar.secretScan(fake.pemHeader()), 'contains_secret', 'a lone PEM header is still detected');
});

// blast-radius: secretScan is ALSO the coalesceSidecar write GATE (reinforce/surfaced/reward). Broadening
// must stay ADDITIVE — it must NOT start flagging the wiki-rel paths, session-id slugs, ISO dates and counts
// those sidecars store (a false positive would silently REFUSE a legit state write), nor mangle them via redact.
test('the broadened patterns do NOT falsely flag wiki-page-path sidecar keys/values (#38 F2 blast-radius)', () => {
  const benign = [
    'concepts/some-page.md',
    'decisions/reset-password-flow.md', // carries the word "password" — but it is a PATH, not an assignment
    'gotchas/pwd-and-cwd-confusion.md', // carries "pwd" — not an assignment
    'gotchas/recall-surface-door-race.md',
    '2026-06-22',
    'session-abc-123-def',
  ];
  for (const key of benign) {
    assert.equal(sidecar.secretScan(key), null, `not a secret (gate must not refuse): ${key}`);
    assert.equal(sidecar.redactSecrets(key), key, `left byte-identical (no over-redaction): ${key}`);
  }

  // the exact shape that regressed the reward gate: a traversal/path-shaped value ENDING in "passwd" used
  // as a JSON KEY — the JSON key-colon then follows "passwd", which must NOT read as a `passwd:` assignment.
  const rewardBody = '{\n  "../../etc/passwd": { "s": 1, "f": 0 },\n  "concepts/a.md": { "s": 1, "f": 0 }\n}';
  assert.equal(sidecar.secretScan(rewardBody), null, 'a path ending in "passwd" as a JSON key is not a password assignment (gate must still write)');

  // and the gate still WRITES a realistic reinforce-style body whose KEY contains "password"
  const dir = tmp('wrxn-sidecar-fp-');
  const file = path.join(dir, '.wrxn', 'reinforce.json');
  const wrote = sidecar.coalesceSidecar(file, (map) => { map['decisions/reset-password-flow.md'] = '2026-06-22'; return true; });
  assert.equal(wrote, true, 'a reinforce body with a password-containing PATH key still writes (gate not tripped)');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'decisions/reset-password-flow.md': '2026-06-22' });
});

// ── self-contained: node stdlib only (it ships into installs alongside the hooks) ────

test('the sidecar helper imports nothing outside the node standard library', () => {
  const src = fs.readFileSync(SIDECAR, 'utf8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0, 'sanity: the helper has require() calls');
  const builtins = new Set(require('module').builtinModules);
  for (const m of mods) {
    const name = m.replace(/^node:/, '');
    assert.ok(builtins.has(name), `${m} must be a node builtin — no kernel-lib or recon import allowed`);
  }
});

// ── shipping: the sibling is managed payload, laid into installs (recall-surface requires it) ──

test('the sidecar helper is classified managed in the manifest and laid into a fresh install', () => {
  const manifest = loadManifest(path.join(PKG_ROOT, 'manifest.json'));
  const entry = manifest.files.find((f) => f.path === '.claude/hooks/sidecar.cjs');
  assert.ok(entry, 'sidecar.cjs is classified in the manifest (the installer refuses any unmanifested payload file)');
  assert.equal(entry.class, 'managed', 'kernel-owned hook code → managed');
  const target = tmp('wrxn-sidecar-laid-');
  init({ pkgRoot: PKG_ROOT, target, profile: 'project' });
  assert.ok(
    fs.existsSync(path.join(target, '.claude', 'hooks', 'sidecar.cjs')),
    'the sibling helper is laid alongside recall-surface.cjs so the require resolves in installs'
  );
});
