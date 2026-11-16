import {
  cancelLogTasks,
  enqueueLogTask,
  flushLogTasks,
} from '../src/runtime/logTasks';
import { LOG_TASK_QUEUE_LIMIT, LOG_TASK_ROOT_LIMIT } from '../src/constants';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await flushLogTasks();
  jest.restoreAllMocks();
});

test('普通业务宏任务在日志分批之间获得执行机会', async () => {
  const order: string[] = [];
  const pending = Array.from({ length: 40 }, () =>
    enqueueLogTask(() => {
      order.push('log');
    }),
  );
  const business = new Promise<void>((resolve) =>
    setTimeout(() => {
      order.push('business');
      resolve();
    }, 0),
  );
  expect(order).toEqual([]);
  await Promise.all([...pending, business]);
  expect(order.indexOf('business')).toBeGreaterThan(0);
  expect(order.indexOf('business')).toBeLessThan(40);
});

test('等待IO的日志任务不会把同时到来的独立业务日志算成旧flush子任务', async () => {
  const started = deferred();
  const first = deferred();
  const later = deferred();
  const work = enqueueLogTask(async () => {
    started.resolve();
    await first.promise;
  });
  await started.promise;
  const flushed = flushLogTasks();
  let laterFinished = false;
  const next = enqueueLogTask(async () => {
    await later.promise;
    laterFinished = true;
  });
  first.resolve();
  try {
    await flushed;
    expect(laterFinished).toBe(false);
  } finally {
    later.resolve();
    await Promise.all([work, next]);
  }
});

test('旧任务同步派生的dispatch在flush边界前完成，不被后来独立等待卡住', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const first = enqueueLogTask(() => {
    enqueueLogTask(() => {
      calls.push('child');
    });
  });
  const flushed = flushLogTasks();
  const later = enqueueLogTask(() => gate.promise);
  try {
    await flushed;
    expect(calls).toEqual(['child']);
  } finally {
    gate.resolve();
    await Promise.all([first, later]);
  }
});

test('队列有界，失败与过量记录均只结束日志任务，不抛向业务', async () => {
  const dropped = jest.fn();
  const owner = {};
  const scope = { owner, valid: () => true, dropped };
  const pending = Array.from({ length: LOG_TASK_QUEUE_LIMIT + 1 }, () =>
    enqueueLogTask(() => 'done', scope),
  );
  expect(dropped).toHaveBeenCalledTimes(1);
  cancelLogTasks(owner);
  await expect(Promise.all(pending)).resolves.toEqual(
    Array(LOG_TASK_QUEUE_LIMIT + 1).fill(null),
  );
});

test('transport持续自日志也有单次血缘上限，后续独立任务仍可完成', async () => {
  let count = 0;
  const recur = () => {
    count++;
    enqueueLogTask(recur);
  };
  enqueueLogTask(recur);
  await flushLogTasks();
  expect(count).toBe(LOG_TASK_ROOT_LIMIT);
  await expect(enqueueLogTask(() => 'business-next')).resolves.toBe(
    'business-next',
  );
});
