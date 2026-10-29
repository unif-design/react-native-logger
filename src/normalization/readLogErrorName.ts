import { NORMALIZATION_LIMITS } from './constants';
import { readLogProperty } from './readLogProperty';
import type { NormalizationState } from './types';

export function readLogErrorName(
  error: object,
  state: NormalizationState,
): string {
  let current: object | null = error;
  for (
    let depth = 0;
    current && depth < NORMALIZATION_LIMITS.errorDepth;
    depth += 1
  ) {
    const name = readLogProperty(current, 'name', state);
    if (typeof name === 'string') return name;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      state.truncated = true;
      break;
    }
  }
  return 'Error';
}
