import type { LogLevel, Logger, LogTransport } from './backend/types';

export type { LogLevel } from './backend/types';
export type LogConsoleTimeZone = 'UTC' | 'Asia/Shanghai';
export type LogTrigger = 'user' | 'startup' | 'background' | 'h5' | 'system';
export type LogOutcome =
  | 'success'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'superseded'
  | 'unsupported'
  | 'requires_action';
export type LogValue = string | number | boolean | null;

export interface LogSource {
  file: string;
  line: number;
  column?: number;
  functionName?: string;
}

export interface FailureDiagnostics {
  errorType: string;
  reason: string;
  sourceCode?: string | number;
  causeType?: string;
  causeCode?: string | number;
  causeTruncated?: boolean;
  errorSource?: LogSource;
}

export interface LogEnvironment {
  appVersion: string;
  installedAppVersion?: string;
  bundleId?: string;
  buildNumber?: string;
  platform: string;
  osVersion: string;
  deviceModel?: string;
  systemName?: string;
  systemVersion?: string;
  development: boolean;
}

export interface OperationContext {
  readonly runId: string;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly identityEpoch: string;
  readonly trigger: LogTrigger;
  readonly startedAt: number;
}

export interface LogMetadata {
  context?: OperationContext;
  phase?: string;
  outcome?: LogOutcome;
  code?: string;
  httpStatus?: number;
  businessCode?: string | number;
  serverTraceId?: string;
  fields?: Readonly<Record<string, unknown>>;
  error?: unknown;
}

export interface LogRecordInput extends LogEnvironment {
  schemaVersion: 1;
  timestamp: string;
  sequence: number;
  runId: string;
  identityEpoch: string;
  level: LogLevel;
  scope: string;
  event: string;
  trigger?: LogTrigger;
  operationId?: string;
  parentOperationId?: string;
  durationMs?: number;
  phase?: string;
  outcome?: LogOutcome;
  code?: string;
  httpStatus?: number;
  businessCode?: string | number;
  serverTraceId?: string;
  fields?: Readonly<Record<string, unknown>>;
  error?: unknown;
  source?: LogSource;
  errorSource?: LogSource;
}

export interface DiagnosticError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: DiagnosticError;
}

export interface DiagnosticRecord extends Omit<
  LogRecordInput,
  'error' | 'fields'
> {
  service: string;
  fields?: Readonly<Record<string, LogValue | readonly LogValue[]>>;
  error?: DiagnosticError;
  truncated?: boolean;
}

export interface SerializedLogRecord {
  record: DiagnosticRecord;
  line: string;
  bytes: number;
}

export interface AppLogger {
  debug(event: string, metadata?: LogMetadata): void;
  info(event: string, metadata?: LogMetadata): void;
  warn(event: string, metadata?: LogMetadata): void;
  error(event: string, metadata?: LogMetadata): void;
  captureError(event: string, metadata?: LogMetadata): string | null;
}

export interface LogBackend {
  createLogger(scope: string): Logger;
  addTransport(transport: LogTransport): void;
  removeTransport(id: string): void;
  getLogLevel(): LogLevel;
  setLogLevel(level: LogLevel): void;
}

export interface ConsoleCaptureOptions {
  target: Pick<Console, LogLevel | 'log'>;
  transport: LogTransport;
}

export interface LoggingPolicy {
  readonly service: string;
  readonly allowedFields: readonly string[];
  readonly startupScopes: readonly string[];
}

export interface LoggingOptions {
  policy: LoggingPolicy;
  environment: LogEnvironment;
  files: LogFileStore;
  createId(): string;
  backend?: LogBackend;
  console?: ConsoleCaptureOptions;
  /** 仅控制可读日志展示；结构化 timestamp 始终为 UTC。 */
  consoleTimeZone?: LogConsoleTimeZone;
  now?: () => number;
  monotonicNow?: () => number;
}

export interface LogWrite {
  line: string;
  bytes: number;
  identityEpoch: string;
  level: LogLevel;
  startup: boolean;
}

export interface LogFileStatus {
  storageMode: 'native' | 'memory';
  state: 'unbound' | 'ready' | 'blocked' | 'disposed';
  writable: boolean;
  bufferedBytes: number;
  droppedCount: number;
  corruptedLines: number;
  lastFailureCode: string | null;
  lastFailure?: Readonly<FailureDiagnostics & { phase: string }>;
}

export interface LogStatus extends LogFileStatus {
  installed: boolean;
  runId: string | null;
  identityEpoch: string | null;
}

export interface LogSnapshot {
  readonly id: string;
  readonly bytes: number;
  readonly identityEpoch: string;
}

export interface LogFileSummary {
  fileCount: number;
  bytes: number;
}

export interface LogRetentionPolicy {
  readonly maxAgeMs: number;
  readonly fileCount: number;
  readonly fileBytes: number;
}

export interface LogClearSuccess {
  status: 'success';
}

export interface LogClearPartial {
  status: 'partial';
  removedFiles: number;
  remainingFiles: number;
  message: string;
}

export interface LogClearFailed {
  status: 'failed';
  code: string;
  message: string;
}

export type LogClearResult = LogClearSuccess | LogClearPartial | LogClearFailed;

export interface LogSnapshotFile {
  readonly uri: string;
  readonly bytes: number;
  release(): Promise<void>;
}

export interface LogFileStore {
  setOwner(ownerKey: string | null, identityEpoch: string): Promise<void>;
  append(entry: LogWrite): void;
  flush(): Promise<void>;
  getStatus(): LogFileStatus;
  readSummary(): Promise<LogFileSummary>;
  clear(): Promise<LogClearResult>;
  createSnapshot(): Promise<LogSnapshot>;
  readSnapshot(snapshot: LogSnapshot): Promise<string>;
  releaseSnapshot(snapshot: LogSnapshot): Promise<void>;
  takeSnapshotFile(snapshot: LogSnapshot): Promise<LogSnapshotFile>;
  dispose(): void;
}

export interface LoggingHandle extends Pick<
  LogFileStore,
  'readSummary' | 'clear' | 'takeSnapshotFile'
> {
  setOwner(ownerKey: string | null): Promise<void>;
  flush(): Promise<void>;
  createSnapshot(): Promise<LogSnapshot>;
  readSnapshot(snapshot: LogSnapshot): Promise<string>;
  releaseSnapshot(snapshot: LogSnapshot): Promise<void>;
  dispose(): void;
}

export type LogFileManagement = Pick<
  LoggingHandle,
  | 'readSummary'
  | 'clear'
  | 'createSnapshot'
  | 'releaseSnapshot'
  | 'takeSnapshotFile'
>;
