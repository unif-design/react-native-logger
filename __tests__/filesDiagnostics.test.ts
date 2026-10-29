import { createLogFileStore } from '../src/files';
import type { LogFileStore } from '../src/files';
import { createMemoryIO, entry, sourceName } from './filesFixture';

const stores: LogFileStore[] = [];
const failure = (code: string) =>
  Object.assign(new Error('PRIVATE_PATH_AND_BODY'), { code });
function setup(initial: Record<string, string> = {}) {
  const disk = createMemoryIO(initial);
  const store = createLogFileStore({
    io: disk.io,
    now: () => 1_750_000_000_000,
    createId: () => 'diagnostic',
  });
  stores.push(store);
  return { ...disk, store };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  jest.useRealTimers();
});

test('初始化拒绝保留可诊断的IO原因，不递归写文件或抛给业务', async () => {
  const f = setup();
  f.io.ensureRoot = async () => {
    throw failure('EACCES');
  };
  await expect(f.store.setOwner('hash-a', 'epoch-a')).resolves.toBeUndefined();
  expect(f.store.getStatus()).toMatchObject({
    state: 'blocked',
    writable: false,
    lastFailureCode: 'logger.files.initialize_failed',
    lastFailure: {
      phase: 'initialize',
      reason: 'permission_denied',
      sourceCode: 'EACCES',
    },
  });
  expect(f.operations).toEqual([]);
  expect(JSON.stringify(f.store.getStatus())).not.toContain('PRIVATE_');
});

test('写入失败保留原缓冲恢复规则，成功后清除诊断而不再标不健康', async () => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.control.before = async (operation) => {
    if (operation === 'append') throw failure('ENOSPC');
  };
  f.store.append(entry('source'));
  await expect(f.store.flush()).resolves.toBeUndefined();
  expect(f.store.getStatus()).toMatchObject({
    writable: false,
    lastFailureCode: 'logger.files.write_failed',
    lastFailure: { phase: 'write', reason: 'storage_full' },
  });
  f.control.before = undefined;
  await f.store.flush();
  expect(f.store.getStatus()).toMatchObject({
    writable: true,
    lastFailureCode: null,
  });
  expect(f.store.getStatus().lastFailure).toBeUndefined();
  expect(f.sourceText()).toBe(entry('source').line);
});

test('轮转清理原因不被通用包装覆盖', async () => {
  const f = setup({
    [sourceName('hash-a', 'expired', 1)]: entry('expired').line,
  });
  f.io.remove = async () => {
    throw failure('EPERM');
  };
  await f.store.setOwner('hash-a', 'epoch-a');
  expect(f.store.getStatus()).toMatchObject({
    lastFailureCode: 'logger.files.cleanup_failed',
    lastFailure: {
      phase: 'cleanup',
      reason: 'permission_denied',
      sourceCode: 'EPERM',
    },
  });
  expect(f.files.size).toBe(1);
});

test('快照写入失败保留底层原因和既有错误码，不删除源日志', async () => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.store.append(entry('source'));
  f.io.write = async () => {
    throw failure('EIO');
  };
  await expect(f.store.createSnapshot()).rejects.toMatchObject({
    code: 'logger.files.snapshot_failed',
  });
  expect(f.store.getStatus()).toMatchObject({
    lastFailure: { phase: 'snapshot', reason: 'io_error', sourceCode: 'EIO' },
  });
  expect(f.sourceText()).toBe(entry('source').line);
});

test('摘要和显式清理诊断不改变返回、在用文件或既有可写状态', async () => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.store.append(entry('source'));
  await f.store.flush();
  f.io.remove = async () => {
    throw failure('EPERM');
  };
  await expect(f.store.clear()).resolves.toMatchObject({
    status: 'partial',
    remainingFiles: 1,
  });
  expect(f.store.getStatus()).toMatchObject({
    writable: true,
    lastFailure: { phase: 'cleanup', reason: 'permission_denied' },
  });
  f.io.list = async () => {
    throw failure('EIO');
  };
  await expect(f.store.readSummary()).rejects.toMatchObject({
    code: 'logger.files.summary_failed',
  });
  expect(f.store.getStatus()).toMatchObject({
    lastFailure: { phase: 'summary', reason: 'io_error' },
  });
  expect(JSON.stringify(f.store.getStatus())).not.toContain('PRIVATE_');
});

test('已交付快照释放失败记录安全原因，重试和跨身份释放规则保持', async () => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.store.append(entry('source'));
  const snapshot = await f.store.createSnapshot();
  const file = await f.store.takeSnapshotFile(snapshot);
  const remove = f.io.remove;
  f.io.remove = async () => {
    throw failure('EACCES');
  };
  await expect(file.release()).rejects.toMatchObject({
    code: 'logger.files.snapshot_failed',
  });
  expect(f.store.getStatus()).toMatchObject({
    writable: true,
    lastFailure: { phase: 'snapshot_release', reason: 'permission_denied' },
  });
  await f.store.setOwner('hash-b', 'epoch-b');
  await expect(file.release()).rejects.toMatchObject({
    code: 'logger.files.snapshot_failed',
  });
  expect(f.store.getStatus().lastFailure).toBeUndefined();
  f.io.remove = remove;
  await file.release();
  expect(f.snapshotNames()).toEqual([]);
  expect(f.sourceText()).toBe(entry('source').line);
});
