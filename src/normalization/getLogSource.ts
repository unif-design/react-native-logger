import type { LogSource } from '../types';
import { NORMALIZATION_LIMITS } from './constants';
import { getLogStackSource } from './getLogStackSource';
import { readLogErrorName } from './readLogErrorName';
import { readLogErrorStack } from './readLogErrorStack';
import { readLogProperty } from './readLogProperty';
import type { NormalizationState } from './types';

export function getLogSource(
  error: unknown,
  skipFrames = 0,
): LogSource | undefined {
  if (
    !Number.isInteger(skipFrames) ||
    skipFrames < 0 ||
    skipFrames >= NORMALIZATION_LIMITS.sourceFrames
  ) {
    return undefined;
  }
  const seen = new WeakSet<object>();
  let source: LogSource | undefined;
  let current = error;
  for (let depth = 0; depth < NORMALIZATION_LIMITS.errorDepth; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current))
      break;
    seen.add(current);
    const state: NormalizationState = { truncated: false };
    const message = readLogProperty(current, 'message', state);
    const name = readLogErrorName(current, state);
    const stack = readLogErrorStack(current, state);
    if (!state.truncated)
      source =
        getLogStackSource(stack, name, message, state, skipFrames) ?? source;
    current = readLogProperty(current, 'cause', state);
  }
  return source;
}
