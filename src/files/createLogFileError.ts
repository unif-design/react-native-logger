import type { LogFileError } from './types';

export function createLogFileError(code: string): LogFileError {
  return Object.assign(new Error(code), { code });
}
