import type { DiagnosticRecord, LogValue, LoggingPolicy } from '../types';
import {
  CORRELATION_FIELDS,
  LOG_LEVELS,
  LOG_OUTCOMES,
  LOG_TRIGGERS,
  NORMALIZATION_LIMITS,
  OPTIONAL_STRING_FIELDS,
  REQUIRED_STRING_FIELDS,
  UNSERIALIZABLE_TEXT,
} from './constants';
import { normalizeLogError } from './normalizeLogError';
import { readLogProperty } from './readLogProperty';
import { redactLogText } from './redactLogText';
import type { NormalizationState } from './types';
import { normalizeLogSource } from './normalizeLogSource';

function normalizeValue(value: unknown, state: NormalizationState): LogValue {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactLogText(value, state);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  state.truncated = true;
  return UNSERIALIZABLE_TEXT;
}

function normalizeFields(
  source: unknown,
  state: NormalizationState,
  allowedFields: readonly string[],
): DiagnosticRecord['fields'] {
  if (source === undefined) {
    return undefined;
  }
  if (typeof source !== 'object' || source === null) {
    state.truncated = true;
    return undefined;
  }
  const fields: Record<string, LogValue | readonly LogValue[]> = {};
  for (const key of allowedFields) {
    const value = readLogProperty(source, key, state);
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      const length = readLogProperty(value, 'length', state);
      if (
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        state.truncated = true;
        continue;
      }
      const items: LogValue[] = [];
      for (
        let index = 0;
        index < Math.min(length, NORMALIZATION_LIMITS.arrayItems);
        index += 1
      ) {
        items.push(
          normalizeValue(readLogProperty(value, String(index), state), state),
        );
      }
      if (length > NORMALIZATION_LIMITS.arrayItems) {
        state.truncated = true;
      }
      fields[key] = items;
    } else {
      fields[key] = normalizeValue(value, state);
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

export function normalizeLogRecord(
  input: unknown,
  policy: LoggingPolicy,
): DiagnosticRecord | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }
  const state: NormalizationState = { truncated: false };
  const schemaVersion = readLogProperty(input, 'schemaVersion', state);
  const sequence = readLogProperty(input, 'sequence', state);
  const development = readLogProperty(input, 'development', state);
  const level = readLogProperty(input, 'level', state);
  if (
    schemaVersion !== 1 ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    typeof development !== 'boolean' ||
    typeof level !== 'string' ||
    !LOG_LEVELS.some((candidate) => candidate === level)
  ) {
    return null;
  }

  const record = {
    service: redactLogText(policy.service, state),
    schemaVersion,
    sequence,
    development,
    level,
  } as DiagnosticRecord;
  for (const key of REQUIRED_STRING_FIELDS) {
    const value = readLogProperty(input, key, state);
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }
    record[key] = redactLogText(
      value,
      state,
      CORRELATION_FIELDS.some((candidate) => candidate === key),
    );
  }
  for (const key of OPTIONAL_STRING_FIELDS) {
    const value = readLogProperty(input, key, state);
    if (typeof value === 'string') {
      record[key] = redactLogText(
        value,
        state,
        CORRELATION_FIELDS.some((candidate) => candidate === key),
      );
    } else if (value !== undefined) {
      state.truncated = true;
    }
  }
  for (const key of ['durationMs', 'httpStatus', 'businessCode'] as const) {
    const value = readLogProperty(input, key, state);
    if (typeof value === 'number' && Number.isFinite(value)) {
      record[key] = value;
    } else if (key === 'businessCode' && typeof value === 'string') {
      record.businessCode = redactLogText(value, state);
    } else if (value !== undefined) {
      state.truncated = true;
    }
  }
  const trigger = readLogProperty(input, 'trigger', state);
  const outcome = readLogProperty(input, 'outcome', state);
  record.trigger = LOG_TRIGGERS.find((candidate) => candidate === trigger);
  record.outcome = LOG_OUTCOMES.find((candidate) => candidate === outcome);
  if (
    (trigger !== undefined && record.trigger === undefined) ||
    (outcome !== undefined && record.outcome === undefined)
  ) {
    state.truncated = true;
  }
  const fields = normalizeFields(
    readLogProperty(input, 'fields', state),
    state,
    policy.allowedFields,
  );
  if (fields) {
    record.fields = fields;
  }
  const error = readLogProperty(input, 'error', state);
  if (error !== undefined) {
    record.error = normalizeLogError(error, state);
  }
  const source = normalizeLogSource(
    readLogProperty(input, 'source', state),
    state,
  );
  if (source) record.source = source;
  const rawFields = readLogProperty(input, 'fields', state);
  const projectedSource =
    typeof rawFields === 'object' && rawFields !== null
      ? readLogProperty(rawFields, 'errorSource', state)
      : undefined;
  const errorSource = normalizeLogSource(
    readLogProperty(input, 'errorSource', state) ??
      projectedSource ??
      state.errorSource,
    state,
  );
  if (errorSource) record.errorSource = errorSource;
  if (state.truncated) {
    record.truncated = true;
  }
  return record;
}
