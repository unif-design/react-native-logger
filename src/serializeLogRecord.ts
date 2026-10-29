import { LOG_LIMITS } from './constants';
import {
  CORRELATION_FIELDS,
  NORMALIZATION_LIMITS,
  OPTIONAL_STRING_FIELDS,
  REQUIRED_STRING_FIELDS,
  UTF16_SURROGATE_UNITS,
} from './normalization/constants';
import { normalizeLogRecord } from './normalization/normalizeLogRecord';
import type {
  DiagnosticRecord,
  LogRecordInput,
  LoggingPolicy,
  SerializedLogRecord,
} from './types';
import { utf8ByteLength } from './utf8ByteLength';

function encodeRecord(record: DiagnosticRecord): SerializedLogRecord {
  const json = JSON.stringify(record).replace(UTF16_SURROGATE_UNITS, (unit) =>
    unit.length === 2
      ? unit
      : `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const line = `${json}\n`;
  return { record, line, bytes: utf8ByteLength(line) };
}

export function serializeLogRecord(
  input: LogRecordInput,
  policy: LoggingPolicy,
  maxBytes = LOG_LIMITS.recordBytes,
): SerializedLogRecord | null {
  try {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      return null;
    }
    const limit = Math.min(Math.floor(maxBytes), LOG_LIMITS.recordBytes);
    const record = normalizeLogRecord(input, policy);
    if (!record) {
      return null;
    }
    let result = encodeRecord(record);
    if (result.bytes <= limit) {
      return result;
    }
    record.truncated = true;
    delete record.fields;
    result = encodeRecord(record);
    if (result.bytes <= limit) {
      return result;
    }
    for (let error = record.error; error; error = error.cause) {
      delete error.stack;
    }
    if (record.error) {
      delete record.error.cause;
      record.error.message = record.error.message.slice(
        0,
        NORMALIZATION_LIMITS.compactCharacters,
      );
    }
    result = encodeRecord(record);
    if (result.bytes <= limit) {
      return result;
    }
    delete record.error;
    for (const key of [...REQUIRED_STRING_FIELDS, ...OPTIONAL_STRING_FIELDS]) {
      if (!CORRELATION_FIELDS.some((candidate) => candidate === key)) {
        const value = record[key];
        if (typeof value === 'string') {
          record[key] = value.slice(0, NORMALIZATION_LIMITS.compactCharacters);
        }
      }
    }
    result = encodeRecord(record);
    return result.bytes <= limit ? result : null;
  } catch {
    return null;
  }
}
