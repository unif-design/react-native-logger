import {
  LOG_TASK_BATCH_SIZE,
  LOG_TASK_QUEUE_LIMIT,
  LOG_TASK_ROOT_LIMIT,
} from '../constants';

export interface LogTaskScope {
  owner?: object;
  identityEpoch?: string;
  startup?: boolean;
  valid(): boolean;
  dropped?(): void;
}
interface Task {
  root: number;
  control: boolean;
  scope?: LogTaskScope;
  revision: number;
  run(): Promise<void>;
  cancel(): void;
}
const tasks: Task[] = [];
const rootCounts = new Map<number, number>();
const waiters: { root: number; resolve(): void }[] = [];
let rootSequence = 0;
let revision = 0;
let captureScope: (() => LogTaskScope) | undefined;
let active: Task | undefined;
let executing: Task | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function dropped(scope?: LogTaskScope) {
  try {
    scope?.dropped?.();
  } catch {
    /* 诊断队列不得抛出。 */
  }
}
function settleWaiters() {
  for (let index = waiters.length - 1; index >= 0; index--) {
    const waiter = waiters[index]!;
    if (
      (!active || active.root > waiter.root) &&
      !tasks.some((task) => task.root <= waiter.root)
    ) {
      waiters.splice(index, 1);
      waiter.resolve();
    }
  }
}
function schedule() {
  if (timer !== undefined || active || !tasks.length) return;
  try {
    timer = setTimeout(() => {
      timer = undefined;
      drainBatch();
    }, 0);
  } catch {
    for (const task of tasks.splice(0)) task.cancel();
    rootCounts.clear();
    settleWaiters();
  }
}
async function drainBatch() {
  for (let count = 0; count < LOG_TASK_BATCH_SIZE && tasks.length; count++) {
    // 同步派生任务仍属于原记录，先于其后提交的flush/快照边界处理。
    let index = 0;
    for (let candidate = 1; candidate < tasks.length; candidate++)
      if (tasks[candidate]!.root < tasks[index]!.root) index = candidate;
    const task = tasks.splice(index, 1)[0]!;
    active = task;
    try {
      if (task.revision !== revision || (task.scope && !task.scope.valid()))
        task.cancel();
      else await task.run();
    } catch {
      task.cancel();
    } finally {
      active = undefined;
      if (!tasks.some((next) => next.root === task.root))
        rootCounts.delete(task.root);
      settleWaiters();
    }
  }
  schedule();
}

/** 一个库内宏任务队列；业务只提交，序列化、输出与文件入队在后续分批执行。 */
export function enqueueLogTask<T>(
  operation: () => T | Promise<T>,
  scope = captureScope?.(),
  control = false,
): Promise<T | null> {
  return new Promise((resolve) => {
    let cancelled!: () => void;
    const cancellation = new Promise<null>((done) => {
      cancelled = () => done(null);
    });
    let settled = false;
    const finish = (value: T | null, failed = false) => {
      if (settled) return;
      settled = true;
      if (failed) dropped(scope);
      resolve(value);
    };
    const task: Task = {
      root: control ? ++rootSequence : (executing?.root ?? ++rootSequence),
      control,
      revision,
      ...(scope ? { scope } : {}),
      async run() {
        try {
          const previous = executing;
          let result: T | Promise<T>;
          executing = task;
          try {
            result = operation();
          } finally {
            executing = previous;
          }
          finish(await Promise.race([Promise.resolve(result), cancellation]));
        } catch {
          finish(null, true);
        }
      },
      cancel() {
        finish(null, true);
        cancelled();
      },
    };
    // 身份与文件管理边界不能被普通日志占满；只腾出一个有界槽位，不同步排空。
    if (control && tasks.length >= LOG_TASK_QUEUE_LIMIT) {
      const index = tasks.findIndex((candidate) => !candidate.control);
      if (index >= 0) {
        const removed = tasks.splice(index, 1)[0]!;
        removed.cancel();
        if (
          active?.root !== removed.root &&
          !tasks.some((candidate) => candidate.root === removed.root)
        )
          rootCounts.delete(removed.root);
      }
    }
    const count = rootCounts.get(task.root) ?? 0;
    if (tasks.length >= LOG_TASK_QUEUE_LIMIT || count >= LOG_TASK_ROOT_LIMIT) {
      task.cancel();
      return;
    }
    rootCounts.set(task.root, count + 1);
    tasks.push(task);
    schedule();
  });
}
export function readActiveLogTaskScope(): LogTaskScope | undefined {
  return executing?.scope;
}
export function isExecutingLogTask(): boolean {
  return executing !== undefined;
}

/** 包含调用前已提交任务及其派生任务，不等待后来无关日志。 */
export function flushLogTasks(): Promise<void> {
  const root = rootSequence;
  if (
    (!active || active.root > root) &&
    !tasks.some((task) => task.root <= root)
  )
    return Promise.resolve();
  return new Promise((resolve) => waiters.push({ root, resolve }));
}
export function installLogTaskScope(capture: () => LogTaskScope): () => void {
  const previous = captureScope;
  captureScope = capture;
  revision++;
  return () => {
    if (captureScope === capture) {
      captureScope = previous;
      revision++;
    }
  };
}
export function cancelLogTasks(owner: object): void {
  if (active?.scope?.owner === owner) active.cancel();
  for (let index = tasks.length - 1; index >= 0; index--) {
    if (tasks[index]!.scope?.owner === owner)
      tasks.splice(index, 1)[0]!.cancel();
  }
  for (const root of rootCounts.keys()) {
    if (active?.root !== root && !tasks.some((task) => task.root === root))
      rootCounts.delete(root);
  }
  if (!tasks.length && timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  settleWaiters();
}
