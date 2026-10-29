import { createLogFileStore } from '../src/files';
import type { LogFileStore } from '../src/files';
import { createMemoryIO, deferred, entry, sourceName } from './filesFixture';

const stores: LogFileStore[] = [];
function setup(initial: Record<string, string> = {}) {
  const disk = createMemoryIO(initial);
  const store = createLogFileStore({
    io: disk.io,
    now: () => 1_750_000_000_000,
    createId: () => 'boundary',
  });
  stores.push(store);
  return { ...disk, store };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  jest.useRealTimers();
});

test.each([-1, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  '文件摘要拒绝外部IO的非法大小 %s',
  async (bytes) => {
    const f = setup();
    await f.store.setOwner('hash-a', 'epoch-a');
    f.io.list = async () => [
      { name: sourceName('hash-a'), bytes, modifiedAt: 1_750_000_000_000 },
    ];
    await expect(f.store.readSummary()).rejects.toMatchObject({
      code: 'logger.files.summary_failed',
    });
    expect(
      f.operations.some((operation) => operation.operation === 'remove'),
    ).toBe(false);
  },
);

test('每个文件大小有效但总和溢出时不能返回失真摘要', async () => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.io.list = async () =>
    ['one', 'two'].map((suffix) => ({
      name: sourceName('hash-a', suffix),
      bytes: Number.MAX_SAFE_INTEGER,
      modifiedAt: 1_750_000_000_000,
    }));
  await expect(f.store.readSummary()).rejects.toMatchObject({
    code: 'logger.files.summary_failed',
  });
});

test('未绑定实例不能生成快照，flush保持无副作用', async () => {
  const f = setup();
  await f.store.flush();
  await expect(f.store.createSnapshot()).rejects.toMatchObject({
    code: 'logger.files.not_ready',
  });
  expect(f.operations).toEqual([]);
});

test('实际快照跳过非对象和超限记录，仅交付有效完整行', async () => {
  const valid = entry('valid').line;
  const f = setup({
    [sourceName('hash-a')]:
      `null\n[]\ntrue\n${JSON.stringify({ text: 'x'.repeat(9000) })}\n${valid}`,
  });
  await f.store.setOwner('hash-a', 'epoch-a');
  const snapshot = await f.store.createSnapshot();
  expect(await f.store.readSnapshot(snapshot)).toBe(valid);
  expect(f.store.getStatus().corruptedLines).toBe(4);
  await f.store.releaseSnapshot(snapshot);
});

test.each([
  { uri: 'content://not-a-file', bytes: 1 },
  { uri: 'file:///virtual/snapshot', bytes: -1 },
])('快照外部文件引用无效时保留原快照可重试（%j）', async (reference) => {
  const f = setup();
  await f.store.setOwner('hash-a', 'epoch-a');
  f.store.append(entry('source'));
  const snapshot = await f.store.createSnapshot();
  const original = f.io.getFile;
  f.io.getFile = async () => reference;
  await expect(f.store.takeSnapshotFile(snapshot)).rejects.toMatchObject({
    code: 'logger.files.snapshot_failed',
  });
  f.io.getFile = original;
  expect(await f.store.readSnapshot(snapshot)).toBe(entry('source').line);
  await f.store.releaseSnapshot(snapshot);
});

test('快照等待IO时销毁实例，已排队flush不再写旧身份', async () => {
  const f = setup({ [sourceName('hash-a')]: entry('source').line });
  await f.store.setOwner('hash-a', 'epoch-a');
  const started = deferred(),
    finish = deferred();
  f.control.before = async (operation) => {
    if (operation === 'read') {
      started.resolve();
      await finish.promise;
    }
  };
  const snapshot = f.store.createSnapshot();
  const settled = snapshot.catch((error: unknown) => error);
  await started.promise;
  const flushed = f.store.flush();
  f.store.dispose();
  finish.resolve();
  await expect(settled).resolves.toMatchObject({
    code: 'logger.files.disposed',
  });
  await expect(flushed).resolves.toBeUndefined();
  expect(f.store.getStatus().state).toBe('disposed');
  expect(
    f.operations.some((operation) => operation.operation === 'append'),
  ).toBe(false);
});
