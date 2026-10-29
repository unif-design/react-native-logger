import type { LogFileStatus } from '../types';
import { LOG_CLEAR_MESSAGES, LOG_FILE_FAILURES } from './constants';
import { createLogBuffer, resolveLogFileLimits } from './createLogBuffer';
import { createLogFileError } from './createLogFileError';
import { getLogPartition } from './fileNames';
import type { LogFileStore, NativeLogFilesOptions } from './types';

export function createLogFiles(_options: NativeLogFilesOptions): LogFileStore {
  const buffer = createLogBuffer(resolveLogFileLimits());
  let ownerKey: string | null | undefined;
  let identityEpoch: string | undefined;
  let state: LogFileStatus['state'] = 'unbound';

  return {
    async setOwner(nextOwner, nextEpoch) {
      if (
        state === 'disposed' ||
        (ownerKey !== undefined &&
          ownerKey === nextOwner &&
          identityEpoch === nextEpoch)
      ) {
        return;
      }
      if (ownerKey !== undefined) {
        buffer.clear();
      }
      ownerKey = nextOwner;
      identityEpoch = nextEpoch;
      state = 'ready';
    },
    append(entry) {
      try {
        if (
          state === 'disposed' ||
          (ownerKey === undefined
            ? !entry.startup
            : entry.identityEpoch !== identityEpoch)
        ) {
          buffer.drop();
        } else {
          buffer.append({
            ...entry,
            partition: getLogPartition(ownerKey ?? null),
          });
        }
      } catch {
        buffer.drop();
      }
    },
    async flush() {},
    getStatus: () => ({
      storageMode: 'memory',
      state,
      writable: state === 'ready',
      bufferedBytes: buffer.getBytes(),
      droppedCount: buffer.getDroppedCount(),
      corruptedLines: 0,
      lastFailureCode: null,
    }),
    async readSummary() {
      throw createLogFileError(LOG_FILE_FAILURES.unsupported);
    },
    async clear() {
      return {
        status: 'failed',
        code: LOG_FILE_FAILURES.unsupported,
        message: LOG_CLEAR_MESSAGES.failed,
      };
    },
    async createSnapshot() {
      throw createLogFileError(LOG_FILE_FAILURES.unsupported);
    },
    async readSnapshot() {
      throw createLogFileError(LOG_FILE_FAILURES.unsupported);
    },
    async releaseSnapshot() {
      throw createLogFileError(LOG_FILE_FAILURES.unsupported);
    },
    async takeSnapshotFile() {
      throw createLogFileError(LOG_FILE_FAILURES.unsupported);
    },
    dispose() {
      state = 'disposed';
      buffer.clear();
    },
  };
}
