const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');

// Only presentation metadata may bypass runtime validation. Unknown fields stay relevant.
const metadata = [
  'description',
  'keywords',
  'homepage',
  'bugs',
  'repository',
  'author',
  'contributors',
  'funding',
];
function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function snapshot(ref, file) {
  const entry = git(['ls-tree', ref, '--', file]);
  if (!entry) return null;
  const value = JSON.parse(git(['show', `${ref}:${file}`]));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid manifest');
  for (const key of metadata) delete value[key];
  return value;
}
function runtimeChanged(event, eventName) {
  let base, head;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else if (eventName === 'push') {
    base = event.before;
    head = event.after;
  } else if (eventName === 'merge_group') {
    base = event.merge_group?.base_sha;
    head = event.merge_group?.head_sha;
  }
  for (const ref of [base, head]) {
    if (!/^[a-f0-9]{40}$/.test(ref || '') || /^0+$/.test(ref))
      throw new Error('Missing comparison commit');
    git(['rev-parse', '--verify', `${ref}^{commit}`]);
  }
  if (eventName === 'pull_request') base = git(['merge-base', base, head]);
  // Conditional exports are ordered. Other key reorders conservatively revalidate runtime.
  return ['package.json', 'example/package.json'].some(
    (file) =>
      JSON.stringify(snapshot(base, file)) !==
      JSON.stringify(snapshot(head, file))
  );
}

let runtime = true;
try {
  runtime = runtimeChanged(
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    process.env.GITHUB_EVENT_NAME
  );
} catch {
  console.warn(
    '::warning::Package comparison unavailable; validating shared runtime inputs.'
  );
}
appendFileSync(process.env.GITHUB_OUTPUT, `runtime=${runtime}\n`);
