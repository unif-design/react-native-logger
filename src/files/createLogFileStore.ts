import SHA256 from 'crypto-js/sha256.js';
import sumBy from 'lodash/sumBy.js';
import type { LogClearFailed, LogFileStatus, LogSnapshot } from '../types';
import { utf8ByteLength } from '../utf8ByteLength';
import { getFailureDiagnostics } from '../getFailureDiagnostics';
import {
  LOG_ANONYMOUS_PARTITION,
  LOG_CLEAR_MESSAGES,
  LOG_FILE_FAILURES,
} from './constants';
import { createLogBuffer, resolveLogFileLimits } from './createLogBuffer';
import { createLogFileError } from './createLogFileError';
import { createLogSnapshotFile } from './createLogSnapshotFile';
import { getLogFileScope } from './getLogFileScope';
import {
  createLogFileName,
  getLogPartition,
  readLogFileName,
} from './fileNames';
import { readLogSnapshotContent } from './readLogSnapshotContent';
import type {
  LogFileInfo,
  LogFileStore,
  LogFileStoreOptions,
  OwnedLogSnapshot,
  StoredLogFile,
} from './types';

function storedFiles(
  files: LogFileInfo[],
  kind: 'log' | 'snapshot',
): StoredLogFile[] {
  const selected: StoredLogFile[] = [];
  for (const file of files) {
    const decoded = readLogFileName(file.name, kind);
    if (decoded) {
      selected.push({
        ...file,
        ...decoded,
        createdAt: Math.min(decoded.createdAt, file.modifiedAt),
      });
    }
  }
  return selected.sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.name.localeCompare(right.name),
  );
}

export function createLogFileStore(options: LogFileStoreOptions): LogFileStore {
  const { io, createId, now = Date.now } = options;
  const limits = resolveLogFileLimits(options.limits);
  const buffer = createLogBuffer(limits);
  const scope = getLogFileScope(io);
  const snapshots = new Map<LogSnapshot, OwnedLogSnapshot>();
  const names = new Set<string>();
  let state: LogFileStatus['state'] = 'unbound';
  let writable = false;
  let lastFailureCode: string | null = null;
  let lastFailure: LogFileStatus['lastFailure'];
  let corruptedLines = 0;
  let ownerKey: string | null | undefined;
  let partition = LOG_ANONYMOUS_PARTITION;
  let identityEpoch: string | undefined;
  let generation = 0;
  let segments: StoredLogFile[] = [];
  let snapshotFiles: StoredLogFile[] = [];
  let active: StoredLogFile | null = null;
  let rescan = false;
  let sequence = 0;
  let initializing: Promise<void> = Promise.resolve();
  let flushing: Promise<void> | null = null;
  let flushingGeneration = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function current(expected: number): boolean {
    return state !== 'disposed' && generation === expected;
  }

  function assertCurrent(expected: number): void {
    if (!current(expected)) {
      throw createLogFileError(
        state === 'disposed'
          ? LOG_FILE_FAILURES.disposed
          : LOG_FILE_FAILURES.identityChanged,
      );
    }
  }

  function assertBound(expected: number): void {
    assertCurrent(expected);
    if (ownerKey === undefined || state === 'unbound') {
      throw createLogFileError(LOG_FILE_FAILURES.notReady);
    }
  }

  function clearFailure(error: unknown): LogClearFailed {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    return {
      status: 'failed',
      code:
        code === LOG_FILE_FAILURES.disposed ||
        code === LOG_FILE_FAILURES.identityChanged ||
        code === LOG_FILE_FAILURES.notReady
          ? code
          : LOG_FILE_FAILURES.cleanup,
      message: LOG_CLEAR_MESSAGES.failed,
    };
  }

  async function readSourceFiles(
    expected: number,
    target: string,
  ): Promise<StoredLogFile[]> {
    assertBound(expected);
    try {
      const files = await io.list();
      assertBound(expected);
      const selected = storedFiles(files, 'log').filter(
        (file) => file.partition === target,
      );
      if (
        selected.some(
          (file) => !Number.isSafeInteger(file.bytes) || file.bytes < 0,
        )
      ) {
        throw createLogFileError(LOG_FILE_FAILURES.summary);
      }
      return selected;
    } catch (error) {
      assertBound(expected);
      lastFailure = { phase: 'summary', ...getFailureDiagnostics(error) };
      throw createLogFileError(LOG_FILE_FAILURES.summary);
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return scope.enqueue(operation);
  }

  function forgetSnapshots(): void {
    snapshots.forEach((snapshot) => scope.heldSnapshots.delete(snapshot.name));
    snapshots.clear();
  }

  function ownedSnapshot(
    snapshot: LogSnapshot,
    expected: number,
    allowBusy = false,
  ): OwnedLogSnapshot {
    assertCurrent(expected);
    const owned = snapshots.get(snapshot);
    if (
      !owned ||
      owned.generation !== expected ||
      owned.partition !== partition ||
      owned.identityEpoch !== identityEpoch ||
      (!allowBusy && owned.busy)
    ) {
      throw createLogFileError(LOG_FILE_FAILURES.invalidSnapshot);
    }
    return owned;
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleTimer(): void {
    if (timer === null && state === 'ready' && buffer.hasPending()) {
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => undefined);
      }, limits.flushIntervalMs);
    }
  }

  function freshName(
    kind: 'log' | 'snapshot',
    targetPartition: string,
  ): string {
    const id = createId();
    let name: string;
    do {
      name = createLogFileName(kind, targetPartition, now(), id, ++sequence);
    } while (names.has(name) || scope.heldSnapshots.has(name));
    names.add(name);
    return name;
  }

  async function scan(expected: number, retainActive = false): Promise<void> {
    const files = await io.list();
    assertCurrent(expected);
    const activeName = retainActive ? active?.name : undefined;
    segments = storedFiles(files, 'log');
    snapshotFiles = storedFiles(files, 'snapshot');
    names.clear();
    [...segments, ...snapshotFiles].forEach((file) => names.add(file.name));
    active = segments.find((file) => file.name === activeName) ?? null;
    rescan = false;
  }

  async function remove(name: string, expected: number): Promise<void> {
    assertCurrent(expected);
    try {
      await io.remove(name);
    } catch (error) {
      if (current(expected))
        lastFailure = { phase: 'cleanup', ...getFailureDiagnostics(error) };
      throw createLogFileError(LOG_FILE_FAILURES.cleanup);
    }
    assertCurrent(expected);
    names.delete(name);
    segments = segments.filter((file) => file.name !== name);
    snapshotFiles = snapshotFiles.filter((file) => file.name !== name);
    if (active?.name === name) {
      active = null;
    }
  }

  async function pruneSnapshots(expected: number): Promise<void> {
    for (const file of [...snapshotFiles]) {
      if (
        file.createdAt < now() - limits.maxAgeMs &&
        !scope.heldSnapshots.has(file.name)
      ) {
        await remove(file.name, expected);
      }
    }
  }

  async function pruneSegments(
    expected: number,
    reserveFile = false,
  ): Promise<void> {
    for (const file of [...segments]) {
      if (
        file.createdAt < now() - limits.maxAgeMs ||
        file.bytes > limits.fileBytes
      ) {
        await remove(file.name, expected);
      }
    }
    const maximum = limits.fileCount - (reserveFile ? 1 : 0);
    while (segments.length > maximum) {
      await remove(segments[0].name, expected);
    }
  }

  function recordWriteFailure(error: unknown): void {
    const cleanupFailed =
      error instanceof Error &&
      'code' in error &&
      error.code === LOG_FILE_FAILURES.cleanup;
    if (cleanupFailed) {
      state = 'blocked';
    }
    writable = false;
    lastFailureCode = cleanupFailed
      ? LOG_FILE_FAILURES.cleanup
      : LOG_FILE_FAILURES.write;
    if (!cleanupFailed || lastFailure?.phase !== 'cleanup')
      lastFailure = {
        phase: cleanupFailed ? 'cleanup' : 'write',
        ...getFailureDiagnostics(error),
      };
  }

  async function initialize(expected: number): Promise<void> {
    let failureCode: string = LOG_FILE_FAILURES.initialize;
    try {
      assertCurrent(expected);
      await io.ensureRoot();
      assertCurrent(expected);
      await scan(expected);
      failureCode = LOG_FILE_FAILURES.cleanup;
      await pruneSegments(expected);
      await pruneSnapshots(expected);
      assertCurrent(expected);
      state = 'ready';
      writable = true;
      lastFailureCode = null;
      lastFailure = undefined;
      scheduleTimer();
    } catch (error) {
      if (current(expected)) {
        state = 'blocked';
        writable = false;
        lastFailureCode = failureCode;
        if (
          failureCode !== LOG_FILE_FAILURES.cleanup ||
          lastFailure?.phase !== 'cleanup'
        )
          lastFailure = {
            phase: 'initialize',
            ...getFailureDiagnostics(error),
          };
      }
    }
  }

  async function drain(expected: number): Promise<void> {
    assertCurrent(expected);
    if (state !== 'ready') {
      return;
    }
    if (rescan) {
      await scan(expected);
    }
    await pruneSegments(expected);
    let remaining = buffer.getBytes();
    while (buffer.hasPending() && remaining > 0) {
      assertCurrent(expected);
      const targetPartition = buffer.getPendingPartition()!;
      if (active?.partition !== targetPartition) {
        active = null;
      }
      if (!active) {
        await pruneSegments(expected, true);
        const createdAt = now();
        active = {
          name: freshName('log', targetPartition),
          partition: targetPartition,
          bytes: 0,
          modifiedAt: createdAt,
          createdAt,
        };
        segments.push(active);
      }
      const batch = buffer.takeBatch(
        Math.min(limits.batchBytes, limits.fileBytes - active.bytes),
      );
      if (!batch.length) {
        active = null;
        continue;
      }
      try {
        await io.append(active.name, batch.map((entry) => entry.line).join(''));
        assertCurrent(expected);
        const size = sumBy(batch, (entry) => entry.bytes);
        active.bytes += size;
        active.modifiedAt = now();
        remaining -= size;
        buffer.finishBatch(batch);
      } catch (error) {
        if (current(expected)) {
          buffer.finishBatch(batch, true);
          active = null;
          rescan = true;
        }
        throw error;
      }
    }
    assertCurrent(expected);
    writable = true;
    lastFailureCode = null;
    lastFailure = undefined;
  }

  function flush(): Promise<void> {
    if (state === 'disposed') {
      return Promise.resolve();
    }
    if (ownerKey === undefined) {
      return Promise.resolve();
    }
    if (flushing && flushingGeneration === generation) {
      return flushing;
    }
    const expected = generation;
    flushingGeneration = expected;
    const result = enqueue(async () => {
      if (!current(expected)) {
        return;
      }
      stopTimer();
      try {
        if (state === 'blocked') {
          await initialize(expected);
        }
        await drain(expected);
      } catch (error) {
        if (current(expected)) {
          recordWriteFailure(error);
        }
      }
      scheduleTimer();
    });
    flushing = result;
    result.then(
      () => {
        if (flushing === result) {
          flushing = null;
        }
      },
      () => undefined,
    );
    return result;
  }

  return {
    setOwner(nextOwner, nextEpoch) {
      if (state === 'disposed') {
        return Promise.resolve();
      }
      const sameIdentity =
        ownerKey !== undefined &&
        ownerKey === nextOwner &&
        identityEpoch === nextEpoch;
      if (sameIdentity && state !== 'blocked') {
        return initializing;
      }
      if (!sameIdentity) {
        lastFailure = undefined;
        if (ownerKey !== undefined) {
          buffer.clear();
        }
        ownerKey = nextOwner;
        identityEpoch = nextEpoch;
        partition = getLogPartition(nextOwner);
        generation++;
        forgetSnapshots();
      }
      state = 'unbound';
      writable = false;
      stopTimer();
      const expected = generation;
      initializing = enqueue(() => initialize(expected));
      return initializing;
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
          return;
        }
        buffer.append({ ...entry, partition });
        if (state === 'ready' && buffer.getBytes() >= limits.batchBytes) {
          flush().catch(() => undefined);
        } else {
          scheduleTimer();
        }
      } catch {
        buffer.drop();
      }
    },
    flush,
    getStatus: () => ({
      storageMode: 'native',
      state,
      writable,
      bufferedBytes: buffer.getBytes(),
      droppedCount: buffer.getDroppedCount(),
      corruptedLines,
      lastFailureCode,
      ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}),
    }),
    async readSummary() {
      const expected = generation;
      const target = partition;
      assertBound(expected);
      return enqueue(async () => {
        const files = await readSourceFiles(expected, target);
        assertBound(expected);
        const bytes = sumBy(files, (file) => file.bytes);
        if (!Number.isSafeInteger(bytes)) {
          throw createLogFileError(LOG_FILE_FAILURES.summary);
        }
        return { fileCount: files.length, bytes };
      });
    },
    async clear() {
      const expected = generation;
      const target = partition;
      try {
        assertBound(expected);
      } catch (error) {
        return clearFailure(error);
      }
      return enqueue(async () => {
        try {
          let selected: StoredLogFile[];
          try {
            assertBound(expected);
            stopTimer();
            selected = await readSourceFiles(expected, target);
            assertBound(expected);
          } catch (error) {
            return clearFailure(error);
          }
          buffer.clearPartition(target);
          let removedFiles = 0;
          for (const file of selected) {
            if (!current(expected)) break;
            try {
              await io.remove(file.name);
            } catch (error) {
              if (current(expected))
                lastFailure = {
                  phase: 'cleanup',
                  ...getFailureDiagnostics(error),
                };
              continue;
            }
            removedFiles++;
            if (current(expected)) {
              names.delete(file.name);
              segments = segments.filter(
                (segment) => segment.name !== file.name,
              );
            }
          }
          if (current(expected)) {
            if (active?.partition === target) active = null;
            rescan = true;
          }
          return removedFiles === selected.length
            ? { status: 'success' as const }
            : {
                status: 'partial' as const,
                removedFiles,
                remainingFiles: selected.length - removedFiles,
                message: LOG_CLEAR_MESSAGES.partial,
              };
        } finally {
          if (current(expected)) scheduleTimer();
        }
      });
    },
    createSnapshot() {
      const expected = generation;
      return enqueue(async () => {
        assertCurrent(expected);
        if (state !== 'ready') {
          throw createLogFileError(LOG_FILE_FAILURES.notReady);
        }
        let name: string | undefined;
        let sourceFlushed = false;
        try {
          await scan(expected, true);
          await pruneSnapshots(expected);
          const snapshotNames = new Set([
            ...snapshotFiles.map((file) => file.name),
            ...scope.heldSnapshots,
          ]);
          if (snapshotNames.size >= limits.fileCount) {
            lastFailureCode = LOG_FILE_FAILURES.snapshotLimit;
            throw createLogFileError(LOG_FILE_FAILURES.snapshotLimit);
          }
          await drain(expected);
          sourceFlushed = true;
          const parts: string[] = [];
          let badLines = 0;
          for (const segment of segments.filter(
            (file) => file.partition === partition,
          )) {
            const text = await io.read(segment.name);
            assertCurrent(expected);
            const content = readLogSnapshotContent(text, limits.recordBytes);
            parts.push(content.text);
            badLines += content.corruptedLines;
          }
          const text = parts.join('');
          name = freshName('snapshot', partition);
          const id = SHA256(`${createId()}:${sequence}`).toString();
          await io.write(name, text);
          assertCurrent(expected);
          const bytes = utf8ByteLength(text);
          const snapshot = Object.freeze({
            id,
            bytes,
            identityEpoch: identityEpoch!,
          });
          snapshots.set(snapshot, {
            name,
            generation: expected,
            partition,
            identityEpoch: identityEpoch!,
            busy: false,
          });
          scope.heldSnapshots.add(name);
          snapshotFiles.push({
            name,
            bytes,
            partition,
            createdAt: now(),
            modifiedAt: now(),
          });
          corruptedLines += badLines;
          return snapshot;
        } catch (error) {
          assertCurrent(expected);
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === LOG_FILE_FAILURES.snapshotLimit
          ) {
            throw error;
          }
          if (name) {
            try {
              await io.remove(name);
              names.delete(name);
            } catch {
              /* 部分产物仍由目录保留策略回收，不能删除源文件代替。 */
            }
            assertCurrent(expected);
          }
          if (sourceFlushed) {
            lastFailureCode = LOG_FILE_FAILURES.snapshot;
            lastFailure = {
              phase: 'snapshot',
              ...getFailureDiagnostics(error),
            };
          } else {
            recordWriteFailure(error);
          }
          throw createLogFileError(LOG_FILE_FAILURES.snapshot);
        } finally {
          scheduleTimer();
        }
      });
    },
    readSnapshot(snapshot) {
      const expected = generation;
      try {
        ownedSnapshot(snapshot, expected);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueue(async () => {
        const owned = ownedSnapshot(snapshot, expected);
        try {
          const text = await io.read(owned.name);
          ownedSnapshot(snapshot, expected);
          return text;
        } catch (error) {
          ownedSnapshot(snapshot, expected);
          lastFailureCode = LOG_FILE_FAILURES.snapshot;
          lastFailure = {
            phase: 'snapshot_read',
            ...getFailureDiagnostics(error),
          };
          throw createLogFileError(LOG_FILE_FAILURES.snapshot);
        }
      });
    },
    takeSnapshotFile(snapshot) {
      const expected = generation;
      let owned: OwnedLogSnapshot;
      try {
        owned = ownedSnapshot(snapshot, expected);
      } catch (error) {
        return Promise.reject(error);
      }
      owned.busy = true;
      return enqueue(async () => {
        try {
          ownedSnapshot(snapshot, expected, true);
          const reference = await io.getFile(owned.name);
          ownedSnapshot(snapshot, expected, true);
          if (
            typeof reference?.uri !== 'string' ||
            !reference.uri.startsWith('file:///') ||
            !Number.isSafeInteger(reference.bytes) ||
            reference.bytes < 0
          )
            throw createLogFileError(LOG_FILE_FAILURES.snapshot);
          const file = createLogSnapshotFile(
            owned.name,
            reference,
            io,
            scope,
            (error) => {
              if (current(expected))
                lastFailure = {
                  phase: 'snapshot_release',
                  ...getFailureDiagnostics(error),
                };
            },
          );
          snapshots.delete(snapshot);
          return file;
        } catch (error) {
          ownedSnapshot(snapshot, expected, true);
          lastFailureCode = LOG_FILE_FAILURES.snapshot;
          lastFailure = {
            phase: 'snapshot_file',
            ...getFailureDiagnostics(error),
          };
          throw createLogFileError(LOG_FILE_FAILURES.snapshot);
        } finally {
          if (snapshots.get(snapshot) === owned) owned.busy = false;
        }
      });
    },
    releaseSnapshot(snapshot) {
      const expected = generation;
      let owned: OwnedLogSnapshot;
      try {
        owned = ownedSnapshot(snapshot, expected);
      } catch (error) {
        return Promise.reject(error);
      }
      owned.busy = true;
      return enqueue(async () => {
        ownedSnapshot(snapshot, expected, true);
        try {
          await io.remove(owned.name);
          ownedSnapshot(snapshot, expected, true);
          snapshots.delete(snapshot);
          scope.heldSnapshots.delete(owned.name);
          names.delete(owned.name);
          snapshotFiles = snapshotFiles.filter(
            (file) => file.name !== owned.name,
          );
        } catch (error) {
          ownedSnapshot(snapshot, expected, true);
          lastFailureCode = LOG_FILE_FAILURES.snapshot;
          lastFailure = {
            phase: 'snapshot_release',
            ...getFailureDiagnostics(error),
          };
          throw createLogFileError(LOG_FILE_FAILURES.snapshot);
        } finally {
          if (snapshots.get(snapshot) === owned) {
            owned.busy = false;
          }
        }
      });
    },
    dispose() {
      if (state === 'disposed') {
        return;
      }
      generation++;
      state = 'disposed';
      writable = false;
      buffer.clear();
      forgetSnapshots();
      stopTimer();
    },
  };
}
