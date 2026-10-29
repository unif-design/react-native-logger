import { TEST_POLICY } from './policyFixture';
import * as logging from '../src';
import { serializeLogRecord } from '../src/serializeLogRecord';

test.each([
  ['ENOSPC', 'storage_full'],
  ['EACCES', 'permission_denied'],
  ['ENOTFOUND', 'dns'],
  ['ECONNRESET', 'connection_reset'],
  ['ETIMEDOUT', 'timeout'],
  ['CERT_HAS_EXPIRED', 'tls'],
  ['SQLITE_BUSY', 'storage_busy'],
  ['ERR_CANCELED', 'cancelled'],
])('底层 %s 可诊断且不保留消息、地址或任意属性', (code, reason) => {
  const failure = Object.assign(new Error('PRIVATE_BODY'), {
    code,
    url: 'https://PRIVATE_URL',
    token: 'PRIVATE_TOKEN',
  });
  expect(logging.getFailureDiagnostics(failure)).toEqual({
    errorType: 'Error',
    sourceCode: code,
    reason,
    errorSource: expect.objectContaining({
      file: 'failureDiagnostics.test.ts',
      line: expect.any(Number),
    }),
  });
});

test('只读取白名单类型、码和有界 cause，不执行访问器或自定义转换', () => {
  const getter = jest.fn(() => {
    throw new Error('PRIVATE_GETTER');
  });
  const error = Object.defineProperties(
    {},
    {
      name: { value: 'PRIVATE_TYPE' },
      code: { value: 'PRIVATE_CODE' },
      message: { get: getter },
      cause: { get: getter },
      toJSON: { value: getter },
      toString: { value: getter },
    },
  );
  const diagnostic = logging.getFailureDiagnostics(error);
  expect(diagnostic).toEqual({
    errorType: 'unknown',
    reason: 'unknown',
    causeTruncated: true,
  });
  expect(getter).not.toHaveBeenCalled();
  expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
});

test('循环和过深原因链明确截断，网络包装保留原始与底层错误码', () => {
  const cause = Object.assign(new Error('PRIVATE_DNS'), { code: 'EAI_AGAIN' });
  const outer = Object.assign(new Error('PRIVATE_REQUEST'), {
    code: 'ERR_NETWORK',
    cause,
  });
  Object.assign(cause, { cause: outer });
  expect(logging.getFailureDiagnostics(outer)).toEqual({
    errorType: 'Error',
    sourceCode: 'ERR_NETWORK',
    reason: 'dns',
    causeType: 'Error',
    causeCode: 'EAI_AGAIN',
    causeTruncated: true,
    errorSource: expect.objectContaining({
      file: 'failureDiagnostics.test.ts',
      line: expect.any(Number),
    }),
  });
});

test('代理对象读取失败和非 Error 拒绝值不影响调用方', () => {
  const unsafe = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error('PRIVATE_PROXY');
      },
    },
  );
  expect(logging.getFailureDiagnostics(unsafe)).toEqual({
    errorType: 'unknown',
    reason: 'unknown',
    causeTruncated: true,
  });
  expect(logging.getFailureDiagnostics('PRIVATE_REJECTION')).toEqual({
    errorType: 'unknown',
    reason: 'unknown',
  });
});

test('数字原生错误码保留但不推测平台含义，真实序列化保留安全字段', () => {
  const fields = logging.getFailureDiagnostics(
    Object.assign(new TypeError('PRIVATE_PATH'), { code: -1009 }),
  );
  const serialized = serializeLogRecord(
    {
      schemaVersion: 1,
      timestamp: '2026-10-29T00:00:00Z',
      sequence: 1,
      runId: 'run',
      identityEpoch: 'epoch',
      appVersion: '4.0.0',
      platform: 'ios',
      osVersion: 'test',
      development: false,
      scope: 'http',
      event: 'failed',
      level: 'warn',
      fields: { ...fields },
    },
    TEST_POLICY,
  );
  expect(serialized?.record.fields).toEqual({
    errorType: 'TypeError',
    sourceCode: -1009,
    reason: 'type_error',
  });
  expect(serialized?.line).not.toContain('PRIVATE_');
});

test('更深原因没有已知码时不借用上一层码，超深原因有明确截断', () => {
  const first = {
    code: 'ERR_NETWORK',
    cause: {
      code: 'ECONNRESET',
      cause: { name: 'PRIVATE_TYPE', code: 'PRIVATE_CODE' },
    },
  };
  const result = logging.getFailureDiagnostics(first);
  expect(result).toMatchObject({
    sourceCode: 'ERR_NETWORK',
    reason: 'connection_reset',
    causeType: 'unknown',
  });
  expect(result.causeCode).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  const deep = { cause: { cause: { cause: { cause: { code: 'ENOSPC' } } } } };
  expect(logging.getFailureDiagnostics(deep)).toMatchObject({
    reason: 'unknown',
    causeTruncated: true,
  });
});
