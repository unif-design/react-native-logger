'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('./build-llms-core.test.js');
require('./build-llms-site.test.js');
const { buildBundle } = require('./llms/bundle');
const site = path.join(__dirname, '..');
assert.equal(
  fs.realpathSync(path.join(site, 'docs')),
  path.resolve(site, '../docs'),
);
const bundle = buildBundle({ root: site });
assert(bundle['md/FORMAT.md'].toString('utf8').includes('timestamp 保持 UTC'));
console.log('PASS Logger 文档与格式契约同源');
