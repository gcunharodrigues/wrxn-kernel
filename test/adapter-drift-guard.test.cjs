'use strict';

// Adapter-helper drift guard (phase-4.5-03). Three helpers are deliberately COPY-PASTED across the
// self-contained payload adapters. Each adapter ships INTO an install and may import only node stdlib —
// it cannot `require` a sibling or a shared module — so the duplication is intentional (Approach B: KEEP
// the copies, do NOT extract). This suite is the safety net that makes that choice safe: it fails the
// build the moment one copy silently drifts from its siblings, so a fix applied to one is never forgotten
// in the others.
//
//   · secretScan (+ its SECRET_PATTERNS table) — harvest.cjs / sync.cjs / dream.cjs — must be BYTE-identical.
//   · dayStamp                                  — harvest.cjs / recall-surface.cjs   — must be BYTE-identical.
//   · the recon-door HTTP client (pidAlive / endpointTrusted / discoverEndpoint / httpTransport)
//       — harvest.cjs / sync.cjs / recall-surface.cjs — must be LOGIC-identical: only the intentional
//       per-door error-message wording (e.g. 'harvest door timeout' vs 'recall door timeout') and the
//       per-file comments may differ, so we compare AFTER normalizing string literals + stripping comments.
//       (dream.cjs has no door client — it never talks http — so it is excluded from this group.)
//
// Copies are extracted by slicing the source TEXT, never by requiring the modules: several helpers are
// unexported (dream's secretScan, every endpointTrusted, the SECRET_PATTERNS table), so Function.toString
// is not an option — and the whole point is that these files share nothing to import.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isBuiltin } = require('node:module');

const PKG_ROOT = path.join(__dirname, '..');
const PAYLOAD = path.join(PKG_ROOT, 'payload');

const ADAPTERS = {
  harvest: path.join(PAYLOAD, '.wrxn', 'harvest.cjs'),
  sync: path.join(PAYLOAD, '.wrxn', 'sync.cjs'),
  dream: path.join(PAYLOAD, '.wrxn', 'dream.cjs'),
  recall: path.join(PAYLOAD, '.claude', 'hooks', 'recall-surface.cjs'),
};

function read(which) {
  return fs.readFileSync(ADAPTERS[which], 'utf8');
}

// Slice a top-level `function <name>(…) { … }` out of source text: from `function <name>(` to the first
// column-0 closing brace (`\n}`). These adapters indent every nested block, so the only newline-anchored
// `}` is the function's own end — robust without a JS parser. Returns null when the function is absent.
function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const m = /^[\s\S]*?\n\}/.exec(src.slice(start));
  return m ? m[0] : null;
}

// Slice the `const SECRET_PATTERNS = [ … ];` table. It is the data secretScan scans and is tightly coupled
// to it: a drift in a single pattern is a behavioral drift the (trivial) function body alone would not
// reveal, so the guard compares the table + the function together.
function sliceSecretPatterns(src) {
  const start = src.indexOf('const SECRET_PATTERNS = [');
  if (start === -1) return null;
  const m = /^[\s\S]*?\n\];/.exec(src.slice(start));
  return m ? m[0] : null;
}

// The full secretScan helper = its pattern table + its function body, joined. Compared BYTE-for-byte.
function secretScanHelper(src) {
  const table = sliceSecretPatterns(src);
  const fn = sliceFn(src, 'secretScan');
  assert.ok(table, 'SECRET_PATTERNS table not found');
  assert.ok(fn, 'secretScan function not found');
  return `${table}\n${fn}`;
}

// LOGIC normalization for the door client: blank every string + template literal, then drop line comments,
// then collapse whitespace. Strings are blanked FIRST so a `//` inside a literal can never be mistaken for
// a comment. What survives is the control flow, identifiers, operators, numeric + regex literals — so the
// intentional per-door error wording and the divergent comments are erased, while any real logic change
// (an identifier, a number, a control-flow edit) still shows.
function normalizeLogic(src) {
  return String(src)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The functions that together form the recon-door HTTP client, duplicated logic-identically.
const DOOR_FNS = ['pidAlive', 'endpointTrusted', 'discoverEndpoint', 'httpTransport'];

// ── AC1 · secretScan: byte-identical across harvest / sync / dream ────────────────────────
test('secretScan (+ SECRET_PATTERNS) is byte-identical across harvest, sync, dream', () => {
  const ref = secretScanHelper(read('harvest'));
  for (const which of ['sync', 'dream']) {
    assert.equal(
      secretScanHelper(read(which)),
      ref,
      `secretScan copy in ${which}.cjs has drifted from harvest.cjs — these are intentionally byte-identical; re-sync the copy`
    );
  }
});

// ── AC2 · dayStamp: byte-identical across harvest / recall-surface ────────────────────────
test('dayStamp is byte-identical across harvest and recall-surface', () => {
  const ref = sliceFn(read('harvest'), 'dayStamp');
  assert.ok(ref, 'dayStamp not found in harvest.cjs');
  assert.equal(
    sliceFn(read('recall'), 'dayStamp'),
    ref,
    'dayStamp copy in recall-surface.cjs has drifted from harvest.cjs — these are intentionally byte-identical; re-sync the copy'
  );
});

// ── AC3 · recon-door client: logic-identical across harvest / sync / recall-surface ───────
test('the recon-door HTTP client is logic-identical across harvest, sync, recall-surface', () => {
  for (const fn of DOOR_FNS) {
    const ref = sliceFn(read('harvest'), fn);
    assert.ok(ref, `door-client function ${fn} not found in harvest.cjs`);
    const refNorm = normalizeLogic(ref);
    for (const which of ['sync', 'recall']) {
      const copy = sliceFn(read(which), fn);
      assert.ok(copy, `door-client function ${fn} not found in ${which}.cjs`);
      assert.equal(
        normalizeLogic(copy),
        refNorm,
        `recon-door ${fn}() in ${which}.cjs has drifted in LOGIC from harvest.cjs (only per-door error wording + comments may differ; logic may not)`
      );
    }
  }
});

// ── AC3 (normalizer contract) · error wording is allowed to differ; logic is not ──────────
// A focused proof that the door-client comparison ALLOWS the intended per-door difference yet still CATCHES
// real divergence — independent of the live tree, so the guard can never silently rot into a tautology
// (e.g. a future over-eager normalizer that blanks everything would pass test AC3 but fails here).
test('door-client normalization ignores per-door error wording + comments but catches logic drift', () => {
  const harvestErr = "req.destroy(new Error('harvest door timeout'));";
  const recallErr = "req.destroy(new Error('recall door timeout'));";
  const withComment = "req.destroy(new Error('harvest door timeout')); // idle timeout";
  const logicChange = "req.unref(new Error('harvest door timeout'));"; // destroy → unref is real logic drift
  assert.equal(normalizeLogic(harvestErr), normalizeLogic(recallErr), 'per-door error wording must normalize equal');
  assert.equal(normalizeLogic(harvestErr), normalizeLogic(withComment), 'a trailing comment must normalize away');
  assert.notEqual(normalizeLogic(harvestErr), normalizeLogic(logicChange), 'a real logic change must NOT normalize away');
});

// ── AC4 · no adapter reaches outside the payload (node stdlib + co-located self-contained siblings) ──
// The duplication of secretScan / dayStamp / the door-client exists PRECISELY because each adapter is
// self-contained. This guards that premise: an adapter may NOT pull in the kernel lib, an npm package, or
// any module outside the shipped payload — so a require must be either a node builtin OR a relative path
// that resolves to a co-located payload sibling (which is itself held to the stdlib-only bar by its own
// test). The duplicated helpers above are NOT relocated by such a sibling — they stay byte/logic-identical
// copies, still guarded by AC1–AC3 — so a co-located helper module (e.g. the shared coalesced-sidecar) is
// permitted while a kernel-lib / npm / out-of-payload import still fails the build.
test('each self-contained adapter imports node stdlib or a co-located payload sibling (no kernel-lib / npm / out-of-payload import)', () => {
  const re = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const which of Object.keys(ADAPTERS)) {
    const file = ADAPTERS[which];
    const src = read(which);
    let m;
    while ((m = re.exec(src)) !== null) {
      const mod = m[2];
      if (mod.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), mod);
        assert.ok(
          resolved.startsWith(PAYLOAD + path.sep) && fs.existsSync(resolved),
          `${which}.cjs requires "${mod}" — a relative import must resolve to a co-located payload sibling (a self-contained module shipped alongside it); reaching outside the payload is forbidden`
        );
        continue;
      }
      assert.ok(
        isBuiltin(mod),
        `${which}.cjs requires "${mod}" — adapters must stay self-contained (node stdlib only); the duplicated helpers exist because these files cannot share a non-payload module`
      );
    }
  }
});

// ── #39 · the ONE canonical secret-pattern set, drift-pinned across every copy ──────────────
// #39 consolidated the drifted SECRET_PATTERNS copies (three coverage levels) into a single canonical set.
// The .wrxn detection adapters (dream/sync/harvest), the memory-synth redactor, and the chat-search engine's
// transcript redactor (#84) carry it as `const SECRET_PATTERNS = [ … ]`; the hooks-layer sidecar — which
// CANNOT import a .wrxn sibling (the self-contained cross-layer doctrine) — replicates the set as
// `SECRET_PATTERNS_CANON`. This pins all SIX copies BYTE-IDENTICAL: a future edit that broadens/narrows one
// shape in one file fails the build here, so "drifted stale copies" becomes "one test-pinned set". (Same
// TEXT-slice idiom as AC1 — these arrays are unexported, so we compare source text, not required values.)
const CANON_SITES = {
  dream: { file: path.join(PAYLOAD, '.wrxn', 'dream.cjs'), name: 'SECRET_PATTERNS' },
  sync: { file: path.join(PAYLOAD, '.wrxn', 'sync.cjs'), name: 'SECRET_PATTERNS' },
  harvest: { file: path.join(PAYLOAD, '.wrxn', 'harvest.cjs'), name: 'SECRET_PATTERNS' },
  memorySynth: { file: path.join(PAYLOAD, '.wrxn', 'memory-synth.cjs'), name: 'SECRET_PATTERNS' },
  sidecar: { file: path.join(PAYLOAD, '.claude', 'hooks', 'sidecar.cjs'), name: 'SECRET_PATTERNS_CANON' },
  chatSearch: { file: path.join(PAYLOAD, '.wrxn', 'chat-search.cjs'), name: 'SECRET_PATTERNS' },
};

// Slice the `[ … ]` body of `const <name> = [` through the first column-0 `\n];` (indent-anchored, like
// sliceSecretPatterns). Returns from '[' to '];' so the const NAME is excluded (sidecar names its copy
// SECRET_PATTERNS_CANON) while every regex literal + comment is compared verbatim.
function sliceArrayBody(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start === -1) return null;
  const from = src.indexOf('[', start);
  const m = /^[\s\S]*?\n\];/.exec(src.slice(from));
  return m ? m[0] : null;
}

test('#39 the canonical SECRET_PATTERNS set is byte-identical across dream/sync/harvest/memory-synth/sidecar/chat-search', () => {
  const ref = sliceArrayBody(fs.readFileSync(CANON_SITES.dream.file, 'utf8'), CANON_SITES.dream.name);
  assert.ok(ref && ref.includes('AKIA') && ref.includes('xox[baprs]') && ref.includes('PRIVATE KEY'), 'the canonical block is found in dream.cjs');
  for (const [site, { file, name }] of Object.entries(CANON_SITES)) {
    const got = sliceArrayBody(fs.readFileSync(file, 'utf8'), name);
    assert.ok(got, `${site}: the canonical block (const ${name} = [ … ]) was not found`);
    assert.equal(
      got,
      ref,
      `${site}: its canonical secret-pattern copy has DRIFTED from dream.cjs — the #39 set is intentionally byte-identical; re-sync the copy`
    );
  }
});

test('#39 the PEM full-block shape precedes the header-only fallback (redaction must eat the key body)', () => {
  const ref = sliceArrayBody(fs.readFileSync(CANON_SITES.dream.file, 'utf8'), 'SECRET_PATTERNS');
  const full = ref.indexOf('-----END'); // only the FULL-block shape carries an END boundary
  const headerOnly = ref.indexOf('/-----BEGIN [A-Z ]*PRIVATE KEY-----/,'); // the lone-header fallback line
  assert.ok(full !== -1 && headerOnly !== -1, 'both PEM shapes are present');
  assert.ok(full < headerOnly, 'the FULL PEM block must appear BEFORE the header-only fallback so redaction consumes the body, not just the header');
});

test('#39 detection stays non-global; the redaction sites derive the g-flagged form from the one set', () => {
  // the canonical base carries no global flag (detection .test is stateless over it) — the byte-identical
  // pin already locks that; here we assert the two redaction sites DERIVE the global clone from it, so a
  // shape can never be detected-but-not-redacted (or vice-versa).
  for (const f of [CANON_SITES.memorySynth.file, CANON_SITES.sidecar.file]) {
    assert.ok(
      fs.readFileSync(f, 'utf8').includes("re.flags.includes('g')"),
      `${f}: must derive the global redaction form from the canonical set (preserving each shape's own flags)`
    );
  }
  // sidecar keeps its broader hooks-layer extras ON TOP of the pinned core, so the cross-layer copy never
  // weakens (no pre-existing match lost) while the shared 14 stay drift-pinned.
  const sc = fs.readFileSync(CANON_SITES.sidecar.file, 'utf8');
  assert.ok(sc.includes('const SIDECAR_EXTRA = ['), 'sidecar declares its layer-specific extras');
  assert.ok(sc.includes('[...SECRET_PATTERNS_CANON, ...SIDECAR_EXTRA]'), 'sidecar composes the pinned core + its extras');
});
