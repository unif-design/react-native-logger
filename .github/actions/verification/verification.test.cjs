const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const {
  createReceipt,
  gitIdentity,
  requiredChecks,
  selectVerification,
  verifyCompletedChecks,
} = require('./verification.cjs');

const sha = char => char.repeat(40);
const scope = {
  has_website: 'true', js: 'true', shared: 'false', android: 'false',
  ios: 'false', website: 'true', code: 'true',
};
const repo = { id: 42, full_name: 'unif-design/react-native-camera', default_branch: 'main' };
const pr = {
  number: 144, state: 'closed', merged: true, merge_commit_sha: sha('a'),
  head: { sha: sha('b'), ref: 'ci/example', repo },
  base: { ref: 'main', repo },
};
const env = {
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha('a'), GITHUB_REPOSITORY: repo.full_name,
  GITHUB_REPOSITORY_ID: '42', GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1',
};
const event = { repository: repo, pull_request: pr };
const identity = { sha: sha('a'), tree: sha('c') };

function fixture(selectedScope = scope) {
  const run = {
    id: 200, workflow_id: 90, path: '.github/workflows/ci.yml',
    event: 'pull_request', head_sha: sha('b'), head_branch: 'ci/example',
    repository: repo, head_repository: repo, run_attempt: 1,
    status: 'completed', conclusion: 'success',
  };
  const receipt = {
    schema: 1, repository: repo.full_name, repositoryId: '42',
    pullRequest: 144, targetBranch: 'main', headSha: sha('b'),
    checkoutSha: sha('d'), tree: sha('c'), runId: 200, runAttempt: 1,
    workflowPath: '.github/workflows/ci.yml', scope: { ...selectedScope },
  };
  const jobs = Object.entries({ changes: true, ...requiredChecks(selectedScope), verified: true })
    .map(([name, required]) => ({
      name, status: 'completed', conclusion: required ? 'success' : 'skipped',
      run_id: 200, run_attempt: 1, head_sha: sha('b'),
    }));
  const data = {
    [`commits/${sha('a')}/pulls?per_page=100`]: [pr],
    'pulls/144': structuredClone(pr),
    'actions/workflows/ci.yml': { id: 90, path: '.github/workflows/ci.yml' },
    [`actions/workflows/90/runs?event=pull_request&head_sha=${sha('b')}&per_page=100`]: { workflow_runs: [run] },
    [`git/commits/${sha('d')}`]: { sha: sha('d'), tree: { sha: sha('c') } },
    'actions/runs/200/attempts/1/jobs?per_page=100': { total_count: jobs.length, jobs },
    'actions/runs/200': structuredClone(run),
  };
  const calls = [];
  return {
    data, receipt, run, jobs, calls,
    options: {
      identity: () => identity,
      read: async path => {
        calls.push(path);
        assert.ok(Object.hasOwn(data, path), `Unexpected GitHub endpoint: ${path}`);
        return data[path];
      },
      download: async (runId, attempt) => {
        assert.equal(runId, 200);
        assert.equal(attempt, 1);
        return receipt;
      },
    },
  };
}

function needsFor(selectedScope = scope) {
  return Object.fromEntries([
    ['changes', { result: 'success', outputs: { ...selectedScope, reused: 'false' } }],
    ...Object.entries(requiredChecks(selectedScope)).map(([name, required]) =>
      [name, { result: required ? 'success' : 'skipped' }]),
  ]);
}

test('records the actual checked-out PR merge tree after every applicable check passes', () => {
  const actual = createReceipt({ ...env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: sha('d'), GITHUB_RUN_ID: '200' },
    event, needsFor(), { sha: sha('d'), tree: sha('c') });
  assert.deepEqual(actual, fixture().receipt);
});

test('reuses a successful PR for a squash commit with a different SHA and identical complete tree', async () => {
  const f = fixture();
  const result = await selectVerification(env, event, f.options);
  assert.equal(result.reused, true);
  assert.equal(result.runId, 200);
  assert.equal(result.pullRequest, 144);
  assert.equal(result.tree, sha('c'));
});

test('legitimately skipped unrelated platform checks remain eligible', async () => {
  const f = fixture({ ...scope, js: 'false', ios: 'true', website: 'false' });
  assert.equal((await selectVerification(env, event, f.options)).reused, true);
});

for (const [name, patch] of [
  ['pull requests', { GITHUB_EVENT_NAME: 'pull_request' }],
  ['merge groups', { GITHUB_EVENT_NAME: 'merge_group' }],
  ['other branches', { GITHUB_REF: 'refs/heads/feature' }],
  ['tags', { GITHUB_REF: 'refs/tags/v1' }],
]) {
  test(`${name} execute normal verification without consulting old runs`, async () => {
    const f = fixture();
    assert.equal((await selectVerification({ ...env, ...patch }, event, f.options)).reused, false);
    assert.deepEqual(f.calls, []);
  });
}

const invalidEvidence = {
  'direct push without a merged PR': f => { f.data[`commits/${sha('a')}/pulls?per_page=100`] = []; },
  'PR is not merged': f => { f.data['pulls/144'].merged = false; },
  'PR merged to another commit': f => { f.data['pulls/144'].merge_commit_sha = sha('e'); },
  'PR targets another branch': f => { f.data['pulls/144'].base.ref = 'release'; },
  'fork source': f => { f.data['pulls/144'].head.repo.id = 7; },
  'different workflow ID': f => { f.run.workflow_id = 91; },
  'different workflow file': f => { f.run.path = '.github/workflows/fake.yml'; },
  'different run repository': f => { f.run.repository = { ...repo, id: 7 }; },
  'different source repository': f => { f.run.head_repository = { ...repo, id: 7 }; },
  'different PR head': f => { f.run.head_sha = sha('e'); },
  'non-PR run': f => { f.run.event = 'push'; },
  'latest run failed': f => { f.run.conclusion = 'failure'; },
  'latest run cancelled': f => { f.run.conclusion = 'cancelled'; },
  'latest run pending': f => { f.run.status = 'in_progress'; },
  'wrong receipt schema': f => { f.receipt.schema = 2; },
  'wrong receipt repository': f => { f.receipt.repository = 'someone/another'; },
  'wrong receipt repository ID': f => { f.receipt.repositoryId = '7'; },
  'wrong receipt PR': f => { f.receipt.pullRequest = 143; },
  'wrong receipt target': f => { f.receipt.targetBranch = 'release'; },
  'wrong receipt head': f => { f.receipt.headSha = sha('e'); },
  'wrong receipt workflow': f => { f.receipt.workflowPath = '.github/workflows/fake.yml'; },
  'wrong receipt run': f => { f.receipt.runId = 201; },
  'wrong receipt attempt': f => { f.receipt.runAttempt = 2; },
  'different merged tree': f => { f.options.identity = () => ({ ...identity, tree: sha('e') }); },
  'different recorded tree': f => { f.receipt.tree = sha('e'); },
  'different actual tested tree': f => { f.data[`git/commits/${sha('d')}`].tree.sha = sha('e'); },
  'wrong tested commit response': f => { f.data[`git/commits/${sha('d')}`].sha = sha('e'); },
  'invalid tested SHA': f => { f.receipt.checkoutSha = '--help'; },
  'missing scope': f => { delete f.receipt.scope.ios; },
  'invalid scope boolean': f => { f.receipt.scope.code = 'yes'; },
  'runtime scope cannot omit tests': f => {
    f.receipt.scope.code = 'false';
    for (const job of f.jobs.filter(j => ['lint', 'test'].includes(j.name))) job.conclusion = 'skipped';
  },
  'failed required test job': f => { f.jobs.find(j => j.name === 'test').conclusion = 'failure'; },
  'skipped required test job': f => { f.jobs.find(j => j.name === 'test').conclusion = 'skipped'; },
  'missing native job': f => { f.jobs.splice(f.jobs.findIndex(j => j.name === 'build-ios'), 1); },
  'unfinished native job': f => { f.jobs.find(j => j.name === 'build-ios').status = 'in_progress'; },
  'unverified summary job': f => { f.jobs.find(j => j.name === 'verified').conclusion = 'skipped'; },
  'jobs from another attempt': f => { f.jobs.find(j => j.name === 'test').run_attempt = 2; },
  'jobs from another run': f => { f.jobs.find(j => j.name === 'test').run_id = 201; },
  'duplicated required job': f => { f.jobs.push({ ...f.jobs.find(j => j.name === 'test') }); },
  'truncated job listing': f => { f.data['actions/runs/200/attempts/1/jobs?per_page=100'].total_count = 101; },
  'new rerun started while reading proof': f => { f.data['actions/runs/200'].run_attempt = 2; },
  'new workflow run started while reading proof': f => {
    f.options.download = async () => {
      f.data[`actions/workflows/90/runs?event=pull_request&head_sha=${sha('b')}&per_page=100`].workflow_runs
        .unshift({ ...f.run, id: 201, status: 'in_progress', conclusion: null });
      return f.receipt;
    };
  },
  'run cancelled while reading proof': f => { f.data['actions/runs/200'].conclusion = 'cancelled'; },
  'local checkout differs from event': f => { f.options.identity = () => ({ ...identity, sha: sha('e') }); },
  'expired or missing artifact': f => { f.options.download = async () => { throw new Error('artifact expired'); }; },
  'GitHub unavailable': f => { f.options.read = async () => { throw new Error('network timeout'); }; },
};
for (const [name, mutate] of Object.entries(invalidEvidence)) {
  test(`${name} keeps normal verification enabled`, async () => {
    const f = fixture();
    mutate(f);
    assert.equal((await selectVerification(env, event, f.options)).reused, false);
  });
}

test('a newer failed run cannot fall back to an older passing run', async () => {
  const f = fixture();
  const runs = f.data[`actions/workflows/90/runs?event=pull_request&head_sha=${sha('b')}&per_page=100`];
  runs.workflow_runs.unshift({ ...f.run, id: 201, conclusion: 'failure' });
  assert.equal((await selectVerification(env, event, f.options)).reused, false);
});

test('failure diagnostics identify the stage without exposing external error text', async () => {
  const f = fixture();
  f.options.download = async () => { throw new Error('credential-like-secret'); };
  const result = await selectVerification(env, event, f.options);
  assert.match(result.reason, /verification receipt/);
  assert.doesNotMatch(result.reason, /credential-like-secret/);
});

for (const name of ['changes', ...Object.keys(requiredChecks(scope))]) {
  test(`receipt creation rejects failed ${name}`, () => {
    const needs = needsFor();
    needs[name].result = 'failure';
    assert.throws(() => verifyCompletedChecks(needs));
  });
}

test('main reuse still requires successful classification and workflow lint', () => {
  const needs = needsFor();
  needs.changes.outputs.reused = 'true';
  for (const name of Object.keys(requiredChecks(scope))) {
    if (name !== 'actionlint') needs[name].result = 'skipped';
  }
  assert.doesNotThrow(() => verifyCompletedChecks(needs));
  needs.actionlint.result = 'failure';
  assert.throws(() => verifyCompletedChecks(needs));
});

test('shared inputs retain every native gate even without a website', () => {
  assert.deepEqual(requiredChecks({ ...scope, has_website: 'false', js: 'false', shared: 'true' }), {
    actionlint: true, lint: true, test: true, website: false,
    'build-library': true, 'build-android': true, 'build-ios': true,
  });
});

test('Git identity includes all files, including coverage and CI configuration', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-git-tree-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'user.name', 'CI test');
    writeFileSync(join(cwd, 'coverage.json'), '{"threshold":100}');
    git('add', '.'); git('commit', '-qm', 'initial');
    const before = gitIdentity(cwd);
    writeFileSync(join(cwd, 'coverage.json'), '{"threshold":99}');
    git('add', '.'); git('commit', '-qm', 'changed');
    assert.notEqual(gitIdentity(cwd).tree, before.tree);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
