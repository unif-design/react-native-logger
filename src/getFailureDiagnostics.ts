import { FAILURE_CODES, FAILURE_ERROR_TYPES } from './constants';
import { NORMALIZATION_LIMITS } from './normalization/constants';
import { readLogProperty } from './normalization/readLogProperty';
import type { FailureDiagnostics } from './types';
import { getLogSource } from './normalization/getLogSource';

export function getFailureDiagnostics(error: unknown): FailureDiagnostics {
  const result: FailureDiagnostics = {
    errorType: 'unknown',
    reason: 'unknown',
  };
  const state = { truncated: false };
  const seen = new Set<object>();
  let current = error;
  for (
    let depth = 0;
    typeof current === 'object' && current !== null;
    depth++
  ) {
    if (seen.has(current) || depth >= NORMALIZATION_LIMITS.errorDepth) {
      state.truncated = true;
      break;
    }
    seen.add(current);
    let errorType = 'unknown';
    let prototype: object | null = current;
    for (
      let index = 0;
      prototype && index < NORMALIZATION_LIMITS.errorDepth;
      index++
    ) {
      const name = readLogProperty(prototype, 'name', state);
      if (typeof name === 'string') {
        if (Object.hasOwn(FAILURE_ERROR_TYPES, name)) errorType = name;
        break;
      }
      try {
        prototype = Object.getPrototypeOf(prototype);
      } catch {
        state.truncated = true;
        break;
      }
    }
    const code = readLogProperty(current, 'code', state);
    const sourceCode =
      typeof code === 'string' && Object.hasOwn(FAILURE_CODES, code)
        ? code
        : typeof code === 'number' &&
            Number.isSafeInteger(code) &&
            Math.abs(code) <= 2147483647
          ? code
          : undefined;
    const reason =
      typeof sourceCode === 'string'
        ? FAILURE_CODES[sourceCode]
        : (FAILURE_ERROR_TYPES[errorType] ?? 'unknown');
    if (depth === 0) {
      result.errorType = errorType;
      if (sourceCode !== undefined) result.sourceCode = sourceCode;
    } else {
      result.causeType = errorType;
      if (sourceCode !== undefined) result.causeCode = sourceCode;
      else delete result.causeCode;
    }
    if (reason !== 'unknown') result.reason = reason;
    current = readLogProperty(current, 'cause', state);
  }
  if (state.truncated) result.causeTruncated = true;
  const errorSource = getLogSource(error);
  if (errorSource) result.errorSource = errorSource;
  return result;
}
