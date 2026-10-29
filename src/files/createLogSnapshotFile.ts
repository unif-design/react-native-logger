import type { LogSnapshotFile } from '../types';
import { LOG_FILE_FAILURES } from './constants';
import { createLogFileError } from './createLogFileError';
import type { LogFileIO, LogFileScope } from './types';

export function createLogSnapshotFile(
  name: string,
  reference: Pick<LogSnapshotFile, 'uri' | 'bytes'>,
  io: LogFileIO,
  scope: LogFileScope,
  onFailure: (error: unknown) => void,
): LogSnapshotFile {
  let released = false;
  let releasing: Promise<void> | undefined;
  return Object.freeze({
    uri: reference.uri,
    bytes: reference.bytes,
    release() {
      if (released) return Promise.resolve();
      if (!releasing) {
        releasing = scope
          .enqueue(async () => {
            try {
              await io.remove(name);
            } catch (error) {
              onFailure(error);
              throw createLogFileError(LOG_FILE_FAILURES.snapshot);
            }
            released = true;
            scope.heldSnapshots.delete(name);
          })
          .finally(() => {
            releasing = undefined;
          });
      }
      return releasing;
    },
  });
}
