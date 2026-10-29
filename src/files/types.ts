import type { LogFileStore, LogSnapshotFile, LogWrite } from '../types';

export interface LogFileInfo {
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface LogFileIO {
  ensureRoot(): Promise<void>;
  list(): Promise<LogFileInfo[]>;
  read(name: string): Promise<string>;
  getFile(name: string): Promise<Pick<LogSnapshotFile, 'uri' | 'bytes'>>;
  write(name: string, text: string): Promise<void>;
  append(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface LogFileLimits {
  recordBytes: number;
  fileBytes: number;
  fileCount: number;
  maxAgeMs: number;
  queueBytes: number;
  batchBytes: number;
  flushIntervalMs: number;
}

export interface LogFileStoreOptions {
  io: LogFileIO;
  createId(): string;
  now?: () => number;
  limits?: Partial<LogFileLimits>;
}

export interface NativeLogFilesOptions {
  directoryName: string;
  createId(): string;
}

export interface LogBuffer {
  append(entry: QueuedLogWrite): void;
  drop(): void;
  clear(): void;
  clearPartition(partition: string): void;
  takeBatch(maxBytes: number): QueuedLogWrite[];
  finishBatch(batch: QueuedLogWrite[], retry?: boolean): void;
  getBytes(): number;
  getDroppedCount(): number;
  hasPending(): boolean;
  getPendingPartition(): string | undefined;
}

export interface QueuedLogWrite extends LogWrite {
  partition: string;
}

export interface LogFileNameInfo {
  partition: string;
  createdAt: number;
}

export interface StoredLogFile extends LogFileInfo, LogFileNameInfo {}

export interface OwnedLogSnapshot {
  name: string;
  generation: number;
  partition: string;
  identityEpoch: string;
  busy: boolean;
}

export interface LogFileScope {
  heldSnapshots: Set<string>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

export interface LogSnapshotContent {
  text: string;
  corruptedLines: number;
}

export interface LogFileError extends Error {
  code: string;
}

export type { LogFileStore };
