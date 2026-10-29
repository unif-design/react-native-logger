import { TEST_POLICY } from './policyFixture';
import { serializeLogRecord } from '../src/serializeLogRecord';
import { normalizeLogRecord } from '../src/normalization/normalizeLogRecord';
import type { LogRecordInput } from '../src/types';

function input(overrides: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    schemaVersion: 1,
    timestamp: '2026-10-17T00:00:00Z',
    sequence: 1,
    runId: 'run',
    identityEpoch: 'epoch',
    appVersion: '4.0.0',
    platform: 'ios',
    osVersion: '26',
    development: false,
    level: 'error',
    scope: 'files',
    event: 'write_failed',
    ...overrides,
  };
}

test('字段超过字节预算时先移除字段，保留必要记录与真实字节数', () => {
  const result = serializeLogRecord(
    input({ fields: { reason: '中'.repeat(1000) } }),
    TEST_POLICY,
    512,
  )!;
  expect(result).not.toBeNull();
  expect(result.record).toMatchObject({
    runId: 'run',
    event: 'write_failed',
    truncated: true,
  });
  expect(result.record.fields).toBeUndefined();
  expect(result.bytes).toBe(Buffer.byteLength(result.line, 'utf8'));
  expect(result.bytes).toBeLessThanOrEqual(512);
});

test('错误栈和cause超过预算时保留压缩后的错误消息', () => {
  const result = serializeLogRecord(
    input({
      error: {
        name: 'Error',
        message: '错误'.repeat(1000),
        stack: 'Error\n' + ' at read (app.ts:2:1)\n'.repeat(100),
        cause: {
          name: 'Error',
          message: 'cause'.repeat(300),
          stack: ' at read (app.ts:3:1)',
        },
      },
    }),
    TEST_POLICY,
    800,
  )!;
  expect(result).not.toBeNull();
  expect(result.record.error?.message).toHaveLength(128);
  expect(result.record.error?.stack).toBeUndefined();
  expect(result.record.error?.cause).toBeUndefined();
  expect(result.bytes).toBeLessThanOrEqual(800);
  expect(JSON.parse(result.line)).toEqual(result.record);
});

test('必要字符串及可选元数据再次压缩后仍保留关联身份', () => {
  const result = serializeLogRecord(
    input({
      scope: 's'.repeat(1024),
      event: 'e'.repeat(1024),
      phase: 'p'.repeat(1024),
      error: { name: 'Error', message: 'm'.repeat(1024) },
    }),
    TEST_POLICY,
    1000,
  )!;
  expect(result).not.toBeNull();
  expect(result.record).toMatchObject({
    runId: 'run',
    identityEpoch: 'epoch',
    truncated: true,
  });
  expect(result.record.error).toBeUndefined();
  expect(result.record.scope).toHaveLength(128);
  expect(result.record.event).toHaveLength(128);
  expect(result.record.phase).toHaveLength(128);
  expect(result.bytes).toBeLessThanOrEqual(1000);
});

test.each([42, false, 'fields'])(
  '非对象fields %s不能冒充诊断字段',
  (fields) => {
    const result = normalizeLogRecord({ ...input(), fields }, TEST_POLICY);
    expect(result).toMatchObject({ truncated: true });
    expect(result?.fields).toBeUndefined();
  },
);

test('元数据类型错误和未知trigger/outcome显式截断，不透传未知值', () => {
  const result = normalizeLogRecord(
    {
      ...input(),
      phase: 123,
      durationMs: 'slow',
      trigger: 'unexpected',
      outcome: 'unexpected',
      fields: {
        missingConfig: Array.from({ length: 35 }, (_, i) => `key-${i}`),
      },
    },
    TEST_POLICY,
  );
  expect(result).toMatchObject({ truncated: true });
  expect(result?.phase).toBeUndefined();
  expect(result?.durationMs).toBeUndefined();
  expect(result?.trigger).toBeUndefined();
  expect(result?.outcome).toBeUndefined();
  expect(result?.fields?.missingConfig).toHaveLength(32);
});

test.each([Infinity, false])(
  '错误code %s与非文本stack不写成误导性文本',
  (code) => {
    const result = normalizeLogRecord(
      {
        ...input(),
        error: { message: 'failed', code, stack: 123 },
      },
      TEST_POLICY,
    );
    expect(result).toMatchObject({
      truncated: true,
      error: { message: 'failed' },
    });
    expect(result?.error?.code).toBeUndefined();
    expect(result?.error?.stack).toBeUndefined();
  },
);

test('过深cause链只保留上限内层级，停止递归', () => {
  let error: object = { message: 'leaf' };
  for (let i = 0; i < 8; i++) error = { message: `layer-${i}`, cause: error };
  const result = normalizeLogRecord({ ...input(), error }, TEST_POLICY);
  expect(result).toMatchObject({ truncated: true });
  let current = result?.error;
  for (let i = 0; i < 4; i++) current = current?.cause;
  expect(current).toEqual({ name: 'Error', message: '[cause limit]' });
});
