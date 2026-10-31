'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const BEGIN = '<!-- BEGIN GITHUB DELIVERY STANDARD -->';
const END = '<!-- END GITHUB DELIVERY STANDARD -->';
const REQUIRED = ['.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/pr-title.yml',
  '.github/scripts/check-library.cjs', '.github/scripts/check-delivery.cjs', '.github/scripts/organization.cjs',
  '.github/actions/setup/action.yml', '.github/actions/changes/action.yml', '.github/actions/changes/classify-package.cjs',
  'lefthook.yml', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml'];
const digest = value => createHash('sha256').update(value).digest('hex');

function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\\x00-\x1f]/.test(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative))
    throw new Error(`unsafe managed path: ${relative}`);
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`managed symlink: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return cursor;
}
function managedBlock(text) {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, i) => line === BEGIN ? [i] : []);
  const ends = lines.flatMap((line, i) => line === END ? [i] : []);
  if (begins.length !== 1 || ends.length !== 1 || begins[0] >= ends[0]) throw new Error('Invalid AGENTS.md managed block');
  return lines.slice(begins[0], ends[0] + 1).join('\n');
}
function dependencies(pkg) {
  if (!pkg.devDependencies?.turbo) throw new Error('Missing workflow dependency: turbo');
  if (pkg['release-it']?.npm?.skipChecks !== true) throw new Error('Missing release-it.npm.skipChecks');
  if (!pkg.devDependencies?.['@release-it/conventional-changelog']) throw new Error('Missing @release-it/conventional-changelog');
}
function projectFiles(value = []) {
  const allowed = new Set(['ci', 'release', 'deploy-docs', 'native-lint', 'nightly-build-check'].map(name => `.github/workflows/${name}.yml`));
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(file => !allowed.has(file)))
    throw new Error('projectFiles may preserve only declared project workflows, not validators');
  return value;
}
function customBuilder(text) {
  const imports = [...text.matchAll(/(?:require\s*\(\s*|from\s+|import\s*[(']?\s*)['"](\.[^'"]+)['"]/g)];
  return imports.some(([, target]) => !target.startsWith('./llms/'));
}
function requiredFiles(root, adopted) {
  const result = [...REQUIRED];
  if (adopted.organization) result.push('.github/organization.json');
  const state = features(root);
  if (adopted.requiredChecks?.some(name => ['lint-cpp', 'lint-kotlin'].includes(name))) result.push('.github/workflows/native-lint.yml', '.github/workflows/nightly-build-check.yml', '.clang-format');
  if (state.website) {
    result.push('.github/workflows/deploy-docs.yml', 'website/scripts/build-llms-core.test.js',
      'website/scripts/llms/.prettierrc.json',
      ...['bundle', 'markdown', 'routes', 'index'].map(name => `website/scripts/llms/${name}.js`));
    const entry = fs.readFileSync(inside(root, 'website/scripts/build-llms.js'), 'utf8');
    if (!customBuilder(entry)) result.push('website/scripts/build-llms.js', 'website/scripts/build-llms-site.test.js');
  }
  if (adopted.prAgent) result.push('.github/workflows/pr-agent.yml', '.github/workflows/pr-agent-reusable.yml');
  const ci = fs.readFileSync(inside(root, '.github/workflows/ci.yml'), 'utf8');
  if (!/^\s+run: node \.github\/scripts\/check-delivery\.cjs\s*$/m.test(ci))
    throw new Error('CI must run the repository delivery check');
  if (/actions\/verification\//.test(ci)) result.push('.github/actions/verification/verification.cjs', '.github/actions/verification/verification.test.cjs');
  return result;
}
function features(root) {
  const native = ['ios', 'android/src'].some(relative => {
    const base = path.join(root, relative);
    return fs.existsSync(base) && fs.readdirSync(base, { recursive: true, withFileTypes: true })
      .some(entry => entry.isFile() && /\.(?:kt|kts|mm|m|cpp|h)$/.test(entry.name));
  });
  return { website: fs.existsSync(path.join(root, 'website')), native,
    podspec: fs.readdirSync(root).some(file => file.endsWith('.podspec')) };
}
function checkDelivery(directory = '.') {
  const root = fs.realpathSync(directory);
  const receipt = JSON.parse(fs.readFileSync(inside(root, '.github/delivery.json'), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.standard !== 'github-delivery/react-native'
      || !receipt.files || Array.isArray(receipt.files) || !receipt.blocks) throw new Error('Invalid delivery receipt');
  projectFiles(receipt.projectFiles);
  if (typeof receipt.organization !== 'boolean' || typeof receipt.prAgent !== 'boolean'
      || !Array.isArray(receipt.requiredChecks) || !receipt.requiredChecks.length
      || receipt.requiredChecks.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Invalid adopted capabilities');
  for (const name of requiredFiles(root, receipt)) if (!Object.hasOwn(receipt.files, name)) throw new Error(`Missing managed check: ${name}`);
  for (const [relative, expected] of Object.entries(receipt.files)) {
    const file = inside(root, relative);
    if (!/^[a-f0-9]{64}$/.test(expected) || !fs.existsSync(file)
        || !fs.statSync(file).isFile() || digest(fs.readFileSync(file)) !== expected)
      throw new Error(`Managed file drift: ${relative}`);
  }
  if (!Object.hasOwn(receipt.blocks, 'AGENTS.md')) throw new Error('Missing AGENTS.md block receipt');
  const agents = fs.readFileSync(inside(root, 'AGENTS.md'), 'utf8');
  if (digest(managedBlock(agents)) !== receipt.blocks['AGENTS.md']) throw new Error('Managed block drift: AGENTS.md');
  const pkg = JSON.parse(fs.readFileSync(inside(root, 'package.json'), 'utf8'));
  if (pkg.name !== receipt.packageName) throw new Error('Package identity differs from adopted delivery standard');
  if (JSON.stringify(features(root)) !== JSON.stringify(receipt.features)) throw new Error('Project structure changed; synchronize applicable templates');
  dependencies(pkg);
  const { readOrganization, validateIdentity } = require('./organization.cjs');
  const organization = readOrganization(root, receipt.repository);
  if (!!organization !== receipt.organization) throw new Error('Organization adoption differs from receipt');
  validateIdentity(organization, pkg, receipt.repository);
  for (const relative of organization?.obsoleteFiles || []) if (fs.existsSync(inside(root, relative))) throw new Error(`Obsolete automation: ${relative}`);
  return { root, receipt };
}
module.exports = { inside, managedBlock, dependencies, features, digest, checkDelivery, projectFiles, customBuilder, requiredFiles };
if (require.main === module) {
  Promise.resolve().then(async () => {
    const [directory = '.', ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Usage: node check-delivery.cjs [target-path]');
    const { root, receipt } = checkDelivery(directory);
    const { checkLibrary } = require('./check-library.cjs');
    await checkLibrary('source', root);
    console.log(`PASS adopted delivery: ${receipt.repository} (${Object.keys(receipt.files).length} managed files)`);
  }).catch(error => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
}
