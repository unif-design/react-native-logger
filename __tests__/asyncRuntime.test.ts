import {
  createLogger,
  createOperationContext,
  defaultLogBackend,
  installLogging,
} from '../src';
import { flushLogTasks } from '../src/runtime/logTasks';
import type {
  DiagnosticRecord,
  LogFileStore,
  LoggingHandle,
  LogWrite,
} from '../src';
import { TEST_POLICY } from './policyFixture';

let handle: LoggingHandle;
let writes: LogWrite[];
let files: LogFileStore;
beforeEach(() => {
  writes = [];
  for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const)
    jest.spyOn(console, level).mockImplementation(() => {});
  files = {
    append: jest.fn((entry) => {
      writes.push(entry);
    }),
    setOwner: jest.fn(async () => {}),
    flush: jest.fn(async () => {}),
    getStatus: () => ({
      storageMode: 'memory',
      state: 'ready',
      writable: true,
      bufferedBytes: 0,
      droppedCount: 0,
      corruptedLines: 0,
      lastFailureCode: null,
    }),
    createSnapshot: jest.fn(),
    readSnapshot: jest.fn(),
    releaseSnapshot: jest.fn(),
    takeSnapshotFile: jest.fn(),
    readSummary: jest.fn(),
    clear: jest.fn(),
    dispose: jest.fn(),
  };
});
afterEach(async () => {
  handle?.dispose();
  await flushLogTasks();
  jest.restoreAllMocks();
});
function install(capture = false) {
  let id = 0;
  handle = installLogging({
    files,
    policy: TEST_POLICY,
    createId: () => `async-${++id}`,
    environment: {
      appVersion: '1',
      platform: 'ios',
      osVersion: '18',
      development: false,
    },
    ...(capture
      ? {
          console: {
            target: console,
            transport: defaultLogBackend.consoleTransport,
          },
        }
      : {}),
  });
  return handle;
}
function records(): DiagnosticRecord[] {
  return writes.map((entry) => JSON.parse(entry.line));
}

test('结构化日志和lazy生产器异步，业务同步返回且flush包括已提交日志', async () => {
  install();
  await handle.setOwner('A');
  const metadata = jest.fn(() => ({ fields: { reason: 'timeout' } }));
  createLogger('home').warn('failed', metadata);
  expect(metadata).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
  await handle.flush();
  expect(metadata).toHaveBeenCalledTimes(1);
  expect(records()).toHaveLength(1);
});

test('captureError异步返回同份JSONL，异常永远不reject', async () => {
  install();
  const report = createLogger('bootstrap').captureError('startup_failed');
  expect(report).toBeInstanceOf(Promise);
  expect(writes).toHaveLength(0);
  await expect(report).resolves.toContain('startup_failed');
  await handle.flush();
  expect(writes[0]?.line.trim()).toBe((await report)?.trim());
});

test('默认SDK后端和console捕获都在业务返回后执行，内容仍受既有策略控制', async () => {
  const warn = console.warn;
  install(true);
  await handle.setOwner('A');
  defaultLogBackend.createLogger('design').warn('PRIVATE_SDK');
  console.warn('PRIVATE_CONSOLE');
  expect(writes).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled();
  await handle.flush();
  expect(records().map((record) => record.event)).toEqual(
    expect.arrayContaining(['sdk.warning', 'console.warn']),
  );
  expect(JSON.stringify(records())).not.toContain('PRIVATE_');
});

test('调用现场固定操作和时间，异步任务不使用后来身份', async () => {
  install();
  await handle.setOwner('A');
  const context = createOperationContext('user');
  createLogger('home').info('first', { context });
  const binding = handle.setOwner('B');
  createLogger('home').info('late', { context });
  await binding;
  await handle.flush();
  expect(records().map((record) => record.event)).toEqual([]);
});

test('首次匿名绑定保留已准入的启动警告，后续普通身份切换不迁移旧任务', async () => {
  install();
  createLogger('bootstrap').warn('device_metadata_unavailable');
  const binding = handle.setOwner(null);
  const context = createOperationContext('startup');
  createLogger('bootstrap').info('app_started', { context });
  await binding;
  await handle.flush();
  expect(records().map((record) => record.event)).toEqual([
    'device_metadata_unavailable',
    'app_started',
  ]);
  expect(writes[0]?.startup).toBe(true);
  expect(writes[1]?.startup).toBe(false);
});

test('lazy错误投影与失败都发生在异步任务，不改变业务结果或产生拒绝', async () => {
  install();
  const metadata = jest.fn(() => {
    throw new Error('PRIVATE_LAZY');
  });
  let result: Promise<string | null> | undefined;
  expect(() => {
    result = createLogger('bootstrap').captureError('failed', metadata);
  }).not.toThrow();
  expect(metadata).not.toHaveBeenCalled();
  await expect(result).resolves.toBeNull();
  expect(writes).toHaveLength(0);
});

test('发生时间和duration按提交现场捕获，等待异步队列不计入业务耗时', async () => {
  let time = 100;
  let elapsed = 10;
  let id = 0;
  handle = installLogging({
    files,
    policy: TEST_POLICY,
    createId: () => `clock-${++id}`,
    now: () => time,
    monotonicNow: () => elapsed,
    environment: {
      appVersion: '1',
      platform: 'ios',
      osVersion: '18',
      development: false,
    },
  });
  await handle.setOwner('A');
  const context = createOperationContext('user');
  time = 200;
  elapsed = 30;
  createLogger('home').info('completed', { context });
  time = 900;
  elapsed = 1000;
  await handle.flush();
  expect(records()[0]).toMatchObject({
    timestamp: new Date(200).toISOString(),
    durationMs: 20,
  });
});

test('默认后端在提交时固定transport函数，后来替换不能接收旧记录', async () => {
  install();
  await handle.setOwner('A');
  const before = jest.fn();
  const after = jest.fn();
  const transport = { id: 'async-boundary-test', log: before };
  defaultLogBackend.addTransport(transport);
  try {
    defaultLogBackend.createLogger('design').warn('original');
    transport.log = after;
    await handle.flush();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  } finally {
    defaultLogBackend.removeTransport(transport.id);
  }
});

test('SDK与console旧任务在切身份后不写到B，也不迟到输出原文', async () => {
  const warn = console.warn;
  install(true);
  await handle.setOwner('A');
  defaultLogBackend.createLogger('design').warn('PRIVATE_A_SDK');
  console.warn('PRIVATE_A_CONSOLE');
  await handle.setOwner('B');
  await handle.flush();
  expect(writes).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled();
});

test('dispose取消未处理任务，重装runtime不会接收旧原文或旧报告', async () => {
  const warn = console.warn;
  install(true);
  await handle.setOwner('A');
  const metadata = jest.fn(() => ({ error: new Error('PRIVATE_OLD') }));
  const report = createLogger('home').captureError('old', metadata);
  console.warn('PRIVATE_OLD_CONSOLE');
  handle.dispose();
  install(true);
  await handle.setOwner('B');
  await handle.flush();
  await expect(report).resolves.toBeNull();
  expect(metadata).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
  expect(warn).not.toHaveBeenCalled();
});

test.each(['createSnapshot', 'clear', 'readSummary'] as const)(
  '%s包含前序及派生记录，后来的日志不拖延边界',
  async (method) => {
    install();
    await handle.setOwner('A');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failure = new Error('management result');
    const operation = jest.fn(async () => {
      expect(records().map((record) => record.event)).toEqual([
        'parent',
        'child',
      ]);
      started();
      await gate;
      throw failure;
    });
    files[method] = operation;
    defaultLogBackend.addTransport({
      id: 'derive-test',
      log: (record) => {
        if (record.message === 'parent') createLogger('home').info('child');
      },
    });
    try {
      createLogger('home').info('parent');
      const result = handle[method]().catch((error) => error);
      createLogger('home').info('future');
      await start;
      expect(records().map((record) => record.event)).toEqual([
        'parent',
        'child',
      ]);
      release();
      await expect(result).resolves.toBe(failure);
      await handle.flush();
      expect(records().map((record) => record.event)).toEqual([
        'parent',
        'child',
        'future',
      ]);
    } finally {
      release();
      defaultLogBackend.removeTransport('derive-test');
    }
  },
);

test.each(['createSnapshot', 'clear', 'readSummary'] as const)(
  '%s等待时身份变化，不能转向新账号',
  async (method) => {
    install();
    await handle.setOwner('A');
    const result = handle[method]().catch((error) => error);
    await handle.setOwner('B');
    await expect(result).resolves.toMatchObject({
      code: 'logger.files.identity_changed',
    });
    expect(files[method]).not.toHaveBeenCalled();
  },
);

test('调度或控制台输出自身失败仍不抛向业务', async () => {
  const warn = jest.mocked(console.warn);
  warn.mockImplementation(() => {
    throw new Error('console failed');
  });
  install(true);
  expect(() => console.warn('PRIVATE_ERROR')).not.toThrow();
  await handle.flush();
  handle.dispose();
  install();
  jest.spyOn(global, 'setTimeout').mockImplementation(() => {
    throw new Error('schedule failed');
  });
  await expect(
    createLogger('bootstrap').captureError('failed'),
  ).resolves.toBeNull();
});

test('被级别或启动范围忽略的日志不执行lazy生产器，不占用异步工作', async () => {
  install();
  const metadata = jest.fn(() => {
    throw new Error('ignored');
  });
  createLogger('bootstrap').debug('hidden', metadata);
  createLogger('home').warn('unknown owner', metadata);
  await handle.flush();
  expect(metadata).not.toHaveBeenCalled();
  expect(writes).toHaveLength(0);
});

test('transport accessor在异步任务中读取，读取异常不回到SDK业务调用', async () => {
  install();
  await handle.setOwner('A');
  const getter = jest.fn(() => {
    throw new Error('getter failed');
  });
  const transport = {
    id: 'accessor-test',
    get log(): (record: unknown) => void {
      return getter();
    },
  };
  defaultLogBackend.addTransport(transport);
  try {
    expect(() =>
      defaultLogBackend.createLogger('design').warn('event'),
    ).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    await handle.flush();
    expect(getter).toHaveBeenCalledTimes(1);
    expect(records()).toHaveLength(1);
  } finally {
    defaultLogBackend.removeTransport(transport.id);
  }
});

test('默认后端级别在提交时固定，异步处理不能绕过应用设置', async () => {
  install();
  await handle.setOwner('A');
  defaultLogBackend.setLogLevel('error');
  createLogger('home').info('hidden');
  await handle.flush();
  expect(writes).toHaveLength(0);
});

test('dispose不等待旧文件IO，新runtime日志不被旧未决Promise卡住', async () => {
  install();
  await handle.setOwner('A');
  let started!: () => void;
  const beginning = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.mocked(files.flush).mockImplementationOnce(async () => {
    started();
    await gate;
  });
  const old = handle.flush();
  await beginning;
  handle.dispose();
  install();
  try {
    await handle.setOwner('B');
    createLogger('home').info('new-runtime');
    await handle.flush();
    expect(records().map((record) => record.event)).toEqual(['new-runtime']);
    await expect(old).resolves.toBeUndefined();
  } finally {
    release();
  }
});

test('默认后端现场时钟失败也不能改变SDK业务调用', async () => {
  install();
  await handle.setOwner('A');
  jest.spyOn(Date, 'now').mockImplementationOnce(() => {
    throw new Error('clock failed');
  });
  expect(() =>
    defaultLogBackend.createLogger('design').warn('event'),
  ).not.toThrow();
  await handle.flush();
  expect(writes).toHaveLength(0);
});

test.each(['readSnapshot', 'takeSnapshotFile', 'releaseSnapshot'] as const)(
  '%s在runtime已切身份而store尚未绑定时立即拒绝旧未交付快照',
  async (method) => {
    install();
    await handle.setOwner('A');
    const snapshot = {
      id: 'A-snapshot',
      bytes: 10,
      identityEpoch: createOperationContext('user').identityEpoch,
    };
    jest.mocked(files.readSnapshot).mockResolvedValue('PRIVATE_A_TEXT');
    jest.mocked(files.releaseSnapshot).mockResolvedValue(undefined);
    jest.mocked(files.takeSnapshotFile).mockResolvedValue({
      uri: 'file:///private-A',
      bytes: 10,
      release: jest.fn(async () => {}),
    });
    const changed = handle.setOwner('B');
    const result = handle[method](snapshot).catch((error) => error);
    await expect(result).resolves.toMatchObject({
      code: 'logger.files.identity_changed',
    });
    expect(files[method]).not.toHaveBeenCalled();
    await changed;
  },
);

test('takeSnapshotFile在等待交付时切身份，迟到file释放一次并拒绝结果', async () => {
  install();
  await handle.setOwner('A');
  const snapshot = {
    id: 'A-snapshot',
    bytes: 10,
    identityEpoch: createOperationContext('user').identityEpoch,
  };
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let deliver!: (file: {
    uri: string;
    bytes: number;
    release(): Promise<void>;
  }) => void;
  const pending = new Promise<{
    uri: string;
    bytes: number;
    release(): Promise<void>;
  }>((resolve) => {
    deliver = resolve;
  });
  jest.mocked(files.takeSnapshotFile).mockImplementationOnce(() => {
    began();
    return pending;
  });
  const result = handle.takeSnapshotFile(snapshot).catch((error) => error);
  await started;
  const changed = handle.setOwner('B');
  const file = {
    uri: 'file:///late-A',
    bytes: 10,
    release: jest.fn(async () => {}),
  };
  deliver(file);
  await expect(result).resolves.toMatchObject({
    code: 'logger.files.identity_changed',
  });
  expect(file.release).toHaveBeenCalledTimes(1);
  await changed;
});

test('普通日志填满队列后身份控制仍能绑定B，B日志正常记录', async () => {
  install();
  await handle.setOwner('A');
  for (let index = 0; index < 1000; index++)
    createLogger('home').info('A-pending');
  await handle.setOwner('B');
  await handle.setOwner('B');
  expect(
    jest.mocked(files.setOwner).mock.calls.map(([owner]) => owner),
  ).toEqual(['A', 'B']);
  createLogger('home').info('B-accepted');
  await handle.flush();
  expect(records().map((record) => record.event)).toEqual(['B-accepted']);
});

test('身份绑定失败但store仍显示ready时，同值重试可恢复日志', async () => {
  install();
  await handle.setOwner('A');
  jest.mocked(files.setOwner).mockRejectedValueOnce(new Error('bind failed'));
  await handle.setOwner('B');
  await handle.setOwner('B');
  expect(
    jest.mocked(files.setOwner).mock.calls.map(([owner]) => owner),
  ).toEqual(['A', 'B', 'B']);
  createLogger('home').info('B-after-retry');
  await handle.flush();
  expect(records().map((record) => record.event)).toEqual(['B-after-retry']);
});

test('普通日志填满队列时管理边界仍可执行', async () => {
  install();
  await handle.setOwner('A');
  for (let index = 0; index < 1000; index++)
    createLogger('home').info('pending');
  jest.mocked(files.clear).mockResolvedValue({ status: 'success' });
  await expect(handle.clear()).resolves.toEqual({ status: 'success' });
  expect(files.clear).toHaveBeenCalledTimes(1);
});

test.each(['clear', 'readSummary'] as const)(
  '%s在新身份绑定失败后不操作旧ready存储',
  async (method) => {
    install();
    await handle.setOwner('A');
    jest
      .mocked(files.setOwner)
      .mockRejectedValueOnce(new Error('B bind failed'));
    await handle.setOwner('B');
    await expect(handle[method]()).rejects.toMatchObject({
      code: 'logger.files.not_ready',
    });
    expect(files[method]).not.toHaveBeenCalled();
  },
);
