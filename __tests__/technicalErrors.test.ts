import * as logging from '../src';
import { normalizeLogError } from '../src/normalization/normalizeLogError';
import { serializeLogRecord } from '../src/serializeLogRecord';
import { TEST_POLICY } from './policyFixture';

test.each([
  [
    'java.net.UnknownHostException: Unable to resolve host "PRIVATE_HOST": No address associated with hostname',
    'Unable to resolve host',
    'dns',
  ],
  [
    'SSLHandshakeException: Chain validation failed for PRIVATE_HOST',
    'Chain validation failed',
    'tls',
  ],
  [
    'SQLITE_BUSY: database is locked (PRIVATE_QUERY)',
    'database is locked',
    'storage_busy',
  ],
  [
    'ENOENT: no such file or directory, open /Users/PRIVATE/file.txt',
    'no such file or directory',
    'not_found',
  ],
  ['Permission denied: PRIVATE_FILE', 'Permission denied', 'permission_denied'],
  [
    'Cannot read properties of undefined (reading PRIVATE_FIELD)',
    'Cannot read properties of undefined',
    'type_error',
  ],
  [
    'Unexpected token PRIVATE_BODY in JSON at position 5',
    'Unexpected token',
    'invalid_response',
  ],
])(
  '受控诊断保留可确认技术原因，省略动态正文：%s',
  (message, expected, reason) => {
    const error = new Error(message);
    const projected = normalizeLogError(error, { truncated: false });
    expect(projected.message).toContain(expected);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE');
    expect(logging.getFailureDiagnostics(error).reason).toBe(reason);
  },
);

test('公开投影经过真实序列化仍保留技术cause和stack，任意业务全文不输出', () => {
  expect(typeof logging.getErrorDiagnostics).toBe('function');
  const original = Object.assign(new Error('PRIVATE_USER_TEXT'), {
    code: 'ERR_NETWORK',
    cause: Object.assign(
      new Error('ECONNREFUSED: Connection refused PRIVATE_HOST'),
      { code: 'ECONNREFUSED' },
    ),
    response: { data: 'PRIVATE_BODY' },
    config: { token: 'PRIVATE_TOKEN' },
  });
  const error = logging.getErrorDiagnostics(original);
  const result = serializeLogRecord(
    {
      schemaVersion: 1,
      timestamp: '2026-11-16T00:00:00.000Z',
      sequence: 1,
      appVersion: '1',
      platform: 'android',
      osVersion: '16',
      development: false,
      runId: 'run',
      identityEpoch: 'identity',
      scope: 'http',
      event: 'request.failed',
      level: 'warn',
      error,
    },
    TEST_POLICY,
  )!;
  expect(result.record.error?.cause?.message).toContain('Connection refused');
  expect(result.record.error?.cause?.code).toBe('ECONNREFUSED');
  expect(result.record.error?.stack).toContain('technicalErrors.test.ts');
  expect(result.line).not.toContain('PRIVATE');
  expect(original.message).toBe('PRIVATE_USER_TEXT');
});

test.each([
  'Operation timed out',
  'TLS handshake failed',
  'Invalid cryptographic parameters',
])('已投影诊断再次归一化保持技术事实：%s', (message) => {
  const projected = normalizeLogError(new Error(message), { truncated: false });
  expect(projected.message).toBe(message);
  expect(normalizeLogError(projected, { truncated: false }).message).toBe(
    message,
  );
});

test('不可取得message与循环/过长原因链明确标记，不调用访问器或丢成普通正文', () => {
  const getter = jest.fn(() => 'PRIVATE');
  const cause = Object.defineProperty({}, 'message', { get: getter });
  const error = Object.assign(new Error('Permission denied: PRIVATE'), {
    cause,
  });
  const projected = logging.getErrorDiagnostics(error);
  expect(projected.cause?.message).toBe('[unserializable]');
  expect(projected.truncated).toBe(true);
  expect(
    normalizeLogError(projected, { truncated: false }).cause?.message,
  ).toBe('[unserializable]');
  expect(getter).not.toHaveBeenCalled();
  Object.assign(error, { cause: error });
  expect(logging.getErrorDiagnostics(error).cause?.message).toBe('[circular]');
  const oversized = logging.getErrorDiagnostics(
    new Error('Permission denied: ' + 'PRIVATE'.repeat(500)),
  );
  expect(oversized.message).toBe('Permission denied');
  expect(oversized.messageStatus).toBe('truncated');
});

test.each([
  ['ReferenceError', 'reference_error'],
  ['QuotaExceededError', 'storage_full'],
  ['BusinessError', 'unknown'],
  ['SecurityException', 'permission_denied'],
  ['SQLiteException', 'storage_error'],
  ['JSONException', 'invalid_response'],
])('固定平台与SDK错误名%s保留类型，任意消息仍隐藏', (name, reason) => {
  const original = { name, message: 'PRIVATE_BODY', code: 401 };
  expect(logging.getErrorDiagnostics(original)).toMatchObject({
    name,
    message: '[REDACTED]',
    code: 401,
  });
  expect(logging.getFailureDiagnostics(original).reason).toBe(reason);
});

test('已投影安全source可进入真实error字段，未知长正文与伪造属性不落盘', () => {
  const original = new Error('PRIVATE_BODY');
  const projected = logging.getErrorDiagnostics(original);
  expect(projected.source).toMatchObject({
    file: 'technicalErrors.test.ts',
    line: expect.any(Number),
  });
  const normalized = normalizeLogError(projected, { truncated: false });
  expect(normalized.source).toEqual(projected.source);
  expect(normalized.message).toBe('[REDACTED]');
  expect(JSON.stringify(normalized)).not.toContain('PRIVATE');
});

test('数字SDK码经过公开投影及再次序列化仍是原始技术码', () => {
  const original = { name: 'BusinessError', code: 401, message: 'PRIVATE' };
  const projected = logging.getErrorDiagnostics(original);
  expect(projected.code).toBe(401);
  expect(normalizeLogError(projected, { truncated: false }).code).toBe(401);
  const large = logging.getErrorDiagnostics({
    name: 'Error',
    message: 'PRIVATE'.repeat(1000),
  });
  expect(large).toMatchObject({
    message: '[REDACTED]',
    messageStatus: 'truncated',
    truncated: true,
  });
});

test.each([
  [
    'java.net.ConnectException: Failed to connect to PRIVATE_HOST:8080',
    'Connection attempt failed',
    'connection_failed',
  ],
  [
    'java.net.UnknownServiceException: CLEARTEXT communication to PRIVATE_HOST not permitted by network security policy',
    'Cleartext traffic not permitted',
    'cleartext_not_permitted',
  ],
])(
  'Android可确认诊断只保留具体事实，不猜成拒绝连接或TLS：%s',
  (message, expected, reason) => {
    const original = new Error(message);
    const projected = logging.getErrorDiagnostics(original);
    expect(projected.message).toBe(expected);
    expect(normalizeLogError(projected, { truncated: false }).message).toBe(
      expected,
    );
    expect(logging.getFailureDiagnostics(original).reason).toBe(reason);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_HOST');
  },
);

test.each([false, true])(
  '重复安全投影及实际序列化保留完整来源，不被脱敏stack降级：cause=%s',
  (withCause) => {
    const original = {
      name: 'Error',
      message: 'Connection refused PRIVATE_HOST',
      stack:
        'Error: Connection refused PRIVATE_HOST\n    at send (src/client.ts:12:4)',
      ...(withCause
        ? {
            cause: {
              name: 'Error',
              message: 'Permission denied PRIVATE_FILE',
              stack:
                'Error: Permission denied PRIVATE_FILE\n    at open (src/storage.ts:23:8)',
            },
          }
        : {}),
    };
    const expected = withCause
      ? { file: 'src/storage.ts', line: 23, column: 8, functionName: 'open' }
      : { file: 'src/client.ts', line: 12, column: 4, functionName: 'send' };
    const first = logging.getErrorDiagnostics(original);
    expect(first.source).toEqual(expected);
    const twice = logging.getErrorDiagnostics(first);
    expect(twice.source).toEqual(expected);
    for (const error of [first, twice]) {
      const result = serializeLogRecord(
        {
          schemaVersion: 1,
          timestamp: '2026-11-16T00:00:00.000Z',
          sequence: 1,
          appVersion: '1',
          platform: 'android',
          osVersion: '16',
          development: false,
          runId: 'run',
          identityEpoch: 'identity',
          scope: 'http',
          event: 'request.failed',
          level: 'warn',
          error,
        },
        TEST_POLICY,
      )!;
      expect(result.record.error?.source).toEqual(expected);
      expect(result.record.errorSource).toEqual(expected);
      expect(result.line).not.toContain('PRIVATE');
    }
  },
);

test.each([
  [42, '[number]'],
  [false, '[boolean]'],
  [null, '[null]'],
  [undefined, '[undefined]'],
  [Symbol('PRIVATE'), '[symbol]'],
  [BigInt(123), '[bigint]'],
  [() => 'PRIVATE', '[function]'],
  [Infinity, '[number]'],
  ['PRIVATE_REJECTION', '[REDACTED]'],
])('非Error拒绝值重复投影保留安全类型标记：%s', (value, marker) => {
  const first = logging.getErrorDiagnostics(value);
  expect(first).toMatchObject({ name: 'NonError', message: marker });
  const twice = logging.getErrorDiagnostics(first);
  expect(twice).toEqual(first);
  const normalized = normalizeLogError(twice, { truncated: false });
  expect(normalized).toMatchObject({ name: 'NonError', message: marker });
  expect(JSON.stringify(normalized)).not.toContain('PRIVATE');
});
