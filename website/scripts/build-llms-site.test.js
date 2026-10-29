'use strict';
const process = require('node:process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const b = require('./llms/bundle');
function test(name, run) {
  run();
  console.log(`PASS ${name}`);
}
function withTempDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unif-llms-cli-'));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('build-llms is a require-guarded thin CLI with no helper exports', () => {
  assert.deepStrictEqual(require('./build-llms.js'), {});
});

test('build-llms CLI exits nonzero when docs are missing', () => {
  withTempDirectory((directory) => {
    const temporaryScripts = path.join(directory, 'website', 'scripts');
    fs.mkdirSync(temporaryScripts, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, 'build-llms.js'),
      path.join(temporaryScripts, 'build-llms.js')
    );
    fs.cpSync(
      path.join(__dirname, 'llms'),
      path.join(temporaryScripts, 'llms'),
      { recursive: true }
    );
    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(temporaryScripts, 'build-llms.js')],
      { encoding: 'utf8' }
    );

    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /docs\/ directory not found/iu);
    assert(!fs.existsSync(path.join(directory, 'website', 'static')));
  });
});

test('the real website has one canonical page per source and portable index links', () => {
  const built = b.buildBundle({ root: path.join(__dirname, '..') });
  const entries = JSON.parse(built['md/index.json'].toString('utf8'));
  assert(entries.length > 0);
  assert.strictEqual(
    new Set(entries.map((entry) => entry.mdPath)).size,
    entries.length
  );
  for (const entry of entries) {
    assert(entry.mdPath.startsWith('md/'));
    assert(Object.hasOwn(built, entry.mdPath));
  }
  assert(!built['llms.txt'].toString('utf8').includes('](/md/'));
});
