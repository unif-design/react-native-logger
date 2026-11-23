import * as defaultLogBackend from './backend';

export { defaultLogBackend };
export { installLogging } from './runtime/installLogging';
export { markLoggingUnavailable } from './runtime/state';
export { redactDiagnosticText } from './normalization/redactDiagnosticText';
export { isSensitiveDiagnosticField } from './normalization/isSensitiveDiagnosticField';
export { consoleTransport } from './backend/transports/console';
export type { Logger, LogRecord, LogTransport } from './backend/types';
export { createLogger } from './runtime/createLogger';
export { createOperationContext } from './runtime/createOperationContext';
export { getLogStatus } from './runtime/getLogStatus';
export { getFailureDiagnostics } from './diagnostics/getFailureDiagnostics';
export { getErrorDiagnostics } from './diagnostics/getErrorDiagnostics';
export { getLogRetentionPolicy } from './policy/getLogRetentionPolicy';
export type {
  AppLogger,
  LogFileStore,
  LogFileStatus,
  LogFileSummary,
  LogClearResult,
  LogSnapshotFile,
  LogFileManagement,
  LogWrite,
  LogOutcome,
  LogValue,
  DiagnosticError,
  DiagnosticRecord,
  LogLevel,
  LogSource,
  LoggingOptions,
  LoggingPolicy,
  LogBackend,
  LogEnvironment,
  ConsoleCaptureOptions,
  LogConsoleTimeZone,
  LogConsoleTimeFormat,
  FailureDiagnostics,
  LogMetadata,
  LogMetadataInput,
  LogStatus,
  LogSnapshot,
  OperationContext,
  LogTrigger,
  LoggingHandle,
  LogRetentionPolicy,
} from './types';
