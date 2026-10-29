import { TEST_POLICY } from './policyFixture';
import * as sdk from '@unif/react-native-design';
import { createLogger, createOperationContext, getLogStatus } from '../src';
import { createLogFiles } from '../src/files/createLogFiles.web';
import { installLogging } from '../src/runtime';
import type { LoggingHandle } from '../src/types';

let handle: LoggingHandle | undefined;
let originalTransportLog: typeof sdk.consoleTransport.log;

beforeEach(() => {
  originalTransportLog = sdk.consoleTransport.log;
});

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  sdk.consoleTransport.log = originalTransportLog;
});

function fixture(development = true) {
  const originals = {
    debug: jest.spyOn(console, 'debug').mockImplementation(() => {}),
    log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    info: jest.spyOn(console, 'info').mockImplementation(() => {}),
    warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
    error: jest.spyOn(console, 'error').mockImplementation(() => {}),
  };
  const files = createLogFiles({
    ...{ createId: () => 'capture-run' },
    directoryName: 'TestLogs',
  });
  const append = jest.spyOn(files, 'append');
  const options = {
    backend: sdk,
    files,
    createId: () => 'capture-run',
    environment: {
      appVersion: '4',
      platform: 'web',
      osVersion: 'test',
      development,
    },
    console: { target: console, transport: sdk.consoleTransport },
  };
  const records = () =>
    append.mock.calls.map(([entry]) => JSON.parse(entry.line));
  return { options, originals, files, append, records };
}

test('App输出统一可读前缀，文件保留结构化字段并区分记录点和异常源', async () => {
  const setup = fixture();
  handle = installLogging({
    ...{
      ...setup.options,
      now: () => Date.UTC(2026, 9, 29),
    },
    policy: TEST_POLICY,
  });
  await handle.setOwner(null);
  const error = Object.assign(new Error('token=PRIVATE_SECRET'), {
    code: 'ENOSPC',
  });
  createLogger('chat.recovery').error('recovery_failed', {
    context: createOperationContext('user'),
    phase: 'write',
    code: 'chat.recovery_failed',
    fields: { reason: 'storage_full' },
    error,
  });
  expect(setup.originals.error).toHaveBeenCalledTimes(1);
  expect(setup.originals.error.mock.calls[0]).toHaveLength(1);
  const line = setup.originals.error.mock.calls[0][0] as string;
  expect(line).toMatch(
    /^2026-10-29T00:00:00.000Z ERROR \[sample-app\] \[chat.recovery\] recovery_failed /,
  );
  expect(line).toContain('op=capture-run:operation:1');
  expect(line).toContain('phase=write');
  expect(line).toContain('reason=storage_full');
  expect(line).not.toContain('PRIVATE_SECRET');
  const record = setup.records()[0];
  expect(record).toMatchObject({
    service: 'sample-app',
    level: 'error',
    scope: 'chat.recovery',
    event: 'recovery_failed',
  });
  expect(record.source.file).toMatch(/consoleCapture\.test\.ts$/);
  expect(record.errorSource.file).toMatch(/consoleCapture\.test\.ts$/);
  expect(record.source.line).toBeGreaterThan(record.errorSource.line);
});

test('INFO和DEBUG不抓取调用栈，四级文本和文件仅各输出一次', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  const log = createLogger('settings');
  log.debug('debug_event');
  log.info('info_event');
  log.warn('warn_event');
  log.error('error_event');
  expect(setup.records().map((record) => record.level)).toEqual([
    'debug',
    'info',
    'warn',
    'error',
  ]);
  for (const [index, level] of (
    ['debug', 'info', 'warn', 'error'] as const
  ).entries()) {
    expect(setup.originals[level]).toHaveBeenCalledTimes(1);
    expect(setup.originals[level].mock.calls[0][0]).toContain(
      `${level.toUpperCase()} [sample-app] [settings] ${level}_event`,
    );
    expect(setup.records()[index].service).toBe('sample-app');
  }
  expect(setup.records()[0].source).toBeUndefined();
  expect(setup.records()[1].source).toBeUndefined();
});

test('可读输出转义事件和模块中的换行，不制造伪日志头', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  createLogger('module\nERROR [spoof]').warn('event\nINFO [spoof]', {
    fields: { reason: 'reset\r\nforged' },
  });
  const args = setup.originals.warn.mock.calls[0];
  expect(args).toHaveLength(1);
  expect(args[0]).not.toMatch(/[\r\n]/);
  expect(setup.records()).toHaveLength(1);
  expect(setup.records()[0].service).toBe('sample-app');
});

test('控制台transport位于文件之后时仍格式化且不重复落盘', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  sdk.addTransport(sdk.consoleTransport);
  createLogger('home').warn('cache_failed', { fields: { reason: 'io_error' } });
  expect(setup.originals.warn).toHaveBeenCalledTimes(1);
  expect(setup.originals.warn.mock.calls[0]).toHaveLength(1);
  expect(setup.originals.warn.mock.calls[0][0]).toContain(
    'WARN [sample-app] [home] cache_failed',
  );
  expect(setup.records()).toHaveLength(1);
});

test('开发 console 五种级别进入现有缓冲，原方法保持参数、接收者和一次输出', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  const receiver = {};
  const details = { count: 2 };
  console.debug('debug detail');
  console.log('legacy info');
  console.info.call(receiver, 'info detail', details);
  console.warn('warning');
  console.error('error');

  expect(setup.records().map(({ level, event }) => [level, event])).toEqual([
    ['debug', 'console.debug'],
    ['info', 'console.log'],
    ['info', 'console.info'],
    ['warn', 'console.warn'],
    ['error', 'console.error'],
  ]);
  expect(setup.records().every((record) => record.scope === 'console')).toBe(
    true,
  );
  expect(setup.files.getStatus().bufferedBytes).toBeGreaterThan(0);
  for (const original of Object.values(setup.originals)) {
    expect(original).toHaveBeenCalledTimes(1);
  }
  expect(setup.originals.info).toHaveBeenCalledWith('info detail', details);
  expect(setup.originals.info.mock.contexts[0]).toBe(receiver);
});

test('正式包 console 仅收 Warn 和 Error，其他级别仍调用原控制台', async () => {
  const setup = fixture(false);
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  console.debug('debug detail');
  console.log('info detail');
  console.info('info detail');
  console.warn('warning');
  console.error('error');
  expect(setup.records().map((record) => record.level)).toEqual([
    'warn',
    'error',
  ]);
  for (const original of Object.values(setup.originals)) {
    expect(original).toHaveBeenCalledTimes(1);
  }
});

test('首次身份确定前不把未知 console 载荷加入匿名启动白名单', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  console.warn('unknown owner');
  expect(setup.records()).toHaveLength(0);
  expect(getLogStatus().droppedCount).toBe(1);
  await handle.setOwner(null);
  console.warn('known anonymous owner');
  expect(setup.records()).toHaveLength(1);
  expect(setup.originals.warn).toHaveBeenCalledTimes(2);
});

test('App 和 SDK 输出不回流成 console 记录，SDK 同一事件只落一条', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  createLogger('home').warn('app_warning');
  sdk.createLogger('design').warn('sdk warning');
  sdk.createLogger('design').info('sdk detail');
  console.warn('direct warning');
  expect(setup.records().map((record) => record.scope)).toEqual([
    'home',
    'sdk.design',
    'console',
  ]);
  expect(setup.originals.warn).toHaveBeenCalledTimes(3);
  expect(setup.originals.info).toHaveBeenCalledTimes(1);
});

test('console 文本和 Error 经现有脱敏，任意对象不展开或触发转换', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  const getter = jest.fn(() => 'SECRET_GETTER');
  const payload = {
    password: 'SECRET_OBJECT',
    toJSON: jest.fn(() => 'SECRET_JSON'),
    toString: jest.fn(() => 'SECRET_STRING'),
  };
  Object.defineProperty(payload, 'message', { get: getter });
  const error = Object.assign(new Error('token=SECRET_ERROR'), {
    config: { password: 'SECRET_CONFIG' },
    cause: new Error('Authorization: Bearer SECRET_CAUSE'),
  });
  console.error(
    'Authorization: Bearer SECRET_HEADER',
    error,
    payload,
    'SECRET_ARGUMENT',
  );
  console.warn(payload);
  expect(setup.records()).toHaveLength(2);
  const serialized = JSON.stringify(setup.records());
  expect(serialized).toContain('[REDACTED]');
  expect(serialized).not.toMatch(/SECRET_|"config"|"password"/);
  expect(setup.records()[0].error).toMatchObject({
    name: 'Error',
    message: expect.any(String),
    cause: { name: 'Error', message: expect.any(String) },
  });
  expect(getter).not.toHaveBeenCalled();
  expect(payload.toJSON).not.toHaveBeenCalled();
  expect(payload.toString).not.toHaveBeenCalled();
  expect(setup.originals.error).toHaveBeenCalledWith(
    'Authorization: Bearer SECRET_HEADER',
    error,
    payload,
    'SECRET_ARGUMENT',
  );
});

test('安装幂等，释放恢复原方法，旧句柄不影响重新安装', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  const wrapper = console.warn;
  expect(installLogging({ ...setup.options, policy: TEST_POLICY })).toBe(
    handle,
  );
  expect(console.warn).toBe(wrapper);
  console.warn('once');
  expect(setup.records()).toHaveLength(1);
  const previous = handle;
  handle.dispose();
  handle.dispose();
  expect(console.warn).toBe(setup.originals.warn);
  expect(sdk.consoleTransport.log).toBe(originalTransportLog);
  const nextFiles = createLogFiles({
    ...{ createId: () => 'next-run' },
    directoryName: 'TestLogs',
  });
  const nextAppend = jest.spyOn(nextFiles, 'append');
  handle = installLogging({
    ...{ ...setup.options, files: nextFiles },
    policy: TEST_POLICY,
  });
  await handle.setOwner(null);
  previous.dispose();
  console.warn('new instance');
  expect(nextAppend).toHaveBeenCalledTimes(1);
  expect(setup.records()).toHaveLength(1);
});

test('释放不覆盖后安装的 console 或 transport wrapper，保留链内旧 wrapper 已失活', async () => {
  const setup = fixture();
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  const capturedWarn = console.warn;
  const laterWarn = jest.fn((...args: unknown[]) => capturedWarn(...args));
  console.warn = laterWarn;
  const capturedTransport = sdk.consoleTransport.log;
  const laterTransport = jest.fn(capturedTransport);
  sdk.consoleTransport.log = laterTransport;
  handle.dispose();
  expect(console.warn).toBe(laterWarn);
  expect(sdk.consoleTransport.log).toBe(laterTransport);
  console.warn('after disposal');
  sdk.createLogger('design').warn('sdk after disposal');
  expect(setup.records()).toHaveLength(0);
  expect(setup.originals.warn).toHaveBeenCalledTimes(2);
});

test('采集失败不改变原 console 的返回或抛错', async () => {
  const setup = fixture();
  setup.originals.info.mockReturnValue('original-return' as never);
  const originalError = new Error('original console failed');
  setup.originals.warn.mockImplementation(() => {
    throw originalError;
  });
  setup.append.mockImplementation(() => {
    throw new Error('storage failed');
  });
  handle = installLogging({ ...setup.options, policy: TEST_POLICY });
  await handle.setOwner(null);
  expect(console.info('info')).toBe('original-return');
  expect(() => console.warn('warn')).toThrow(originalError);
  expect(getLogStatus().lastFailureCode).toBe('logger.transport_failed');
  expect(setup.originals.warn).toHaveBeenCalledTimes(1);
});

test('安装参数仅改变控制台时区，文件和复制诊断仍使用 UTC', async () => {
  const setup = fixture();
  const options = {
    ...setup.options,
    policy: TEST_POLICY,
    consoleTimeZone: 'Asia/Shanghai' as 'UTC' | 'Asia/Shanghai',
    now: () => Date.UTC(2026, 11, 31, 20, 30, 0, 123),
  };
  handle = installLogging(options);
  await handle.setOwner(null);
  options.consoleTimeZone = 'UTC';
  const report = createLogger('module').captureError('failed');
  expect(setup.originals.error.mock.calls[0][0]).toMatch(
    /^2027-01-01T04:30:00.123\+08:00 ERROR /,
  );
  expect(setup.records()[0].timestamp).toBe('2026-12-31T20:30:00.123Z');
  expect(JSON.parse(report!).timestamp).toBe('2026-12-31T20:30:00.123Z');
  expect(setup.records()).toHaveLength(1);
});

test.each(['', 'Asia/Tokyo', null, 480])(
  '无效控制台时区 %s 在安装时拒绝',
  (consoleTimeZone) => {
    const setup = fixture();
    expect(() => {
      handle = installLogging({
        ...setup.options,
        policy: TEST_POLICY,
        consoleTimeZone: consoleTimeZone as never,
      });
    }).toThrow('Invalid console time zone');
    expect(getLogStatus().installed).toBe(false);
  },
);
