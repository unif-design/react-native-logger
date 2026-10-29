// 共用生成规则源：unif-design/.github/templates/llms。
'use strict';

const RESERVED_TARGETS = ['llms.txt', 'llms-full.txt', 'md', 'md/index.json'];

function collisionKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function findExactReservedTarget(value) {
  const key = collisionKey(value);
  return (
    RESERVED_TARGETS.find((target) => collisionKey(target) === key) || null
  );
}

function findReservedRouteTarget(relSlug) {
  const exactTarget = findExactReservedTarget(relSlug);
  if (exactTarget !== null) return exactTarget;
  return collisionKey(relSlug).startsWith(`${collisionKey('md')}/`)
    ? 'md'
    : null;
}

function assertRouteIsNotReserved(relSlug, sourceName) {
  const reservedTarget = findReservedRouteTarget(relSlug);
  if (reservedTarget !== null) {
    throw new Error(
      `${sourceName}: route ${relSlug} conflicts with reserved target ${reservedTarget}`
    );
  }
}

function normalizeRelSlug(value, sourceName) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes('\\') ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new Error(
      `${sourceName}: unsafe relative slug ${JSON.stringify(value)}`
    );
  }

  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..'
    )
  ) {
    throw new Error(`${sourceName}: unsafe path segment in ${value}`);
  }
  return segments.map((segment) => segment.normalize('NFC')).join('/');
}

function sourceParts(document) {
  const sourceName = document.sourceName || document.sourcePath || '<source>';
  const sourcePath = document.sourcePath;
  if (typeof sourcePath !== 'string') {
    throw new Error(
      `${sourceName}: unsafe relative slug ${JSON.stringify(sourcePath)}`
    );
  }

  const extensionMatch = sourcePath.match(/\.mdx?$/iu);
  const extension = extensionMatch ? extensionMatch[0] : '';
  const withoutExtension = extension
    ? sourcePath.slice(0, -extension.length)
    : sourcePath;
  const relSlug = normalizeRelSlug(withoutExtension, sourceName);
  return {
    extension,
    relSlug,
    sourceName,
    sourcePath: `${relSlug}${extension}`,
  };
}

function frontmatterRouteSlug(value, sourceName) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    throw new Error(
      `${sourceName}: unsafe frontmatter slug ${JSON.stringify(value)}`
    );
  }
  return normalizeRelSlug(value.slice(1), sourceName);
}

function buildRouteMap(inputDocuments) {
  const documents = [];
  const outputs = new Map();
  const routes = new Map();
  const sourceIds = new Set();

  for (const input of inputDocuments) {
    const parts = sourceParts(input);
    const id = input.id || parts.sourcePath;
    if (sourceIds.has(id)) {
      throw new Error(`${parts.sourceName}: duplicate source id ${id}`);
    }
    sourceIds.add(id);

    assertRouteIsNotReserved(parts.relSlug, parts.sourceName);

    const outputPath = `md/${parts.relSlug}.md`;
    // canonical 形态正常只会落在 md/*.md；精确 guard 防止未来构造规则变化时覆盖正式目标。
    const reservedOutput = findExactReservedTarget(outputPath);
    if (reservedOutput !== null) {
      throw new Error(
        `${parts.sourceName}: canonical output uses reserved target ${reservedOutput}`
      );
    }

    const outputKey = collisionKey(outputPath);
    const existingOutput = outputs.get(outputKey);
    if (existingOutput !== undefined) {
      throw new Error(
        `canonical output collision between ${existingOutput.sourceName} and ${parts.sourceName}: ${outputPath}`
      );
    }

    const frontmatterSlug =
      input.frontmatterSlug === undefined ? input.slug : input.frontmatterSlug;
    const sourceRoute = `/docs/${parts.relSlug}`;
    let frontmatterRoute = null;
    if (frontmatterSlug !== null && frontmatterSlug !== undefined) {
      const routeSlug = frontmatterRouteSlug(frontmatterSlug, parts.sourceName);
      assertRouteIsNotReserved(routeSlug, parts.sourceName);
      frontmatterRoute = `/docs/${routeSlug}`;
    }
    const document = {
      ...input,
      id,
      sourceName: parts.sourceName,
      sourcePath: parts.sourcePath,
      relSlug: parts.relSlug,
      outputPath,
      sourceRoute,
      frontmatterRoute,
    };

    outputs.set(outputKey, document);
    documents.push(document);

    for (const route of [sourceRoute, frontmatterRoute]) {
      if (route === null) continue;
      const routeKey = collisionKey(route);
      const existingRoute = routes.get(routeKey);
      if (existingRoute !== undefined && existingRoute.id !== id) {
        throw new Error(
          `route alias collision between ${existingRoute.sourceName} and ${parts.sourceName}: ${route}`
        );
      }
      routes.set(routeKey, document);
    }
  }

  return {
    documents,
    resolve(route) {
      if (typeof route !== 'string') return null;
      return routes.get(collisionKey(route)) || null;
    },
  };
}

module.exports = {
  buildRouteMap,
  collisionKey,
  normalizeRelSlug,
};
