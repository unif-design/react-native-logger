import type { DiagnosticError } from '../types';
import { FAILURE_CODES, FAILURE_ERROR_TYPES } from '../constants';
import { redactLogText } from './redactLogText';
import { NORMALIZATION_LIMITS, UNSERIALIZABLE_TEXT } from './constants';
import { getLogStackSource } from './getLogStackSource';
import { readLogErrorName } from './readLogErrorName';
import { readLogErrorStack } from './readLogErrorStack';
import { readLogProperty } from './readLogProperty';
import { redactLogStack } from './redactLogStack';
import { readTechnicalErrorMessage } from './readTechnicalErrorMessage';
import { normalizeLogSource } from './normalizeLogSource';
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
    const message = `[${reason === null ? 'null' : typeof reason}]`;
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
  const technical = readTechnicalErrorMessage(message);
  const messageTruncated =
    (typeof message === 'string' &&
      message.length > NORMALIZATION_LIMITS.stringCharacters) ||
    technical?.truncated ||
    readLogProperty(reason, 'messageStatus', state) === 'truncated';
  const marker =
    typeof message === 'string' &&
    [
      '[REDACTED]',
      '[unserializable]',
      '[cause limit]',
      '[circular]',
      '[number]',
      '[boolean]',
      '[null]',
      '[undefined]',
      '[symbol]',
      '[bigint]',
      '[function]',
    ].includes(message)
      ? message
      : undefined;
  if (
    readLogProperty(reason, 'truncated', state) === true ||
    (marker && marker !== '[REDACTED]')
  )
    state.truncated = true;
  const error: DiagnosticError = {
    name: Object.hasOwn(FAILURE_ERROR_TYPES, name) ? name : 'Error',
    message:
      technical?.message ??
      marker ??
      (typeof message === 'string' ? '[REDACTED]' : UNSERIALIZABLE_TEXT),
    ...(technical || messageTruncated
      ? ({
          messageStatus: messageTruncated ? 'truncated' : 'technical',
        } as const)
      : {}),
  };
  if (messageTruncated) state.truncated = true;
  if (typeof message !== 'string') {
    state.truncated = true;
  }
  const projectedSource = normalizeLogSource(
    readLogProperty(reason, 'source', state),
    state,
  );
  if (projectedSource) {
    error.source = projectedSource;
    state.errorSource = projectedSource;
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
    if (safeCode)
      error.code = typeof code === 'number' ? code : redactLogText(code, state);
  } else if (code !== undefined) {
    state.truncated = true;
  }
  const stack = readLogErrorStack(reason, readState);
  if (readState.truncated) state.truncated = true;
  else if (!projectedSource) {
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
  // 已确认的安全投影比再次解析脱敏堆栈更完整，子原因也不能将其降级。
  if (projectedSource) state.errorSource = projectedSource;
  return error;
}
