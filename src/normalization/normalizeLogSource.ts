import type { LogSource } from '../types';
import { NORMALIZATION_LIMITS, STACK_SOURCE_NAME_PATTERN } from './constants';
import { readLogProperty } from './readLogProperty';
import { redactLogText } from './redactLogText';
import type { NormalizationState } from './types';

function readSourceFile(
  value: unknown,
  state: NormalizationState,
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > NORMALIZATION_LIMITS.stackCharacters
  ) {
    return undefined;
  }
  const path = value.split(/[?#]/, 1)[0];
  const basename = path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  );
  if (
    basename.length > NORMALIZATION_LIMITS.sourceNameCharacters ||
    !STACK_SOURCE_NAME_PATTERN.test(basename) ||
    redactLogText(basename, state) !== basename
  ) {
    return undefined;
  }
  if (
    /^(?:src|__tests__)\/(?:[a-z\d_$.-]+\/)*[a-z\d_$.-]+$/i.test(path) &&
    !path.split('/').some((segment) => segment === '.' || segment === '..') &&
    path.length <= NORMALIZATION_LIMITS.sourceNameCharacters &&
    redactLogText(path, state) === path
  ) {
    return path;
  }
  return basename;
}

function isSourcePosition(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= NORMALIZATION_LIMITS.sourcePosition
  );
}

export function normalizeLogSource(
  value: unknown,
  state: NormalizationState,
): LogSource | undefined {
  if (typeof value !== 'object' || value === null) {
    if (value !== undefined) state.truncated = true;
    return undefined;
  }
  try {
    if (Array.isArray(value)) {
      state.truncated = true;
      return undefined;
    }
  } catch {
    state.truncated = true;
    return undefined;
  }
  const file = readSourceFile(readLogProperty(value, 'file', state), state);
  const line = readLogProperty(value, 'line', state);
  const column = readLogProperty(value, 'column', state);
  if (
    !file ||
    !isSourcePosition(line, 1) ||
    (column !== undefined && !isSourcePosition(column, 0))
  ) {
    state.truncated = true;
    return undefined;
  }
  const source: LogSource = { file, line };
  if (typeof column === 'number') source.column = column;
  const functionName = readLogProperty(value, 'functionName', state);
  if (functionName !== undefined) {
    if (
      typeof functionName === 'string' &&
      functionName.length <= NORMALIZATION_LIMITS.sourceNameCharacters &&
      functionName !== 'anonymous' &&
      /^[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*$/i.test(functionName) &&
      redactLogText(functionName, state) === functionName
    ) {
      source.functionName = functionName;
    } else {
      state.truncated = true;
    }
  }
  return source;
}
