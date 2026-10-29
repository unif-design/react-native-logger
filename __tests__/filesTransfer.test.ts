import { createLogFileStore } from '../src/files';
import type { LogFileStore, LogFileStoreOptions } from '../src/files';
import type { LogSnapshotFile } from '../src/types';
import {
  createMemoryIO,
  deferred,
  entry,
  sourceName,
  snapshotName,
} from './filesFixture';

describe('日志快照文件交付与持有保护', () => {
  const stores: LogFileStore[] = [];
  const held: LogSnapshotFile[] = [];
  const disks: ReturnType<typeof createMemoryIO>[] = [];
  let sequence = 0;

  function setup(limits: LogFileStoreOptions['limits'] = {}) {
    const disk = createMemoryIO();
    disks.push(disk);
    function install() {
      const store = createLogFileStore({
        io: disk.io,
        createId: () => `transfer-${++sequence}`,
        now: Date.now,
        limits,
      });
      stores.push(store);
      return store;
    }
    return { ...disk, store: install(), install };
  }

  async function take(store: LogFileStore) {
    const snapshot = await store.createSnapshot();
    const file = await store.takeSnapshotFile(snapshot);
    held.push(file);
    return { snapshot, file };
  }

  beforeEach(() => jest.useFakeTimers().setSystemTime(1_750_000_000_000));
  afterEach(async () => {
    stores.splice(0).forEach((store) => store.dispose());
    disks.splice(0).forEach((disk) => {
      disk.control.before = undefined;
    });
    await Promise.all(
      held.splice(0).map((file) => file.release().catch(() => undefined)),
    );
    jest.useRealTimers();
  });

  test('直接交付已有独占快照与实际大小，不读全文或复制，原句柄失效', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('中文'));
    const snapshot = await disk.store.createSnapshot();
    const name = disk.snapshotNames()[0];
    const before = new Map(disk.files);
    disk.operations.length = 0;
    const file = await disk.store.takeSnapshotFile(snapshot);
    held.push(file);
    expect(file).toMatchObject({
      uri: `file:///virtual/logs/${name}`,
      bytes: entry('中文').bytes,
    });
    expect(Object.isFrozen(file)).toBe(true);
    expect(disk.operations).toEqual([{ operation: 'getFile', name }]);
    expect(disk.files).toEqual(before);
    for (const method of [
      'readSnapshot',
      'releaseSnapshot',
      'takeSnapshotFile',
    ] as const) {
      await expect(disk.store[method](snapshot)).rejects.toMatchObject({
        code: 'logger.files.snapshot_invalid',
      });
    }
    expect(disk.operations).toHaveLength(1);
  });

  test('空快照可以交付，实际文件字节不使用原句柄的缓存数值代替', async () => {
    const disk = setup();
    await disk.store.setOwner(null, 'epoch-a');
    const empty = await take(disk.store);
    expect(empty.file.bytes).toBe(0);
    const snapshot = await disk.store.createSnapshot();
    const name = disk
      .snapshotNames()
      .find((value) => !empty.file.uri.endsWith(value))!;
    disk.files.set(name, 'changed bytes');
    const file = await disk.store.takeSnapshotFile(snapshot);
    held.push(file);
    expect(file.bytes).toBe(13);
  });

  test('伪造对象、其他实例和 A-B-A 旧周期不能取得文件，不进行 I/O', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    const snapshot = await disk.store.createSnapshot();
    const other = disk.install();
    await other.setOwner('hash-a', 'epoch-a');
    disk.operations.length = 0;
    await expect(
      disk.store.takeSnapshotFile({ ...snapshot }),
    ).rejects.toMatchObject({ code: 'logger.files.snapshot_invalid' });
    await expect(other.takeSnapshotFile(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.operations).toEqual([]);
    await disk.store.setOwner('hash-b', 'epoch-b');
    await disk.store.setOwner('hash-a', 'epoch-a2');
    disk.operations.length = 0;
    await expect(disk.store.takeSnapshotFile(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_invalid',
    });
    expect(disk.operations).toEqual([]);
  });

  test('交付途中锁定原句柄，防止重入交付或抢先释放', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    const snapshot = await disk.store.createSnapshot();
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'getFile') {
        started.resolve();
        await finish.promise;
      }
    };
    const pending = disk.store.takeSnapshotFile(snapshot);
    await started.promise;
    for (const method of [
      'takeSnapshotFile',
      'readSnapshot',
      'releaseSnapshot',
    ] as const) {
      await expect(disk.store[method](snapshot)).rejects.toMatchObject({
        code: 'logger.files.snapshot_invalid',
      });
    }
    finish.resolve();
    held.push(await pending);
    expect(
      disk.operations.filter((item) => item.operation === 'getFile'),
    ).toHaveLength(1);
  });

  test.each(['owner', 'dispose'])(
    '交付元数据读取期间 %s 失效，拒绝交付旧 URI',
    async (transition) => {
      const disk = setup();
      await disk.store.setOwner('hash-a', 'epoch-a');
      const snapshot = await disk.store.createSnapshot();
      const started = deferred();
      const finish = deferred();
      disk.control.before = async (operation) => {
        if (operation === 'getFile') {
          started.resolve();
          await finish.promise;
        }
      };
      const pending = disk.store
        .takeSnapshotFile(snapshot)
        .catch((error) => error);
      await started.promise;
      const changing =
        transition === 'owner'
          ? disk.store.setOwner('hash-b', 'epoch-b')
          : (disk.store.dispose(), Promise.resolve());
      finish.resolve();
      expect(await pending).toMatchObject({
        code:
          transition === 'owner'
            ? 'logger.files.identity_changed'
            : 'logger.files.disposed',
      });
      await changing;
      expect(disk.snapshotNames()).toHaveLength(1);
    },
  );

  test('文件引用取得失败保留原句柄及内容，可读取或按原接口释放', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('kept'));
    const snapshot = await disk.store.createSnapshot();
    disk.control.before = async (operation) => {
      if (operation === 'getFile') throw new Error('file:///private/sensitive');
    };
    await expect(disk.store.takeSnapshotFile(snapshot)).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
      message: 'logger.files.snapshot_failed',
    });
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('kept').line,
    );
    await disk.store.releaseSnapshot(snapshot);
    expect(disk.snapshotNames()).toEqual([]);
    expect(disk.sourceText()).toBe(entry('kept').line);
  });

  test('交付后换身份并释放安装，文件 release 仍只删除自己的快照', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('a'));
    const { file } = await take(disk.store);
    await disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('b', 'epoch-b'));
    const other = await take(disk.store);
    disk.store.dispose();
    await file.release();
    expect(disk.snapshotNames()).toEqual([
      decodeURIComponent(other.file.uri.split('/').pop()!),
    ]);
    expect(disk.sourceText()).toContain(entry('a').line);
    expect(disk.sourceText()).toContain(entry('b', 'epoch-b').line);
  });

  test('并发 release 共用一次删除，成功后重复调用无额外 I/O', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    const { file } = await take(disk.store);
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'remove') {
        started.resolve();
        await finish.promise;
      }
    };
    const first = file.release();
    const second = file.release();
    expect(first).toBe(second);
    await started.promise;
    finish.resolve();
    await Promise.all([first, second]);
    const before = disk.operations.length;
    await file.release();
    expect(disk.operations).toHaveLength(before);
    expect(disk.snapshotNames()).toEqual([]);
  });

  test('释放失败保留持有保护，跨安装过期回收不能删除，原持有者可再次释放', async () => {
    const disk = setup({ maxAgeMs: 1000 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const { file } = await take(disk.store);
    disk.control.before = async (operation) => {
      if (operation === 'remove') throw new Error('busy');
    };
    await expect(file.release()).rejects.toMatchObject({
      code: 'logger.files.snapshot_failed',
    });
    disk.control.before = undefined;
    disk.store.dispose();
    jest.setSystemTime(1_750_000_002_000);
    const next = disk.install();
    await next.setOwner('hash-b', 'epoch-b');
    expect(disk.snapshotNames()).toHaveLength(1);
    await file.release();
    expect(disk.snapshotNames()).toEqual([]);
  });

  test('同根新实例保留在用快照，过期未持有文件仍回收，清理源日志不影响快照', async () => {
    const disk = setup({ maxAgeMs: 1000 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const { file } = await take(disk.store);
    disk.files.set(snapshotName('hash-b', 'abandoned'), 'abandoned');
    disk.store.dispose();
    jest.setSystemTime(1_750_000_002_000);
    const next = disk.install();
    await next.setOwner('hash-a', 'epoch-a2');
    expect(disk.snapshotNames()).toEqual([
      decodeURIComponent(file.uri.split('/').pop()!),
    ]);
    disk.files.set(
      sourceName('hash-a', 'current', Date.now()),
      entry('new', 'epoch-a2').line,
    );
    await next.clear();
    expect(disk.snapshotNames()).toHaveLength(1);
    expect(disk.sourceNames()).toHaveLength(0);
  });

  test('同根全部在用快照仍占数量预算，新实例不能删除它们腾位置', async () => {
    const disk = setup({ fileCount: 1, maxAgeMs: 1000 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const { file } = await take(disk.store);
    disk.store.dispose();
    jest.setSystemTime(1_750_000_002_000);
    const next = disk.install();
    await next.setOwner('hash-b', 'epoch-b');
    await expect(next.createSnapshot()).rejects.toMatchObject({
      code: 'logger.files.snapshot_limit',
    });
    expect(disk.snapshotNames()).toHaveLength(1);
    await file.release();
    await expect(next.createSnapshot()).resolves.toMatchObject({
      bytes: 0,
      identityEpoch: 'epoch-b',
    });
  });

  test('同根并发快照创建串行核对全局数量预算，不能各自占满一份预算', async () => {
    const disk = setup({ fileCount: 1 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const other = disk.install();
    await other.setOwner('hash-b', 'epoch-b');
    const results = await Promise.allSettled([
      disk.store.createSnapshot(),
      other.createSnapshot(),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: { code: 'logger.files.snapshot_limit' },
    });
    expect(disk.snapshotNames()).toHaveLength(1);
  });

  test('已交付文件意外缺失时仍保留名称，旧 release 不能误删新快照', async () => {
    const disk = createMemoryIO();
    disks.push(disk);
    function install() {
      const store = createLogFileStore({
        io: disk.io,
        createId: () => 'same-id',
        now: Date.now,
        limits: { fileCount: 2 },
      });
      stores.push(store);
      return store;
    }
    const previous = install();
    await previous.setOwner('hash-a', 'epoch-a');
    const first = await take(previous);
    disk.files.delete(decodeURIComponent(first.file.uri.split('/').pop()!));
    previous.dispose();
    const next = install();
    await next.setOwner('hash-a', 'epoch-a2');
    const second = await take(next);
    expect(second.file.uri).not.toBe(first.file.uri);
    await first.file.release();
    expect(disk.snapshotNames()).toEqual([
      decodeURIComponent(second.file.uri.split('/').pop()!),
    ]);
  });
});
