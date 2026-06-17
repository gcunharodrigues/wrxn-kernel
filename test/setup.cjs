'use strict';

// Test-harness hygiene. The suite spins up throwaway installs via fs.mkdtempSync and almost never
// removes them, so a full run leaks dozens of /tmp/<prefix>… dirs — enough to fill the disk during a
// long build (observed: 100% /tmp, a transient suite failure). Rather than thread an explicit cleanup
// through ~28 test files, this module is preloaded into every test subprocess
// (`node --test --require ./test/setup.cjs`): it wraps mkdtempSync to record each dir it hands out and
// removes them when the subprocess exits. Reaping is scoped to the OS temp root so it can never touch a
// caller-supplied real path, and runs at process exit so dirs stay live for the whole file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = new Set();
const realMkdtempSync = fs.mkdtempSync;
const tmpRoot = os.tmpdir() + path.sep;

fs.mkdtempSync = function mkdtempSync(prefix, options) {
  const dir = realMkdtempSync.call(this, prefix, options);
  if (typeof dir === 'string' && dir.startsWith(tmpRoot)) created.add(dir);
  return dir;
};

process.on('exit', () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort reap — never fail a test run over cleanup */
    }
  }
});
