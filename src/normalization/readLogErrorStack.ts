import { NORMALIZATION_LIMITS } from './constants';
import { readLogProperty } from './readLogProperty';
import type { NormalizationState } from './types';

function canFormatNativeErrorStack(
  error: object,
  state: NormalizationState,
): boolean {
  for (const [source, key] of [
    [Error, 'prepareStackTrace'],
    [error, 'name'],
    [error, 'message'],
  ] as const) {
    let current: object | null = source;
    for (let depth = 0; current; depth += 1) {
      if (depth >= NORMALIZATION_LIMITS.errorDepth) {
        state.truncated = true;
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        const safe =
          'value' in descriptor &&
          (key === 'prepareStackTrace'
            ? typeof descriptor.value !== 'function'
            : descriptor.value === undefined ||
              typeof descriptor.value === 'string');
        if (!safe) state.truncated = true;
        if (!safe) return false;
        break;
      }
      current = Object.getPrototypeOf(current);
    }
  }
  return true;
}

export function readLogErrorStack(
  error: object,
  state: NormalizationState,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'stack');
    if (descriptor?.get) {
      // Some engines expose Error.stack lazily. Only their own getter is trusted.
      const nativeGetter = Object.getOwnPropertyDescriptor(
        new Error(),
        'stack',
      )?.get;
      if (descriptor.get === nativeGetter) {
        return canFormatNativeErrorStack(error, state)
          ? descriptor.get.call(error)
          : undefined;
      }
    }
    if (!descriptor) {
      // Hermes 在 Error.prototype 暴露原生 getter，不能通过 error.stack 执行子类自定义访问器。
      const nativeGetter = Object.getOwnPropertyDescriptor(
        Error.prototype,
        'stack',
      )?.get;
      if (nativeGetter) {
        let current: object | null = error;
        for (
          let depth = 0;
          current && depth < NORMALIZATION_LIMITS.errorDepth;
          depth += 1
        ) {
          current = Object.getPrototypeOf(current);
          if (current === Error.prototype)
            return canFormatNativeErrorStack(error, state)
              ? nativeGetter.call(error)
              : undefined;
        }
        if (current) state.truncated = true;
      }
    }
    return readLogProperty(error, 'stack', state);
  } catch {
    state.truncated = true;
    return undefined;
  }
}
