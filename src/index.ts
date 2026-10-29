export { installLogging } from './runtime/installLogging';
export { markLoggingUnavailable } from './state';
export { redactDiagnosticText } from './normalization/redactDiagnosticText';
export { isSensitiveDiagnosticField } from './normalization/isSensitiveDiagnosticField';
export { consoleTransport } from './backend/transports/console';
export type { Logger, LogRecord, LogTransport } from './backend/types';
export { createLogger } from './createLogger';
export { createOperationContext } from './createOperationContext';
export { getLogStatus } from './getLogStatus';
export { getFailureDiagnostics } from './getFailureDiagnostics';
export { getLogRetentionPolicy } from './getLogRetentionPolicy';
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
  FailureDiagnostics,
  LogMetadata,
  LogStatus,
  LogSnapshot,
  OperationContext,
  LogTrigger,
  LoggingHandle,
  LogRetentionPolicy,
} from './types';
