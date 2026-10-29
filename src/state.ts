import type { LogRuntime } from './runtime/types';
import type { LogFileStatus } from './types';
import { getFailureDiagnostics } from './getFailureDiagnostics';

// 运行期资源指针，不发布可订阅状态；初始化和释放由 runtime 管理。
let runtime: LogRuntime | null = null;
let unavailableFailure: string | null = null;
let unavailableDiagnostic: LogFileStatus['lastFailure'];

export function readLogRuntime(): LogRuntime | null {
  return runtime;
}

export function setLogRuntime(value: LogRuntime | null): void {
  runtime = value;
  if (value) {
    unavailableFailure = null;
    unavailableDiagnostic = undefined;
  }
}

export function markLoggingUnavailable(
  code = 'logger.initialize_failed',
  error?: unknown,
): void {
  unavailableFailure = code;
  unavailableDiagnostic =
    error === undefined
      ? undefined
      : {
          phase: code === 'logger.dispose_failed' ? 'dispose' : 'initialize',
          ...getFailureDiagnostics(error),
        };
}

export function readUnavailableLogDiagnostic(): LogFileStatus['lastFailure'] {
  return unavailableDiagnostic ? { ...unavailableDiagnostic } : undefined;
}

export function readUnavailableLogFailure(): string | null {
  return unavailableFailure;
}
