import { Buffer } from 'buffer';
import { createLogFileStore } from '../src/files/createLogFileStore';
import type { LogFileStore, LogFileStoreOptions } from '../src/files/types';
import {
  createMemoryIO,
  deferred,
  entry,
  partition,
  sourceName,
} from './filesFixture';

describe('日志分区、队列与保留策略', () => {
  const stores: LogFileStore[] = [];
  let sequence = 0;

  function setup(
    initial: Record<string, string> = {},
    limits: LogFileStoreOptions['limits'] = {},
  ) {
    const disk = createMemoryIO(initial);
    let time = 1_750_000_000_000;
    const store = createLogFileStore({
      io: disk.io,
      now: () => time,
      createId: () => `id-${++sequence}`,
      limits,
    });
    stores.push(store);
    return {
      ...disk,
      store,
      textFor: (owner: string | null) =>
        [...disk.files]
          .filter(
            ([name]) =>
              name.startsWith(`${partition(owner)}-logs-`) &&
              !name.includes('-logs-snapshot-'),
          )
          .map(([, text]) => text)
          .join(''),
      advance: (milliseconds: number) => {
        time += milliseconds;
      },
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    stores.splice(0).forEach((store) => store.dispose());
    jest.useRealTimers();
  });

  test('创建和首次身份确认前不启动 IO，只接受启动行入队', async () => {
    const disk = setup();
    disk.store.append(entry('unknown'));
    const startup = entry('startup', 'anonymous-epoch', 'info', true);
    disk.store.append(startup);
    await disk.store.flush();
    expect(disk.operations).toEqual([]);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'unbound',
      writable: false,
      droppedCount: 1,
      bufferedBytes: startup.bytes,
    });
  });

  test('正式 owner 摘要原样形成 accountIdentity 摘要-logs 前缀，不能再做一次 SHA', async () => {
    const disk = setup();
    const owner = 'a'.repeat(64);
    await disk.store.setOwner(owner, 'epoch-a');
    disk.store.append(entry('current'));
    await disk.store.flush();
    expect([...disk.files.keys()]).toEqual([
      expect.stringMatching(
        new RegExp(`^${owner}-logs-1750000000000-[a-zA-Z0-9_-]+\\.jsonl$`),
      ),
    ]);
    await disk.store.createSnapshot();
    expect([...disk.files.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(
            `^${owner}-logs-snapshot-1750000000000-[a-zA-Z0-9_-]+\\.jsonl$`,
          ),
        ),
      ]),
    );
  });

  test('anonymous-logs 文件保留同一容量和期限预算', async () => {
    const disk = setup({}, { fileBytes: 100, fileCount: 1, maxAgeMs: 70 });
    await disk.store.setOwner(null, 'epoch-a');
    disk.store.append(entry('anonymous'));
    await disk.store.flush();
    const names = [...disk.files.keys()];
    expect(names).toEqual([
      expect.stringMatching(
        /^anonymous-logs-1750000000000-[a-zA-Z0-9_-]+\.jsonl$/,
      ),
    ]);
    disk.advance(71);
    await disk.store.flush();
    expect([...disk.files.keys()]).toEqual([]);
  });

  test('同用户冷启动保留历史，初始启动行固定匿名分区且 JSON epoch 原样保留', async () => {
    const history = entry('previous-run', 'previous-epoch').line;
    const disk = setup({ [sourceName('hash-a')]: history });
    const startup = entry('boot', 'anonymous-epoch', 'info', true);
    disk.store.append(startup);
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('current'));
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(history + entry('current').line);
    expect(disk.textFor(null)).toBe(startup.line);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'ready',
      writable: true,
      droppedCount: 0,
    });
  });

  test('非本模块文件不参与日志读取或保留清理', async () => {
    const disk = setup(
      {
        '../outside': 'keep',
        'unrelated.txt': 'keep',
        'metadata.json': '{}',
      },
      { maxAgeMs: 70 },
    );
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('current'));
    const snapshot = await disk.store.createSnapshot();
    await expect(disk.store.readSnapshot(snapshot)).resolves.toBe(
      entry('current').line,
    );
    disk.advance(71);
    await disk.store.flush();
    for (const name of ['../outside', 'unrelated.txt', 'metadata.json']) {
      expect(disk.files.has(name)).toBe(true);
      expect(disk.operations.some((item) => item.name === name)).toBe(false);
    }
  });

  test('文件初始化失败只阻断落盘，相同分区和 epoch 的调用可恢复', async () => {
    const disk = setup({ [sourceName('hash-a')]: entry('old').line });
    disk.control.before = async (operation) => {
      if (operation === 'list') {
        throw new Error('list denied');
      }
    };
    await expect(
      disk.store.setOwner('hash-a', 'epoch-a'),
    ).resolves.toBeUndefined();
    disk.store.append(entry('new'));
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(entry('old').line);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'blocked',
      writable: false,
      lastFailureCode: 'logger.files.initialize_failed',
    });
    disk.control.before = undefined;
    await disk.store.setOwner('hash-a', 'epoch-a');
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(entry('old').line + entry('new').line);
  });

  test('后续显式 flush 可恢复已确认分区的初始化失败，不依赖账号再次发布身份', async () => {
    const disk = setup({ [sourceName('hash-a')]: entry('history').line });
    disk.control.before = async (operation) => {
      if (operation === 'list') {
        throw new Error('temporary storage unavailable');
      }
    };
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('buffered'));
    const attempts = disk.operations.filter(
      (item) => item.operation === 'ensureRoot',
    ).length;
    await expect(disk.store.flush()).resolves.toBeUndefined();
    expect(
      disk.operations.filter((item) => item.operation === 'ensureRoot'),
    ).toHaveLength(attempts + 1);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'blocked',
      writable: false,
    });
    const failedAttempts = disk.operations.length;
    await jest.advanceTimersByTimeAsync(5000);
    expect(disk.operations).toHaveLength(failedAttempts);
    expect(jest.getTimerCount()).toBe(0);
    disk.control.before = undefined;
    await disk.store.flush();
    expect(disk.store.getStatus()).toMatchObject({
      state: 'ready',
      writable: true,
      bufferedBytes: 0,
    });
    expect(disk.textFor('hash-a')).toBe(
      entry('history').line + entry('buffered').line,
    );
  });

  test('正常同用户同 epoch 刷新不重复 IO，同用户新 epoch 保留原分区并拒绝迟到行', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('first'));
    await disk.store.flush();
    const before = disk.operations.length;
    await disk.store.setOwner('hash-a', 'epoch-a');
    expect(disk.operations).toHaveLength(before);
    await disk.store.setOwner('hash-a', 'epoch-a2');
    disk.store.append(entry('late-old-epoch'));
    disk.store.append(entry('new-epoch', 'epoch-a2'));
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(
      entry('first').line + entry('new-epoch', 'epoch-a2').line,
    );
    expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
      false,
    );
  });

  test('退出切到独立匿名分区，旧持久日志保留但旧内存队列失效', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('persisted-a'));
    await disk.store.flush();
    disk.store.append(entry('queued-a'));
    const switching = disk.store.setOwner(null, 'anonymous');
    disk.store.append(entry('late-a'));
    disk.store.append(entry('signed-out', 'anonymous'));
    await switching;
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(entry('persisted-a').line);
    expect(disk.textFor(null)).toBe(entry('signed-out', 'anonymous').line);
    expect(disk.store.getStatus().droppedCount).toBe(2);
    expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
      false,
    );
  });

  test('正在 append 时切换，旧批次按原分区完成且不会进入新用户文件', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'append') {
        started.resolve();
        await finish.promise;
      }
    };
    disk.store.append(entry('in-flight-a'));
    const flushing = disk.store.flush();
    await started.promise;
    const switching = disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('new-b', 'epoch-b'));
    finish.resolve();
    await Promise.all([flushing, switching]);
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(entry('in-flight-a').line);
    expect(disk.textFor('hash-b')).toBe(entry('new-b', 'epoch-b').line);
    expect(disk.operations.some((item) => item.operation === 'remove')).toBe(
      false,
    );
  });

  test('A 到 B 到 A 恢复 A 的持久分区，不恢复旧内存和旧 epoch', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('persisted-a'));
    await disk.store.flush();
    const b = disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('queued-b', 'epoch-b'));
    const a = disk.store.setOwner('hash-a', 'epoch-a2');
    disk.store.append(entry('late-a'));
    disk.store.append(entry('new-a', 'epoch-a2'));
    await Promise.all([b, a]);
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(
      entry('persisted-a').line + entry('new-a', 'epoch-a2').line,
    );
    expect(disk.textFor('hash-b')).toBe('');
  });

  test('周期和容量阈值触发批写，单次 append 不超过批次上限', async () => {
    const disk = setup({}, { batchBytes: 130, flushIntervalMs: 1000 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('timer'));
    await jest.advanceTimersByTimeAsync(999);
    expect(disk.sourceText()).toBe('');
    await jest.advanceTimersByTimeAsync(1);
    expect(disk.sourceText()).toBe(entry('timer').line);
    disk.store.append(entry('batch-one'));
    disk.store.append(entry('batch-two'));
    disk.store.append(entry('batch-three'));
    await disk.store.flush();
    expect(disk.sourceText()).toContain(entry('batch-three').line);
    expect(
      disk.operations
        .filter((item) => item.operation === 'append')
        .every((item) => Buffer.byteLength(item.text!, 'utf8') <= 130),
    ).toBe(true);
  });

  test('UTF8 记录、共享队列和全 Error 洪峰都受硬上限约束，优先丢低级别', async () => {
    const disk = setup(
      {},
      { queueBytes: 110, recordBytes: 105, batchBytes: 110 },
    );
    const error = entry('error', 'epoch-a', 'error', true);
    disk.store.append(entry('debug', 'epoch-a', 'debug', true));
    disk.store.append(error);
    disk.store.append(error);
    disk.store.append(error);
    disk.store.append({
      ...entry('中'.repeat(90), 'epoch-a', 'error', true),
      bytes: 1,
    });
    expect(disk.store.getStatus()).toMatchObject({
      bufferedBytes: 88,
      droppedCount: 3,
    });
    await disk.store.setOwner('hash-a', 'epoch-a');
    await disk.store.flush();
    expect(disk.textFor(null)).toBe(error.line + error.line);
    expect(disk.textFor('hash-a')).toBe('');
  });

  test('文件数上限是全 App 共享预算，跨用户轮转只淘汰最旧日志段', async () => {
    const disk = setup({}, { fileBytes: 100, fileCount: 2, batchBytes: 100 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('a'));
    await disk.store.flush();
    disk.advance(1);
    await disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('b', 'epoch-b'));
    await disk.store.flush();
    expect(disk.textFor('hash-a')).toBe(entry('a').line);
    disk.advance(1);
    await disk.store.setOwner('hash-c', 'epoch-c');
    disk.store.append(entry('c', 'epoch-c'));
    await disk.store.flush();
    expect(disk.sourceNames()).toHaveLength(2);
    expect(disk.textFor('hash-a')).toBe('');
    expect(disk.textFor('hash-b')).toBe(entry('b', 'epoch-b').line);
    expect(disk.textFor('hash-c')).toBe(entry('c', 'epoch-c').line);
    expect(
      disk
        .sourceNames()
        .every(
          (name) => Buffer.byteLength(disk.files.get(name)!, 'utf8') <= 100,
        ),
    ).toBe(true);
  });

  test('容量清理失败会阻断写入，恢复前不超过全 App 文件上限', async () => {
    const disk = setup({}, { fileCount: 1 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('a'));
    await disk.store.flush();
    await disk.store.setOwner('hash-b', 'epoch-b');
    disk.control.before = async (operation) => {
      if (operation === 'remove') {
        throw new Error('cannot rotate');
      }
    };
    disk.store.append(entry('b', 'epoch-b'));
    await disk.store.flush();
    expect(disk.sourceNames()).toHaveLength(1);
    expect(disk.textFor('hash-a')).toBe(entry('a').line);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'blocked',
      writable: false,
      lastFailureCode: 'logger.files.cleanup_failed',
    });
    disk.control.before = undefined;
    await disk.store.setOwner('hash-b', 'epoch-b');
    await disk.store.flush();
    expect(disk.textFor('hash-b')).toBe(entry('b', 'epoch-b').line);
    expect(disk.sourceNames()).toHaveLength(1);
  });

  test('普通记录和定时 flush 故障不抛出，显式 flush 可恢复', async () => {
    const disk = setup();
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.control.before = async (operation) => {
      if (operation === 'append') {
        throw new Error('full disk');
      }
    };
    expect(() => disk.store.append(entry('retained'))).not.toThrow();
    await jest.advanceTimersByTimeAsync(1000);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'ready',
      writable: false,
      lastFailureCode: 'logger.files.write_failed',
    });
    disk.control.before = undefined;
    await expect(disk.store.flush()).resolves.toBeUndefined();
    expect(disk.sourceText()).toBe(entry('retained').line);
    expect(disk.store.getStatus()).toMatchObject({
      writable: true,
      bufferedBytes: 0,
      lastFailureCode: null,
    });
  });

  test('持续低频 append 和冷启动新 mtime 都不延长旧段的保留期限', async () => {
    const disk = setup({}, { maxAgeMs: 70 });
    await disk.store.setOwner('hash-a', 'epoch-a');
    disk.store.append(entry('old'));
    await disk.store.flush();
    disk.advance(40);
    disk.store.append(entry('later'));
    await disk.store.flush();
    disk.advance(31);
    await disk.store.flush();
    expect(disk.sourceNames()).toEqual([]);
    const name = sourceName('hash-a', 'old', 1_749_999_999_900);
    const restored = setup({ [name]: entry('expired').line }, { maxAgeMs: 70 });
    restored.modified.set(name, 1_750_000_000_000);
    await restored.store.setOwner('hash-a', 'epoch-a');
    expect(restored.sourceNames()).toEqual([]);
  });

  test('dispose 清 timer 和队列，旧初始化结束后不再启动后续 IO', async () => {
    const disk = setup();
    const started = deferred();
    const finish = deferred();
    disk.control.before = async (operation) => {
      if (operation === 'ensureRoot') {
        started.resolve();
        await finish.promise;
      }
    };
    const initializing = disk.store.setOwner('hash-a', 'epoch-a');
    await started.promise;
    disk.store.append(entry('pending'));
    disk.store.dispose();
    finish.resolve();
    await initializing;
    await disk.store.setOwner('hash-b', 'epoch-b');
    disk.store.append(entry('after', 'epoch-b'));
    await disk.store.flush();
    await jest.advanceTimersByTimeAsync(3000);
    expect(disk.operations.map((item) => item.operation)).toEqual([
      'ensureRoot',
    ]);
    expect(disk.store.getStatus()).toMatchObject({
      state: 'disposed',
      writable: false,
      bufferedBytes: 0,
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
