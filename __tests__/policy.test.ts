import { createLogger, getLogStatus } from '../src/index';
import { installLogging } from '../src/runtime/index';
import { createLogFileStore } from '../src/files/createLogFileStore';
import { createMemoryIO } from './filesFixture';
import type { LogLevel, LogTransport } from '@unif/react-native-design';
import type { LoggingHandle, LogBackend } from '../src/types';

let handle: LoggingHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});

function setup() {
  const memory = createMemoryIO();
  const files = createLogFileStore({ io: memory.io, createId: () => 'file' });
  const transports = new Map<string, LogTransport>();
  let level: LogLevel = 'warn';
  const backend: LogBackend = {
    getLogLevel: () => level,
    setLogLevel: (next: LogLevel) => {
      level = next;
    },
    addTransport: (transport: LogTransport) => {
      transports.set(transport.id, transport);
    },
    removeTransport: (id: string) => {
      transports.delete(id);
    },
    createLogger(scope: string) {
      const emit =
        (severity: LogLevel) =>
        (message: string, ...args: unknown[]) => {
          transports.forEach((transport) =>
            transport.log({
              level: severity,
              scope,
              message,
              args,
              ts: Date.now(),
            }),
          );
        };
      return {
        debug: emit('debug'),
        info: emit('info'),
        warn: emit('warn'),
        error: emit('error'),
      };
    },
  };
  const policy = {
    service: 'sample-app',
    allowedFields: ['reason', 'sampleCount'],
    startupScopes: ['boot'],
  };
  const options = {
    policy,
    files,
    backend,
    createId: () => 'run',
    environment: {
      appVersion: '1.0.0',
      platform: 'test',
      osVersion: 'test',
      development: true,
    },
    monotonicNow: () => 100,
  };
  return { options, memory, transports };
}

test('应用策略决定服务名、启动范围和字段，既有脱敏仍执行', async () => {
  const state = setup();
  handle = installLogging(state.options);
  createLogger('boot').info('ready', {
    fields: { sampleCount: 2, hidden: 'PRIVATE', reason: 'token=PRIVATE' },
  });
  createLogger('blocked').warn('ignored');
  await handle.setOwner(null);
  await handle.flush();
  const lines = state.memory.sourceText().trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0])).toMatchObject({
    service: 'sample-app',
    scope: 'boot',
    fields: { sampleCount: 2 },
  });
  expect(lines[0]).not.toContain('PRIVATE');
  expect(lines[0]).not.toContain('hidden');
  expect(getLogStatus().droppedCount).toBe(1);
});

test('安装后修改传入策略不能扩大记录范围', async () => {
  const state = setup();
  handle = installLogging(state.options);
  state.options.policy.service = 'changed';
  state.options.policy.allowedFields.push('hidden');
  state.options.policy.startupScopes.push('blocked');
  createLogger('boot').info('ready', {
    fields: { hidden: 'PRIVATE', sampleCount: 2 },
  });
  createLogger('blocked').info('ignored');
  await handle.setOwner(null);
  await handle.flush();
  expect(state.memory.sourceText()).toContain('sample-app');
  expect(state.memory.sourceText()).not.toMatch(/changed|PRIVATE|ignored/);
});

test.each(['password', 'authorization', '__proto__', 'constructor'])(
  '拒绝不安全字段策略 %s',
  (field) => {
    const state = setup();
    state.options.policy.allowedFields.push(field);
    expect(() => {
      handle = installLogging(state.options);
    }).toThrow();
    expect(state.transports.size).toBe(0);
  },
);

test('未提供应用策略时拒绝安装，不采用隐含的企业配置', () => {
  const options = { ...setup().options, policy: undefined };
  expect(() => {
    handle = installLogging(options as never);
  }).toThrow();
});
