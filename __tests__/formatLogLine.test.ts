import { TEST_POLICY } from './policyFixture';
import { formatLogLine } from '../src/formatLogLine';
import { serializeLogRecord } from '../src/serializeLogRecord';
import type { LogRecordInput } from '../src/types';

function format(
  overrides: Partial<LogRecordInput> = {},
  timeZone?: 'UTC' | 'Asia/Shanghai',
) {
  const serialized = serializeLogRecord(
    {
      schemaVersion: 1,
      timestamp: '2026-10-29T00:00:00.000Z',
      sequence: 1,
      runId: 'run',
      identityEpoch: 'epoch',
      appVersion: '4',
      platform: 'ios',
      osVersion: 'test',
      development: true,
      level: 'warn',
      scope: 'chat',
      event: 'failed',
      ...overrides,
    },
    TEST_POLICY,
  );
  return {
    line: formatLogLine(serialized!.record, timeZone),
    record: serialized!.record,
  };
}

test('文本沿用结构化字段，安全位置与异常源单独可检索', () => {
  const { line, record } = format({
    phase: 'write',
    code: 'failed',
    httpStatus: 503,
    businessCode: 'unavailable',
    operationId: 'op',
    parentOperationId: 'parent',
    serverTraceId: 'trace',
    durationMs: 12,
    source: {
      file: '/Users/PRIVATE_OWNER/src/storage.ts',
      line: 13,
      column: 2,
      functionName: 'save',
    },
    errorSource: { file: 'src/adapter.ts', line: 7, functionName: 'append' },
    fields: {
      reason: 'storage_full',
      count: 1,
      hasResult: false,
      missingConfig: ['A', 'B'],
      dataSource: null,
    },
  });
  expect(record.service).toBe('sample-app');
  expect(line).toContain('op=op parent=parent phase=write code=failed');
  expect(line).toContain(
    'httpStatus=503 businessCode=unavailable durationMs=12 serverTraceId=trace',
  );
  expect(line).toContain('log_source=storage.ts:13:2 log_function=save');
  expect(line).toContain('error_source=src/adapter.ts:7 error_function=append');
  expect(line).toContain('hasResult=false');
  expect(line).toContain('missingConfig=["A","B"]');
  expect(line).not.toContain('PRIVATE_');
});

test('自由文本的控制字符不制造第二行，安全JSON字段不成为原文dump', () => {
  const { line } = format({
    scope: 'chat\n[FORGED]',
    event: 'failure\u2028[FORGED]',
    fields: {
      reason: 'broken\nnext\u0085\u2028\u2029\x1b',
      token: 'PRIVATE_TOKEN',
    },
    error: Object.assign(new Error('PRIVATE_EXCEPTION_TEXT'), { code: 'EIO' }),
  });
  expect(line).not.toMatch(/[\r\n\u007f-\u009f\u2028\u2029]/);
  expect(line).not.toContain(String.fromCharCode(27));
  expect(line).not.toContain('PRIVATE_');
  expect(line).toContain('errorCode=EIO');
});

test('诊断字段裁剪仍显示truncated，不追加完整栈或自定义对象', () => {
  const { line, record } = format({
    fields: { reason: 'x'.repeat(3000) },
    error: {
      name: 'Error',
      message: 'private detail',
      stack: 'Error: private detail\n at work (main.jsbundle:1:123)',
    },
  });
  expect(record.truncated).toBe(true);
  expect(line).toContain('truncated=true');
  expect(line).toContain('error_source=main.jsbundle:1:123');
  expect(line).not.toContain('private detail');
});

test.each([
  ['2026-10-29T00:00:00.000Z', '2026-10-29T08:00:00.000+08:00'],
  ['2026-12-31T20:30:00.123Z', '2027-01-01T04:30:00.123+08:00'],
  ['2028-02-28T20:00:00.000Z', '2028-02-29T04:00:00.000+08:00'],
])('北京时间显示 %s，结构化时间不变', (timestamp, display) => {
  const result = format({ timestamp }, 'Asia/Shanghai');
  expect(result.line.startsWith(`${display} WARN `)).toBe(true);
  expect(result.record.timestamp).toBe(timestamp);
});

test('默认及显式 UTC 都保留原显示', () => {
  const timestamp = '2026-10-29T00:00:00.000Z';
  expect(format({ timestamp }).line.startsWith(`${timestamp} WARN `)).toBe(
    true,
  );
  expect(format({ timestamp }, 'UTC').line).toBe(format({ timestamp }).line);
});

test('无法解析的时间安全保留，不能阻断日志展示', () => {
  expect(format({ timestamp: 'unavailable' }, 'Asia/Shanghai').line).toMatch(
    /^unavailable WARN /,
  );
});
