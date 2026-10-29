import {
  redactDiagnosticText,
  isSensitiveDiagnosticField,
} from '../src/normalization';
import { redactLogText } from '../src/normalization/redactLogText';

test.each([
  ['Authorization: Bearer secret-value', 'secret-value'],
  ['access_key_secret="private key value"', 'private key value'],
  ['Cookie: sid=private-cookie', 'private-cookie'],
  ['手机号 13800138000，邮箱 person@example.com', '13800138000'],
  ['device_id=device-private', 'device-private'],
  ['imei 123456789012345', '123456789012345'],
  ['合成证件 123456789012345678', '123456789012345678'],
  ['合成证件 12345678901234567X', '12345678901234567X'],
  ['合成证件 12345678901234567x', '12345678901234567x'],
  ['00:11:22:AA:BB:CC', '00:11:22:AA:BB:CC'],
  [
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
  ],
  [
    'https://person:private-pass@example.com/path?token=query-private#fragment-private',
    'private-pass',
  ],
  ['file:///private/var/mobile/private-folder/image.jpg', 'private-folder'],
  ['C:\\Users\\Alice\\private-folder\\image.jpg', 'private-folder'],
])('公共文本与 App 复用脱敏规则：%s', (input, sensitive) => {
  const original = input;
  const result = redactDiagnosticText(input);
  expect(result).toContain('[REDACTED]');
  expect(result).not.toContain(sensitive);
  expect(result).not.toMatch(
    /person@example\.com|query-private|fragment-private/,
  );
  expect(input).toBe(original);
  expect(redactLogText(input, { truncated: false })).toBe(result);
});

test('公共文本不套用单条 App 字符限额，尾部敏感内容仍处理', () => {
  const prefix = '正常诊断 '.repeat(2000);
  const input = prefix + 'accessKeySecret=private-tail';
  expect(redactDiagnosticText(input)).toBe(
    prefix + 'accessKeySecret=[REDACTED]',
  );
  const state = { truncated: false };
  expect(redactLogText(input, state)).toBe('[truncated]');
  expect(state.truncated).toBe(true);
});

test('普通文字、空串与换行保持，关联标识例外只留 App 入口', () => {
  const plain = 'phoneModel=iPhone 17\nsessionName=日常会话\nbankName=示例银行';
  expect(redactDiagnosticText(plain)).toBe(plain);
  expect(redactDiagnosticText('')).toBe('');
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const state = { truncated: false };
  expect(redactLogText(id, state, true)).toBe(id);
  expect(state.truncated).toBe(false);
  expect(redactDiagnosticText(id)).toBe('[REDACTED]');
  expect(redactDiagnosticText('工单 ABC1234567890123456789Z')).toBe(
    '工单 ABC1234567890123456789Z',
  );
  expect(redactLogText('123456789012345678', state, true)).toBe(
    '123456789012345678',
  );
});

test.each([
  ['/api/items?x=private#fragment', '/api/items[REDACTED]'],
  ['prefix/api/items#private next', 'prefix/api/items[REDACTED] next'],
  ['/a?x /b#y', '/a[REDACTED] /b[REDACTED]'],
  ['/a?\n/b#', '/a[REDACTED]\n/b[REDACTED]'],
  ['/?x', '/?x'],
  ['//?x', '//[REDACTED]'],
  ['word?x /a?x"tail', 'word?x /a[REDACTED]"tail'],
  ['/路径?x', '/路径?x'],
])('相对地址参数保持现有边界：%s', (input, expected) => {
  expect(redactDiagnosticText(input)).toBe(expected);
});

test('长路径后的非相邻分隔符不改变原文，后续实际地址仍脱敏', () => {
  const prefix = '/x'.repeat(32768) + '\n?';
  expect(redactDiagnosticText(prefix)).toBe(prefix);
  expect(redactDiagnosticText(prefix + ' /safe?private')).toBe(
    prefix + ' /safe[REDACTED]',
  );
});

test.each([
  ['protocol', 'a.'.repeat(16384) + '\n://'],
  ['email', 'a.'.repeat(16384) + '\n@'],
  ['jwt', 'eyJ-'.repeat(8192) + '\n..'],
])('长候选段在 %s 分隔符不相邻时保持原文', (_kind, input) => {
  expect(redactDiagnosticText(input)).toBe(input);
});

test('协议、邮箱与 JWT 的实际匹配仍按原规则替换', () => {
  expect(redactDiagnosticText('prefix eyJ-a.b_c.d-e suffix')).toBe(
    'prefix [REDACTED] suffix',
  );
  expect(redactDiagnosticText('a+id@host.example')).toBe('[REDACTED]');
  expect(redactDiagnosticText('custom+app://host/path?private')).toBe(
    'custom+app://host/path[REDACTED]',
  );
});

test.each([
  'accessKeySecret',
  'access_key_secret',
  'ACCESS-KEY-ID',
  'x-api-key',
  'Client Secret',
  'authorization',
  'Set_Cookie',
  'password',
  'otp',
  'authCode',
  'deviceUUID',
  'android_id',
  'idfa',
  'imei',
  'credential',
  'session',
  'idcard',
  'phone',
  'mobile',
  'bank',
])('完整敏感字段 %s 被识别且不依赖上一次匹配', (name) => {
  expect(isSensitiveDiagnosticField(name)).toBe(true);
  expect(isSensitiveDiagnosticField('phoneModel')).toBe(false);
  expect(isSensitiveDiagnosticField(name)).toBe(true);
});

test.each([
  'phoneModel',
  'sessionName',
  'bankName',
  'author',
  'authStatus',
  'mobileOs',
  'tokenCount',
  'passwordPolicy',
  'businessCode',
  'arbitraryCustomField',
  '',
])('正常字段 %s 不因片段或 App 准入名单被删掉', (name) => {
  expect(isSensitiveDiagnosticField(name)).toBe(false);
});

test.each([
  'accessKeySecret',
  'access_key_secret',
  'Client Secret',
  'deviceUUID',
  'x-api-key',
])('字段与文本赋值共用名称规则：%s', (name) => {
  expect(isSensitiveDiagnosticField(name)).toBe(true);
  expect(redactDiagnosticText(`${name}=private-value`)).toBe(
    `${name}=[REDACTED]`,
  );
});
