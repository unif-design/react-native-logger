import { BEIJING_OFFSET_MS } from './constants';
import type {
  DiagnosticRecord,
  LogSource,
  LogValue,
  LogConsoleTimeZone,
  LogConsoleTimeFormat,
} from './types';

function atom(value: LogValue | readonly LogValue[]): string {
  return typeof value === 'string' && /^[a-z\d_.:/-]+$/i.test(value)
    ? value
    : JSON.stringify(value).replace(
        /[\u007f-\u009f\u2028\u2029]/g,
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
}

export function formatLogLine(
  record: DiagnosticRecord,
  timeZone: LogConsoleTimeZone = 'UTC',
  timeFormat: LogConsoleTimeFormat = 'iso',
): string {
  let timestamp = atom(record.timestamp);
  if (timeZone === 'Asia/Shanghai' || timeFormat === 'datetime') {
    const offset = timeZone === 'Asia/Shanghai' ? BEIJING_OFFSET_MS : 0;
    const display = new Date(Date.parse(record.timestamp) + offset);
    if (Number.isFinite(display.getTime())) {
      const iso = display.toISOString();
      timestamp =
        timeFormat === 'datetime'
          ? iso.slice(0, -5).replace('T', ' ')
          : iso.replace(/Z$/, '+08:00');
    }
  }
  const parts = [
    timestamp,
    record.level.toUpperCase(),
    `[${record.service}]`,
    `[${atom(record.scope)}]`,
    atom(record.event),
  ];
  function add(key: string, value: LogValue | readonly LogValue[] | undefined) {
    if (value !== undefined) parts.push(`${key}=${atom(value)}`);
  }
  function source(key: string, value: LogSource | undefined) {
    if (!value) return;
    add(
      key,
      `${value.file}:${value.line}${value.column === undefined ? '' : `:${value.column}`}`,
    );
    add(
      key === 'log_source' ? 'log_function' : 'error_function',
      value.functionName,
    );
  }
  add('summary', record.fields?.summary);
  add('op', record.operationId);
  add('parent', record.parentOperationId);
  add('phase', record.phase);
  add('outcome', record.outcome);
  add('code', record.code);
  add('httpStatus', record.httpStatus);
  add('businessCode', record.businessCode);
  add('durationMs', record.durationMs);
  add('serverTraceId', record.serverTraceId);
  source('log_source', record.source);
  source('error_source', record.errorSource);
  if (record.error) {
    add('errorType', record.error.name);
    add('errorCode', record.error.code);
  }
  for (const [key, value] of Object.entries(record.fields ?? {})) {
    if (key !== 'summary') add(key, value);
  }
  if (record.truncated) add('truncated', true);
  return parts.join(' ');
}
