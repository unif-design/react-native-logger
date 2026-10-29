'use strict';
const process = require('node:process');
const { Buffer } = require('node:buffer');

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assembleMarkdown,
  convertMdxBody,
  findBalancedEnd,
  parseFrontmatter,
  protectCode,
  rewriteInternalLinks,
} = require('./llms/markdown');
const bundle = require('./llms/bundle');
const {
  buildRouteMap,
  collisionKey,
  normalizeRelSlug,
} = require('./llms/routes');
const b = {
  ...bundle,
  assembleMarkdown,
  convertMdxBody,
  parseFrontmatter,
};

function test(name, run) {
  try {
    run();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n`);
    throw error;
  }
}

const count = (value, needle) => value.split(needle).length - 1;

function writeFixture(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function withTempDirectory(run) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'react-native-design-llms-')
  );
  try {
    return run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function snapshotTree(directory) {
  if (!fs.existsSync(directory)) return null;
  const files = {};
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolutePath = path.join(current, name);
      const relativePath = path
        .relative(directory, absolutePath)
        .split(path.sep)
        .join('/');
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) {
        visit(absolutePath);
      } else {
        files[relativePath] = {
          bytes: fs.readFileSync(absolutePath).toString('base64'),
          hash: sha256(fs.readFileSync(absolutePath)),
        };
      }
    }
  };
  visit(directory);
  return files;
}

function createTempSite(directory, options = {}) {
  const siteRoot = path.join(directory, 'website');
  writeFixture(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: '@unif/fixture',
      version: '1.2.3',
      description: 'Fixture library',
    })
  );
  const docsDir = path.join(siteRoot, 'docs');
  const staticDir = path.join(siteRoot, 'static');
  writeFixture(
    path.join(siteRoot, 'docusaurus.config.ts'),
    "export default { title: 'Fixture Design' };\n"
  );
  writeFixture(
    path.join(docsDir, 'UNIF-DESIGN.md'),
    [
      '---',
      'title: UNIF Design',
      'slug: /unif-design',
      'description: 总览',
      '---',
      '',
      options.deadLink
        ? '[缺失页面](/docs/does-not-exist)'
        : '[Button](/docs/components/button)',
    ].join('\n')
  );
  writeFixture(
    path.join(docsDir, 'getting-started.md'),
    [
      '---',
      'title: Getting Started',
      '---',
      '',
      '[总览](/docs/unif-design#intro)',
    ].join('\n')
  );
  writeFixture(
    path.join(docsDir, 'components/button.mdx'),
    [
      '---',
      'title: Button 按钮',
      'description: 操作按钮',
      '---',
      '',
      "import { LiveDemo } from '@site/src/components/LiveDemo';",
      '',
      'export const ButtonDemo = () => (',
      '  <LiveDemo><Button label="保存" onPress={() => undefined} /></LiveDemo>',
      ');',
      '',
      options.unknownDemo ? '<MissingDemo />' : '<ButtonDemo />',
      '',
      '<LiveDemo>',
      '  <Text>直接示例</Text>',
      '</LiveDemo>',
      '',
      '[开始](../getting-started)',
    ].join('\n')
  );
  writeFixture(path.join(staticDir, 'llms.txt'), 'old index\n');
  writeFixture(path.join(staticDir, 'llms-full.txt'), 'old full\n');
  writeFixture(path.join(staticDir, 'md/old-stale.md'), 'old stale\n');
  writeFixture(
    path.join(staticDir, 'img/sentinel.bin'),
    Buffer.from([0, 1, 2, 3, 255])
  );
  return {
    docsDir,
    root: siteRoot,
    staticDir,
  };
}

function transientDirectories(staticDir) {
  return fs
    .readdirSync(staticDir)
    .filter(
      (name) =>
        name.startsWith('.llms-stage-') || name.startsWith('.llms-backup-')
    );
}

function overrideFileOps(overrides = {}) {
  return Object.fromEntries(
    Object.entries(bundle.REAL_FILE_OPS).map(([name, operation]) => [
      name,
      overrides[name] === undefined
        ? operation
        : (...args) => overrides[name](operation, ...args),
    ])
  );
}

function isInsideTransient(target, prefix) {
  return target.split(path.sep).some((segment) => segment.startsWith(prefix));
}

function createFormalFixture(directory, present = bundle.FORMAL_TARGETS) {
  const staticDir = path.join(directory, 'static');
  const oldContents = {
    'llms.txt': Buffer.from('old index\n'),
    'llms-full.txt': Buffer.from('old full\n'),
    'md': {
      'index.json': Buffer.from('old index json\n'),
      'old.md': Buffer.from('old page\n'),
    },
  };
  fs.mkdirSync(staticDir, { recursive: true });
  if (present.includes('llms.txt')) {
    writeFixture(path.join(staticDir, 'llms.txt'), oldContents['llms.txt']);
  }
  if (present.includes('llms-full.txt')) {
    writeFixture(
      path.join(staticDir, 'llms-full.txt'),
      oldContents['llms-full.txt']
    );
  }
  if (present.includes('md')) {
    for (const [name, content] of Object.entries(oldContents.md)) {
      writeFixture(path.join(staticDir, 'md', name), content);
    }
  }
  writeFixture(
    path.join(staticDir, 'img/sentinel.bin'),
    Buffer.from([7, 8, 9, 255])
  );
  return { oldContents, staticDir };
}

function document(sourcePath, frontmatter = {}) {
  return {
    id: sourcePath,
    sourceName: `docs/${sourcePath}`,
    sourcePath,
    ...frontmatter,
  };
}

function minimalBundle(overrides = {}) {
  const entries = [
    {
      title: 'Guide',
      mdPath: 'md/guide.md',
      slug: '/guide',
      section: '概览',
      description: null,
    },
  ];
  return {
    'llms.txt': Buffer.from(
      [
        '# Fixture',
        '',
        '- [完整全文](llms-full.txt)',
        '- [Guide](md/guide.md)',
        '',
      ].join('\n')
    ),
    'llms-full.txt': Buffer.from('# Fixture\n\nFull text.\n'),
    'md/index.json': Buffer.from(`${JSON.stringify(entries, null, 2)}\n`),
    'md/guide.md': Buffer.from('# Guide\n\n[External](https://example.com)\n'),
    ...overrides,
  };
}

test('bundle is built in memory and installs idempotently without touching unrelated static files', () => {
  withTempDirectory((directory) => {
    const site = createTempSite(directory);
    const beforeBuild = snapshotTree(site.staticDir);
    const firstBundle = b.buildBundle(site);

    assert.deepStrictEqual(snapshotTree(site.staticDir), beforeBuild);
    assert(
      Object.keys(firstBundle).every(
        (name) =>
          name === 'llms.txt' ||
          name === 'llms-full.txt' ||
          name === 'md/index.json' ||
          /^md\/.+\.md$/u.test(name)
      )
    );
    assert(Object.values(firstBundle).every(Buffer.isBuffer));

    b.validateBundle(firstBundle);
    b.commitBundle(site.staticDir, firstBundle);
    const firstSnapshot = snapshotTree(site.staticDir);

    assert(fs.existsSync(path.join(site.staticDir, 'md/UNIF-DESIGN.md')));
    assert(
      fs.readdirSync(path.join(site.staticDir, 'md')).includes('UNIF-DESIGN.md')
    );
    assert(
      !fs
        .readdirSync(path.join(site.staticDir, 'md'))
        .includes('unif-design.md')
    );
    assert(!fs.existsSync(path.join(site.staticDir, 'md/old-stale.md')));
    assert.strictEqual(
      firstSnapshot['img/sentinel.bin'].hash,
      beforeBuild['img/sentinel.bin'].hash
    );
    assert.deepStrictEqual(transientDirectories(site.staticDir), []);

    const secondBundle = b.buildBundle(site);
    b.commitBundle(site.staticDir, secondBundle);
    const secondSnapshot = snapshotTree(site.staticDir);

    assert.deepStrictEqual(secondSnapshot, firstSnapshot);
    assert.deepStrictEqual(
      Object.keys(secondSnapshot).sort(),
      Object.keys(firstSnapshot).sort()
    );
    assert.deepStrictEqual(transientDirectories(site.staticDir), []);
  });
});

test('a package version change only updates bundle metadata, not individual document pages', () => {
  withTempDirectory((directory) => {
    const site = createTempSite(directory);
    const before = b.buildBundle(site);
    const manifest = path.join(directory, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    writeFixture(manifest, JSON.stringify({ ...pkg, version: '1.2.4' }));
    const after = b.buildBundle(site);
    const changed = Object.keys(before)
      .filter((name) => !before[name].equals(after[name]))
      .sort();
    assert.deepStrictEqual(changed, ['llms-full.txt', 'llms.txt']);
    for (const [name, content] of Object.entries(after)) {
      if (/^md\/.+\.md$/u.test(name)) {
        assert.match(
          content.toString('utf8'),
          /<!-- Generated from @unif\/fixture; edit source documentation\. -->/u
        );
        assert(!content.toString('utf8').includes('@unif/fixture@'));
      }
    }
    for (const name of ['llms.txt', 'llms-full.txt'])
      assert(after[name].toString('utf8').includes('@unif/fixture@1.2.4'));
  });
});

test('full bundle ends with exactly one newline', () => {
  withTempDirectory((directory) => {
    const site = createTempSite(directory);
    for (const sourcePath of [
      'UNIF-DESIGN.md',
      'getting-started.md',
      'components/button.mdx',
    ]) {
      fs.appendFileSync(path.join(site.docsDir, sourcePath), '\n');
    }
    const candidate = b.buildBundle(site);
    const ending = candidate['llms-full.txt'].toString('utf8').match(/\n*$/u);

    assert.strictEqual(ending?.[0], '\n');
  });
});

test('unknown Demo and dead internal links fail before staging and preserve every old byte', () => {
  for (const failure of [
    { name: 'unknown Demo', options: { unknownDemo: true } },
    { name: 'dead link', options: { deadLink: true } },
  ]) {
    withTempDirectory((directory) => {
      const site = createTempSite(directory, failure.options);
      const before = snapshotTree(site.staticDir);

      assert.throws(
        () => b.buildBundle(site),
        failure.name === 'unknown Demo'
          ? /unknown Demo MissingDemo/u
          : /missing internal route \/docs\/does-not-exist/u
      );
      assert.deepStrictEqual(snapshotTree(site.staticDir), before);
      assert.deepStrictEqual(transientDirectories(site.staticDir), []);
    });
  }
});

test('empty or missing docs fail instead of producing an empty successful bundle', () => {
  withTempDirectory((directory) => {
    const emptyRoot = path.join(directory, 'empty-site');
    fs.mkdirSync(path.join(emptyRoot, 'docs'), { recursive: true });
    assert.throws(
      () => b.buildBundle({ root: emptyRoot }),
      /docs.*no Markdown documents/iu
    );

    const missingRoot = path.join(directory, 'missing-site');
    fs.mkdirSync(missingRoot, { recursive: true });
    assert.throws(
      () => b.buildBundle({ root: missingRoot }),
      /docs.*not found/iu
    );
  });
});

test('unsafe and colliding bundle keys fail before mkdtemp', () => {
  withTempDirectory((directory) => {
    const staticDir = path.join(directory, 'static');
    fs.mkdirSync(staticDir, { recursive: true });
    const fixtures = [
      ['parent traversal', { '../img/evil.bin': Buffer.from('evil') }],
      ['nested traversal', { 'md/../../img/evil.bin': Buffer.from('evil') }],
      [
        'case collision',
        {
          'md/A.md': Buffer.from('# A\n'),
          'md/a.md': Buffer.from('# a\n'),
        },
      ],
      [
        'NFC collision',
        {
          'md/café.md': Buffer.from('# composed\n'),
          'md/cafe\u0301.md': Buffer.from('# decomposed\n'),
        },
      ],
    ];

    for (const [name, additions] of fixtures) {
      let mkdtempCalls = 0;
      const fileOps = {
        ...b.REAL_FILE_OPS,
        mkdtempSync(...args) {
          mkdtempCalls += 1;
          return fs.mkdtempSync(...args);
        },
      };
      assert.throws(
        () =>
          b.commitBundle(
            staticDir,
            { ...minimalBundle(), ...additions },
            fileOps
          ),
        name.includes('collision') ? /collision/iu : /unsafe.*target/iu
      );
      assert.strictEqual(mkdtempCalls, 0, name);
      assert.deepStrictEqual(transientDirectories(staticDir), []);
    }
  });
});

test('single non-NFC target and every unprocessed Demo name fail before mkdtemp', () => {
  withTempDirectory((directory) => {
    const staticDir = path.join(directory, 'static');
    fs.mkdirSync(staticDir, { recursive: true });
    const decomposedPath = 'md/cafe\u0301.md';
    const decomposedEntries = [
      {
        title: 'Cafe',
        mdPath: decomposedPath,
        slug: '/cafe',
        section: '概览',
        description: null,
      },
    ];
    const fixtures = [
      {
        expected: /NFC.*target|target.*NFC/iu,
        value: {
          'llms.txt': Buffer.from(`- [Cafe](${decomposedPath})\n`),
          'llms-full.txt': Buffer.from('# Full\n'),
          'md/index.json': Buffer.from(
            `${JSON.stringify(decomposedEntries, null, 2)}\n`
          ),
          [decomposedPath]: Buffer.from('# Cafe\n'),
        },
      },
      ...['Demo', 'fooDemo', '_fooDemo', '$fooDemo'].map((name) => ({
        expected: /unprocessed Demo markup/u,
        value: minimalBundle({
          'md/guide.md': Buffer.from(`# Guide\n\n<${name} />\n`),
        }),
      })),
    ];

    for (const fixture of fixtures) {
      let mkdtempCalls = 0;
      const fileOps = overrideFileOps({
        mkdtempSync(real, ...args) {
          mkdtempCalls += 1;
          return real(...args);
        },
      });
      assert.throws(
        () => b.commitBundle(staticDir, fixture.value, fileOps),
        fixture.expected
      );
      assert.strictEqual(mkdtempCalls, 0);
    }
  });
});

test('file-directory and directory spelling collisions fail before staging and name both targets', () => {
  withTempDirectory((directory) => {
    const staticDir = path.join(directory, 'static');
    fs.mkdirSync(staticDir, { recursive: true });
    const fixtures = [
      {
        additions: {
          'md/index.json/guide.md': Buffer.from('# Descendant\n'),
        },
        left: 'md/index.json',
        right: 'md/index.json/guide.md',
      },
      {
        additions: {
          'md/Group/a.md': Buffer.from('# A\n'),
          'md/group/b.md': Buffer.from('# B\n'),
        },
        left: 'md/Group/a.md',
        right: 'md/group/b.md',
      },
      {
        additions: {
          'md/Café/a.md': Buffer.from('# A\n'),
          'md/Cafe\u0301/b.md': Buffer.from('# B\n'),
        },
        left: 'md/Café/a.md',
        right: 'md/Cafe\u0301/b.md',
      },
    ];

    for (const fixture of fixtures) {
      const candidate = { ...minimalBundle(), ...fixture.additions };
      const namesBothTargets = (error) =>
        error instanceof Error &&
        error.message.includes(fixture.left) &&
        error.message.includes(fixture.right);

      assert.throws(() => b.validateBundle(candidate), namesBothTargets);
      let mkdtempCalls = 0;
      const fileOps = overrideFileOps({
        mkdtempSync(real, ...args) {
          mkdtempCalls += 1;
          return real(...args);
        },
      });
      assert.throws(
        () => b.commitBundle(staticDir, candidate, fileOps),
        namesBothTargets
      );
      assert.strictEqual(mkdtempCalls, 0);
    }
  });
});

test('fileOps injection surface stays restricted to the nine planned methods', () => {
  assert.deepStrictEqual(Object.keys(b.REAL_FILE_OPS).sort(), [
    'existsSync',
    'mkdirSync',
    'mkdtempSync',
    'readFileSync',
    'readdirSync',
    'renameSync',
    'rmSync',
    'statSync',
    'writeFileSync',
  ]);
});

test('stage write, read, and second validation failures remove only stage', () => {
  const scenarios = [
    {
      name: 'write',
      expected: /stage write fault/u,
      createOps() {
        let writes = 0;
        return overrideFileOps({
          writeFileSync(real, ...args) {
            writes += 1;
            if (writes === 2) throw new Error('stage write fault');
            return real(...args);
          },
        });
      },
    },
    {
      name: 'read',
      expected: /stage read fault/u,
      createOps() {
        let reads = 0;
        return overrideFileOps({
          readFileSync(real, target, ...args) {
            if (isInsideTransient(target, '.llms-stage-')) {
              reads += 1;
              if (reads === 2) throw new Error('stage read fault');
            }
            return real(target, ...args);
          },
        });
      },
    },
    {
      name: 'second validation',
      expected: /missing internal route missing\.md/u,
      createOps(candidate) {
        return overrideFileOps({
          writeFileSync(real, target, content, ...args) {
            if (target.endsWith(path.join('md', 'guide.md'))) {
              const invalid = Buffer.from('# Guide\n\n[Dead](missing.md)\n');
              candidate['md/guide.md'] = invalid;
              return real(target, invalid, ...args);
            }
            return real(target, content, ...args);
          },
        });
      },
    },
    {
      name: 'staged Demo validation',
      expected: /unprocessed Demo markup/u,
      createOps(candidate) {
        return overrideFileOps({
          writeFileSync(real, target, content, ...args) {
            if (target.endsWith(path.join('md', 'guide.md'))) {
              const invalid = Buffer.from('# Guide\n\n<fooDemo />\n');
              candidate['md/guide.md'] = invalid;
              return real(target, invalid, ...args);
            }
            return real(target, content, ...args);
          },
        });
      },
    },
    {
      name: 'unexpected staged target',
      expected: /staged bundle tree.*unexpected/iu,
      createOps() {
        return overrideFileOps({
          writeFileSync(real, target, content, ...args) {
            const result = real(target, content, ...args);
            if (target.endsWith(path.join('md', 'guide.md'))) {
              real(
                path.join(path.dirname(target), 'unexpected.md'),
                '# extra\n'
              );
            }
            return result;
          },
        });
      },
    },
  ];

  for (const scenario of scenarios) {
    withTempDirectory((directory) => {
      const { staticDir } = createFormalFixture(directory);
      const before = snapshotTree(staticDir);
      const candidate = minimalBundle();

      assert.throws(
        () =>
          b.commitBundle(staticDir, candidate, scenario.createOps(candidate)),
        scenario.expected,
        scenario.name
      );
      assert.deepStrictEqual(snapshotTree(staticDir), before, scenario.name);
      assert.deepStrictEqual(
        transientDirectories(staticDir),
        [],
        scenario.name
      );
    });
  }
});

test('bundle validation uses full Markdown reference semantics for staged links', () => {
  const candidate = minimalBundle({
    'md/guide.md': Buffer.from(
      [
        '# Guide',
        '',
        '[Dead reference][target]',
        '',
        '[target]:',
        '  missing.md "title"',
        '',
      ].join('\n')
    ),
  });

  assert.throws(
    () => b.validateBundle(candidate),
    /missing internal route missing\.md/u
  );
});

test('mid-install failure restores all three originally present targets', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const commitFault = new Error('install llms-full fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        return real(source, destination);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(snapshotTree(staticDir), before);
    assert.deepStrictEqual(transientDirectories(staticDir), []);
  });
});

test('mid-install failure restores originally present targets and keeps absent targets absent', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory, ['llms.txt']);
    const before = snapshotTree(staticDir);
    const commitFault = new Error('partial install fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        return real(source, destination);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(snapshotTree(staticDir), before);
    assert(!fs.existsSync(path.join(staticDir, 'llms-full.txt')));
    assert(!fs.existsSync(path.join(staticDir, 'md')));
    assert.deepStrictEqual(transientDirectories(staticDir), []);
  });
});

test('backup-phase failure restores only the first moved target and preserves untouched targets', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const backupFault = new Error('backup llms-full fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(destination, '.llms-backup-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw backupFault;
        }
        return real(source, destination);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, backupFault);
    assert.deepStrictEqual(snapshotTree(staticDir), before);
    assert.deepStrictEqual(transientDirectories(staticDir), []);
  });
});

test('backup directory creation failure removes stage without touching formal targets', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const backupCreationFault = new Error('backup creation fault');
    let temporaryDirectoryCalls = 0;
    const fileOps = overrideFileOps({
      mkdtempSync(real, ...args) {
        temporaryDirectoryCalls += 1;
        if (temporaryDirectoryCalls === 2) throw backupCreationFault;
        return real(...args);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert.strictEqual(caught, backupCreationFault);
    assert.deepStrictEqual(snapshotTree(staticDir), before);
    assert.deepStrictEqual(transientDirectories(staticDir), []);
  });
});

test('backup creation plus stage cleanup failure retains both causes and the exact stage path', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const backupCreationFault = new Error('backup creation fault');
    const stageCleanupFault = new Error('precommit stage cleanup fault');
    let temporaryDirectoryCalls = 0;
    const fileOps = overrideFileOps({
      mkdtempSync(real, ...args) {
        temporaryDirectoryCalls += 1;
        if (temporaryDirectoryCalls === 2) throw backupCreationFault;
        return real(...args);
      },
      rmSync(real, target, options) {
        if (path.basename(target).startsWith('.llms-stage-')) {
          throw stageCleanupFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, backupCreationFault);
    assert.deepStrictEqual(caught.cleanupErrors, [stageCleanupFault]);
    assert.strictEqual(caught.recoveryPaths.length, 1);
    assert(fs.existsSync(caught.recoveryPaths[0]));
    assert(caught.message.includes(caught.recoveryPaths[0]));
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(snapshotTree(staticDir)).filter(
          ([name]) => !name.startsWith('.llms-stage-')
        )
      ),
      before
    );
    assert(
      transientDirectories(staticDir).every((name) =>
        name.startsWith('.llms-stage-')
      )
    );
  });
});

test('rollback stage cleanup failure reports both staged files and retained empty backup', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const candidate = minimalBundle();
    const commitFault = new Error('install fault before llms-full');
    const stageCleanupFault = new Error('rollback stage cleanup fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        return real(source, destination);
      },
      rmSync(real, target, options) {
        if (path.basename(target).startsWith('.llms-stage-')) {
          throw stageCleanupFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, candidate, fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(caught.rollbackErrors, [stageCleanupFault]);
    const transientPaths = transientDirectories(staticDir)
      .map((name) => path.join(staticDir, name))
      .sort();
    assert(Array.isArray(caught.recoveryPaths));
    assert.deepStrictEqual([...caught.recoveryPaths].sort(), transientPaths);
    assert.strictEqual(caught.recoveryPath, undefined);
    assert(
      caught.recoveryPaths.every((target) => caught.message.includes(target))
    );

    const stage = caught.recoveryPaths.find((target) =>
      path.basename(target).startsWith('.llms-stage-')
    );
    const backup = caught.recoveryPaths.find((target) =>
      path.basename(target).startsWith('.llms-backup-')
    );
    assert.deepStrictEqual(Object.keys(snapshotTree(stage)).sort(), [
      'llms-full.txt',
      'md/guide.md',
      'md/index.json',
    ]);
    assert.deepStrictEqual(
      fs.readFileSync(path.join(stage, 'llms-full.txt')),
      candidate['llms-full.txt']
    );
    assert.deepStrictEqual(snapshotTree(backup), {});
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(snapshotTree(staticDir)).filter(
          ([name]) =>
            !name.startsWith('.llms-stage-') &&
            !name.startsWith('.llms-backup-')
        )
      ),
      before
    );
  });
});

test('rollback reports installed removal, restore, and stage cleanup errors without replacing commit cause', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const sentinelBefore = fs.readFileSync(
      path.join(staticDir, 'img/sentinel.bin')
    );
    const commitFault = new Error('commit fault');
    const installedRemovalFault = new Error('installed removal fault');
    const restoreFault = new Error('restore fault');
    const stageRemovalFault = new Error('stage removal fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        if (
          isInsideTransient(source, '.llms-backup-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw restoreFault;
        }
        return real(source, destination);
      },
      rmSync(real, target, options) {
        if (target === path.join(staticDir, 'llms.txt')) {
          throw installedRemovalFault;
        }
        if (path.basename(target).startsWith('.llms-stage-')) {
          throw stageRemovalFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(caught.rollbackErrors, [
      installedRemovalFault,
      restoreFault,
      stageRemovalFault,
    ]);
    const transientPaths = transientDirectories(staticDir)
      .map((name) => path.join(staticDir, name))
      .sort();
    assert(Array.isArray(caught.recoveryPaths));
    assert.deepStrictEqual([...caught.recoveryPaths].sort(), transientPaths);
    assert.strictEqual(caught.recoveryPath, undefined);
    assert(
      caught.recoveryPaths.every(
        (target) => fs.existsSync(target) && caught.message.includes(target)
      )
    );
    assert.deepStrictEqual(
      fs.readFileSync(path.join(staticDir, 'img/sentinel.bin')),
      sentinelBefore
    );
    assert.strictEqual(transientDirectories(staticDir).length, 2);
  });
});

test('rollback backup cleanup failure preserves the exact recovery path and restored formal targets', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const commitFault = new Error('commit before backup cleanup');
    const backupRemovalFault = new Error('rollback backup removal fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        return real(source, destination);
      },
      rmSync(real, target, options) {
        if (path.basename(target).startsWith('.llms-backup-')) {
          throw backupRemovalFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(caught.rollbackErrors, [backupRemovalFault]);
    assert(Array.isArray(caught.recoveryPaths));
    assert.strictEqual(caught.recoveryPaths.length, 1);
    assert(path.basename(caught.recoveryPaths[0]).startsWith('.llms-backup-'));
    assert(fs.existsSync(caught.recoveryPaths[0]));
    assert(caught.message.includes(caught.recoveryPaths[0]));
    assert.strictEqual(caught.recoveryPath, undefined);
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(snapshotTree(staticDir)).filter(
          ([name]) => !name.startsWith('.llms-backup-')
        )
      ),
      before
    );
    assert.deepStrictEqual(
      transientDirectories(staticDir).filter((name) =>
        name.startsWith('.llms-stage-')
      ),
      []
    );
  });
});

test('originally absent cleanup errors are appended while the original commit cause is retained', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory, ['llms.txt']);
    const before = snapshotTree(staticDir);
    const commitFault = new Error('partial commit fault');
    const absentCleanupFault = new Error('absent md cleanup fault');
    const fileOps = overrideFileOps({
      renameSync(real, source, destination) {
        if (
          isInsideTransient(source, '.llms-stage-') &&
          path.basename(source) === 'llms-full.txt'
        ) {
          throw commitFault;
        }
        return real(source, destination);
      },
      rmSync(real, target, options) {
        if (target === path.join(staticDir, 'md')) {
          throw absentCleanupFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, commitFault);
    assert.deepStrictEqual(caught.rollbackErrors, [absentCleanupFault]);
    assert(Array.isArray(caught.recoveryPaths));
    assert.strictEqual(caught.recoveryPaths.length, 1);
    assert(path.basename(caught.recoveryPaths[0]).startsWith('.llms-backup-'));
    assert(fs.existsSync(caught.recoveryPaths[0]));
    assert(caught.message.includes(caught.recoveryPaths[0]));
    assert.strictEqual(caught.recoveryPath, undefined);
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(snapshotTree(staticDir)).filter(
          ([name]) => !name.startsWith('.llms-backup-')
        )
      ),
      before
    );
  });
});

test('stage failure plus stage cleanup failure keeps the original cause and recovery path', () => {
  withTempDirectory((directory) => {
    const { staticDir } = createFormalFixture(directory);
    const before = snapshotTree(staticDir);
    const writeFault = new Error('prepare write fault');
    const cleanupFault = new Error('prepare cleanup fault');
    let writes = 0;
    const fileOps = overrideFileOps({
      writeFileSync(real, ...args) {
        writes += 1;
        if (writes === 2) throw writeFault;
        return real(...args);
      },
      rmSync(real, target, options) {
        if (path.basename(target).startsWith('.llms-stage-')) {
          throw cleanupFault;
        }
        return real(target, options);
      },
    });

    let caught;
    try {
      b.commitBundle(staticDir, minimalBundle(), fileOps);
    } catch (error) {
      caught = error;
    }

    assert(caught instanceof Error);
    assert.strictEqual(caught.cause, writeFault);
    assert.deepStrictEqual(caught.cleanupErrors, [cleanupFault]);
    assert.strictEqual(caught.recoveryPaths.length, 1);
    assert(fs.existsSync(caught.recoveryPaths[0]));
    assert(caught.message.includes(caught.recoveryPaths[0]));
    assert.deepStrictEqual(
      Object.fromEntries(
        Object.entries(snapshotTree(staticDir)).filter(
          ([name]) => !name.startsWith('.llms-stage-')
        )
      ),
      before
    );
  });
});

test('post-install cleanup faults report complete formal targets and never roll back', () => {
  for (const failedTarget of ['stage', 'backup']) {
    withTempDirectory((directory) => {
      const { staticDir } = createFormalFixture(directory);
      const candidate = minimalBundle();
      const sentinelBefore = fs.readFileSync(
        path.join(staticDir, 'img/sentinel.bin')
      );
      const cleanupFault = new Error(`${failedTarget} cleanup fault`);
      let restoreCalls = 0;
      const fileOps = overrideFileOps({
        renameSync(real, source, destination) {
          if (isInsideTransient(source, '.llms-backup-')) restoreCalls += 1;
          return real(source, destination);
        },
        rmSync(real, target, options) {
          if (path.basename(target).startsWith(`.llms-${failedTarget}-`)) {
            throw cleanupFault;
          }
          return real(target, options);
        },
      });

      let caught;
      try {
        b.commitBundle(staticDir, candidate, fileOps);
      } catch (error) {
        caught = error;
      }

      assert(caught instanceof Error);
      assert.strictEqual(caught.cause, cleanupFault);
      assert.strictEqual(caught.formalTargetsComplete, true);
      assert.strictEqual(restoreCalls, 0);
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staticDir, 'llms.txt')),
        candidate['llms.txt']
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staticDir, 'llms-full.txt')),
        candidate['llms-full.txt']
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staticDir, 'md/guide.md')),
        candidate['md/guide.md']
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staticDir, 'img/sentinel.bin')),
        sentinelBefore
      );
      assert(
        caught.recoveryPaths.every((target) => fs.existsSync(target)),
        failedTarget
      );
      assert(
        caught.recoveryPaths.every((target) => caught.message.includes(target)),
        failedTarget
      );
      assert.strictEqual(
        transientDirectories(staticDir).some((name) =>
          name.startsWith(`.llms-${failedTarget}-`)
        ),
        true
      );
    });
  }
});

test('post-install partial cleanup reports only recovery paths that still exist', () => {
  for (const failedTarget of ['stage', 'backup']) {
    withTempDirectory((directory) => {
      const { staticDir } = createFormalFixture(directory);
      const candidate = minimalBundle();
      const cleanupFault = new Error(`${failedTarget} partial cleanup fault`);
      let restoreCalls = 0;
      const fileOps = overrideFileOps({
        renameSync(real, source, destination) {
          if (isInsideTransient(source, '.llms-backup-')) restoreCalls += 1;
          return real(source, destination);
        },
        rmSync(real, target, options) {
          if (path.basename(target).startsWith(`.llms-${failedTarget}-`)) {
            real(target, options);
            throw cleanupFault;
          }
          return real(target, options);
        },
      });

      let caught;
      try {
        b.commitBundle(staticDir, candidate, fileOps);
      } catch (error) {
        caught = error;
      }

      assert(caught instanceof Error);
      assert.strictEqual(caught.cause, cleanupFault);
      assert.strictEqual(caught.formalTargetsComplete, true);
      assert.strictEqual(restoreCalls, 0);
      assert(
        caught.recoveryPaths.every((target) => fs.existsSync(target)),
        failedTarget
      );
      assert.deepStrictEqual(
        caught.recoveryPaths.map((target) => path.basename(target)),
        failedTarget === 'stage'
          ? [
              transientDirectories(staticDir).find((name) =>
                name.startsWith('.llms-backup-')
              ),
            ]
          : []
      );
      assert.deepStrictEqual(
        fs.readFileSync(path.join(staticDir, 'llms.txt')),
        candidate['llms.txt']
      );
    });
  }
});

test('frontmatter description is parsed', () => {
  const parsed = b.parseFrontmatter(
    '---\ntitle: T\ndescription: D 描述\n---\nbody'
  );

  assert.strictEqual(parsed.description, 'D 描述');
  assert.strictEqual(parsed.body, 'body');
});

test('uppercase source and lowercase alias share one canonical output', () => {
  const map = buildRouteMap([
    document('UNIF-DESIGN.md', { slug: '/unif-design' }),
  ]);

  assert.strictEqual(map.documents[0].outputPath, 'md/UNIF-DESIGN.md');
  assert.strictEqual(
    map.resolve('/docs/UNIF-DESIGN').outputPath,
    'md/UNIF-DESIGN.md'
  );
  assert.strictEqual(
    map.resolve('/docs/unif-design').outputPath,
    'md/UNIF-DESIGN.md'
  );
  assert.strictEqual(map.documents.length, 1);
});

test('route map rejects case-only canonical output collisions', () => {
  assert.throws(
    () => buildRouteMap([document('Guide.md'), document('guide.mdx')]),
    /canonical output collision.*Guide\.md.*guide\.mdx/iu
  );
});

test('route map rejects NFC-equivalent canonical output collisions', () => {
  assert.throws(
    () => buildRouteMap([document('café.md'), document('cafe\u0301.mdx')]),
    /canonical output collision.*café\.md.*café\.mdx/iu
  );
});

test('route map rejects case-only and NFC-equivalent alias collisions', () => {
  assert.throws(
    () =>
      buildRouteMap([
        document('first.md', { slug: '/shared' }),
        document('second.md', { slug: '/SHARED' }),
      ]),
    /route alias collision.*first\.md.*second\.md/iu
  );
  assert.throws(
    () =>
      buildRouteMap([
        document('first.md', { slug: '/café' }),
        document('second.md', { slug: '/cafe\u0301' }),
      ]),
    /route alias collision.*first\.md.*second\.md/iu
  );
});

test('relative slugs preserve case, normalize NFC, and share collision keys', () => {
  assert.strictEqual(
    normalizeRelSlug('Components/Cafe\u0301', 'docs/source.md'),
    'Components/Café'
  );
  assert.strictEqual(collisionKey('Components/CAFÉ'), 'components/café');
  assert.strictEqual(
    collisionKey('Components/Cafe\u0301'),
    collisionKey('components/café')
  );
});

test('relative slugs reject absolute, backslash, control, and unsafe segments', () => {
  const unsafe = [
    '',
    '/absolute',
    'C:/absolute',
    'components\\button',
    'components//button',
    '.',
    'components/./button',
    '..',
    'components/../button',
    'components/\u0001button',
  ];

  for (const value of unsafe) {
    assert.throws(
      () => normalizeRelSlug(value, 'docs/source.md'),
      /docs\/source\.md: unsafe/u
    );
  }
});

test('frontmatter aliases require exactly one leading slash', () => {
  for (const slug of ['components/button', '//components/button']) {
    assert.throws(
      () => buildRouteMap([document('button.md', { slug })]),
      /docs\/button\.md: unsafe frontmatter slug/u
    );
  }
});

test('source-derived routes reject reserved targets and the md namespace', () => {
  const fixtures = [
    ['LLMS.TXT.md', 'llms.txt'],
    ['Llms-Full.Txt.mdx', 'llms-full.txt'],
    ['MD.md', 'md'],
    ['Md/Index.Json.md', 'md/index.json'],
    ['mD/components/button.mdx', 'md'],
  ];

  for (const [sourcePath, reservedTarget] of fixtures) {
    assert.throws(
      () => buildRouteMap([document(sourcePath)]),
      (error) =>
        error.message.includes(`docs/${sourcePath}`) &&
        error.message.includes(reservedTarget)
    );
  }
});

test('frontmatter aliases reject reserved targets and the md namespace', () => {
  const fixtures = [
    ['/LLMS.TXT', 'llms.txt'],
    ['/Llms-Full.Txt', 'llms-full.txt'],
    ['/MD', 'md'],
    ['/Md/Index.Json', 'md/index.json'],
    ['/mD/components/button', 'md'],
  ];

  for (const [slug, reservedTarget] of fixtures) {
    const sourcePath = `safe-${reservedTarget.replace('/', '-')}.md`;
    assert.throws(
      () => buildRouteMap([document(sourcePath, { slug })]),
      (error) =>
        error.message.includes(`docs/${sourcePath}`) &&
        error.message.includes(reservedTarget)
    );
  }
});

test('internal links resolve only through canonical routes and preserve fragments', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx', { slug: '/catalog/deep/card' }),
    document('components/button.mdx'),
    document('components/cell.mdx'),
    document('getting-started.md'),
  ]);
  const sourceDocument = routeMap.documents[0];
  const fragment = '#API-Cafe\u0301-中文%20X';
  const markdown = [
    `[Button](/docs/components/button${fragment})`,
    '[Cell](./cell.mdx)',
    '[Button source](./button.mdx)',
    '[Next](../getting-started.md)',
    '[Http](http://x)',
    '[Web](https://x)',
    '[Mail](mailto:a@b)',
    '[Here](#local)',
  ].join(' ');

  assert.strictEqual(
    rewriteInternalLinks(markdown, sourceDocument, routeMap),
    [
      `[Button](button.md${fragment})`,
      '[Cell](cell.md)',
      '[Button source](button.md)',
      '[Next](../getting-started.md)',
      '[Http](http://x)',
      '[Web](https://x)',
      '[Mail](mailto:a@b)',
      '[Here](#local)',
    ].join(' ')
  );
  assert.strictEqual(
    rewriteInternalLinks(
      `[Button](/docs/components/button${fragment})`,
      { ...sourceDocument, outputPath: 'llms-full.txt' },
      routeMap
    ),
    `[Button](md/components/button.md${fragment})`
  );
});

test('whitelisted schemes use the unescaped semantic target but preserve source bytes', () => {
  const routeMap = buildRouteMap([document('components/card.mdx')]);
  const source = [
    '[Web](https\\://example.com/docs)',
    '[Mail](mailto\\:docs@example.com)',
  ].join(' ');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    source
  );
});

test('non-whitelisted schemes and protocol-relative targets fail through route lookup', () => {
  const routeMap = buildRouteMap([document('components/card.mdx')]);
  const targets = [
    'ftp://example.com/guide',
    'tel:+123456',
    'data:text/plain,guide',
    'javascript:alert(1)',
    '//cdn.example.com/guide',
  ];

  for (const target of targets) {
    assert.throws(
      () =>
        rewriteInternalLinks(
          `[Target](${target})`,
          routeMap.documents[0],
          routeMap
        ),
      (error) =>
        error.message.includes('docs/components/card.mdx') &&
        error.message.includes(target)
    );
  }
});

test('structured inline links support nested and escaped labels while preserving titles', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '[Button [primary]](/docs/components/button#props "Primary button")',
    "[Button \\]](./button.mdx#api 'Escaped label')",
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Button [primary]](button.md#props "Primary button")',
      "[Button \\]](button.md#api 'Escaped label')",
    ].join('\n')
  );
});

test('inline destinations unescape CommonMark ASCII punctuation before route lookup', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/guide(test).md'),
  ]);

  assert.strictEqual(
    rewriteInternalLinks(
      '[Guide](./guide\\(test\\).md)',
      routeMap.documents[0],
      routeMap
    ),
    '[Guide](guide(test).md)'
  );
});

test('escaped fragment delimiters are split from the CommonMark semantic target', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '[Inline](./button.md\\#Inline-Props)',
    '[Reference][button]',
    '',
    '[button]: ./button.mdx\\#Reference-Props',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Inline](button.md#Inline-Props)',
      '[Reference][button]',
      '',
      '[button]: button.md#Reference-Props',
    ].join('\n')
  );
});

test('escaped literal link syntax remains byte-for-byte unchanged', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = '\\[Button](/docs/components/button)';

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    source
  );
});

test('reference definitions rewrite destinations and preserve uses and titles', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '[Button][button]',
    '[Web][web] [Mail][mail] [Local][local]',
    '',
    '[button]: /docs/components/button#Props "Button title"',
    '[web]: https://example.com/docs',
    '[mail]: mailto:docs@example.com',
    '[local]: #same-page',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Button][button]',
      '[Web][web] [Mail][mail] [Local][local]',
      '',
      '[button]: button.md#Props "Button title"',
      '[web]: https://example.com/docs',
      '[mail]: mailto:docs@example.com',
      '[local]: #same-page',
    ].join('\n')
  );
});

test('reference labels normalize escapes whitespace and case for full collapsed and shortcut links', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '[Full][  BuTton\\!   Docs ]',
    '[Collapsed][]',
    '[Shortcut]',
    '',
    '[button! docs]: /docs/components/button#full',
    '[collapsed]: /docs/components/button#collapsed',
    '[shortcut]: /docs/components/button#shortcut',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Full][  BuTton\\!   Docs ]',
      '[Collapsed][]',
      '[Shortcut]',
      '',
      '[button! docs]: button.md#full',
      '[collapsed]: button.md#collapsed',
      '[shortcut]: button.md#shortcut',
    ].join('\n')
  );
});

test('only the first normalized reference definition is active', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '[Button][shared]',
    '',
    '[shared]: /docs/components/button#first',
    '[SHARED]: ./missing.mdx#inactive',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Button][shared]',
      '',
      '[shared]: button.md#first',
      '[SHARED]: ./missing.mdx#inactive',
    ].join('\n')
  );
});

test('multiline plain and angle reference definitions preserve layout and titles', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/guide(test).md'),
  ]);
  const source = [
    '[Plain][plain]',
    '[Angle][angle]',
    '',
    '[plain]: ./guide\\(test\\).md',
    '  "Plain title"',
    '[angle]:',
    '  </docs/components/guide(test).md#API>',
    "  'Angle title'",
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    [
      '[Plain][plain]',
      '[Angle][angle]',
      '',
      '[plain]: guide(test).md',
      '  "Plain title"',
      '[angle]:',
      '  <guide(test).md#API>',
      "  'Angle title'",
    ].join('\n')
  );
});

test('image-only and unused reference definitions remain byte-for-byte', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);
  const source = [
    '![Button][image]',
    '',
    '[image]: /docs/components/button#image "Image target"',
    '[unused]: ./missing.mdx#unused "Unused target"',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    source
  );
});

test('a reference label used by both link and image fails explicitly', () => {
  const routeMap = buildRouteMap([
    document('components/card.mdx'),
    document('components/button.mdx'),
  ]);

  assert.throws(
    () =>
      rewriteInternalLinks(
        [
          '[Button][shared]',
          '![Button][shared]',
          '',
          '[shared]: /docs/components/button',
        ].join('\n'),
        routeMap.documents[0],
        routeMap
      ),
    /docs\/components\/card\.mdx: reference label shared is used by both link and image/iu
  );
});

test('reference definitions inside fenced and inline code remain byte-for-byte', () => {
  const routeMap = buildRouteMap([document('components/card.mdx')]);
  const source = [
    '正文 `[missing]: /docs/missing` 保留。',
    '```md',
    '[missing]: ./missing.mdx#props "Missing"',
    '```',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    source
  );
});

test('missing reference destinations report source and original target', () => {
  const routeMap = buildRouteMap([document('components/card.mdx')]);

  assert.throws(
    () =>
      rewriteInternalLinks(
        [
          '[Missing][missing]',
          '',
          '[missing]: ./missing.mdx#props "Missing"',
        ].join('\n'),
        routeMap.documents[0],
        routeMap
      ),
    /docs\/components\/card\.mdx: missing internal route \.\/missing\.mdx#props/u
  );
});

test('real relative and alias routes resolve to canonical mirror paths', () => {
  const routeMap = buildRouteMap([
    document('UNIF-DESIGN.md', { slug: '/unif-design' }),
    document('components/overview.md', { slug: '/components' }),
    document('components/drawer-header.mdx'),
    document('components/avatar.mdx'),
    document('components/pulse.mdx'),
    document('design/tokens/motion.md'),
  ]);
  const bySource = new Map(
    routeMap.documents.map((item) => [item.sourcePath, item])
  );

  assert.strictEqual(
    rewriteInternalLinks(
      '[Components](/docs/components)',
      bySource.get('UNIF-DESIGN.md'),
      routeMap
    ),
    '[Components](components/overview.md)'
  );
  assert.strictEqual(
    rewriteInternalLinks(
      '[Avatar](./avatar#图片-source-identity-与失败隔离)',
      bySource.get('components/drawer-header.mdx'),
      routeMap
    ),
    '[Avatar](avatar.md#图片-source-identity-与失败隔离)'
  );
  assert.strictEqual(
    rewriteInternalLinks(
      '[Pulse](../../components/pulse)',
      bySource.get('design/tokens/motion.md'),
      routeMap
    ),
    '[Pulse](../../components/pulse.md)'
  );
});

test('internal links inside fenced and inline code remain byte-for-byte', () => {
  const routeMap = buildRouteMap([document('source.md')]);
  const source = [
    '正文 `[Missing](/docs/missing)` 保留。',
    '```md',
    '[Also missing](./missing.mdx)',
    '```',
  ].join('\n');

  assert.strictEqual(
    rewriteInternalLinks(source, routeMap.documents[0], routeMap),
    source
  );
});

test('missing internal routes report source file and original target', () => {
  const routeMap = buildRouteMap([document('components/card.mdx')]);

  assert.throws(
    () =>
      rewriteInternalLinks(
        '[Missing](./missing.mdx#props)',
        routeMap.documents[0],
        routeMap
      ),
    /docs\/components\/card\.mdx: missing internal route \.\/missing\.mdx#props/u
  );
});

test('direct LiveDemo retains one support definition and nested source', () => {
  const source = [
    "import { LiveDemo } from '@site/src/components/LiveDemo';",
    'export const Support = ({ children }) => {',
    '  const [on] = useState(true);',
    '  const value = { nested: { label: on ? "开" : "关" } };',
    '  return <View data-label={value.nested.label}>{children}</View>;',
    '};',
    '## 预览',
    '<LiveDemo client:load data-options={{ nested: true }}>',
    '  <Support>',
    '    <Button label="开始" onPress={() => undefined} />',
    '  </Support>',
    '</LiveDemo>',
  ].join('\n');

  const output = b.convertMdxBody(source, 'direct.mdx');

  assert.strictEqual(count(output, 'const Support'), 1);
  assert.strictEqual(count(output, '```tsx'), 1);
  assert.strictEqual(count(output, 'LiveDemo'), 0);
  assert.strictEqual(count(output, 'export const Support'), 0);
  assert(output.includes('const [on] = useState(true);'));
  assert(output.includes('<Support>'));
  assert(output.includes('<Button label="开始"'));
  assert(
    output.includes(
      'return <View data-label={value.nested.label}>{children}</View>;\n' +
        '};\n\n' +
        '  <Support>'
    ),
    'support 与首个 demo body 之间恰好保留一个空白行'
  );
});

test('multiple support definitions keep source order and emit only once', () => {
  const source = [
    'export const FIRST = { order: 1 };',
    'export function secondLabel() { return "second"; }',
    '<LiveDemo><Text>{FIRST.order} {secondLabel()}</Text></LiveDemo>',
    '<LiveDemo><Text>later</Text></LiveDemo>',
  ].join('\n');

  const output = b.convertMdxBody(source, 'support-order.mdx');
  const firstIndex = output.indexOf('const FIRST');
  const secondIndex = output.indexOf('function secondLabel');
  const demoIndex = output.indexOf('<Text>{FIRST.order}');

  assert(firstIndex >= 0);
  assert(firstIndex < secondIndex);
  assert(secondIndex < demoIndex);
  assert.strictEqual(count(output, 'const FIRST'), 1);
  assert.strictEqual(count(output, 'function secondLabel'), 1);
});

test('exported function/const and multiple demos are emitted once', () => {
  const source = [
    'export const SHARED = { label: "共享" };',
    'export function FirstDemo() {',
    '  const [on, setOn] = useState(false);',
    '  return (',
    '    <LiveDemo>',
    '      <Button label={on ? SHARED.label : "关"} onPress={() => setOn(!on)} />',
    '    </LiveDemo>',
    '  );',
    '}',
    'export const SecondDemo = () => {',
    '  const value = { nested: { ok: true } };',
    '  return <Text>{String(value.nested.ok)}</Text>;',
    '};',
    '<FirstDemo />',
    '<SecondDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'multi.mdx');

  assert.strictEqual(count(output, 'function FirstDemo'), 1);
  assert.strictEqual(count(output, 'const SecondDemo'), 1);
  assert.strictEqual(count(output, 'const SHARED'), 1);
  assert.strictEqual(count(output, '<FirstDemo />'), 0);
  assert.strictEqual(count(output, '<SecondDemo />'), 0);
  assert.strictEqual(count(output, 'LiveDemo'), 0);
  assert(output.includes('<>'));
  assert(output.includes('</>'));
});

test('an exported exact Demo is emitted for its self-closing invocation', () => {
  const source = [
    'export const Demo = () => <Text>exact</Text>;',
    '<Demo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'exact-demo.mdx');

  assert.strictEqual(count(output, 'const Demo'), 1);
  assert.strictEqual(count(output, '<Demo />'), 0);
  assert(output.includes('<Text>exact</Text>'));
});

test('an unknown exact Demo invocation fails with source and name', () => {
  assert.throws(
    () => b.convertMdxBody('<Demo />', 'unknown-exact-demo.mdx'),
    /unknown-exact-demo\.mdx: unknown Demo Demo/u
  );
});

test('unknown Demo fails with source name and component name', () => {
  assert.throws(
    () => b.convertMdxBody('## 预览\n<MissingDemo />\n', 'unknown.mdx'),
    /unknown\.mdx: unknown Demo MissingDemo/u
  );
});

test('unknown self-closing Demo with props keeps the unknown error contract', () => {
  assert.throws(
    () =>
      b.convertMdxBody(
        '## 预览\n<MissingDemo value={{ nested: true }} />\n',
        'unknown-props.mdx'
      ),
    /unknown-props\.mdx: unknown Demo MissingDemo/u
  );
});

test('known Demo invocations with props fail instead of dropping props', () => {
  const source = [
    'export const KnownDemo = () => <Text>known</Text>;',
    '<KnownDemo value={{ nested: true }} />',
  ].join('\n');

  assert.throws(
    () => b.convertMdxBody(source, 'known-props.mdx'),
    /known-props\.mdx: unprocessed Demo KnownDemo/u
  );
});

test('known paired Demo invocations fail instead of leaving dangling JSX', () => {
  const source = [
    'export const KnownDemo = () => <Text>known</Text>;',
    '<KnownDemo value="paired"><Text>child</Text></KnownDemo>',
  ].join('\n');

  assert.throws(
    () => b.convertMdxBody(source, 'known-paired.mdx'),
    /known-paired\.mdx: unprocessed Demo KnownDemo/u
  );
});

test('unknown paired Demo invocations fail with source and name', () => {
  const source = '<MissingDemo value="paired"><Text>child</Text></MissingDemo>';

  assert.throws(
    () => b.convertMdxBody(source, 'unknown-paired.mdx'),
    /unknown-paired\.mdx: unknown Demo MissingDemo/u
  );
});

test('ordinary self-closing MDX components are preserved', () => {
  const source = ['## 内容', '<Tabs />', '<DemoPanel />'].join('\n');

  assert.strictEqual(b.convertMdxBody(source, 'ordinary.mdx'), source);
});

test('support definitions without a generated demo fail', () => {
  assert.throws(
    () =>
      b.convertMdxBody(
        'export const OPTIONS = { enabled: true };\n## 正文\n',
        'orphan.mdx'
      ),
    /orphan\.mdx: orphan support definition/u
  );
});

test('duplicate Demo definitions fail', () => {
  const source = [
    'export const SameDemo = () => <Text>A</Text>;',
    'export function SameDemo() { return <Text>B</Text>; }',
    '<SameDemo />',
  ].join('\n');

  assert.throws(
    () => b.convertMdxBody(source, 'duplicate.mdx'),
    /duplicate\.mdx: duplicate Demo SameDemo/u
  );
});

test('unsupported top-level exports fail with source line', () => {
  assert.throws(
    () =>
      b.convertMdxBody(
        ['## 内容', 'export default function DemoPage() {}'].join('\n'),
        'unsupported.mdx'
      ),
    /unsupported\.mdx: unsupported export at 2/u
  );
});

test('unsupported export line numbers include preceding protected code', () => {
  const source = [
    '```tsx',
    'export default function ExampleOnly() {}',
    '```',
    '',
    'export default function RealExport() {}',
  ].join('\n');

  assert.throws(
    () => b.convertMdxBody(source, 'line-number.mdx'),
    /line-number\.mdx: unsupported export at 5/u
  );
});

test('fenced and inline code remain byte-for-byte unchanged', () => {
  const protectedText = [
    '~~~tsx',
    'export const FakeDemo = () => <LiveDemo />;',
    '<UnknownDemo />',
    '~~~',
    '正文 `export const InlineDemo = () => <LiveDemo />` 保留。',
  ].join('\n');

  assert.strictEqual(
    b.convertMdxBody(protectedText, 'protected.mdx'),
    protectedText
  );
});

test('a longer backtick fence is closed only by the same run length', () => {
  const protectedText = [
    '`````tsx',
    'export const FakeDemo = () => (',
    '  <LiveDemo>',
    '```',
    '  <UnknownDemo />',
    '```',
    '  </LiveDemo>',
    ');',
    '`````',
  ].join('\n');

  assert.strictEqual(
    b.convertMdxBody(protectedText, 'long-fence.mdx'),
    protectedText
  );
});

test('Demo normalization changes only real JSX LiveDemo wrappers', () => {
  const source = [
    'export const LexicalDemo = () => {',
    "  const literal = '<LiveDemo>string</LiveDemo>';",
    '  // <LiveDemo>line comment</LiveDemo>',
    '  /* <LiveDemo>block comment</LiveDemo> */',
    '  const template = `<LiveDemo>template raw</LiveDemo>`;',
    '  return <LiveDemo><Text>{literal}</Text></LiveDemo>;',
    '};',
    '<LexicalDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'lexical-live-demo.mdx');

  assert(output.includes("const literal = '<LiveDemo>string</LiveDemo>';"));
  assert(output.includes('// <LiveDemo>line comment</LiveDemo>'));
  assert(output.includes('/* <LiveDemo>block comment</LiveDemo> */'));
  assert(
    output.includes('const template = `<LiveDemo>template raw</LiveDemo>`;')
  );
  assert(output.includes('return <><Text>{literal}</Text></>;'));
});

test('HTML and MDX comments cannot declare exported demos', () => {
  const source = [
    '<!--',
    'export const HiddenDemo = () => <LiveDemo><Text>HTML</Text></LiveDemo>;',
    '<HiddenDemo />',
    '-->',
    '',
    '{/*',
    'export const AlsoHiddenDemo = () => <LiveDemo><Text>MDX</Text></LiveDemo>;',
    '<AlsoHiddenDemo />',
    '*/}',
  ].join('\n');

  assert.strictEqual(b.convertMdxBody(source, 'comments.mdx'), source);
});

test('protected ranges restore nested tokens without changing sentinel-like source', () => {
  const originalSentinel = '\u0000PROTECTED_0\u0000';
  const source = [
    `原始 ${originalSentinel} 保留，\`跨行 code span`,
    '```tsx',
    "import { Hidden } from './hidden';",
    '```',
    '结束` 后继续。',
  ].join('\n');
  const protectedSource = protectCode(source);

  assert.strictEqual(protectedSource.restore(protectedSource.source), source);
  assert.strictEqual(b.convertMdxBody(source, 'nested-protection.mdx'), source);
  assert.strictEqual(count(source, originalSentinel), 1);
});

test('matching multi-backtick inline code and protected imports stay byte-for-byte', () => {
  const source = [
    '正文 ``import Fake from "inline"; ` 内层 backtick`` 保留。',
    '~~~tsx',
    "import { Fenced } from './fenced';",
    '~~~',
    '尾注 `import AlsoFake from "inline";` 保留。',
  ].join('\n');

  assert.strictEqual(b.convertMdxBody(source, 'protected-imports.mdx'), source);
});

test('exported Demo preserves an escaped backtick in a template literal', () => {
  const templateLine = '  const text = `tick \\` value ${1}`;';
  const source = [
    'export const EscapedTemplateDemo = () => {',
    templateLine,
    '  return <LiveDemo><Text>{text}</Text></LiveDemo>;',
    '};',
    '<EscapedTemplateDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'escaped-exported-template.mdx');

  assert(output.includes(templateLine));
  assert(output.includes('return <><Text>{text}</Text></>;'));
});

test('direct LiveDemo preserves an escaped backtick in a template literal', () => {
  const templateExpression = '{`tick \\` value ${1}`}';
  const source = [
    '<LiveDemo>',
    `  <Text>${templateExpression}</Text>`,
    '</LiveDemo>',
  ].join('\n');

  const output = b.convertMdxBody(source, 'escaped-direct-template.mdx');

  assert(output.includes(`<Text>${templateExpression}</Text>`));
  assert.strictEqual(count(output, '```tsx'), 1);
});

test('exported Demo preserves escaped single quotes and template raw text', () => {
  const quoteLine = "  const text = 'it\\'s <LiveDemo>string raw</LiveDemo>';";
  const templateLine =
    '  const template = `keep <LiveDemo>template raw</LiveDemo> and \\`tick`;';
  const source = [
    'export const EscapedStringDemo = () => {',
    quoteLine,
    templateLine,
    '  return <LiveDemo><Text>{text + template}</Text></LiveDemo>;',
    '};',
    '<EscapedStringDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'escaped-string-pipeline.mdx');

  assert(output.includes(quoteLine));
  assert(output.includes(templateLine));
  assert(output.includes('return <><Text>{text + template}</Text></>;'));
});

test('exported Demo preserves nested template expressions end-to-end', () => {
  const templateLine = '  const text = `outer ${`inner ${value}`}`;';
  const source = [
    'export const NestedTemplateDemo = () => {',
    '  const value = "nested";',
    templateLine,
    '  return <LiveDemo><Text>{text}</Text></LiveDemo>;',
    '};',
    '<NestedTemplateDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'nested-template.mdx');

  assert(output.includes(templateLine));
  assert(output.includes('return <><Text>{text}</Text></>;'));
});

test('exported Demo supports regex literals inside JSX event handlers', () => {
  const handlerLine =
    '    <Button onPress={() => /[}]/u.test(value)} label="检查" />';
  const source = [
    'export const RegexHandlerDemo = () => {',
    '  const value = "ok";',
    '  return (',
    '    <LiveDemo>',
    handlerLine,
    '    </LiveDemo>',
    '  );',
    '};',
    '<RegexHandlerDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'regex-handler.mdx');

  assert(output.includes(handlerLine));
  assert(output.includes('return ('));
});

test('Demo token scanning ignores LiveDemo text inside regex literals', () => {
  const patternLine = '  const pattern = /<LiveDemo>raw<\\/LiveDemo>/u;';
  const source = [
    'export const RegexRawDemo = () => {',
    patternLine,
    '  return <LiveDemo><Text>{pattern.source}</Text></LiveDemo>;',
    '};',
    '<RegexRawDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'regex-raw-live-demo.mdx');

  assert(output.includes(patternLine));
  assert(output.includes('return <><Text>{pattern.source}</Text></>;'));
});

test('balanced scanner ignores comments, escaped quotes, and templates', () => {
  const declaration = [
    'export const ComplexDemo = () => {',
    '  const escaped = "} \\" still-string";',
    '  const template = `value ${(() => ({ nested: "]" }))()}`;',
    '  // }]); must not close the declaration',
    '  /* {[( must not open it either */',
    '  return <Text>{template}</Text>;',
    '};',
  ].join('\n');
  const source = `${declaration}\nAFTER`;

  assert.strictEqual(findBalancedEnd(source, 0), declaration.length);
});

test('balanced scanner consumes semicolons in concise JSX text', () => {
  const declaration = 'export const TextDemo = () => <Text>semi;colon</Text>;';
  const source = `${declaration}\n<TextDemo />`;

  assert.strictEqual(findBalancedEnd(source, 0), declaration.length);
  assert(
    b
      .convertMdxBody(source, 'concise-jsx.mdx')
      .includes('const TextDemo = () => <Text>semi;colon</Text>;')
  );
});

test('balanced scanner consumes delimiters and semicolons in regex literals', () => {
  const declaration = 'export const PATTERN = /[});;]+/u;';
  const source = [
    declaration,
    '<LiveDemo><Text>{PATTERN.source}</Text></LiveDemo>',
  ].join('\n');

  assert.strictEqual(findBalancedEnd(source, 0), declaration.length);
  assert(
    b
      .convertMdxBody(source, 'regex-support.mdx')
      .includes('const PATTERN = /[});;]+/u;')
  );
});

test('balanced scanner treats division after postfix increment and decrement as division', () => {
  const incrementLine = '  const incremented = count++ / total;';
  const decrementLine = '  const decremented = count-- / total;';
  const source = [
    'export const PostfixDivisionDemo = () => {',
    '  let count = 2;',
    '  const total = 4;',
    incrementLine,
    decrementLine,
    '  return <LiveDemo><Text>{incremented + decremented}</Text></LiveDemo>;',
    '};',
    '<PostfixDivisionDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'postfix-division.mdx');

  assert(output.includes(incrementLine));
  assert(output.includes(decrementLine));
});

test('balanced scanner still recognizes regex literals after return', () => {
  const regexLine = '  return /[}]/u;';
  const source = [
    'export function ReturnRegexDemo() {',
    regexLine,
    '}',
    '<ReturnRegexDemo />',
  ].join('\n');

  const output = b.convertMdxBody(source, 'return-regex.mdx');

  assert(output.includes(regexLine));
});

test('balanced scanner ends a function declaration at its body brace', () => {
  const declaration = [
    'export async function StatefulDemo() {',
    '  return <View>{`value ${1 + 1}`}</View>;',
    '}',
  ].join('\n');

  assert.strictEqual(
    findBalancedEnd(`${declaration}\nAFTER`, 0),
    declaration.length
  );
});

test('balanced scanner accepts a top-level function indented up to three spaces', () => {
  const declaration = [
    '  export function IndentedDemo() {',
    '    return <Text>缩进声明</Text>;',
    '  }',
  ].join('\n');

  assert.strictEqual(
    findBalancedEnd(`${declaration}\nAFTER`, 0),
    declaration.length
  );
});

test('balanced scanner rejects mismatched and unclosed declarations', () => {
  assert.throws(
    () => findBalancedEnd('export const BrokenDemo = ({ value: true ];', 0),
    /mismatched \] at \d+/u
  );
  assert.throws(
    () => findBalancedEnd('export const BrokenDemo = ({ value: true', 0),
    /unclosed export declaration at 0/u
  );
});

test('mismatched LiveDemo wrappers fail with source name', () => {
  assert.throws(
    () =>
      b.convertMdxBody(
        [
          'export const BrokenDemo = () => (',
          '  <LiveDemo><Text>未闭合</Text>',
          ');',
          '<BrokenDemo />',
        ].join('\n'),
        'broken-live.mdx'
      ),
    /broken-live\.mdx: unclosed LiveDemo/u
  );
});

test('nested and self-closing LiveDemo wrappers fail explicitly', () => {
  assert.throws(
    () =>
      b.convertMdxBody(
        '<LiveDemo><LiveDemo><Text>nested</Text></LiveDemo></LiveDemo>',
        'nested-live.mdx'
      ),
    /nested-live\.mdx: nested LiveDemo is not supported/u
  );
  assert.throws(
    () => b.convertMdxBody('<LiveDemo />', 'self-closing-live.mdx'),
    /self-closing-live\.mdx: self-closing LiveDemo is not supported/u
  );
});

test('Markdown assembly collapses blank lines only outside fenced code', () => {
  const parts = [
    'before',
    '',
    '',
    [
      '```tsx',
      'const first = true;',
      '',
      '',
      'const second = true;',
      '```',
    ].join('\n'),
    '',
    '',
    'after',
  ];

  assert.strictEqual(
    b.assembleMarkdown(parts),
    [
      'before',
      '',
      '```tsx',
      'const first = true;',
      '',
      '',
      'const second = true;',
      '```',
      '',
      'after',
    ].join('\n')
  );
});

test('index formatting helpers keep their existing behavior', () => {
  assert.strictEqual(
    b.formatIndexLine({
      title: 'Button 按钮',
      mdPath: '/md/components/button.md',
      description: '主/次',
    }),
    '- [Button 按钮](/md/components/button.md) — 主/次'
  );
  assert.strictEqual(
    b.formatIndexLine({
      title: 'X',
      mdPath: '/md/x.md',
      description: null,
    }),
    '- [X](/md/x.md)'
  );
  assert.deepStrictEqual(b.sortSections(['components', '概览', 'design']), [
    '概览',
    'components',
    'design',
  ]);
  assert(b.buildToc(['A', 'B']).startsWith('## 目录'));
  assert(b.buildToc(['A', 'B']).includes('- A'));
});

test('LLM index groups prototype-named sections as ordinary headings', () => {
  const output = b.buildLlmsIndex(
    'Fixture',
    [
      {
        title: 'Prototype Guide',
        mdPath: 'md/prototype.md',
        section: '__proto__',
        description: null,
      },
      {
        title: 'Constructor Guide',
        mdPath: 'md/constructor.md',
        section: 'constructor',
        description: null,
      },
    ],
    { name: '@unif/fixture', version: '1.0.0' }
  );

  assert(output.includes('## __proto__'));
  assert(output.includes('- [Prototype Guide](md/prototype.md)'));
  assert(output.includes('## constructor'));
  assert(output.includes('- [Constructor Guide](md/constructor.md)'));
});

test('a library renderer and public type sidecar share the same validated bundle', () => {
  withTempDirectory((directory) => {
    const site = createTempSite(directory);
    const api = { Composer: 'export interface ComposerProps {}' };
    const built = b.buildBundle({
      ...site,
      publicApi: api,
      renderDocument: (document) =>
        `# ${document.title}\n\n[入口](/docs/getting-started)`,
    });
    assert.deepStrictEqual(
      JSON.parse(built['md/api.json'].toString('utf8')),
      api
    );
    assert(
      built['md/components/button.md']
        .toString('utf8')
        .includes('](../getting-started.md)')
    );
    assert.throws(
      () => b.buildBundle({ ...site, publicApi: { Composer: null } }),
      /public API/
    );
    const previous = snapshotTree(site.staticDir);
    assert.throws(
      () =>
        b.buildBundle({
          ...site,
          renderDocument: () => {
            throw new Error('renderer failed');
          },
        }),
      /renderer failed/
    );
    assert.deepStrictEqual(snapshotTree(site.staticDir), previous);
  });
});

test('missing package metadata fails before replacing generated files', () => {
  withTempDirectory((directory) => {
    const site = createTempSite(directory);
    const before = snapshotTree(site.staticDir);
    fs.rmSync(path.join(directory, 'package.json'));
    assert.throws(() => b.buildBundle(site), /package.*json|ENOENT/);
    assert.deepStrictEqual(snapshotTree(site.staticDir), before);
  });
});

test('null and primitive package declarations preserve previous outputs', () => {
  for (const invalid of [
    null,
    false,
    0,
    '',
    [],
    { name: '@unif/fixture' },
    { name: '@unif/fixture', version: '1.0.0', description: 5 },
  ]) {
    withTempDirectory((directory) => {
      const site = createTempSite(directory);
      const before = snapshotTree(site.staticDir);
      writeFixture(
        path.join(directory, 'package.json'),
        JSON.stringify(invalid)
      );
      assert.throws(() => b.buildBundle(site), /package/);
      assert.deepStrictEqual(snapshotTree(site.staticDir), before);
    });
  }
});

test('invalid package identity cannot be rendered as an apparent version', () => {
  assert.throws(
    () => b.buildLlmsIndex('Fixture', [], { name: {}, version: 1 }),
    /package/
  );
});

test('index selects task pages before optional full, migration and maintenance material', () => {
  const entries = [
    {
      title: '安装',
      mdPath: 'md/getting-started/installation.md',
      section: 'getting-started',
    },
    {
      title: 'Button',
      mdPath: 'md/components/button.md',
      section: 'components',
    },
    { title: 'FAQ', mdPath: 'md/troubleshooting.md', section: '概览' },
    { title: '迁移', mdPath: 'md/migration.md', section: '概览' },
    { title: '技能', mdPath: 'md/skills.md', section: '概览' },
  ];
  const output = b.buildLlmsIndex('Fixture', entries, {
    name: '@unif/fixture',
    version: '2.3.4',
    description: '公共 UI 能力',
  });
  assert(output.includes('@unif/fixture@2.3.4'));
  assert(output.includes('公共 UI 能力'));
  assert(output.includes('## 开始使用'));
  assert(output.includes('## 场景问题'));
  const optional = output.indexOf('## Optional');
  assert(optional > output.indexOf('[Button]'));
  assert(output.indexOf('[FAQ]') < optional);
  assert(output.indexOf('[迁移]') > optional);
  assert(output.indexOf('[技能]') > optional);
  assert(output.indexOf('(llms-full.txt)') > optional);
  assert(!output.includes('适合一次性加载'));
  for (const entry of entries)
    assert.strictEqual(count(output, `](${entry.mdPath})`), 1);
});

process.stdout.write('ALL PASS\n');
