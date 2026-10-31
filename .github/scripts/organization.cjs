'use strict';
const fs = require('node:fs');
const path = require('node:path');

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/;
const SETTINGS = ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge', 'allow_auto_merge', 'delete_branch_on_merge', 'has_issues'];
const WORKFLOWS = new Set(['ci', 'release', 'pr-title', 'pr-agent', 'pr-agent-reusable', 'deploy-docs', 'native-lint', 'nightly-build-check']);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value, allowed, label) {
  requireValue(object(value) && Object.keys(value).every(key => allowed.includes(key)), `Invalid ${label} fields`);
}
function repositoryParts(repository) {
  requireValue(typeof repository === 'string' && REPOSITORY.test(repository)
    && !['.', '..'].includes(repository.split('/')[1]), 'Expected an explicit owner/repo');
  return repository.split('/');
}
function checkOwner(config, repository) {
  const [owner] = repositoryParts(repository);
  if (config?.owner) requireValue(config.owner.toLowerCase() === owner.toLowerCase(), 'Repository owner conflicts with organization owner');
}
function pagesAddress(value) {
  requireValue(typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f]/.test(value), 'Invalid pagesURL');
  requireValue(!/[{}]/.test(value.replaceAll('{repo}', 'fixture')), 'Unsupported pagesURL placeholder');
  let url;
  try { url = new URL(value.replaceAll('{repo}', 'fixture')); } catch { throw new Error('Invalid pagesURL'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'pagesURL requires credential-free HTTPS without query or fragment');
}
function validateOrganization(config) {
  keys(config, ['schemaVersion', 'owner', 'namePattern', 'pagesURL', 'releaseAppId', 'repositorySettings', 'security', 'obsoleteFiles'], 'organization');
  requireValue(config.schemaVersion === 1, 'Unsupported organization schemaVersion');
  if ('owner' in config) requireValue(typeof config.owner === 'string' && OWNER.test(config.owner), 'Invalid organization owner');
  if ('namePattern' in config) {
    requireValue(typeof config.namePattern === 'string' && config.namePattern.length > 0, 'Invalid organization namePattern');
    try { new RegExp(`^(?:${config.namePattern})$`); } catch { throw new Error('Invalid organization namePattern'); }
  }
  if ('pagesURL' in config) pagesAddress(config.pagesURL);
  if ('releaseAppId' in config) requireValue(Number.isSafeInteger(config.releaseAppId) && config.releaseAppId > 0, 'Invalid organization releaseAppId');
  if ('repositorySettings' in config) {
    const settings = config.repositorySettings;
    keys(settings, [...SETTINGS, 'security_and_analysis'], 'repositorySettings');
    for (const key of SETTINGS) if (key in settings) requireValue(typeof settings[key] === 'boolean', `Invalid repositorySettings.${key}`);
    if ('security_and_analysis' in settings) {
      keys(settings.security_and_analysis, ['secret_scanning', 'secret_scanning_push_protection'], 'repositorySettings.security_and_analysis');
      for (const value of Object.values(settings.security_and_analysis)) {
        keys(value, ['status'], 'repositorySettings security status');
        requireValue(['enabled', 'disabled'].includes(value.status), 'Invalid repositorySettings security status');
      }
    }
  }
  if ('security' in config) {
    keys(config.security, ['codeqlDefaultSetup', 'dependabotSecurityUpdates', 'privateVulnerabilityReporting'], 'security');
    const security = config.security;
    if ('codeqlDefaultSetup' in security) requireValue(['configured', 'not-configured'].includes(security.codeqlDefaultSetup), 'Invalid security.codeqlDefaultSetup');
    if ('dependabotSecurityUpdates' in security) requireValue(['enabled', 'disabled'].includes(security.dependabotSecurityUpdates), 'Invalid security.dependabotSecurityUpdates');
    if ('privateVulnerabilityReporting' in security) requireValue(typeof security.privateVulnerabilityReporting === 'boolean', 'Invalid security.privateVulnerabilityReporting');
  }
  if ('obsoleteFiles' in config) {
    requireValue(Array.isArray(config.obsoleteFiles) && new Set(config.obsoleteFiles).size === config.obsoleteFiles.length, 'Invalid obsoleteFiles list');
    for (const file of config.obsoleteFiles) {
      requireValue(typeof file === 'string' && !/[\\\x00-\x1f]/.test(file)
        && file.split('/').every(part => part && !['.', '..'].includes(part)), 'Unsafe obsoleteFiles path');
      const workflow = /^\.github\/workflows\/([A-Za-z0-9_.-]+)\.ya?ml$/.exec(file);
      requireValue(/^\.github\/dependabot\.ya?ml$/.test(file)
        || (workflow && !WORKFLOWS.has(workflow[1])), 'obsoleteFiles may only retire non-managed GitHub automation');
    }
  }
  return config;
}
function readOrganization(root, repository) {
  const directory = fs.realpathSync(root);
  for (const relative of ['.github', '.github/organization.json']) {
    const file = path.join(directory, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    requireValue(!stat.isSymbolicLink(), 'Organization configuration path contains a symlink');
  }
  const file = path.join(directory, '.github/organization.json');
  if (!fs.existsSync(file)) {
    if (repository !== undefined) repositoryParts(repository);
    return null;
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Invalid organization configuration JSON'); }
  validateOrganization(config);
  if (repository !== undefined) checkOwner(config, repository);
  return config;
}
function resolvePagesURL(config, repository) {
  if (!config?.pagesURL) return null;
  checkOwner(config, repository);
  const [, repo] = repositoryParts(repository);
  return new URL(config.pagesURL.replaceAll('{repo}', repo)).href;
}
function validateIdentity(config, pkg, repository) {
  if (config?.namePattern) requireValue(typeof pkg.name === 'string' && new RegExp(`^(?:${config.namePattern})$`).test(pkg.name), 'Package name conflicts with organization namePattern');
  if (!config?.owner && !config?.pagesURL && repository === undefined) return;
  const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  let url;
  try { url = new URL(source.replace(/^git\+/, '')); } catch { throw new Error('Package repository must identify its GitHub repository'); }
  requireValue(url.hostname.toLowerCase() === 'github.com' && !url.username && !url.password && !url.search && !url.hash, 'Package repository must identify its GitHub repository');
  const declared = url.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
  checkOwner(config, declared);
  if (repository !== undefined) requireValue(declared.toLowerCase() === repository.toLowerCase(), 'Package repository conflicts with the target repository');
  const expected = resolvePagesURL(config, repository || declared);
  if (expected) {
    let homepage;
    try { homepage = new URL(pkg.homepage).href; } catch { throw new Error('Package homepage conflicts with organization pagesURL'); }
    requireValue(homepage.replace(/\/$/, '') === expected.replace(/\/$/, ''), 'Package homepage conflicts with organization pagesURL');
  }
}

module.exports = { readOrganization, validateOrganization, validateIdentity, resolvePagesURL };
if (require.main === module) {
  try {
    const [root, repository, ...extra] = process.argv.slice(2);
    requireValue(root && extra.length === 0, 'Usage: node organization.cjs target-path [owner/repo]');
    process.stdout.write(JSON.stringify(readOrganization(root, repository)) + '\n');
  } catch (error) {
    console.error(`FAIL organization: ${error.message}`);
    process.exitCode = 1;
  }
}
