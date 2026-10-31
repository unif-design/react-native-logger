'use strict';

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { readOrganization, validateIdentity } = require('./organization.cjs');

const REGISTRY = 'https://registry.npmjs.org/';
const MODES = ['source', 'pack', 'release', 'published'];
const README = /^readme(?:\.(?:md|markdown|txt))?$/i;
const LICENSE = /^licen[cs]e(?:\.(?:md|markdown|txt))?$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function targetPath(value, label, wildcard = false, exported = false) {
  requireValue(nonempty(value), `${label} must be a nonempty target path`);
  requireValue(!exported || value.startsWith('./'), `${label}: export target must start with ./`);
  const relative = value.replace(/^\.\//, '');
  requireValue(!path.posix.isAbsolute(relative) && !/[\\\x00-\x1f?#]/.test(relative)
    && !/%(?:2e|2f|5c)/i.test(relative)
    && relative.split('/').every(part => part && !['.', '..', 'node_modules'].includes(part))
    && (wildcard || !relative.includes('*')), `${label}: unsafe target path ${value}`);
  return relative;
}

function readInside(root, relative) {
  const file = path.join(root, relative);
  requireValue(fs.existsSync(file), `Missing ${relative}`);
  const resolved = fs.realpathSync(file);
  const fromRoot = path.relative(root, resolved);
  requireValue(fromRoot !== '..' && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot), `${relative}: symlink escapes package root`);
  requireValue(fs.statSync(resolved).isFile(), `${relative} must be a file`);
  return fs.readFileSync(resolved, 'utf8');
}

function readJson(root, file) {
  const text = readInside(root, file);
  try {
    const value = JSON.parse(text);
    requireValue(record(value), `${file} must contain an object`);
    return value;
  } catch (error) {
    throw new Error(`${file}: invalid JSON object`, { cause: error });
  }
}

function documentName(files, pattern, label) {
  const name = files.find(file => pattern.test(file));
  requireValue(name, `Missing ${label}`);
  return name;
}

function readDocument(root, pattern, label) {
  const name = documentName(fs.readdirSync(root), pattern, label);
  const text = readInside(root, name);
  requireValue(text.trim(), `${label} must not be empty`);
  return { name, text };
}

function httpUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an HTTP(S) URL`); }
  requireValue(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, `${label} must be an HTTP(S) URL without credentials`);
  return url;
}

function exportGroups(pkg) {
  const value = pkg.exports;
  requireValue(value !== undefined && value !== null, 'exports must declare the public entry points');
  let entries = [['.', value]];
  if (record(value) && Object.keys(value).some(key => key.startsWith('.'))) {
    requireValue(Object.keys(value).every(key => key === '.' || key.startsWith('./')), 'exports cannot mix subpaths and conditions');
    entries = Object.entries(value);
  }
  requireValue(entries.some(([key, target]) => key === '.' && target !== null), 'exports must expose the root entry');
  return entries.map(([key, tree]) => {
    if (key !== '.') targetPath(key, `exports ${key}`, true, true);
    requireValue((key.match(/\*/g) || []).length <= 1, `exports ${key}: only one subpath wildcard is supported`);
    const targets = [];
    const visit = node => {
      if (node === null) return;
      if (typeof node === 'string') {
        targets.push(targetPath(node, `exports ${key}`, key.includes('*'), true));
      } else if (Array.isArray(node)) {
        node.forEach(visit);
      } else {
        requireValue(record(node) && Object.keys(node).length > 0, `exports ${key}: invalid conditional target`);
        for (const [condition, child] of Object.entries(node)) {
          requireValue(condition && !condition.startsWith('.') && !/^\d+$/.test(condition), `exports ${key}: invalid condition`);
          visit(child);
        }
      }
    };
    visit(tree);
    requireValue(key !== '.' || targets.length > 0, 'exports root must contain a target');
    return { key, targets: [...new Set(targets)] };
  });
}

function validateManifest(pkg) {
  requireValue(record(pkg), 'package.json must contain an object');
  const name = pkg.name;
  const parts = typeof name === 'string' ? /^(?:@([^/]+)\/)?([^/]+)$/.exec(name) : null;
  requireValue(parts && name.length <= 214 && name === name.toLowerCase()
    && !/^[._-]/.test(name) && !parts[2].startsWith('.') && !/[~'!()*]/.test(parts[2])
    && parts.slice(1).filter(Boolean).every(part => encodeURIComponent(part) === part)
    && !['node_modules', 'favicon.ico'].includes(name), 'package name must be a valid npm package name');
  requireValue(typeof pkg.version === 'string' && VERSION.test(pkg.version), 'package version must be an exact semantic version');
  const prerelease = pkg.version.split('+')[0].split('-').slice(1).join('-');
  requireValue(prerelease.split('.').every(part => !/^0\d+$/.test(part)), 'package version has a leading-zero prerelease identifier');
  requireValue(nonempty(pkg.description), 'package description is required');
  httpUrl(pkg.homepage, 'homepage');
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  requireValue(nonempty(repository), 'repository URL is required');
  httpUrl(repository.replace(/^git\+/, ''), 'repository');
  requireValue(nonempty(pkg.license), 'license metadata is required');
  requireValue(pkg.private === undefined || typeof pkg.private === 'boolean', 'private must be a boolean');
  requireValue(pkg.publishConfig === undefined || record(pkg.publishConfig), 'publishConfig must be an object');
  requireValue(Array.isArray(pkg.files) && pkg.files.length > 0 && pkg.files.every(nonempty), 'files must declare the distributed files');
  targetPath(pkg.main, 'main');
  targetPath(pkg.types, 'types');
  return exportGroups(pkg);
}

function buildsLlms(scripts, name, seen = new Set()) {
  if (seen.has(name) || !nonempty(scripts[name])) return false;
  seen.add(name);
  const command = scripts[name];
  if (/(?:^|[\s/])scripts\/build-llms\.js(?:\s|$)/.test(command)) return true;
  const calls = [...command.matchAll(/\b(?:npm\s+run|(?:yarn|pnpm)(?:\s+run)?)\s+([\w:-]+)/g)];
  return calls.some(([, called]) => buildsLlms(scripts, called, seen));
}

function validateWebsite(root, pkg, required) {
  const present = fs.readdirSync(root).includes('website');
  requireValue(present || !required, 'Public release requires a website workspace');
  if (!present) return;
  const site = readJson(root, 'website/package.json');
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  requireValue(Array.isArray(workspaces) && workspaces.some(item => typeof item === 'string' && path.matchesGlob('website', item.replace(/^\.\//, '').replace(/\/$/, ''))), 'website must be registered in workspaces');
  requireValue(site.name === `${pkg.name}-website`, 'website package name must match the shared deployment workspace');
  for (const script of ['build', 'typecheck']) {
    requireValue(nonempty(site.scripts?.[script]), `website requires a ${script} script`);
  }
  readInside(root, 'website/scripts/build-llms.js');
  readInside(root, 'website/scripts/build-llms.test.js');
  requireValue(buildsLlms(site.scripts, 'build'), 'website build must invoke the shared LLM builder scripts/build-llms.js');
}

function validateRelease(root, pkg, readme) {
  requireValue(pkg.private !== true, 'private:true prevents public npm publishing');
  requireValue(pkg.license.trim().toUpperCase() !== 'UNLICENSED', 'Public release requires a license other than UNLICENSED');
  const license = readDocument(root, LICENSE, 'LICENSE');
  requireValue(pkg['release-it']?.npm?.publish === true, 'release-it.npm.publish must be true');
  requireValue(pkg['release-it']?.npm?.skipChecks === true, 'release-it.npm.skipChecks must be true for OIDC');
  if (pkg.publishConfig?.registry !== undefined) {
    requireValue(httpUrl(pkg.publishConfig.registry, 'registry').href === REGISTRY, 'publishConfig.registry must be the official npm registry');
  }
  requireValue(pkg.publishConfig?.access === undefined || pkg.publishConfig.access === 'public', 'publishConfig.access must be public when specified');
  const homepage = httpUrl(pkg.homepage, 'homepage');
  requireValue(homepage.protocol === 'https:' && !['github.com', 'www.github.com', 'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org', 'localhost'].includes(homepage.hostname), 'homepage must point to the documentation website');
  const installation = new RegExp(`\\b(?:npm\\s+(?:install|i)|yarn\\s+add|pnpm\\s+(?:add|install|i)|bun\\s+add)\\s+[^\\r\\n]*${escapeRegex(pkg.name)}(?=[\\s\\x60]|$)`);
  requireValue(installation.test(readme), 'README must include an installation command with the package name');
  const links = [...readme.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^)]*)?\s*\)/g), ...readme.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1]);
  const siteUrl = homepage.href.replace(/\/$/, '');
  requireValue(links.some(link => link === siteUrl || link.startsWith(`${siteUrl}/`)), 'README must link to the documentation homepage');
  requireValue(links.some(link => /^https:\/\/(?:www\.)?npmjs\.com\/package\//.test(link) && decodeURIComponent(link.replace(/\/$/, '').split('/package/')[1]) === pkg.name), 'README must link to its npm package');
  requireValue(links.some(link => link.split(/[?#]/)[0].split('/').at(-1)?.toLowerCase() === license.name.toLowerCase()), 'README must link to LICENSE');
  validateWebsite(root, pkg, true);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardRegex(target) {
  const parts = target.split('*').map(escapeRegex);
  return new RegExp(`^${parts[0]}(.+)${parts.slice(1).join('\\1')}$`);
}

function validatePackedTargets(pkg, files) {
  const available = new Set(files);
  const requireFile = (file, label) => requireValue(available.has(file), `${label}: missing packed file ${file}`);
  requireFile(targetPath(pkg.main, 'main'), 'main');
  requireFile(targetPath(pkg.types, 'types'), 'types');
  for (const { key, targets } of exportGroups(pkg)) {
    const instances = new Set();
    for (const target of targets) {
      if (!target.includes('*')) {
        requireFile(target, `exports ${key}`);
        continue;
      }
      const pattern = wildcardRegex(target);
      const matches = files.map(file => pattern.exec(file)).filter(Boolean);
      requireValue(matches.length > 0, `exports ${key}: no packed files match ${target}`);
      for (const match of matches) instances.add(match[1]);
    }
    for (const instance of instances) {
      const subpath = key.replace('*', instance);
      if (record(pkg.exports) && Object.hasOwn(pkg.exports, subpath)) continue;
      for (const target of targets) requireFile(target.replaceAll('*', instance), `exports ${subpath}`);
    }
  }
}

function tar(archive, args) {
  try {
    return execFileSync('tar', [...args, archive], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new Error('Cannot read npm tarball with tar', { cause: error });
  }
}

function inspectArchive(archive, expected) {
  const entries = tar(archive, ['-tzf']).trim().split('\n');
  requireValue(entries.length > 0 && new Set(entries).size === entries.length, 'Invalid or duplicate tarball entries');
  for (const entry of entries) {
    requireValue(entry.startsWith('package/'), 'Tarball entry is outside package/');
    if (entry !== 'package/') targetPath(entry.replace(/\/$/, ''), 'tarball entry');
  }
  const verbose = tar(archive, ['-tvzf']).trim().split('\n');
  requireValue(verbose.every(line => /^[-d]/.test(line)), 'Tarball must not contain symlinks or special files');
  const files = entries.filter(entry => !entry.endsWith('/')).map(entry => entry.slice('package/'.length));
  const read = file => {
    requireValue(files.includes(file), `Missing packed ${file}`);
    return execFileSync('tar', ['-xOzf', archive, `package/${file}`], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  };
  const packed = JSON.parse(read('package.json'));
  validateManifest(packed);
  requireValue(packed.name === expected.name, 'Tarball package name does not match');
  requireValue(packed.version === expected.version, 'Tarball package version does not match');
  // Conditional exports select matching targets in insertion order.
  for (const field of ['main', 'types', 'exports']) requireValue(JSON.stringify(packed[field]) === JSON.stringify(expected[field]), `Tarball ${field} does not match the current package contract`);
  for (const [pattern, label] of [[README, 'README'], [LICENSE, 'LICENSE']]) {
    requireValue(read(documentName(files, pattern, label)).trim(), `Packed ${label} must not be empty`);
  }
  validatePackedTargets(packed, files);
  return files.length;
}

async function registryMetadata(pkg, request, wait) {
  let value;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    let response;
    try {
      response = await request(`${REGISTRY}${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000), redirect: 'error',
      });
      if (response.ok) value = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('npm registry returned invalid JSON', { cause: error });
      if (attempt === 6) throw new Error('npm registry request failed after 6 attempts', { cause: error });
      await wait(5000);
      continue;
    }
    if (response.ok) break;
    const retryable = [404, 408, 429].includes(response.status) || (response.status >= 500 && response.status <= 599);
    requireValue(retryable && attempt < 6, `npm registry returned HTTP ${response.status} after ${attempt} attempt(s)`);
    // Discard error response bodies before retrying the registry connection.
    await response.body?.cancel().catch(() => {});
    await wait(5000);
  }
  requireValue(record(value) && value.name === pkg.name, 'npm registry package name does not match');
  requireValue(value.version === pkg.version, 'npm registry version does not match the current version');
  const download = httpUrl(value.dist?.tarball, 'registry tarball');
  requireValue(download.origin === new URL(REGISTRY).origin, 'Registry tarball must use the official npm registry');
  requireValue(nonempty(value.dist?.integrity) || /^[a-f0-9]{40}$/i.test(value.dist?.shasum || ''), 'npm registry metadata has no integrity digest');
  return value;
}

function verifyIntegrity(archive, dist) {
  const bytes = fs.readFileSync(archive);
  const digests = typeof dist.integrity === 'string' ? [...dist.integrity.matchAll(/(?:^|\s)(sha(?:512|384|256|1))-([A-Za-z0-9+/=]+)(?=\s|$)/g)] : [];
  if (dist.integrity) {
    requireValue(digests.some(([, algorithm, digest]) => createHash(algorithm).update(bytes).digest('base64') === digest), 'Downloaded tarball integrity does not match the registry');
  } else {
    requireValue(createHash('sha1').update(bytes).digest('hex') === dist.shasum, 'Downloaded tarball integrity does not match the registry');
  }
}

async function checkLibrary(mode, directory = process.cwd(), options = {}) {
  requireValue(MODES.includes(mode), `Usage: node check-library.cjs ${MODES.join('|')} [repo-path]`);
  const root = fs.realpathSync(directory);
  const pkg = readJson(root, 'package.json');
  validateManifest(pkg);
  validateIdentity(readOrganization(root), pkg);
  const readme = readDocument(root, README, 'README').text;
  validateWebsite(root, pkg, false);
  const result = { mode, name: pkg.name, version: pkg.version };
  if (mode === 'source') return result;
  if (mode === 'release') {
    validateRelease(root, pkg, readme);
    return result;
  }
  const metadata = mode === 'published' ? await registryMetadata(pkg, options.fetch || globalThis.fetch, options.wait || sleep) : null;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'github-delivery-pack-'));
  try {
    const userconfig = path.join(temporary, 'user.npmrc');
    const globalconfig = path.join(temporary, 'global.npmrc');
    fs.writeFileSync(userconfig, '');
    fs.writeFileSync(globalconfig, '');
    const args = ['pack', metadata ? `${pkg.name}@${pkg.version}` : root, '--ignore-scripts', '--json',
      '--pack-destination', temporary, '--cache', path.join(temporary, 'cache'), '--registry', REGISTRY,
      ...(pkg.name.startsWith('@') ? [`--${pkg.name.split('/')[0]}:registry=${REGISTRY}`] : []),
      '--userconfig', userconfig, '--globalconfig', globalconfig,
      '--workspaces=false', '--fetch-retries=1', '--fetch-timeout=15000'];
    const npm = options.npm || ((argv, execution) => execFileSync('npm', argv, {
      ...execution, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024,
    }));
    let output;
    try { output = JSON.parse(npm(args, { cwd: temporary })); }
    catch (error) { throw new Error('npm pack failed or returned invalid JSON', { cause: error }); }
    // npm 11 returns an array; npm 12 indexes the same records by package name.
    const packages = Array.isArray(output) ? output : record(output) ? Object.values(output) : [];
    requireValue(packages.length === 1 && record(packages[0]), 'npm pack must produce exactly one tarball');
    const filename = packages[0].filename;
    requireValue(nonempty(filename) && path.basename(filename) === filename && filename.endsWith('.tgz'), 'npm pack returned an unsafe tarball filename');
    const archive = path.join(temporary, filename);
    requireValue(fs.existsSync(archive) && fs.lstatSync(archive).isFile(), 'npm pack did not create a regular tarball file');
    if (metadata) verifyIntegrity(archive, metadata.dist);
    result.fileCount = inspectArchive(archive, pkg);
    return result;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { checkLibrary };

if (require.main === module) {
  const [mode, directory, ...extra] = process.argv.slice(2);
  Promise.resolve().then(() => {
    requireValue(extra.length === 0, 'Too many arguments');
    return checkLibrary(mode, directory);
  }).then(result => {
    const note = result.mode === 'source' ? ' (development metadata only; release and publication are separate checks)' : '';
    console.log(`PASS ${result.mode}: ${result.name}@${result.version}${note}`);
  }).catch(error => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
