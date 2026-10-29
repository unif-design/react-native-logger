import type { DiagnosticError } from '../types';
import { NORMALIZATION_LIMITS, UNSERIALIZABLE_TEXT } from './constants';
import { getLogStackSource } from './getLogStackSource';
import { readLogErrorName } from './readLogErrorName';
import { readLogErrorStack } from './readLogErrorStack';
import { readLogProperty } from './readLogProperty';
import { redactLogStack } from './redactLogStack';
import { redactLogText } from './redactLogText';
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
    return { name: 'NonError', message: redactLogText(reason, state) };
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
    name: redactLogText(name, state),
    message:
      typeof message === 'string'
        ? redactLogText(message, state)
        : UNSERIALIZABLE_TEXT,
  };
  if (typeof message !== 'string') {
    state.truncated = true;
  }
  const code = readLogProperty(reason, 'code', state);
  if (
    typeof code === 'string' ||
    (typeof code === 'number' && Number.isFinite(code))
  ) {
    error.code = redactLogText(String(code), state);
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
