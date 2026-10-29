import {
  NORMALIZATION_LIMITS,
  REDACTED_TEXT,
  STACK_AT_PREFIX,
  STACK_FUNCTION_PREFIX,
  STACK_LOCATION_PATTERN,
  STACK_PARENTHESIZED_LOCATION,
  STACK_SOURCE_NAME_PATTERN,
  TRUNCATED_TEXT,
} from './constants';
import { redactLogText } from './redactLogText';
import type { NormalizationState } from './types';

function projectSourceLocation(source: string): string | null {
  const prefix = source.startsWith('address at ') ? 'address at ' : '';
  const location = source.slice(prefix.length).trim();
  const match = STACK_LOCATION_PATTERN.exec(location);
  if (
    !match &&
    !location.includes('/') &&
    !location.includes('\\') &&
    !STACK_SOURCE_NAME_PATTERN.test(location)
  ) {
    return null;
  }
  const path = (match ? match[1] : location).split(/[?#]/, 1)[0];
  const basename = path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  );
  const filename =
    basename.length <= NORMALIZATION_LIMITS.sourceNameCharacters &&
    STACK_SOURCE_NAME_PATTERN.test(basename)
      ? basename
      : null;
  const position = match
    ? `:${match[2]}${match[3] === undefined ? '' : `:${match[3]}`}`
    : '';
  if (!filename) {
    return `${prefix}${REDACTED_TEXT}${position}`;
  }
  return `${prefix}${
    path === basename ? '' : `${REDACTED_TEXT}/`
  }${filename}${position}`;
}

function projectStackLine(line: string, keepFrameText = true): string | null {
  const framePrefix =
    STACK_FUNCTION_PREFIX.exec(line) ?? STACK_AT_PREFIX.exec(line);
  if (!framePrefix) {
    return null;
  }
  const locations: string[] = [];
  const projected = line.replace(
    STACK_PARENTHESIZED_LOCATION,
    (original, source: string) => {
      const location = projectSourceLocation(source);
      if (location === null) {
        return original;
      }
      locations.push(location);
      return `(${location})`;
    },
  );
  if (locations.length > 0) {
    return keepFrameText
      ? projected
      : locations.map((location) => `at ${location}`).join('\n');
  }
  const source = projectSourceLocation(line.slice(framePrefix[0].length));
  return source === null
    ? null
    : `${keepFrameText ? framePrefix[0] : 'at '}${source}`;
}

export function redactLogStack(
  stack: string,
  state: NormalizationState,
): string {
  const oversized = stack.length > NORMALIZATION_LIMITS.stackCharacters;
  const prefix = stack.slice(0, NORMALIZATION_LIMITS.stackCharacters);
  const source = oversized
    ? prefix.slice(0, prefix.lastIndexOf('\n') + 1)
    : prefix;
  const lines = source.split(/\r?\n/);
  if (!oversized) {
    return redactLogText(
      lines.map((line) => projectStackLine(line) ?? line).join('\n'),
      state,
      false,
      NORMALIZATION_LIMITS.stackCharacters,
    );
  }

  state.truncated = true;
  const projected: string[] = [];
  let characters = TRUNCATED_TEXT.length;
  for (const line of lines) {
    const frame = projectStackLine(line, false);
    if (frame === null) {
      continue;
    }
    if (characters + frame.length + 1 > NORMALIZATION_LIMITS.stackCharacters) {
      break;
    }
    projected.push(frame);
    characters += frame.length + 1;
  }
  projected.push(TRUNCATED_TEXT);
  return redactLogText(
    projected.join('\n'),
    state,
    false,
    NORMALIZATION_LIMITS.stackCharacters,
  );
}
