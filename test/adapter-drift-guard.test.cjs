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
