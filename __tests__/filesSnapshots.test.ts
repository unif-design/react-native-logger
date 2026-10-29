import { Buffer } from 'buffer';
import { createLogFileStore } from '../src/files/createLogFileStore';
import type { LogFileStore, LogFileStoreOptions } from '../src/files/types';
import {
  createMemoryIO,
  deferred,
  entry,
  sourceName,
  snapshotName,
} from './filesFixture';

describe('日志快照的身份与资源归属', () => {
  const stores: LogFileStore[] = [];
  let sequence = 0;

  function setup(
    initial: Record<string, string> = {},
    limits: LogFileStoreOptions['limits'] = {},
  ) {
    const disk = createMemoryIO(initial);
    const store = createLogFileStore({
      io: disk.io,
      createId: () => `snapshot-id-${++sequence}`,
      now: () => 1_750_000_000_000,
      limits,
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

  test('快照先 flush 当前队列，跳过损坏行和不完整尾行，源文件保持原样', async () => {
    const history =
      entry('history', 'old-epoch').line +
      '{bad}\n' +
      '{"validButIncomplete":true}';
    const disk = setup({
      [sourceName('hash-a')]: history,
      [sourceName('hash-b')]: entry('other-private', 'epoch-b').line,
      [snapshotName('hash-a', 'abandoned', 1_749_000_000_000)]: 'old-snapshot',
    });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('current'));
    const snapshot = await disk.store.createSnapshot();
    const expected = entry('history', 'old-epoch').line + entry('current').line;
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(expected);
    expect(snapshot).toMatchObject({
      bytes: Buffer.byteLength(expected, 'utf8'),
      identityEpoch: 'epoch-a',
    });
    expect(disk.files.get(sourceName('hash-a'))).toBe(history);
    expect(
      disk.files.has(snapshotName('hash-a', 'abandoned', 1_749_000_000_000)),
    ).toBe(false);
    expect(disk.store.getStatus().corruptedLines).toBe(2);
    await disk.store.releaseSnapshot(snapshot);
    expect(disk.snapshotNames()).toEqual([]);
    expect(disk.files.get(sourceName('hash-a'))).toBe(history);
    expect(disk.files.get(sourceName('hash-b'))).toBe(
      entry('other-private', 'epoch-b').line,
    );
  });

  test('只接受本实例创建的快照对象，伪造或已释放对象不触发删除', async () => {
    const disk = setup();
    const other = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    await other.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('source'));
    const snapshot = await disk.store.createSnapshot();
    const before = disk.operations.length;
    await expect(
      disk.store.releaseSnapshot({ ...snapshot }),
    ).rejects.toMatchObject({ code: 'logger.files.snapshot_invalid' });
    await expect(
      disk.store.releaseSnapshot({ ...snapshot, id: '/outside/private' }),
    ).rejects.toMatchObject({ code: 'logger.files.snapshot_invalid' });
    await expect(other.store.releaseSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.operations).toHaveLength(before);
    expect(Object.isFrozen(snapshot)).toBe(true);
    await disk.store.releaseSnapshot(snapshot);
    await expect(disk.store.releaseSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.sourceText()).toBe(entry('source').line);
  });

  test('快照读取中切身份拒绝旧结果，后续快照仅含新 owner', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('old'));
    await disk.store.flush();
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation, name) => {
      if (
        operation === 'read' &&
        name?.includes('-logs-') &&
        !name.includes('-logs-snapshot-')
      ) {
        started.resolve();
        await finish.promise;
      }
    };
    const pending = disk.store.createSnapshot().catch((error) => error);
    await started.promise;
    const switching = disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('new', 'epoch-b'));
    finish.resolve();
    await switching;
    expect(await pending).toMatchObject({
      code: 'logger.files.identity_changed',
    });
    const snapshot = await disk.store.createSnapshot();
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('new', 'epoch-b').line,
    );
    expect(disk.snapshotNames()).toHaveLength(1);
  });

  test('快照写入途中切身份拒绝旧句柄，旧分区源文件和快照保留', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('old'));
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation, name) => {
      if (operation === 'write' && name?.includes('-logs-snapshot-')) {
        started.resolve();
        await finish.promise;
      }
    };
    const pending = disk.store.createSnapshot().catch((error) => error);
    await started.promise;
    const switching = disk.store.setOwner('hash-b', 'epoch-b');
    finish.resolve();
    await switching;
    expect(await pending).toMatchObject({
      code: 'logger.files.identity_changed',
    });
    expect(disk.snapshotNames()).toHaveLength(1);
    expect(disk.sourceText()).toBe(entry('old').line);
  });

  test('切换再回同 owner 与 dispose 都使原快照对象失效', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    const first = await disk.store.createSnapshot();
    await disk.store.setOwner('hash-b', 'epoch-b');
    await disk.store.setOwner('hash-a', 'epoch-a2');
    await expect(disk.store.releaseSnapshot(first)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    const current = await disk.store.createSnapshot();
    disk.store.dispose();
    await expect(disk.store.releaseSnapshot(current)).rejects.toMatchObject({
      code: 'logger.files.disposed',
    });
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.disposed',
    });
  });

  test('显式快照写失败拒绝并报告健康状态，释放失败可重试且不删源文件', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('source'));
    disk.control.before = async (operation, name) => {
      if (operation === 'write' && name?.includes('-logs-snapshot-')) {
        throw new Error('full disk');
      }
    };
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    expect(disk.store.getStatus().lastFailureCode).toBe(
      'logger.files.snapshot_failed',
    );
    expect(disk.sourceText()).toBe(entry('source').line);
    disk.control.before = undefined;
    const snapshot = await disk.store.createSnapshot();
    disk.control.before = async (operation) => {
      if (operation === 'remove') {
        throw new Error('remove failed');
      }
    };
    await expect(disk.store.releaseSnapshot(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    disk.control.before = undefined;
    await disk.store.releaseSnapshot(snapshot);
    expect(disk.sourceText()).toBe(entry('source').line);
  });

  test('同 owner 从轮转阻断恢复时保留本实例持有的有效快照', async () => {
    const disk = setup({}, { fileCount: 1, fileBytes: 60 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('first'));
    const snapshot = await disk.store.createSnapshot();
    disk.control.before = async (operation, target) => {
      if (
        operation === 'remove' &&
        target?.includes('-logs-') &&
        !target.includes('-logs-snapshot-')
      ) {
        throw new Error('cannot rotate');
      }
    };
    disk.store.append(entry('next'));
    await disk.store.flush();
    expect(disk.store.getStatus().state).toBe('blocked');
    disk.control.before = undefined;
    await disk.store.setOwner('hash-a', 'epoch-a');
    await disk.store.flush();
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('first').line,
    );
    await expect(disk.store.releaseSnapshot(snapshot)).resolves.toBeUndefined();
    expect(disk.sourceText()).toBe(entry('next').line);
  });

  test('快照部分写入后失败时清掉临时产物，源日志不受影响', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('source'));
    disk.control.before = async (operation, name) => {
      if (operation === 'write' && name?.includes('-logs-snapshot-')) {
        disk.files.set(name, 'partial snapshot');
        throw new Error('write failed after partial data');
      }
    };
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    expect(disk.snapshotNames()).toEqual([]);
    expect(disk.sourceText()).toBe(entry('source').line);
  });

  test('快照前的源日志 flush 失败同时反映文件不可写', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('pending'));
    disk.control.before = async (operation) => {
      if (operation === 'append') {
        throw new Error('cannot append');
      }
    };
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    expect(disk.store.getStatus()).toMatchObject({
      writable: false,
      lastFailureCode: 'logger.files.write_failed',
    });
    expect(disk.snapshotNames()).toEqual([]);
  });

  test('全 App 快照数量有上限，满额时不删除已持有快照或源文件', async () => {
    const disk = setup({}, { fileCount: 2 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('a'));
    const first = await disk.store.createSnapshot();
    const second = await disk.store.createSnapshot();
    const before = disk.sourceText();
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_limit',
    });
    expect(disk.snapshotNames()).toHaveLength(2);
    expect(disk.sourceText()).toBe(before);
    await disk.store.releaseSnapshot(first);
    await expect(disk.store.createSnapshot()).resolves.toMatchObject({
      identityEpoch: 'epoch-a',
    });
    await expect(disk.store.readSnapshot(second)).resolves.toBe(
      entry('a').line,
    );
  });

  test('旧分区快照占用同一个上限，过期未持有快照可回收', async () => {
    const old = snapshotName('hash-b', 'expired', 1_749_000_000_000);
    const disk = setup({ [old]: 'old snapshot' }, { fileCount: 1 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const first = await disk.store.createSnapshot();
    expect(disk.files.has(old)).toBe(false);
    await disk.store.setOwner('hash-b', 'epoch-b');
    await expect(disk.store.releaseSnapshot(first)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    await expect(disk.store.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_limit',
    });
    expect(disk.snapshotNames()).toHaveLength(1);
  });
});
