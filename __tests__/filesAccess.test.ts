import { createLogFileStore } from '../src/files/createLogFileStore';
import type { LogFileStore } from '../src/files/types';
import { createMemoryIO, deferred, entry } from './filesFixture';

describe('快照的受控读取', () => {
  const stores: LogFileStore[] = [];
  let sequence = 0;

  function setup() {
    const disk = createMemoryIO();
    const store = createLogFileStore({
      io: disk.io,
      createId: () => `opaque-${++sequence}`,
      now: () => 1_750_000_000_000,
    });
    stores.push(store);
    return { ...disk, store };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    stores.splice(0).forEach((store) => store.dispose());
    jest.useRealTimers();
  });

  test('公开快照只含不透明 ID、字节和 epoch，通过受控读取取得隔离的 JSONL', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('at-snapshot'));
    const snapshot = await disk.store.createSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual([
      'bytes',
      'id',
      'identityEpoch',
    ]);
    expect(disk.files.has(snapshot.id)).toBe(false);
    expect(snapshot.id).not.toContain('.jsonl');
    expect(snapshot.id).not.toContain('/');
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('at-snapshot').line,
    );
    disk.store.append(entry('later'));
    await disk.store.flush();
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('at-snapshot').line,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('复制对象、伪造 ID 和其他实例的真实句柄都不能触发读取', async () => {
    const disk = setup();
    const other = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    await other.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('private'));
    const snapshot = await disk.store.createSnapshot();
    const before = disk.operations.length;
    await expect(
      disk.store.readSnapshot({ ...snapshot }),
    ).rejects.toMatchObject({ code: 'logger.files.snapshot_invalid' });
    await expect(
      disk.store.readSnapshot({ ...snapshot, id: '/outside/private.jsonl' }),
    ).rejects.toMatchObject({ code: 'logger.files.snapshot_invalid' });
    await expect(other.store.readSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.operations).toHaveLength(before);
  });

  test('释放后读取旧句柄被拒绝，不通过路径重新打开文件', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('private'));
    const snapshot = await disk.store.createSnapshot();
    await disk.store.releaseSnapshot(snapshot);
    const before = disk.operations.length;
    await expect(disk.store.readSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.operations).toHaveLength(before);
    expect(disk.sourceText()).toBe(entry('private').line);
  });

  test('切身份与 A-B-A 后都不能读取原快照，旧持久文件仍保留', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('private-a'));
    const snapshot = await disk.store.createSnapshot();
    await disk.store.setOwner('hash-b', 'epoch-b');
    await expect(disk.store.readSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    await disk.store.setOwner('hash-a', 'epoch-a2');
    await expect(disk.store.readSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.snapshotNames()).toHaveLength(1);
    expect(disk.sourceText()).toBe(entry('private-a').line);
  });

  test.each([
    ['owner', 'logger.files.identity_changed'],
    ['release', 'logger.files.snapshot_invalid'],
    ['dispose', 'logger.files.disposed'],
  ])('读取 IO 进行中发生 %s 时拒绝交付旧内容', async (transition, code) => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('private-a'));
    const snapshot = await disk.store.createSnapshot();
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'read') {
        started.resolve();
        await finish.promise;
      }
    };
    const reading = disk.store.readSnapshot(snapshot).catch((error) => error);
    await started.promise;
    let changed: Promise<void>;
    if (transition === 'owner') {
      changed = disk.store.setOwner('hash-b', 'epoch-b');
    } else if (transition === 'release') {
      changed = disk.store.releaseSnapshot(snapshot);
    } else {
      disk.store.dispose();
      changed = Promise.resolve();
    }
    finish.resolve();
    await changed;
    expect(await reading).toMatchObject({ code });
  });

  test('显式读取失败报告健康状态，当前有效句柄可再次读取', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('private'));
    const snapshot = await disk.store.createSnapshot();
    disk.control.before = async (operation) => {
      if (operation === 'read') {
        throw new Error('temporary read failure');
      }
    };
    await expect(disk.store.readSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    expect(disk.store.getStatus().lastFailureCode).toBe(
      'logger.files.snapshot_failed',
    );
    disk.control.before = undefined;
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('private').line,
    );
  });
});
