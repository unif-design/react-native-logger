import type { LogFileIO, LogFileScope } from './types';

const scopes = new WeakMap<LogFileIO, LogFileScope>();

export function getLogFileScope(io: LogFileIO): LogFileScope {
  const existing = scopes.get(io);
  if (existing) return existing;
  let serial: Promise<void> = Promise.resolve();
  const scope: LogFileScope = {
    heldSnapshots: new Set(),
    enqueue(operation) {
      const result = serial.then(operation);
      serial = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  scopes.set(io, scope);
  return scope;
}
