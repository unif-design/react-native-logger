import { TEST_POLICY } from './policyFixture';
import { createLogger, createOperationContext, getLogStatus } from '../src';
import { installLogging } from '../src';
import type { LogBackend, LogFileStore, LogWrite, LoggingHandle } from '../src';
import type { LogLevel, LogTransport } from '../src';

function fixture(development = false) {
  let level: LogLevel = 'warn';
  const transports = new Map<string, LogTransport>();
  const emitted: unknown[][] = [];
  const writes: LogWrite[] = [];
  const files: LogFileStore = {
    setOwner: jest.fn(async () => {}),
    append: jest.fn((entry) => writes.push(entry)),
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
  const backend: LogBackend = {
    createLogger: (scope) => {
      function emit(severity: LogLevel, message: string, ...args: unknown[]) {
        const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
        if (levels.indexOf(severity) < levels.indexOf(level)) return;
        emitted.push([severity, scope, message, ...args]);
        transports.forEach((transport) =>
          transport.log({
            level: severity,
            scope,
            message,
            args,
            ts: Date.now(),
          }),
        );
      }
      return {
        debug: (message, ...args) => emit('debug', message, ...args),
        info: (message, ...args) => emit('info', message, ...args),
        warn: (message, ...args) => emit('warn', message, ...args),
        error: (message, ...args) => emit('error', message, ...args),
      };
    },
    addTransport: (transport) => {
      transports.set(transport.id, transport);
    },
    removeTransport: (id) => {
      transports.delete(id);
    },
    getLogLevel: () => level,
    setLogLevel: (value) => {
      level = value;
    },
  };
  let sequence = 0;
  return {
    options: {
      backend,
      files,
      createId: () => `run-${++sequence}`,
      environment: {
        appVersion: '4.0.0',
        buildNumber: '1',
        platform: 'ios',
        osVersion: '18',
        development,
      },
      monotonicNow: () => 100,
    },
    emitted,
    writes,
    transports,
    files,
    backend,
  };
}

let handle: LoggingHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});

test('日志SDK分发失败只更新安全健康诊断，不抛错或递归写入', () => {
  const setup = fixture();
  setup.backend.createLogger = () => {
    throw Object.assign(new Error('PRIVATE_SDK'), { code: 'EIO' });
  };
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  expect(() => createLogger('bootstrap').warn('failed')).not.toThrow();
  expect(getLogStatus()).toMatchObject({
    lastFailureCode: 'logger.dispatch_failed',
    lastFailure: { reason: 'io_error', sourceCode: 'EIO' },
  });
  expect(setup.writes).toEqual([]);
  expect(JSON.stringify(getLogStatus())).not.toContain('PRIVATE_');
});

test('日志初始化失败仍抛原异常，未安装时可读取脱敏原因', () => {
  const setup = fixture();
  const error = Object.assign(new Error('PRIVATE_RANDOM_SOURCE'), {
    code: 'EACCES',
  });
  setup.options.createId = () => {
    throw error;
  };
  expect(() =>
    installLogging({ ...setup.options, policy: TEST_POLICY }),
  ).toThrow(error);
  expect(getLogStatus()).toMatchObject({
    installed: false,
    lastFailureCode: 'logger.initialize_failed',
    lastFailure: { reason: 'permission_denied' },
  });
  expect(JSON.stringify(getLogStatus())).not.toContain('PRIVATE_');
});

test('旧身份的日志IO迟到失败不把新增诊断带入新身份', async () => {
  const setup = fixture();
  let reject!: (error: unknown) => void;
  jest.mocked(setup.files.setOwner).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const old = handle.setOwner('old');
  await handle.setOwner('new');
  reject(Object.assign(new Error('PRIVATE_OLD_OWNER'), { code: 'EACCES' }));
  await old;
  expect(getLogStatus().lastFailure).toBeUndefined();
});

test('诊断时钟失败不能让业务创建操作上下文失败，健康状态仍可排查', () => {
  const setup = fixture();
  setup.options.monotonicNow = () => {
    throw Object.assign(new Error('PRIVATE_CLOCK'), { code: 'EIO' });
  };
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  expect(() => createOperationContext('user')).not.toThrow();
  expect(getLogStatus()).toMatchObject({
    lastFailureCode: 'logger.context_failed',
    lastFailure: { reason: 'io_error' },
  });
});

test('释放后的句柄和迟到SDK事件不再触及文件，外部日志级别保持', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const transport = [...setup.transports.values()][0];
  setup.backend.setLogLevel('error');
  handle.dispose();
  await handle.setOwner('late');
  await handle.flush();
  transport.log({
    level: 'error',
    scope: 'sdk',
    message: 'PRIVATE_LATE',
    args: [],
    ts: Date.now(),
  });
  expect(setup.files.setOwner).not.toHaveBeenCalled();
  expect(setup.files.flush).not.toHaveBeenCalled();
  expect(setup.writes).toEqual([]);
  expect(setup.backend.getLogLevel()).toBe('error');
});

test('新失败没有原始原因时不复用上一失败的安全细节', () => {
  const setup = fixture();
  setup.options.createId = () => {
    throw Object.assign(new Error('old'), { code: 'EACCES' });
  };
  expect(() =>
    installLogging({ ...setup.options, policy: TEST_POLICY }),
  ).toThrow();
  const next = fixture();
  next.options.createId = () => {
    throw undefined;
  };
  expect(() =>
    installLogging({ ...next.options, policy: TEST_POLICY }),
  ).toThrow();
  expect(getLogStatus().lastFailure).toBeUndefined();
});

test('错误诊断返回交给控制台和文件的同一条完整脱敏日志，只记录一次', () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const context = createOperationContext('startup');
  const cause = new Error('Authorization: Bearer PRIVATE_TOKEN');
  const error = Object.assign(new Error('storage failed'), {
    code: 'key_value.invalid_options',
    cause,
  });
  Object.defineProperty(error, 'stack', {
    value: 'Error: storage failed\n at bootstrap (/fixture/bootstrap.ts:1:1)',
  });
  Object.defineProperty(cause, 'stack', {
    value:
      'Error: Authorization: Bearer PRIVATE_TOKEN\n at request (/fixture/request.ts:2:1)',
  });
  const report = createLogger('bootstrap').captureError('startup_failed', {
    context,
    phase: 'services',
    code: error.code,
    error,
    fields: { password: 'PRIVATE_PASSWORD', count: 1 },
  });

  expect(typeof report).toBe('string');
  expect(setup.writes).toHaveLength(1);
  expect(setup.emitted).toHaveLength(1);
  expect(report).toBe(setup.writes[0].line);
  expect(report).not.toMatch(/PRIVATE_TOKEN|PRIVATE_PASSWORD/);
  expect(JSON.parse(report!)).toMatchObject({
    schemaVersion: 1,
    level: 'error',
    scope: 'bootstrap',
    event: 'startup_failed',
    phase: 'services',
    code: 'key_value.invalid_options',
    runId: context.runId,
    operationId: context.operationId,
    appVersion: '4.0.0',
    buildNumber: '1',
    platform: 'ios',
    error: {
      message: 'storage failed',
      code: 'key_value.invalid_options',
      stack: expect.any(String),
      cause: { name: 'Error', message: expect.stringContaining('[REDACTED]') },
    },
  });
});

test('未安装、旧身份和已卸载时不伪造可复制的错误日志', async () => {
  const log = createLogger('bootstrap');
  expect(log.captureError('before_install')).toBeNull();
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const previous = createOperationContext('startup');
  await handle.setOwner('owner');
  expect(log.captureError('late_error', { context: previous })).toBeNull();
  expect(setup.writes).toHaveLength(0);
  handle.dispose();
  expect(log.captureError('after_dispose')).toBeNull();
});

test('文件通道失败仍可复制已生成的安全诊断，文件失败由健康状态表达', () => {
  const setup = fixture();
  setup.files.append = () => {
    throw new Error('disk failure');
  };
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const report = createLogger('bootstrap').captureError('startup_failed', {
    error: new Error('configuration unavailable'),
  });
  expect(JSON.parse(report!)).toMatchObject({ event: 'startup_failed' });
  expect(getLogStatus().lastFailureCode).toBe('logger.transport_failed');
});

test('安装句柄交接文件摘要和部分清理结果，读取失败不替换为零', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  jest
    .mocked(setup.files.readSummary)
    .mockResolvedValue({ fileCount: 2, bytes: 30 });
  const partial = {
    status: 'partial' as const,
    removedFiles: 1,
    remainingFiles: 1,
    message: '部分日志未清理',
  };
  jest.mocked(setup.files.clear).mockResolvedValue(partial);
  await expect(handle.readSummary()).resolves.toEqual({
    fileCount: 2,
    bytes: 30,
  });
  await expect(handle.clear()).resolves.toBe(partial);
  const error = new Error('read failed');
  jest.mocked(setup.files.readSummary).mockRejectedValue(error);
  await expect(handle.readSummary()).rejects.toBe(error);
  expect(setup.files.readSummary).toHaveBeenCalledTimes(2);
  expect(setup.files.clear).toHaveBeenCalledTimes(1);
  expect(setup.files.flush).not.toHaveBeenCalled();
  expect(setup.files.createSnapshot).not.toHaveBeenCalled();
});

test('安装句柄按原对象交接快照文件，不重新创建或读取内容', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  const snapshot = Object.freeze({
    id: 'owned',
    bytes: 7,
    identityEpoch: 'original',
  });
  const file = Object.freeze({
    uri: 'file:///fixture/snapshot',
    bytes: 7,
    release: jest.fn(async () => {}),
  });
  jest.mocked(setup.files.takeSnapshotFile).mockResolvedValue(file);
  await expect(handle.takeSnapshotFile(snapshot)).resolves.toBe(file);
  expect(setup.files.takeSnapshotFile).toHaveBeenCalledTimes(1);
  expect(setup.files.takeSnapshotFile).toHaveBeenCalledWith(snapshot);
  expect(setup.files.readSnapshot).not.toHaveBeenCalled();
  expect(setup.files.createSnapshot).not.toHaveBeenCalled();
  expect(file.release).not.toHaveBeenCalled();
});

test('客户端请求保留子操作、父操作与服务端关联', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner('owner');
  const parent = createOperationContext('user');
  const context = createOperationContext('user', parent);
  const metadata = {
    context,
    serverTraceId: 'server-trace',
  };
  const log = createLogger('http');
  log.info('request_started', metadata);
  log.info('request_completed', metadata);
  expect(setup.writes).toHaveLength(2);
  for (const entry of setup.writes) {
    const record = JSON.parse(entry.line);
    expect(record).toMatchObject({
      operationId: context.operationId,
      parentOperationId: parent.operationId,
      serverTraceId: 'server-trace',
    });
  }
});

test('普通入口没有安装副作用，预先建立的 logger 在安装后使用已脱敏的数据分发一次', async () => {
  const log = createLogger('bootstrap');
  expect(() => log.error('before_install')).not.toThrow();
  expect(getLogStatus().installed).toBe(false);
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  log.info('startup_failed', {
    error: new Error('Authorization: Bearer SECRET_VALUE'),
    fields: { password: 'SECRET_PASS', count: 2 },
  });
  expect(setup.writes).toHaveLength(1);
  expect(setup.writes[0].startup).toBe(true);
  expect(setup.writes[0].line.endsWith('\n')).toBe(true);
  expect(JSON.stringify(setup.emitted)).not.toMatch(/SECRET_VALUE|SECRET_PASS/);
  expect(JSON.parse(setup.writes[0].line)).toMatchObject({
    scope: 'bootstrap',
    event: 'startup_failed',
    fields: { count: 2 },
  });
});

test('正式包保留 App Info，忽略 Debug，SDK 仅 Warn+ 且不保留任意 args', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  expect(setup.backend.getLogLevel()).toBe('info');
  await handle.setOwner('owner-a');
  const log = createLogger('home');
  log.debug('render');
  log.info('load_started');
  setup.backend.createLogger('design').info('render');
  setup.backend
    .createLogger('design')
    .warn('request failed', { token: 'secret-arg' });
  expect(setup.writes).toHaveLength(2);
  expect(setup.writes.map((entry) => JSON.parse(entry.line).event)).toEqual([
    'load_started',
    'sdk.warning',
  ]);
  expect(JSON.stringify(setup.writes)).not.toContain('secret-arg');
});

test('未确定身份时只有匿名白名单入队，不持久化未知 SDK 或工作台记录', () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  createLogger('home').error('load_failed');
  setup.backend.createLogger('design').warn('unknown');
  createLogger('account.session').info('restore_started');
  expect(setup.writes).toHaveLength(1);
  expect(getLogStatus().droppedCount).toBe(2);
});

test('操作上下文不可变，身份切换和 A→B→A 都使旧操作失效，正常刷新不换周期', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner('a');
  const context = createOperationContext('user');
  expect(Object.isFrozen(context)).toBe(true);
  await handle.setOwner('a');
  expect(createOperationContext('system').identityEpoch).toBe(
    context.identityEpoch,
  );
  const child = createOperationContext('system', context);
  expect(child.parentOperationId).toBe(context.operationId);
  await handle.setOwner('b');
  await handle.setOwner('a');
  createLogger('home').error('late_result', { context });
  createLogger('home').error('late_child', {
    context: createOperationContext('system', context),
  });
  expect(setup.writes).toHaveLength(0);
  createLogger('home').info('current', {
    context: createOperationContext('user'),
  });
  expect(setup.writes).toHaveLength(1);
  expect(setup.files.setOwner).toHaveBeenCalledTimes(3);
});

test('日志 SDK、文件及身份切换失败不能抛向业务且留下健康状态', async () => {
  const setup = fixture();
  setup.files.append = () => {
    throw new Error('disk');
  };
  setup.files.setOwner = async () => {
    throw new Error('owner');
  };
  setup.files.flush = async () => {
    throw new Error('flush');
  };
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  expect(() => createLogger('bootstrap').info('start')).not.toThrow();
  await expect(handle.setOwner(null)).resolves.toBeUndefined();
  await expect(handle.flush()).resolves.toBeUndefined();
  expect(getLogStatus().lastFailureCode).toBeTruthy();
});

test('安装幂等，卸载移除 transport 并恢复所接管级别，旧 handle 不影响新实例', () => {
  const setup = fixture(true);
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  expect(installLogging({ ...setup.options, policy: TEST_POLICY })).toBe(
    handle,
  );
  expect(setup.transports.size).toBe(1);
  expect(setup.backend.getLogLevel()).toBe('debug');
  const previous = handle;
  handle.dispose();
  handle.dispose();
  expect(setup.files.dispose).toHaveBeenCalledTimes(1);
  expect(setup.transports.size).toBe(0);
  expect(setup.backend.getLogLevel()).toBe('warn');
  const next = fixture();
  handle = installLogging({ ...next.options, policy: TEST_POLICY });
  previous.dispose();
  expect(getLogStatus().installed).toBe(true);
});

test('安装实例复用规范化 scope 的后端 logger，动态级别及重新安装保持有效', async () => {
  const setup = fixture(true);
  const create = jest.spyOn(setup.backend, 'createLogger');
  const add = jest.spyOn(setup.backend, 'addTransport');
  const facade = createLogger('home');
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner('owner');
  facade.info('first');
  createLogger('home').info('second');
  createLogger('account').warn('other_scope');
  expect(create.mock.calls).toEqual([['unif:home'], ['unif:account']]);
  expect(setup.writes).toHaveLength(3);
  setup.backend.setLogLevel('error');
  facade.info('filtered');
  facade.error('visible');
  expect(setup.writes).toHaveLength(4);
  setup.backend.setLogLevel('debug');
  facade.debug('debug_enabled');
  expect(setup.writes).toHaveLength(5);
  expect(create).toHaveBeenCalledTimes(2);
  expect(installLogging({ ...setup.options, policy: TEST_POLICY })).toBe(
    handle,
  );
  expect(add).toHaveBeenCalledTimes(1);
  handle.dispose();
  facade.error('after_dispose');
  expect(setup.writes).toHaveLength(5);
  const next = fixture();
  const nextCreate = jest.spyOn(next.backend, 'createLogger');
  handle = installLogging({ ...next.options, policy: TEST_POLICY });
  await handle.setOwner('owner');
  facade.info('new_instance');
  expect(nextCreate).toHaveBeenCalledTimes(1);
  expect(next.writes).toHaveLength(1);
  expect(JSON.parse(next.writes[0].line).event).toBe('new_instance');
  expect(setup.writes).toHaveLength(5);
});

test('不同原始 scope 规范化为相同值时只建立一个后端对象', async () => {
  const setup = fixture();
  const create = jest.spyOn(setup.backend, 'createLogger');
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner('owner');
  createLogger('/home?token=first').info('first');
  createLogger('/home?token=second').info('second');
  expect(create.mock.calls).toEqual([['unif:/home[REDACTED]']]);
  expect(setup.writes).toHaveLength(2);
  expect(setup.writes.map((write) => JSON.parse(write.line).scope)).toEqual([
    '/home[REDACTED]',
    '/home[REDACTED]',
  ]);
});
