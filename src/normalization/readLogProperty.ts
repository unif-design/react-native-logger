import type { NormalizationState } from './types';

export function readLogProperty(
  source: object,
  key: string,
  state: NormalizationState,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      return undefined;
    }
    if (!('value' in descriptor)) {
      state.truncated = true;
      return undefined;
    }
    return descriptor.value;
  } catch {
    state.truncated = true;
    return undefined;
  }
}
