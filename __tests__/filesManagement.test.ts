import { createLogFileStore } from '../src/files';
import type { LogFileStore } from '../src/files';
import {
  createMemoryIO,
  deferred,
  entry,
  snapshotName,
  sourceName,
} from './filesFixture';

describe('日志文件摘要与明确清理', () => {
  const stores: LogFileStore[] = [];

  function setup(initial: Record<string, string> = {}) {
    const disk = createMemoryIO(initial);
    const store = createLogFileStore({
      io: disk.io,
      now: () => 1_750_000_000_000,
      createId: () => 'management',
    });
    stores.push(store);
    return { ...disk, store };
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    stores.splice(0).forEach((store) => store.dispose());
    jest.useRealTimers();
  });

  test('摘要只读当前分区源文件实际字节，不触发刷新、快照或清理', async () => {
    const disk = setup({
      [sourceName('hash-a', 'one')]: '中文',
      [sourceName('hash-a', 'two')]: 'abc',
      [sourceName('hash-b')]: 'other',
      [sourceName(null)]: 'anonymous',
      [snapshotName('hash-a')]: 'snapshot',
      'unrelated.txt': 'unrelated',
    });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('buffered'));
    disk.operations.length = 0;
    await expect(disk.store.readSummary()).resolves.toEqual({
      fileCount: 2,
      bytes: 9,
    });
    expect(disk.operations).toEqual([{ operation: 'list' }]);
    expect(disk.store.getStatus().bufferedBytes).toBe(entry('buffered').bytes);
  });

  test('匿名分区只读自身，没有文件返回零', async () => {
    const disk = setup({ [sourceName('hash-a')]: 'private' });
    await disk.store.setOwner(null, 'anonymous');
    await expect(disk.store.readSummary()).resolves.toEqual({
      fileCount: 0,
      bytes: 0,
    });
    disk.files.set(sourceName(null), 'abc');
    await expect(disk.store.readSummary()).resolves.toEqual({
      fileCount: 1,
      bytes: 3,
    });
  });

  test('摘要读取失败拒绝，清理范围准备失败保留源文件和待写内容', async () => {
    const name = sourceName('hash-a');
    const disk = setup({ [name]: 'private' });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('buffered'));
    disk.control.before = async (operation) => {
      if (operation === 'list') throw new Error('private/path: unreadable');
    };
    await expect(disk.store.readSummary()).rejects.toMatchObject({
      code: 'logger.files.summary_failed',
    });
    await expect(disk.store.clear()).resolves.toMatchObject({
      status: 'failed',
      code: 'logger.files.cleanup_failed',
    });
    expect(disk.files.get(name)).toBe('private');
    expect(disk.store.getStatus().bufferedBytes).toBe(entry('buffered').bytes);
    expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
      false,
    );
  });

  test('未绑定与绑定过程中不能接受管理操作', async () => {
    const disk = setup();
    await expect(disk.store.readSummary()).rejects.toMatchObject({
      code: 'logger.files.not_ready',
    });
    await expect(disk.store.clear()).resolves.toMatchObject({
      status: 'failed',
      code: 'logger.files.not_ready',
    });
    expect(disk.operations).toEqual([]);
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'ensureRoot') await finish.promise;
    };
    const binding = disk.store.setOwner('hash-a', 'epoch-a');
    await expect(disk.store.readSummary()).rejects.toMatchObject({
      code: 'logger.files.not_ready',
    });
    await expect(disk.store.clear()).resolves.toMatchObject({
      status: 'failed',
      code: 'logger.files.not_ready',
    });
    finish.resolve();
    await binding;
  });

  test('写入受阻仍按实际 I/O 读取与清理，清理不声称写入已恢复', async () => {
    const name = sourceName('hash-a');
    const disk = setup({ [name]: 'abc' });
    disk.control.before = async (operation) => {
      if (operation === 'ensureRoot') throw new Error('mkdir blocked');
    };
    await disk.store.setOwner('hash-a', 'epoch-a');
    expect(disk.store.getStatus().state).toBe('blocked');
    await expect(disk.store.readSummary()).resolves.toEqual({
      fileCount: 1,
      bytes: 3,
    });
    await expect(disk.store.clear()).resolves.toEqual({ status: 'success' });
    expect(disk.files.has(name)).toBe(false);
    expect(disk.store.getStatus().writable).toBe(false);
    disk.control.before = undefined;
    disk.store.append(entry('after'));
    await disk.store.flush();
    expect(disk.sourceText()).toBe(entry('after').line);
    expect(disk.store.getStatus().writable).toBe(true);
  });

  test.each(['readSummary', 'clear'] as const)(
    '%s 排队期间切身份失败，不操作新身份',
    async (method) => {
      const disk = setup({ [sourceName('hash-b')]: 'other' });
      await disk.store.setOwner('hash-a', 'epoch-a');
      const started = deferred();
      const finish = deferred();
      disk.control.before = async (operation) => {
        if (operation === 'append') {
          started.resolve();
          await finish.promise;
        }
      };
      disk.store.append(entry('writing'));
      const flushing = disk.store.flush();
      await started.promise;
      const managing = disk.store[method]().catch((error) => error);
      const changed = disk.store.setOwner('hash-b', 'epoch-b');
      finish.resolve();
      await flushing;
      const result = await managing;
      await changed;
      expect(result).toMatchObject({ code: 'logger.files.identity_changed' });
      expect(disk.files.get(sourceName('hash-b'))).toBe('other');
      expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
        false,
      );
    },
  );

  test.each(['readSummary', 'clear'] as const)(
    '%s 目录读取中 A-B-A 切换拒绝原结果',
    async (method) => {
      const disk = setup({ [sourceName('hash-a')]: 'private' });
      await disk.store.setOwner('hash-a', 'epoch-a');
      const started = deferred();
      const finish = deferred();
      disk.control.before = async (operation) => {
        if (operation === 'list') {
          started.resolve();
          await finish.promise;
        }
      };
      const managing = disk.store[method]().catch((error) => error);
      await started.promise;
      const changed = disk.store.setOwner('hash-b', 'epoch-b');
      const restored = disk.store.setOwner('hash-a', 'epoch-a2');
      finish.resolve();
      expect(await managing).toMatchObject({
        code: 'logger.files.identity_changed',
      });
      await Promise.all([changed, restored]);
      expect(disk.files.get(sourceName('hash-a'))).toBe('private');
      expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
        false,
      );
    },
  );

  test('清理仅移除当前分区源文件与当次待写内容，保留其他分区和快照', async () => {
    const disk = setup({
      [sourceName('hash-a')]: 'private',
      [sourceName('hash-b')]: 'other',
      [sourceName(null)]: 'anonymous',
      [snapshotName('hash-a')]: 'snapshot',
    });
    const startup = entry('boot', 'startup', 'info', true);
    disk.store.append(startup);
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('discard'));
    const dropped = disk.store.getStatus().droppedCount;
    await expect(disk.store.clear()).resolves.toEqual({ status: 'success' });
    expect(disk.files).toEqual(
      new Map([
        [sourceName('hash-b'), 'other'],
        [sourceName(null), 'anonymous'],
        [snapshotName('hash-a'), 'snapshot'],
      ]),
    );
    expect(disk.store.getStatus()).toMatchObject({
      bufferedBytes: startup.bytes,
      droppedCount: dropped,
    });
    await disk.store.flush();
    expect(disk.sourceText()).toContain(startup.line);
    expect(disk.sourceText()).not.toContain('discard');
  });

  test('清理范围确定后新日志与新源文件保留，活动段可以继续记录', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('before'));
    await disk.store.flush();
    disk.store.append(entry('discard'));
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'remove') {
        started.resolve();
        await finish.promise;
      }
    };
    const clearing = disk.store.clear();
    await started.promise;
    disk.store.append(entry('during'));
    disk.files.set(sourceName('hash-a', 'new-external'), 'external');
    finish.resolve();
    await expect(clearing).resolves.toEqual({ status: 'success' });
    expect(disk.store.getStatus()).toMatchObject({
      bufferedBytes: entry('during').bytes,
      droppedCount: 0,
    });
    disk.store.append(entry('after'));
    await disk.store.flush();
    expect(disk.sourceText()).toContain('external');
    expect(disk.sourceText()).toContain(
      entry('during').line + entry('after').line,
    );
    expect(disk.sourceText()).not.toContain('before');
    expect(disk.sourceText()).not.toContain('discard');
  });

  test('部分删除失败继续处理当次其他文件，只统计选定文件', async () => {
    const disk = setup({
      [sourceName('hash-a', 'one')]: 'one',
      [sourceName('hash-a', 'two')]: 'two',
      [sourceName('hash-b')]: 'other',
    });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.control.before = async (operation, name) => {
      if (operation === 'remove' && name === sourceName('hash-a', 'one')) {
        disk.files.set(sourceName('hash-a', 'new'), 'new');
        throw new Error('/private/path');
      }
    };
    await expect(disk.store.clear()).resolves.toEqual({
      status: 'partial',
      removedFiles: 1,
      remainingFiles: 1,
      message: expect.any(String),
    });
    expect(disk.files.get(sourceName('hash-a', 'one'))).toBe('one');
    expect(disk.files.has(sourceName('hash-a', 'two'))).toBe(false);
    expect(disk.files.get(sourceName('hash-a', 'new'))).toBe('new');
  });

  test('删除中切身份停止后续删除，准确保留已完成数量', async () => {
    const disk = setup({
      [sourceName('hash-a', 'one')]: 'one',
      [sourceName('hash-a', 'two')]: 'two',
      [sourceName('hash-b')]: 'other',
    });
    await disk.store.setOwner('hash-a', 'epoch-a');
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'remove') {
        started.resolve();
        await finish.promise;
      }
    };
    const clearing = disk.store.clear();
    await started.promise;
    const changed = disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('new-owner', 'epoch-b'));
    finish.resolve();
    await expect(clearing).resolves.toMatchObject({
      status: 'partial',
      removedFiles: 1,
      remainingFiles: 1,
    });
    await changed;
    expect(
      disk.operations.filter((item) => item.operation === 'remove'),
    ).toHaveLength(1);
    expect(disk.files.get(sourceName('hash-b'))).toBe('other');
    expect(disk.store.getStatus().bufferedBytes).toBe(
      entry('new-owner', 'epoch-b').bytes,
    );
  });

  test('已释放实例明确失败，不再执行 I/O', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.dispose();
    disk.operations.length = 0;
    await expect(disk.store.readSummary()).rejects.toMatchObject({
      code: 'logger.files.disposed',
    });
    await expect(disk.store.clear()).resolves.toMatchObject({
      status: 'failed',
      code: 'logger.files.disposed',
    });
    expect(disk.operations).toEqual([]);
  });
});
