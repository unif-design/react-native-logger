#!/usr/bin/env node
'use strict';
const process = require('node:process');

const path = require('node:path');
const { buildBundle, commitBundle } = require('./llms/bundle');

if (require.main === module) {
  try {
    const root = path.join(__dirname, '..');
    const bundle = buildBundle({
      docsDir: path.join(root, 'docs'),
      root,
    });
    commitBundle(path.join(root, 'static'), bundle);

    const pageCount = Object.keys(bundle).filter((target) =>
      /^md\/.+\.md$/u.test(target)
    ).length;
    const fullSize = bundle['llms-full.txt'].byteLength / 1024;
    process.stdout.write(
      `[build-llms] llms.txt(索引 ${pageCount} 页) + llms-full.txt(${fullSize.toFixed(
        1
      )} KB) + ${pageCount} 页 md/*.md\n`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[build-llms] ${message}\n`);
    process.exitCode = 1;
  }
}
