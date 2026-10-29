const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const workflowPath = '.github/workflows/ci.yml';
const scopeKeys = ['has_website', 'js', 'shared', 'android', 'ios', 'website', 'code'];
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isId = value => Number.isSafeInteger(value) && value > 0;
const normal = reason => ({ reused: false, reason });

function requiredChecks(scope) {
  for (const key of scopeKeys) assert.ok(['true', 'false'].includes(scope?.[key]), `Missing or invalid scope: ${key}`);
  const enabled = key => scope[key] === 'true';
  assert.ok(!['js', 'shared', 'android', 'ios'].some(enabled) || enabled('code'), 'Runtime inputs require lint and tests');
  return {
    actionlint: true,
    lint: enabled('code'),
    test: enabled('code'),
    website: enabled('website') && enabled('has_website'),
    'build-library': enabled('js') || enabled('shared'),
    'build-android': enabled('android') || enabled('js') || enabled('shared'),
    'build-ios': enabled('ios') || enabled('js') || enabled('shared'),
  };
}

function verifyCompletedChecks(needs) {
  assert.equal(needs.changes?.result, 'success', 'Change classification must succeed');
  const outputs = needs.changes.outputs;
  const expected = outputs.reused === 'true'
    ? { actionlint: true, lint: false, test: false, website: false, 'build-library': false, 'build-android': false, 'build-ios': false }
    : requiredChecks(outputs);
  for (const [name, required] of Object.entries(expected)) {
    assert.equal(needs[name]?.result, required ? 'success' : 'skipped', `Unexpected ${name} result`);
  }
}

function gitIdentity(cwd = process.cwd()) {
  const git = ref => execFileSync('git', ['rev-parse', '--verify', ref], {
    cwd, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return { sha: git('HEAD'), tree: git('HEAD^{tree}') };
}

function context(env, event) {
  assert.match(env.GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/);
  assert.equal(event.repository.full_name, env.GITHUB_REPOSITORY);
  assert.equal(String(event.repository.id), env.GITHUB_REPOSITORY_ID);
  assert.ok(isId(event.repository.id));
  assert.ok(isSha(env.GITHUB_SHA));
  return { repository: env.GITHUB_REPOSITORY, repositoryId: env.GITHUB_REPOSITORY_ID, targetBranch: event.repository.default_branch };
}

function sameRepository(repo, current) {
  return repo?.full_name === current.repository && String(repo.id) === current.repositoryId;
}

function createReceipt(env, event, needs, identity = gitIdentity()) {
  const current = context(env, event);
  const pr = event.pull_request;
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  assert.notEqual(needs.changes?.outputs?.reused, 'true', 'PR checks cannot reuse a previous receipt');
  verifyCompletedChecks(needs);
  assert.ok(isId(pr.number) && isSha(pr.head.sha));
  assert.ok(sameRepository(pr.base.repo, current));
  assert.equal(pr.base.ref, current.targetBranch);
  assert.equal(identity.sha, env.GITHUB_SHA);
  assert.ok(isSha(identity.tree));
  const receipt = {
    schema: 1, ...current, pullRequest: pr.number, headSha: pr.head.sha,
    checkoutSha: identity.sha, tree: identity.tree,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    workflowPath, scope: Object.fromEntries(scopeKeys.map(key => [key, needs.changes.outputs[key]])),
  };
  assert.ok(isId(receipt.runId) && isId(receipt.runAttempt));
  return receipt;
}

function githubApi(repository, path) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function downloadReceipt(repository, runId, attempt) {
  assert.ok(isId(runId) && isId(attempt));
  const directory = mkdtempSync(join(tmpdir(), 'ci-verification-'));
  try {
    execFileSync('gh', ['run', 'download', String(runId), '--repo', repository,
      '--name', `ci-verification-${attempt}`, '--dir', directory], {
      timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = join(directory, 'verified.json');
    assert.ok(statSync(file).size <= 16384, 'Unexpected receipt size');
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function selectVerification(env, event, {
  read = path => githubApi(env.GITHUB_REPOSITORY, path),
  download = (runId, attempt) => downloadReceipt(env.GITHUB_REPOSITORY, runId, attempt),
  identity = gitIdentity,
} = {}) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/heads/${event.repository?.default_branch}`) {
    return normal('This event executes the normal checks');
  }
  let stage = 'checkout identity';
  try {
    const current = context(env, event);
    const checkout = identity();
    assert.equal(checkout.sha, env.GITHUB_SHA);
    assert.ok(isSha(checkout.tree));
    stage = 'merged PR identity';
    const associated = await read(`commits/${env.GITHUB_SHA}/pulls?per_page=100`);
    const candidate = associated.find(pr => pr.merge_commit_sha === env.GITHUB_SHA && pr.state === 'closed');
    if (!candidate) return normal('This commit is not the result of a merged PR');
    assert.ok(isId(candidate.number));
    const pr = await read(`pulls/${candidate.number}`);
    assert.equal(pr.number, candidate.number);
    assert.equal(pr.merged, true);
    assert.equal(pr.merge_commit_sha, env.GITHUB_SHA);
    assert.equal(pr.base.ref, current.targetBranch);
    assert.ok(sameRepository(pr.base.repo, current) && sameRepository(pr.head.repo, current));
    assert.ok(isSha(pr.head.sha));
    stage = 'latest PR workflow run';
    const workflow = await read('actions/workflows/ci.yml');
    assert.ok(isId(workflow.id));
    assert.equal(workflow.path, workflowPath);
    const runsPath = `actions/workflows/${workflow.id}/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`;
    const { workflow_runs: runs } = await read(runsPath);
    // Only the latest run can establish success; an older green run cannot mask a new failure.
    const run = runs[0];
    assert.ok(isId(run?.id) && isId(run.run_attempt));
    const validRun = actual => {
      assert.equal(actual.id, run.id);
      assert.equal(actual.workflow_id, workflow.id);
      assert.equal(actual.path, workflowPath);
      assert.equal(actual.event, 'pull_request');
      assert.equal(actual.head_sha, pr.head.sha);
      assert.equal(actual.head_branch, pr.head.ref);
      assert.ok(sameRepository(actual.repository, current) && sameRepository(actual.head_repository, current));
      assert.equal(actual.status, 'completed');
      assert.equal(actual.conclusion, 'success');
      assert.equal(actual.run_attempt, run.run_attempt);
    };
    validRun(run);
    stage = 'verification receipt';
    const proof = await download(run.id, run.run_attempt);
    const expected = {
      schema: 1, ...current, pullRequest: pr.number, headSha: pr.head.sha,
      runId: run.id, runAttempt: run.run_attempt, workflowPath, tree: checkout.tree,
    };
    for (const [key, value] of Object.entries(expected)) assert.equal(proof[key], value, `Receipt mismatch: ${key}`);
    assert.ok(isSha(proof.checkoutSha));
    stage = 'tested Git tree';
    const tested = await read(`git/commits/${proof.checkoutSha}`);
    assert.equal(tested.sha, proof.checkoutSha);
    assert.equal(tested.tree.sha, checkout.tree);
    stage = 'completed job results';
    const listing = await read(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    assert.equal(listing.total_count, listing.jobs.length, 'Incomplete job evidence');
    for (const [name, required] of Object.entries({ changes: true, ...requiredChecks(proof.scope), verified: true })) {
      const matches = listing.jobs.filter(job => job.name === name);
      assert.equal(matches.length, 1, `Missing or duplicate job: ${name}`);
      const job = matches[0];
      assert.equal(job.run_id, run.id);
      assert.equal(job.run_attempt, run.run_attempt);
      assert.equal(job.head_sha, pr.head.sha);
      assert.equal(job.status, 'completed');
      assert.equal(job.conclusion, required ? 'success' : 'skipped', `Unexpected job result: ${name}`);
    }
    stage = 'latest run recheck';
    validRun(await read(`actions/runs/${run.id}`));
    validRun((await read(runsPath)).workflow_runs[0]);
    return {
      reused: true, reason: 'The complete Git tree matches the PR verification receipt and successful checks',
      pullRequest: pr.number, runId: run.id, runAttempt: run.run_attempt, tree: checkout.tree,
      url: `https://github.com/${current.repository}/actions/runs/${run.id}`,
    };
  } catch {
    // Missing, expired, failed or unreadable evidence must never disable verification.
    return normal(`PR evidence was not verified at ${stage}; execute the normal checks`);
  }
}

module.exports = { createReceipt, gitIdentity, requiredChecks, selectVerification, verifyCompletedChecks };

if (require.main === module) {
  (async () => {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (process.argv[2] === 'plan') {
      const decision = await selectVerification(process.env, event);
      appendFileSync(process.env.GITHUB_OUTPUT, `reused=${decision.reused}\n`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `${decision.reason}\n${decision.reused ? `\nPR #${decision.pullRequest}: ${decision.url}\n\nGit tree: \`${decision.tree}\`\n` : ''}`);
      console.log(JSON.stringify(decision, null, 2));
    } else {
      assert.equal(process.argv[2], 'record');
      const needs = JSON.parse(process.env.CI_CHECK_RESULTS);
      verifyCompletedChecks(needs);
      if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
        const receipt = createReceipt(process.env, event, needs);
        const directory = join(process.env.RUNNER_TEMP, 'ci-verification');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'verified.json'), `${JSON.stringify(receipt, null, 2)}\n`);
        console.log(JSON.stringify(receipt, null, 2));
      } else {
        console.log(needs.changes.outputs.reused === 'true' ? 'Matching PR verification reused; all main gates checked.' : 'All applicable checks passed.');
      }
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
