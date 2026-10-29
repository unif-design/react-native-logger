// 共用生成规则源：unif-design/.github/templates/llms。
'use strict';
const { Buffer } = require('node:buffer');

const fs = require('node:fs');
const path = require('node:path');
const { buildLlmsIndex, formatIndexLine, packageLabel } = require('./index');
const {
  assembleMarkdown,
  convertMdxBody,
  findUnprocessedDemo,
  parseFrontmatter,
  rewriteInternalLinks,
} = require('./markdown');
const { buildRouteMap, collisionKey } = require('./routes');

const FORMAL_TARGETS = Object.freeze(['llms.txt', 'llms-full.txt', 'md']);
const BUNDLE_META = Symbol('bundleMeta');
const REAL_FILE_OPS = Object.freeze({
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  mkdtempSync: fs.mkdtempSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
});

function readSiteTitle(root, fileOps = REAL_FILE_OPS) {
  for (const extension of ['ts', 'js', 'mjs']) {
    const config = path.join(root, `docusaurus.config.${extension}`);
    if (!fileOps.existsSync(config)) continue;
    const match = fileOps
      .readFileSync(config, 'utf8')
      .match(/title:\s*['"]([^'"]+)['"]/u);
    if (match !== null) return match[1];
  }
  return 'Documentation';
}

function walkMarkdown(directory, fileOps = REAL_FILE_OPS) {
  const files = [];
  for (const name of fileOps.readdirSync(directory)) {
    const absolutePath = path.join(directory, name);
    const stat = fileOps.statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...walkMarkdown(absolutePath, fileOps));
    } else if (/\.mdx?$/iu.test(name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function pageFrontmatter(raw) {
  if (!raw.startsWith('---')) return '';
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? '' : `${raw.slice(0, end + 4)}\n`;
}

function createIndexEntry(document) {
  const publicRoute = document.frontmatterRoute || document.sourceRoute;
  const publicSlug = publicRoute.slice('/docs'.length);
  const segments = document.relSlug.split('/');
  return {
    title: document.title || publicSlug.slice(1),
    mdPath: document.outputPath,
    slug: publicSlug,
    section: segments.length > 1 ? segments[0] : '概览',
    description: document.description || null,
  };
}

function formatFullMetadata(document) {
  return `*Source: \`docs/${document.sourcePath}\` · Mirror: \`${document.outputPath}\`*`;
}

function sortSections(keys) {
  return [...keys].sort((left, right) =>
    left === '概览' ? -1 : right === '概览' ? 1 : left.localeCompare(right)
  );
}

function buildToc(titles) {
  return ['## 目录', '', ...titles.map((title) => `- ${title}`), ''].join('\n');
}

function withSingleTrailingNewline(value) {
  return `${value.replace(/(?:\r?\n)(?:[ \t]*(?:\r?\n))*$/u, '')}\n`;
}

function attachBundleMeta(bundle, meta) {
  Object.defineProperty(bundle, BUNDLE_META, {
    configurable: false,
    enumerable: false,
    value: meta,
    writable: false,
  });
  return bundle;
}

function buildBundle(site) {
  if (site === null || typeof site !== 'object') {
    throw new TypeError('site must be an object');
  }
  const root = path.resolve(site.root || path.join(__dirname, '..', '..'));
  const docsDir = path.resolve(site.docsDir || path.join(root, 'docs'));
  if (!REAL_FILE_OPS.existsSync(docsDir)) {
    throw new Error(`[build-llms] docs/ directory not found at ${docsDir}`);
  }

  const files = walkMarkdown(docsDir).sort();
  if (files.length === 0) {
    throw new Error(
      `[build-llms] docs/ directory contains no Markdown documents at ${docsDir}`
    );
  }
  const siteName = site.siteName || site.name || readSiteTitle(root);
  const packageFile = path.join(root, '..', 'package.json');
  const packageInfo = JSON.parse(
    REAL_FILE_OPS.readFileSync(packageFile, 'utf8')
  );
  const versionNote = `<!-- Generated from ${packageLabel(packageInfo)}; edit source documentation. -->\n`;
  const sourceNote = `<!-- Generated from ${packageInfo.name}; edit source documentation. -->\n`;
  const sourceDocuments = files.map((file) => {
    const sourcePath = path.relative(docsDir, file).split(path.sep).join('/');
    const sourceName = `docs/${sourcePath}`;
    const raw = REAL_FILE_OPS.readFileSync(file, 'utf8');
    const frontmatter = parseFrontmatter(raw);
    return {
      id: sourcePath,
      file,
      sourceName,
      sourcePath,
      raw,
      slug: frontmatter.slug,
      title: frontmatter.title,
      description: frontmatter.description,
      body: frontmatter.body,
    };
  });
  const routeMap = buildRouteMap(sourceDocuments);
  const bodyBlocks = [];
  const tocTitles = [];
  const pages = {};

  for (const document of routeMap.documents) {
    const convertedBody = site.renderDocument
      ? site.renderDocument(document)
      : convertMdxBody(document.body, document.sourceName);
    const pageBody = rewriteInternalLinks(convertedBody, document, routeMap);
    const fullBody = rewriteInternalLinks(
      convertedBody,
      { ...document, outputPath: 'llms-full.txt' },
      routeMap
    );
    const title =
      document.title ||
      (document.frontmatterRoute || document.sourceRoute).slice(
        '/docs/'.length
      );

    pages[document.outputPath] = Buffer.from(
      assembleMarkdown([pageFrontmatter(document.raw), sourceNote, pageBody])
    );
    tocTitles.push(title);
    bodyBlocks.push(
      `## ${title}`,
      '',
      formatFullMetadata(document),
      '',
      fullBody,
      ''
    );
  }

  const llmsFull = withSingleTrailingNewline(
    assembleMarkdown([
      `# ${siteName} — 全文文档聚合`,
      '',
      '> 可选全文。普通查询优先通过 llms.txt 定位相关单页。',
      versionNote,
      '',
      buildToc(tocTitles),
      ...bodyBlocks,
    ])
  );
  const entries = routeMap.documents.map(createIndexEntry);
  const bundle = {
    'llms.txt': Buffer.from(buildLlmsIndex(siteName, entries, packageInfo)),
    'llms-full.txt': Buffer.from(llmsFull),
    'md/index.json': Buffer.from(`${JSON.stringify(entries, null, 2)}\n`),
    ...pages,
    ...(site.publicApi === undefined
      ? {}
      : {
          'md/api.json': Buffer.from(
            `${JSON.stringify(site.publicApi, null, 2)}\n`
          ),
        }),
  };
  attachBundleMeta(bundle, {
    expectedDocumentCount: routeMap.documents.length,
    routeMap,
  });
  validateBundle(bundle, routeMap);
  return bundle;
}

function validateTargetPathGraph(targets) {
  const root = { children: new Map() };
  for (const target of targets) {
    const segments = target.split('/');
    let parent = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const kind = index === segments.length - 1 ? 'file' : 'directory';
      const key = collisionKey(segment);
      const existing = parent.children.get(key);
      if (existing !== undefined) {
        if (existing.spelling !== segment) {
          throw new Error(
            `bundle path representation collision between ${existing.target} and ${target}: ${existing.spelling} vs ${segment}`
          );
        }
        if (existing.kind !== kind) {
          throw new Error(
            `bundle file/directory collision between ${existing.target} and ${target}`
          );
        }
        parent = existing;
        continue;
      }

      const node = {
        children: new Map(),
        kind,
        spelling: segment,
        target,
      };
      parent.children.set(key, node);
      parent = node;
    }
  }
}

function validateTargetNames(bundle) {
  const collisions = new Map();
  for (const [target, content] of Object.entries(bundle)) {
    const unsafe =
      target === '' ||
      target.startsWith('/') ||
      /^[A-Za-z]:/u.test(target) ||
      target.includes('\\') ||
      Array.from(target).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      ) ||
      target
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..'
        );
    if (unsafe) {
      throw new Error(`unsafe bundle target ${JSON.stringify(target)}`);
    }

    const key = collisionKey(target);
    const existing = collisions.get(key);
    if (existing !== undefined) {
      throw new Error(
        `bundle target collision between ${existing} and ${target}`
      );
    }
    collisions.set(key, target);

    if (!Buffer.isBuffer(content)) {
      throw new TypeError(`bundle target ${target} must contain a Buffer`);
    }
    if (
      target !== 'llms.txt' &&
      target !== 'llms-full.txt' &&
      target !== 'md/index.json' &&
      target !== 'md/api.json' &&
      !/^md\/.+\.md$/u.test(target)
    ) {
      throw new Error(`unsafe bundle target ${JSON.stringify(target)}`);
    }
  }

  const targets = Object.keys(bundle);
  validateTargetPathGraph(targets);
  for (const target of targets) {
    if (target !== target.normalize('NFC')) {
      throw new Error(`bundle target must use NFC: ${target}`);
    }
  }

  for (const required of ['llms.txt', 'llms-full.txt', 'md/index.json']) {
    if (!Object.hasOwn(bundle, required)) {
      throw new Error(`bundle is missing required target ${required}`);
    }
  }
}

function outputRouteMap(bundle) {
  const routes = new Map();
  for (const target of Object.keys(bundle)) {
    const extensionlessTarget = target.replace(/\.md$/iu, '');
    routes.set(collisionKey(`/bundle/${extensionlessTarget}`), {
      outputPath: target,
    });
  }
  return {
    resolve(route) {
      return routes.get(collisionKey(route)) || null;
    },
  };
}

function validateBundle(bundle, routeMap) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new TypeError('bundle must be an object');
  }
  validateTargetNames(bundle);

  if (Object.hasOwn(bundle, 'md/api.json')) {
    const api = JSON.parse(bundle['md/api.json'].toString('utf8'));
    if (
      !api ||
      Array.isArray(api) ||
      typeof api !== 'object' ||
      Object.values(api).some((value) => typeof value !== 'string')
    ) {
      throw new Error('Invalid public API text');
    }
  }
  const pageTargets = Object.keys(bundle).filter(
    (target) => target.startsWith('md/') && target.endsWith('.md')
  );
  if (pageTargets.length === 0) {
    throw new Error('bundle contains no Markdown documents');
  }

  let entries;
  try {
    entries = JSON.parse(bundle['md/index.json'].toString('utf8'));
  } catch (error) {
    throw new Error('md/index.json is not valid JSON', { cause: error });
  }
  if (!Array.isArray(entries)) {
    throw new Error('md/index.json must contain an array');
  }
  if (entries.length !== pageTargets.length) {
    throw new Error(
      `bundle document/output count mismatch: ${entries.length} index entries and ${pageTargets.length} pages`
    );
  }

  const entryTargets = new Set();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof entry.mdPath !== 'string'
    ) {
      throw new Error('md/index.json contains an invalid entry');
    }
    if (!Object.hasOwn(bundle, entry.mdPath)) {
      throw new Error(`index entry is missing canonical page ${entry.mdPath}`);
    }
    const key = collisionKey(entry.mdPath);
    if (entryTargets.has(key)) {
      throw new Error(`index entry collision for ${entry.mdPath}`);
    }
    entryTargets.add(key);
  }
  for (const target of pageTargets) {
    if (!entryTargets.has(collisionKey(target))) {
      throw new Error(`canonical page is missing from index ${target}`);
    }
  }

  const metadata = bundle[BUNDLE_META];
  const expectedRouteMap = routeMap || metadata?.routeMap;
  const expectedDocumentCount =
    expectedRouteMap?.documents?.length ?? metadata?.expectedDocumentCount;
  if (
    expectedDocumentCount !== undefined &&
    expectedDocumentCount !== pageTargets.length
  ) {
    throw new Error(
      `expected ${expectedDocumentCount} documents but bundle contains ${pageTargets.length}`
    );
  }
  if (expectedRouteMap?.documents !== undefined) {
    const expectedTargets = new Set(
      expectedRouteMap.documents.map((document) =>
        collisionKey(document.outputPath)
      )
    );
    if (
      expectedTargets.size !== pageTargets.length ||
      pageTargets.some((target) => !expectedTargets.has(collisionKey(target)))
    ) {
      throw new Error('route map and canonical bundle pages do not match');
    }
  }

  const routes = outputRouteMap(bundle);
  for (const [target, content] of Object.entries(bundle)) {
    if (target === 'md/index.json' || target === 'md/api.json') continue;
    const markdown = content.toString('utf8');
    if (findUnprocessedDemo(markdown) !== null) {
      throw new Error(`${target}: unprocessed Demo markup`);
    }
    const rewritten = rewriteInternalLinks(
      markdown,
      {
        outputPath: target,
        sourceName: target,
        sourceRoute: `/bundle/${target}`,
      },
      routes
    );
    if (rewritten !== markdown) {
      throw new Error(`${target}: bundle link is not canonical`);
    }
  }
}

function expectedStageDirectories(bundle) {
  const directories = new Set();
  for (const target of Object.keys(bundle)) {
    const segments = target.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return [...directories].sort();
}

function readStageTree(stage, fileOps) {
  const directories = [];
  const files = {};
  const visit = (directory, relativeDirectory) => {
    for (const name of fileOps.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const relativePath =
        relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const stat = fileOps.statSync(absolutePath);
      if (stat.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files[relativePath] = fileOps.readFileSync(absolutePath);
      } else {
        throw new Error(`staged bundle tree has unsupported ${relativePath}`);
      }
    }
  };
  visit(stage, '');
  return {
    directories: directories.sort(),
    files,
  };
}

function writeStagedBundle(stage, bundle, fileOps) {
  for (const [target, content] of Object.entries(bundle)) {
    const output = path.join(stage, ...target.split('/'));
    fileOps.mkdirSync(path.dirname(output), { recursive: true });
    fileOps.writeFileSync(output, content);
  }

  const tree = readStageTree(stage, fileOps);
  const expectedFiles = Object.keys(bundle).sort();
  const actualFiles = Object.keys(tree.files).sort();
  const expectedDirectories = expectedStageDirectories(bundle);
  if (
    JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles) ||
    JSON.stringify(tree.directories) !== JSON.stringify(expectedDirectories)
  ) {
    const unexpected = [
      ...actualFiles.filter((target) => !expectedFiles.includes(target)),
      ...tree.directories.filter(
        (target) => !expectedDirectories.includes(target)
      ),
    ];
    const missing = [
      ...expectedFiles.filter((target) => !actualFiles.includes(target)),
      ...expectedDirectories.filter(
        (target) => !tree.directories.includes(target)
      ),
    ];
    throw new Error(
      `staged bundle tree mismatch; unexpected: ${
        unexpected.join(', ') || '<none>'
      }; missing: ${missing.join(', ') || '<none>'}`
    );
  }

  for (const target of expectedFiles) {
    const content = tree.files[target];
    if (!Buffer.isBuffer(content) || !content.equals(bundle[target])) {
      throw new Error(`staged bundle byte mismatch for ${target}`);
    }
  }
  const staged = tree.files;
  attachBundleMeta(staged, bundle[BUNDLE_META] || {});
  validateBundle(staged, staged[BUNDLE_META].routeMap);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildPreCommitError(originalError, cleanupErrors, recoveryPaths) {
  const details =
    cleanupErrors.length === 0
      ? ''
      : `; cleanup errors: ${cleanupErrors
          .map((error) => errorMessage(error))
          .join('; ')}`;
  const recovery =
    recoveryPaths.length === 0
      ? ''
      : `; recovery paths: ${recoveryPaths.join(', ')}`;
  const error = new Error(
    `LLM bundle preparation failed: ${errorMessage(originalError)}${details}${recovery}`,
    { cause: originalError }
  );
  error.cleanupErrors = [...cleanupErrors];
  error.recoveryPaths = [...recoveryPaths];
  return error;
}

function buildCommitError(commitError, rollbackErrors, recoveryPaths) {
  const details =
    rollbackErrors.length === 0
      ? ''
      : `; rollback errors: ${rollbackErrors
          .map((error) => errorMessage(error))
          .join('; ')}`;
  const recovery =
    recoveryPaths.length === 0
      ? ''
      : `; recovery paths: ${recoveryPaths.join(', ')}`;
  const error = new Error(
    `LLM bundle commit failed: ${errorMessage(
      commitError
    )}${details}${recovery}`,
    { cause: commitError }
  );
  error.rollbackErrors = [...rollbackErrors];
  error.recoveryPaths = [...recoveryPaths];
  return error;
}

function buildCleanupError(cleanupError, context) {
  const recovery =
    context.recoveryPaths.length === 0
      ? '; no recovery path remains'
      : `; recovery paths: ${context.recoveryPaths.join(', ')}`;
  const error = new Error(
    `LLM bundle formal targets are complete, but cleanup failed: ${errorMessage(
      cleanupError
    )}${recovery}`,
    { cause: cleanupError }
  );
  error.formalTargetsComplete = true;
  error.recoveryPaths = [...context.recoveryPaths];
  return error;
}

function existingRecoveryPaths(recoveryPaths, fileOps) {
  return recoveryPaths.filter((target) => {
    try {
      return fileOps.existsSync(target);
    } catch {
      // 无法确认时保留路径，避免把仍存在的人工恢复入口从错误中抹掉。
      return true;
    }
  });
}

function removeStageAfterFailure(stage, originalError, fileOps) {
  try {
    fileOps.rmSync(stage, { recursive: true, force: true });
  } catch (cleanupError) {
    throw buildPreCommitError(
      originalError,
      [cleanupError],
      existingRecoveryPaths([stage], fileOps)
    );
  }
  throw originalError;
}

function commitBundle(staticDir, bundle, fileOps = REAL_FILE_OPS) {
  validateBundle(bundle, bundle[BUNDLE_META]?.routeMap);
  fileOps.mkdirSync(staticDir, { recursive: true });
  const stage = fileOps.mkdtempSync(path.join(staticDir, '.llms-stage-'));
  try {
    writeStagedBundle(stage, bundle, fileOps);
  } catch (error) {
    removeStageAfterFailure(stage, error, fileOps);
  }

  let presence;
  let backup;
  try {
    presence = new Map(
      FORMAL_TARGETS.map((name) => [
        name,
        fileOps.existsSync(path.join(staticDir, name)),
      ])
    );
    backup = fileOps.mkdtempSync(path.join(staticDir, '.llms-backup-'));
  } catch (preCommitError) {
    removeStageAfterFailure(stage, preCommitError, fileOps);
  }

  const backedUp = new Set();
  const installed = new Set();
  try {
    for (const name of FORMAL_TARGETS) {
      if (!presence.get(name)) continue;
      fileOps.renameSync(path.join(staticDir, name), path.join(backup, name));
      backedUp.add(name);
    }
    for (const name of FORMAL_TARGETS) {
      fileOps.renameSync(path.join(stage, name), path.join(staticDir, name));
      installed.add(name);
    }
  } catch (commitError) {
    const rollbackErrors = [];
    for (const name of [...installed].reverse()) {
      try {
        fileOps.rmSync(path.join(staticDir, name), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const name of [...backedUp].reverse()) {
      try {
        fileOps.renameSync(path.join(backup, name), path.join(staticDir, name));
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const name of FORMAL_TARGETS.filter((item) => !presence.get(item))) {
      try {
        fileOps.rmSync(path.join(staticDir, name), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    try {
      fileOps.rmSync(stage, { recursive: true, force: true });
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length === 0) {
      try {
        fileOps.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    throw buildCommitError(
      commitError,
      rollbackErrors,
      existingRecoveryPaths([stage, backup], fileOps)
    );
  }

  const recoveryPaths = [stage, backup];
  try {
    fileOps.rmSync(stage, { recursive: true, force: true });
    recoveryPaths.shift();
    fileOps.rmSync(backup, { recursive: true, force: true });
    recoveryPaths.shift();
  } catch (cleanupError) {
    throw buildCleanupError(cleanupError, {
      recoveryPaths: existingRecoveryPaths(recoveryPaths, fileOps),
    });
  }
}

module.exports = {
  FORMAL_TARGETS,
  REAL_FILE_OPS,
  buildBundle,
  buildLlmsIndex,
  buildToc,
  commitBundle,
  createIndexEntry,
  formatFullMetadata,
  formatIndexLine,
  sortSections,
  validateBundle,
};
