import type { DiagnosticError } from '../types';
import { FAILURE_CODES, FAILURE_ERROR_TYPES } from '../constants';
import { redactLogText } from './redactLogText';
import { NORMALIZATION_LIMITS, UNSERIALIZABLE_TEXT } from './constants';
import { getLogStackSource } from './getLogStackSource';
import { readLogErrorName } from './readLogErrorName';
import { readLogErrorStack } from './readLogErrorStack';
import { readLogProperty } from './readLogProperty';
import { redactLogStack } from './redactLogStack';
import type { NormalizationState } from './types';

export function normalizeLogError(
  reason: unknown,
  state: NormalizationState,
  seen = new WeakSet<object>(),
  depth = 0,
): DiagnosticError {
  if (depth >= NORMALIZATION_LIMITS.errorDepth) {
    state.truncated = true;
    return { name: 'Error', message: '[cause limit]' };
  }
  if (typeof reason === 'string') {
    return { name: 'NonError', message: '[REDACTED]' };
  }
  if (typeof reason !== 'object' || reason === null) {
    state.truncated = true;
    const message =
      typeof reason === 'boolean' ||
      (typeof reason === 'number' && Number.isFinite(reason))
        ? String(reason)
        : `[${reason === null ? 'null' : typeof reason}]`;
    return { name: 'NonError', message };
  }
  if (seen.has(reason)) {
    state.truncated = true;
    return { name: 'Error', message: '[circular]' };
  }
  seen.add(reason);

  const readState: NormalizationState = { truncated: false };
  const message = readLogProperty(reason, 'message', readState);
  const name = readLogErrorName(reason, readState);
  const error: DiagnosticError = {
    name: Object.hasOwn(FAILURE_ERROR_TYPES, name) ? name : 'Error',
    message: typeof message === 'string' ? '[REDACTED]' : UNSERIALIZABLE_TEXT,
  };
  if (typeof message !== 'string') {
    state.truncated = true;
  }
  const code = readLogProperty(reason, 'code', state);
  if (
    typeof code === 'string' ||
    (typeof code === 'number' && Number.isFinite(code))
  ) {
    // 允许已知平台码和固定命名空间的应用故障码，不保留任意账号式字符串。
    const safeCode =
      typeof code === 'number'
        ? Number.isSafeInteger(code) && Math.abs(code) <= 2147483647
        : Object.hasOwn(FAILURE_CODES, code) ||
          /^[a-z][a-z_]*\.(?:[a-z][a-z_]*\.){0,2}(?:failed|failure|unavailable|invalid_[a-z_]+)$/.test(
            code,
          );
    if (safeCode) error.code = redactLogText(String(code), state);
  } else if (code !== undefined) {
    state.truncated = true;
  }
  const stack = readLogErrorStack(reason, readState);
  if (readState.truncated) state.truncated = true;
  else {
    const source = getLogStackSource(stack, name, message, readState);
    if (source) state.errorSource = source;
  }
  if (typeof stack === 'string') {
    error.stack = redactLogStack(stack, state);
  } else if (stack !== undefined) {
    state.truncated = true;
  }
  const cause = readLogProperty(reason, 'cause', state);
  if (cause !== undefined) {
    error.cause = normalizeLogError(cause, state, seen, depth + 1);
  }
  return error;
}
