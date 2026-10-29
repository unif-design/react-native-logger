import {
  readLogRuntime,
  readUnavailableLogFailure,
  readUnavailableLogDiagnostic,
} from './state';
import type { LogStatus } from './types';

export function getLogStatus(): LogStatus {
  return (
    readLogRuntime()?.status() ?? {
      installed: false,
      runId: null,
      identityEpoch: null,
      storageMode: 'memory',
      state: 'unbound',
      writable: false,
      bufferedBytes: 0,
      droppedCount: 0,
      corruptedLines: 0,
      lastFailureCode: readUnavailableLogFailure(),
      ...(readUnavailableLogDiagnostic()
        ? { lastFailure: readUnavailableLogDiagnostic() }
        : {}),
    }
  );
}
