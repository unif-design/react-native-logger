import type { LogSource } from '../types';
import {
  NORMALIZATION_LIMITS,
  STACK_AT_PREFIX,
  STACK_LOCATION_PATTERN,
} from './constants';
import { normalizeLogSource } from './normalizeLogSource';
import type { NormalizationState } from './types';

export function getLogStackSource(
  stack: unknown,
  name: string,
  message: unknown,
  state: NormalizationState,
  skipFrames = 0,
): LogSource | undefined {
  if (
    typeof stack !== 'string' ||
    stack.length > NORMALIZATION_LIMITS.stackCharacters ||
    name.length > NORMALIZATION_LIMITS.stackCharacters ||
    (message !== undefined && typeof message !== 'string') ||
    (typeof message === 'string' &&
      message.length > NORMALIZATION_LIMITS.stackCharacters)
  ) {
    return undefined;
  }
  const description = message ?? '';
  const headers =
    name && !description
      ? [name, `${name}: `]
      : [name && description ? `${name}: ${description}` : name || description];
  const header = headers.find(
    (value) =>
      stack === value ||
      stack.startsWith(`${value}\n`) ||
      stack.startsWith(`${value}\r\n`),
  );
  const frameText =
    header === undefined
      ? stack
      : stack.slice(header.length).replace(/^\r?\n/, '');
  const lines = frameText.split(/\r?\n/, NORMALIZATION_LIMITS.sourceFrames + 1);
  let frameIndex = 0;
  for (const [index, line] of lines.entries()) {
    const at = STACK_AT_PREFIX.exec(line);
    const jsc = at
      ? null
      : /^(?:([a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*)|(?:global code))?@(.*)$/i.exec(
          line,
        );
    if (!at && !jsc) {
      if (index === 0) return undefined;
      continue;
    }
    if (frameIndex++ < skipFrames) continue;
    if (frameIndex > NORMALIZATION_LIMITS.sourceFrames) break;
    let location = at ? line.slice(at[0].length) : jsc![2];
    let functionName = jsc?.[1];
    if (at && location.endsWith(')')) {
      const open = location.lastIndexOf('(');
      if (open < 0) continue;
      functionName = location
        .slice(0, open)
        .trim()
        .replace(/^(?:async |new )/, '');
      location = location.slice(open + 1, -1);
    }
    const match = STACK_LOCATION_PATTERN.exec(
      location.replace(/^address at /, '').trim(),
    );
    if (!match) continue;
    const source = normalizeLogSource(
      {
        file: match[1],
        line: Number(match[2]),
        ...(match[3] === undefined ? {} : { column: Number(match[3]) }),
        ...(functionName === undefined ? {} : { functionName }),
      },
      state,
    );
    if (source) return source;
  }
  return undefined;
}
