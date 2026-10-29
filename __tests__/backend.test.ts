import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

/**
 * logger 单测 —— scope 前缀、level 门控、setLogLevel、addTransport / removeTransport。
 *
 * logger.ts 用模块级 `state.level` + `state.transports`,跨 test 共享,
 * 所以每个 case 用 jest.resetModules() + require 重新加载,避免污染。
 */
describe('logger', () => {
  let consoleDebugSpy: ReturnType<typeof jest.spyOn>;
  let consoleInfoSpy: ReturnType<typeof jest.spyOn>;
  let consoleWarnSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.resetModules();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('createLogger 返 4 个 level method', () => {
    const { createLogger } = require('../src/backend');
    const log = createLogger('TestScope');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  test('warn 输出带 [Scope] 前缀,业务消息单独传', () => {
    const { createLogger } = require('../src/backend');
    const log = createLogger('TestScope');
    log.warn('msg');
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const args = consoleWarnSpy.mock.calls[0];
    expect(args[0]).toBe('[TestScope]');
    expect(args[1]).toBe('msg');
  });

  test('error 走 console.error 且带 scope 前缀', () => {
    const { createLogger } = require('../src/backend');
    const log = createLogger('TestScope');
    log.error('boom', { code: 500 });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const args = consoleErrorSpy.mock.calls[0];
    expect(args[0]).toBe('[TestScope]');
    expect(args[1]).toBe('boom');
    expect(args[2]).toEqual({ code: 500 });
  });

  test('__DEV__ 下默认 level=debug,debug/info 都输出', () => {
    // jest preset 默认 __DEV__ = true
    const { createLogger, getLogLevel } = require('../src/backend');
    expect(getLogLevel()).toBe('debug');
    const log = createLogger('TestScope');
    log.debug('d');
    log.info('i');
    expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
  });

  test('setLogLevel("warn") 之后 debug/info 不再输出,warn/error 仍输出', () => {
    const { createLogger, setLogLevel } = require('../src/backend');
    setLogLevel('warn');
    const log = createLogger('TestScope');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(consoleDebugSpy).not.toHaveBeenCalled();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  test('addTransport 同 id 自动去重 + removeTransport 删除', () => {
    const {
      createLogger,
      addTransport,
      removeTransport,
    } = require('../src/backend');
    const records: Array<{ scope: string; message: string }> = [];
    const t = {
      id: 'memory',
      log: (rec: { scope: string; message: string }) => {
        records.push({ scope: rec.scope, message: rec.message });
      },
    };
    addTransport(t);
    addTransport(t); // 同 id 应去重
    const log = createLogger('TestScope');
    log.warn('hello');
    expect(records).toEqual([{ scope: 'TestScope', message: 'hello' }]);
    removeTransport('memory');
    log.warn('after-remove');
    expect(records).toHaveLength(1); // 移除后不再追加
  });

  test('transport 抛错被隔离,不影响其他 transport / 业务调用', () => {
    const { createLogger, addTransport } = require('../src/backend');
    const calls: string[] = [];
    addTransport({
      id: 'bad',
      log: () => {
        throw new Error('bad transport');
      },
    });
    addTransport({
      id: 'good',
      log: (rec: { message: string }) => {
        calls.push(rec.message);
      },
    });
    const log = createLogger('TestScope');
    expect(() => log.warn('ok')).not.toThrow();
    expect(calls).toEqual(['ok']);
  });
});

test('production default filters debug and info while retaining warnings', () => {
  const dev = Reflect.get(globalThis, '__DEV__');
  Reflect.set(globalThis, '__DEV__', false);
  jest.resetModules();
  try {
    const { createLogger, getLogLevel } = require('../src/backend');
    expect(getLogLevel()).toBe('warn');
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
    createLogger('Production').debug('hidden');
    expect(debug).not.toHaveBeenCalled();
  } finally {
    Reflect.set(globalThis, '__DEV__', dev);
    jest.restoreAllMocks();
  }
});
