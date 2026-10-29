import { TEST_POLICY } from './policyFixture';
import { serializeLogRecord } from '../src/serializeLogRecord';
import { utf8ByteLength } from '../src/utf8ByteLength';
import type { LogRecordInput } from '../src/types';

function createInput(overrides: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    schemaVersion: 1,
    timestamp: '2026-09-13T01:02:03.000Z',
    sequence: 9,
    runId: 'run-9',
    identityEpoch: 'epoch-2',
    appVersion: '4.0.0',
    buildNumber: '401',
    platform: 'ios',
    osVersion: '26.0',
    development: false,
    level: 'warn',
    scope: 'account.gateway',
    event: 'auth.failed',
    ...overrides,
  };
}

function serialize(input: LogRecordInput, maxBytes?: number) {
  const result = serializeLogRecord(input, TEST_POLICY, maxBytes);
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error('Expected a safe diagnostic record');
  }
  expect(result.line.endsWith('\n')).toBe(true);
  expect(result.line.split('\n')).toHaveLength(2);
  expect(JSON.parse(result.line)).toEqual(result.record);
  expect(result.bytes).toBe(Buffer.byteLength(result.line, 'utf8'));
  expect(result.bytes).toBeLessThanOrEqual(maxBytes ?? 8192);
  return result;
}

describe('log normalization', () => {
  it('保留设备和安装元数据，区分 JS 版本与原生安装版本', () => {
    const result = serialize(
      createInput({
        deviceModel: 'Pixel 9',
        systemName: 'Android',
        systemVersion: '15',
        bundleId: 'cn.portal.fixture',
        installedAppVersion: '3.9.0-beta',
      }),
    );
    expect(result.record).toMatchObject({
      appVersion: '4.0.0',
      deviceModel: 'Pixel 9',
      systemName: 'Android',
      systemVersion: '15',
      bundleId: 'cn.portal.fixture',
      installedAppVersion: '3.9.0-beta',
    });
  });

  it('新增环境字段沿用脱敏边界，不采纳永久设备标识或用户资料', () => {
    const result = serialize(
      Object.assign(
        createInput({
          deviceModel: 'Model token=SECRET_MODEL',
          systemName: 'System token=SECRET_SYSTEM',
          systemVersion: '15 token=SECRET_VERSION',
          bundleId: 'cn.fixture token=SECRET_BUNDLE',
          installedAppVersion: '4.0 token=SECRET_APP',
        }),
        { deviceId: 'PRIVATE_DEVICE', user: { userId: 'PRIVATE_USER' } },
      ),
    );
    expect(result.record).toMatchObject({
      deviceModel: 'Model token=[REDACTED]',
      systemName: 'System token=[REDACTED]',
      systemVersion: '15 token=[REDACTED]',
      bundleId: 'cn.fixture token=[REDACTED]',
      installedAppVersion: '4.0 token=[REDACTED]',
    });
    expect(result.record).not.toHaveProperty('deviceId');
    expect(result.record).not.toHaveProperty('user');
    expect(result.line).not.toMatch(/SECRET_|PRIVATE_/);
  });

  it('普通原因和错误消息中的合成18位证件格式在实际JSONL中遮蔽', () => {
    const result = serialize(
      createInput({
        fields: { reason: '合成证件 123456789012345678' },
        error: new Error('合成证件 12345678901234567X'),
      }),
    );
    expect(result.record.fields?.reason).toBe('合成证件 [REDACTED]');
    expect(result.record.error?.message).toBe('合成证件 [REDACTED]');
    expect(result.line).not.toContain('12345678901234567');
  });

  it.each([
    'name',
    'message',
    'objectMessage',
    'prepareAccessor',
    'prepareFunction',
  ] as const)('原生堆栈格式化不会执行 %s 中的用户代码', (field) => {
    const error = new Error('fixture');
    Reflect.deleteProperty(error, 'stack');
    const unsafe = jest.fn(() => 'PRIVATE_GETTER_VALUE');
    if (field === 'name' || field === 'message')
      Object.defineProperty(error, field, { get: unsafe });
    if (field === 'objectMessage')
      Object.defineProperty(error, 'message', { value: { toString: unsafe } });
    const nativeGetter = jest.fn(function (this: Error) {
      const description = field.startsWith('prepare')
        ? unsafe()
        : Error.prototype.toString.call(this);
      return `${description}\n at bootstrap (/private/app/start.ts:4:2)`;
    });
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const descriptors = jest
      .spyOn(Object, 'getOwnPropertyDescriptor')
      .mockImplementation((target, key) => {
        if (target === Error.prototype && key === 'stack')
          return { configurable: true, get: nativeGetter };
        if (target === Error && key === 'prepareStackTrace')
          return field === 'prepareAccessor'
            ? { get: unsafe }
            : { value: field === 'prepareFunction' ? unsafe : undefined };
        return getDescriptor(target, key);
      });
    try {
      const result = serialize(createInput({ error }));
      expect(unsafe).not.toHaveBeenCalled();
      expect(nativeGetter).not.toHaveBeenCalled();
      expect(result.record.error?.stack).toBeUndefined();
      expect(result.record.truncated).toBe(true);
      expect(result.line).not.toContain('PRIVATE_GETTER_VALUE');
    } finally {
      descriptors.mockRestore();
    }
  });

  it('异常对象的循环原型不会让堆栈读取无限遍历', () => {
    let reads = 0;
    const error: object = new Proxy(
      { name: 'Error', message: 'fixture' },
      {
        getPrototypeOf() {
          reads += 1;
          if (reads > 8)
            throw new Error('prototype traversal exceeded fixture budget');
          return error;
        },
      },
    );
    const getter = jest.fn();
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const descriptors = jest
      .spyOn(Object, 'getOwnPropertyDescriptor')
      .mockImplementation((target, key) =>
        target === Error.prototype && key === 'stack'
          ? { configurable: true, get: getter }
          : getDescriptor(target, key),
      );
    try {
      serialize(createInput({ error }));
      expect(reads).toBeLessThanOrEqual(4);
      expect(getter).not.toHaveBeenCalled();
    } finally {
      descriptors.mockRestore();
    }
  });

  it('读取 Hermes 原型上的原生 stack getter，保留脱敏定位且不执行子类自定义 getter', () => {
    const error = new Error('startup fixture');
    Reflect.deleteProperty(error, 'stack');
    const arbitraryGetter = jest.fn(() => 'PRIVATE_CUSTOM_STACK');
    const customPrototype = Object.create(Error.prototype);
    Object.defineProperty(customPrototype, 'stack', { get: arbitraryGetter });
    Object.setPrototypeOf(error, customPrototype);
    const nativeGetter = jest.fn(function (this: Error) {
      if (this !== error) throw new Error('unexpected receiver');
      return `${Error.prototype.toString.call(
        this,
      )}\n    at createAppServices (/private/app/bootstrap.ts:42:9)`;
    });
    const getDescriptor = Object.getOwnPropertyDescriptor;
    const descriptors = jest
      .spyOn(Object, 'getOwnPropertyDescriptor')
      .mockImplementation((target, key) => {
        if (target === Error.prototype && key === 'stack')
          return { configurable: true, get: nativeGetter };
        if (target === Error && key === 'prepareStackTrace')
          return { value: undefined };
        return getDescriptor(target, key);
      });
    try {
      const result = serialize(createInput({ level: 'error', error }));
      expect(result.record.error?.stack).toContain('bootstrap.ts:42:9');
      expect(result.line).not.toContain('/private/app');
      expect(result.line).not.toContain('PRIVATE_CUSTOM_STACK');
      expect(nativeGetter).toHaveBeenCalledTimes(1);
      expect(arbitraryGetter).not.toHaveBeenCalled();
    } finally {
      descriptors.mockRestore();
    }
  });

  it('保留规范定义的操作关联与服务端关联', () => {
    const input = {
      ...createInput(),
      operationId: 'http-operation',
      serverTraceId: 'server-trace',
    };
    const { record } = serialize(input);
    expect(record).toMatchObject({
      operationId: 'http-operation',
      serverTraceId: 'server-trace',
    });
  });

  it('retains diagnostic classification, timing, correlation and controlled fields', () => {
    const result = serialize(
      createInput({
        operationId: 'operation-7',
        parentOperationId: 'operation-6',
        trigger: 'user',
        phase: 'decode',
        outcome: 'failed',
        durationMs: 125,
        code: 'account.reply.invalid',
        httpStatus: 200,
        businessCode: 4102,
        serverTraceId: 'trace-8',
        fields: {
          operation: 'auth',
          method: 'POST',
          persisted: false,
          count: 0,
          missingConfig: ['API_HOST', 'APP_NAME'],
          attemptedValue: null,
        },
      }),
    );

    expect(result.record).toMatchObject({
      schemaVersion: 1,
      sequence: 9,
      appVersion: '4.0.0',
      buildNumber: '401',
      runId: 'run-9',
      identityEpoch: 'epoch-2',
      operationId: 'operation-7',
      parentOperationId: 'operation-6',
      trigger: 'user',
      phase: 'decode',
      outcome: 'failed',
      durationMs: 125,
      code: 'account.reply.invalid',
      httpStatus: 200,
      businessCode: 4102,
      serverTraceId: 'trace-8',
      fields: {
        operation: 'auth',
        method: 'POST',
        persisted: false,
        count: 0,
        missingConfig: ['API_HOST', 'APP_NAME'],
        attemptedValue: null,
      },
    });
    expect(result.record.truncated).toBeUndefined();
  });

  it('drops unknown top-level and field keys without inspecting entire payloads', () => {
    let reads = 0;
    const rawPayload = { secret: 'raw-payload-must-not-appear' };
    const fields = {
      'count': 4,
      'body': rawPayload,
      'headers': rawPayload,
      'config': rawPayload,
      'store': rawPayload,
      'props': rawPayload,
      'api_key': 'private-field-key',
      'x-api-key': 'private-header-key',
      'unknown': 'uncontrolled-value',
      get 'payload'() {
        reads += 1;
        throw new Error('must not inspect');
      },
    };
    const result = serialize(
      Object.assign(createInput({ fields }), {
        config: rawPayload,
        body: rawPayload,
        headers: rawPayload,
        store: rawPayload,
      }),
    );

    expect(result.record.fields).toEqual({ count: 4 });
    expect(Object.keys(result.record)).not.toEqual(
      expect.arrayContaining(['config']),
    );
    for (const secret of [
      'raw-payload',
      'private-field-key',
      'private-header-key',
      'uncontrolled-value',
    ]) {
      expect(result.line).not.toContain(secret);
    }
    expect(reads).toBe(0);
  });

  it('replaces nested objects, cycles, throwing accessors and nonfinite field values', () => {
    let reads = 0;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    circular.password = 'nested-object-secret';
    const result = serialize(
      createInput({
        fields: {
          attemptedValue: circular,
          savedValue: [{ password: 'array-object-secret' }, Infinity],
          count: NaN,
          get reason() {
            reads += 1;
            throw new Error('getter-secret');
          },
          persisted: true,
        },
      }),
    );

    expect(result.record).toMatchObject({
      truncated: true,
      fields: { persisted: true },
    });
    expect(result.line).not.toMatch(
      /nested-object-secret|array-object-secret|getter-secret|NaN|Infinity/,
    );
    expect(reads).toBe(0);
  });

  it('projects Error chains without losing their code or invoking custom serialization', () => {
    let conversions = 0;
    const cause = Object.assign(new TypeError('token=inner-token-value'), {
      code: 'storage.read.failed',
      stack:
        'TypeError: token=inner-token-value\n at read (/Users/alice/private/cache.ts:8:1)',
    });
    const error = Object.assign(
      new Error('request for user@example.com failed'),
      {
        code: 'account.restore.failed',
        cause,
        stack:
          'Error: request failed\n at restore (/data/user/0/com.portal/files/session.json:5:2)',
        config: { password: 'never-dump-config' },
        toJSON() {
          conversions += 1;
          throw new Error('never call toJSON');
        },
      },
    );
    // 位置投影使用已格式化的静态栈；原生 getter 行为由 Hermes 用例单独验证。
    Object.defineProperty(cause, 'stack', { value: cause.stack });
    Object.defineProperty(error, 'stack', { value: error.stack });
    const result = serialize(createInput({ error }));

    expect(result.record.error).toMatchObject({
      name: 'Error',
      code: 'account.restore.failed',
      cause: { name: 'TypeError', code: 'storage.read.failed' },
    });
    expect(result.record.error?.stack).toContain('at restore');
    expect(result.line).not.toMatch(
      /inner-token-value|user@example.com|\/Users\/alice|\/data\/user\/0|never-dump-config/,
    );
    expect(conversions).toBe(0);
  });

  it('bounds cyclic error causes and safely ignores Error accessors', () => {
    let reads = 0;
    const error = Object.assign(new Error('broken'), {
      code: 'stable.failure',
    });
    Object.defineProperty(error, 'cause', { value: error });
    Object.defineProperty(error, 'stack', {
      get() {
        reads += 1;
        throw new Error('secret-stack');
      },
    });
    const result = serialize(createInput({ error }));

    expect(result.record).toMatchObject({
      truncated: true,
      error: { message: 'broken', code: 'stable.failure' },
    });
    expect(result.line).not.toContain('secret-stack');
    expect(reads).toBe(0);
  });

  it.each([
    { label: 'string', error: 'password=string-reason-secret' },
    { label: 'number', error: 42 },
    { label: 'boolean', error: false },
    { label: 'null', error: null },
    { label: 'symbol', error: Symbol('symbol-secret') },
    { label: 'bigint', error: BigInt(123) },
    { label: 'function', error: () => 'function-secret' },
    { label: 'nonfinite', error: Infinity },
    { label: 'object', error: { password: 'object-reason-secret' } },
    {
      label: 'hostile proxy',
      error: new Proxy(
        {},
        {
          get() {
            throw new Error('proxy-secret');
          },
          getOwnPropertyDescriptor() {
            throw new Error('proxy-secret');
          },
          getPrototypeOf() {
            throw new Error('proxy-secret');
          },
        },
      ),
    },
  ])(
    'accepts an unknown $label reason without leaking object internals',
    ({ error }) => {
      const result = serialize(createInput({ error }));
      expect(result.record.error).toEqual(
        expect.objectContaining({
          name: expect.any(String),
          message: expect.any(String),
        }),
      );
      expect(result.line).not.toMatch(
        /string-reason-secret|symbol-secret|function-secret|object-reason-secret|proxy-secret/,
      );
    },
  );

  it('bounds long Chinese content while preserving event identity and valid UTF-8 JSONL', () => {
    const result = serialize(
      createInput({
        operationId: 'operation-7',
        parentOperationId: 'operation-6',
        code: 'account.reply.invalid',
        fields: { reason: '超长错误上下文'.repeat(4000) },
        error: Object.assign(new Error('超长错误原因'.repeat(2000)), {
          stack: '调试栈'.repeat(4000),
        }),
      }),
    );
    expect(result.record).toMatchObject({
      truncated: true,
      runId: 'run-9',
      identityEpoch: 'epoch-2',
      operationId: 'operation-7',
      parentOperationId: 'operation-6',
      scope: 'account.gateway',
      event: 'auth.failed',
      level: 'warn',
      appVersion: '4.0.0',
      code: 'account.reply.invalid',
    });
  });

  it('uses the caller byte limit and returns null when the necessary record cannot fit', () => {
    const input = createInput({ fields: { reason: '中'.repeat(4000) } });
    expect(serialize(input, 512).record.truncated).toBe(true);
    expect(serializeLogRecord(input, TEST_POLICY, 20)).toBeNull();
  });

  it('escapes lone surrogates and line delimiters without breaking UTF-8 accounting', () => {
    const result = serialize(
      createInput({ fields: { reason: 'a\ud800b\udc00c\n中文😀' } }),
    );
    expect(result.line).toContain('\\ud800');
    expect(result.line).toContain('\\udc00');
    expect(result.record.fields?.reason).toContain('中文😀');
    expect(utf8ByteLength('中文😀\n')).toBe(11);
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('\ud800')).toBe(3);
  });

  it('removes nonfinite optional metadata rather than letting JSON imply a real value', () => {
    const result = serialize(
      createInput({
        durationMs: Infinity,
        httpStatus: NaN,
        businessCode: -Infinity,
        fields: { persisted: false },
      }),
    );
    expect(result.record.truncated).toBe(true);
    expect(result.record.durationMs).toBeUndefined();
    expect(result.record.httpStatus).toBeUndefined();
    expect(result.record.businessCode).toBeUndefined();
    expect(result.record.fields?.persisted).toBe(false);
  });

  it.each([
    null,
    undefined,
    false,
    42,
    'input',
    {},
    createInput({ sequence: NaN }),
    createInput({ level: 'fatal' as 'error' }),
    Object.defineProperty(createInput(), 'runId', {
      get() {
        throw new Error('unsafe');
      },
    }),
  ])('rejects an unsafe required record without throwing (%#)', (input) => {
    expect(serializeLogRecord(input as LogRecordInput, TEST_POLICY)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])(
    'rejects an invalid byte budget (%s)',
    (maxBytes) => {
      expect(
        serializeLogRecord(createInput(), TEST_POLICY, maxBytes),
      ).toBeNull();
    },
  );
});

describe('log text redaction', () => {
  it.each([
    { text: 'apiKey=api-secret-value', secret: 'api-secret-value' },
    { text: 'api_key: api-underscore-secret', secret: 'api-underscore-secret' },
    { text: 'api-key="api-dash-secret"', secret: 'api-dash-secret' },
    { text: 'x-api-key: header-secret-value', secret: 'header-secret-value' },
    {
      text: '{"X_API_KEY":"json-header-secret"}',
      secret: 'json-header-secret',
    },
    { text: 'access_key=access-secret-value', secret: 'access-secret-value' },
    { text: 'clientSecret=client-secret-value', secret: 'client-secret-value' },
    {
      text: 'password: "password with spaces"',
      secret: 'password with spaces',
    },
    { text: 'password=unquoted password phrase', secret: 'password phrase' },
    {
      text: JSON.stringify({ password: 'escaped "private value" phrase' }),
      secret: 'private value',
    },
    {
      text: 'session_token=session-token-secret',
      secret: 'session-token-secret',
    },
    {
      text: 'access_key_secret=access-key-secret-value',
      secret: 'access-key-secret-value',
    },
    { text: 'verification_code=321987', secret: '321987' },
    {
      text: 'cookie: sid=cookie-secret-value; mode=secret-mode',
      secret: 'cookie-secret-value',
    },
    {
      text: 'Authorization: Bearer bearer-secret-value',
      secret: 'bearer-secret-value',
    },
    { text: 'Basic dXNlcjpwYXNzd29yZA==', secret: 'dXNlcjpwYXNzd29yZA==' },
    {
      text: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
    },
    { text: 'phone +86 13812345678', secret: '13812345678' },
    { text: 'phone 138-1234-5678', secret: '138-1234-5678' },
    {
      text: 'email member+test@example.com',
      secret: 'member+test@example.com',
    },
    {
      text: 'deviceId=permanent-device-identifier',
      secret: 'permanent-device-identifier',
    },
    { text: 'android_id: abcdef0123456789', secret: 'abcdef0123456789' },
    { text: 'imei 490154203237518', secret: '490154203237518' },
    { text: 'MAC aa:bb:cc:dd:ee:ff', secret: 'aa:bb:cc:dd:ee:ff' },
    {
      text: 'https://host.example/api/auth?token=query-secret#fragment-secret',
      secret: 'query-secret',
    },
    {
      text: '/api/auth?phone=13812345678#relative-fragment-secret',
      secret: 'relative-fragment-secret',
    },
    {
      text: 'https://host.example/api#fragment-only-secret',
      secret: 'fragment-only-secret',
    },
    { text: 'file:///tmp/selected.jpg', secret: '/tmp/selected.jpg' },
    { text: 'file:///private/secret.jpg', secret: '/private/secret.jpg' },
    {
      text: 'FILE:///tmp/UPPER-SELECTED.JPG',
      secret: '/tmp/UPPER-SELECTED.JPG',
    },
    { text: '/Users/alice/private/session.json', secret: '/Users/alice' },
    { text: '/home/alice/private/session.json', secret: '/home/alice' },
    {
      text: '/var/mobile/Containers/Data/Application/device-secret/Library/file',
      secret: 'device-secret',
    },
    { text: 'C:\\Users\\Alice\\AppData\\session.json', secret: 'Alice' },
  ])(
    'removes $secret from every output string boundary',
    ({ text, secret }) => {
      const result = serialize(
        createInput({
          scope: text,
          event: text,
          operationId: text,
          serverTraceId: text,
          fields: { reason: text, missingConfig: [text] },
          error: {
            name: text,
            message: text,
            code: text,
            stack: text,
            cause: text,
          },
        }),
      );
      expect(result.line).not.toContain(secret);
      expect(result.line).toContain('[REDACTED]');
    },
  );

  it('keeps a route and useful failure classification after stripping URL credentials and parameters', () => {
    const result = serialize(
      createInput({
        code: 'network.timeout',
        fields: {
          endpoint:
            'https://alice:password-value@api.example.com/auth/login?token=secret-query#secret-fragment',
        },
      }),
    );
    expect(result.record.code).toBe('network.timeout');
    expect(result.record.fields?.endpoint).toContain(
      'api.example.com/auth/login',
    );
    expect(result.line).not.toMatch(
      /alice|password-value|secret-query|secret-fragment/,
    );
  });

  it('redacts unlabelled permanent identifiers in text while preserving explicit diagnostic correlation', () => {
    const result = serialize(
      createInput({
        runId: '42bfb225-508b-4ffc-b5ca-c5f47787a8a5',
        operationId: '87972761-e080-4c46-95f6-fc6b520201df',
        serverTraceId: 'd9b36908-1a64-4f2b-a0ae-ad5e3e2a8760',
        fields: {
          reason: 'device 178271cc-f97e-4ddb-9bda-83d4280bebaf failed',
        },
      }),
    );
    expect(result.record.runId).toBe('42bfb225-508b-4ffc-b5ca-c5f47787a8a5');
    expect(result.record.operationId).toBe(
      '87972761-e080-4c46-95f6-fc6b520201df',
    );
    expect(result.record.serverTraceId).toBe(
      'd9b36908-1a64-4f2b-a0ae-ad5e3e2a8760',
    );
    expect(result.line).not.toContain('178271cc-f97e-4ddb-9bda-83d4280bebaf');
  });
});
