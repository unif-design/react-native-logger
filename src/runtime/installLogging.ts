import * as defaultBackend from '../backend';
import { prepareLoggingPolicy } from '../prepareLoggingPolicy';
import type { LogRecord as SdkLogRecord } from '../backend/types';
import { APP_LOG_PREFIX, LOG_TRANSPORT_ID } from '../constants';
import { serializeLogRecord } from '../serializeLogRecord';
import { formatLogLine } from '../formatLogLine';
import { getFailureDiagnostics } from '../getFailureDiagnostics';
import {
  markLoggingUnavailable,
  readLogRuntime,
  setLogRuntime,
} from '../state';
import type {
  DiagnosticRecord,
  LogLevel,
  LogMetadata,
  LogFileStatus,
  LogSource,
  LoggingOptions,
  LoggingPolicy,
  SerializedLogRecord,
} from '../types';
import type { LogRuntime, LogDelivery } from './types';
import { captureConsole } from './captureConsole';

export function installLogging(options: LoggingOptions): LogRuntime {
  const current = readLogRuntime();
  if (current) return current;
  const { files, environment } = options;
  const backend = options.backend ?? defaultBackend;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let runId: string;
  let policy: LoggingPolicy;
  let originalLevel: LogLevel;
  try {
    policy = prepareLoggingPolicy(options.policy);
    runId = options.createId();
    originalLevel = backend.getLogLevel();
  } catch (error) {
    try {
      files.dispose();
    } catch {
      /* 释放失败仍保留初始化失败状态。 */
    }
    markLoggingUnavailable(undefined, error);
    throw error;
  }
  const loggers = new Map<string, ReturnType<typeof backend.createLogger>>();
  // 两个 transport 可先后消费同一记录，落盘只执行一次。
  const pending = new WeakMap<DiagnosticRecord, LogDelivery>();
  let identityEpoch = `${runId}:identity:0`;
  let owner: string | null | undefined;
  let identitySequence = 0;
  let sequence = 0;
  let operationSequence = 0;
  let droppedCount = 0;
  let failure: string | null = null;
  let diagnostic: LogFileStatus['lastFailure'];
  let disposed = false;
  let releaseConsole = () => {};
  const installedLevel = environment.development ? 'debug' : 'info';

  function fail(code: string, error?: unknown, expectedEpoch = identityEpoch) {
    droppedCount += 1;
    failure = code;
    if (!disposed && expectedEpoch === identityEpoch)
      diagnostic =
        error === undefined
          ? undefined
          : { phase: 'runtime', ...getFailureDiagnostics(error) };
  }

  function normalize(
    scope: string,
    level: LogLevel,
    event: string,
    metadata: LogMetadata = {},
    source?: LogSource,
  ) {
    const context = metadata.context;
    if (disposed || (level === 'debug' && !environment.development))
      return null;
    if (
      context &&
      (context.runId !== runId || context.identityEpoch !== identityEpoch)
    ) {
      droppedCount += 1;
      return null;
    }
    if (
      owner === undefined &&
      !policy.startupScopes.some((value) => value === scope)
    ) {
      droppedCount += 1;
      return null;
    }
    const result = serializeLogRecord(
      {
        ...environment,
        schemaVersion: 1,
        timestamp: new Date(now()).toISOString(),
        sequence: ++sequence,
        runId,
        identityEpoch,
        level,
        scope,
        event,
        ...(context
          ? {
              trigger: context.trigger,
              operationId: context.operationId,
              parentOperationId: context.parentOperationId,
              durationMs: Math.max(0, monotonicNow() - context.startedAt),
            }
          : {}),
        phase: metadata.phase,
        outcome: metadata.outcome,
        code: metadata.code,
        httpStatus: metadata.httpStatus,
        businessCode: metadata.businessCode,
        serverTraceId: metadata.serverTraceId,
        fields: metadata.fields,
        error: metadata.error,
        source,
      },
      policy,
    );
    if (!result) fail('logger.normalize_failed');
    return result;
  }

  function enqueue(serialized: SerializedLogRecord) {
    files.append({
      line: serialized.line,
      bytes: serialized.bytes,
      identityEpoch: serialized.record.identityEpoch,
      level: serialized.record.level,
      startup: owner === undefined,
    });
  }

  function transportLog(input: SdkLogRecord) {
    try {
      if (disposed) return;
      const payload = input.args.find(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          pending.has(value as DiagnosticRecord),
      ) as DiagnosticRecord | undefined;
      if (payload) {
        const delivery = pending.get(payload)!;
        if (!delivery.enqueued) {
          delivery.enqueued = true;
          enqueue(delivery.serialized);
        }
        return;
      }
      // 不重收 App 日志，也不把 SDK 的任意 args 当成安全的业务上下文。
      if (
        input.scope.startsWith(APP_LOG_PREFIX) ||
        !['warn', 'error'].includes(input.level)
      )
        return;
      if (owner === undefined) {
        droppedCount += 1;
        return;
      }
      const serialized = normalize(
        `sdk.${input.scope}`,
        input.level,
        input.level === 'error' ? 'sdk.error' : 'sdk.warning',
        {
          fields: { reason: input.message },
          error: input.args.find((value) => value instanceof Error),
        },
      );
      if (serialized) enqueue(serialized);
    } catch (error) {
      fail('logger.transport_failed', error);
    }
  }

  const runtime: LogRuntime = {
    emit(scope, level, event, metadata, source) {
      try {
        const serialized = normalize(scope, level, event, metadata, source);
        if (!serialized) return null;
        pending.set(serialized.record, { serialized, enqueued: false });
        const scopeKey = serialized.record.scope;
        let logger = loggers.get(scopeKey);
        if (!logger) {
          logger = backend.createLogger(`${APP_LOG_PREFIX}${scopeKey}`);
          loggers.set(scopeKey, logger);
        }
        logger[level](serialized.record.event, serialized.record);
        return serialized.line;
      } catch (error) {
        fail('logger.dispatch_failed', error);
        return null;
      }
    },
    context(trigger, parent) {
      try {
        return Object.freeze({
          runId: parent?.runId ?? runId,
          identityEpoch: parent?.identityEpoch ?? identityEpoch,
          operationId: `${runId}:operation:${++operationSequence}`,
          ...(parent ? { parentOperationId: parent.operationId } : {}),
          trigger,
          startedAt: monotonicNow(),
        });
      } catch (error) {
        fail('logger.context_failed', error);
        throw error;
      }
    },
    status() {
      const status = files.getStatus();
      return {
        ...status,
        installed: !disposed,
        runId,
        identityEpoch,
        droppedCount: status.droppedCount + droppedCount,
        lastFailureCode: status.lastFailureCode ?? failure,
        ...(!status.lastFailure && diagnostic
          ? { lastFailure: { ...diagnostic } }
          : {}),
      };
    },
    async setOwner(value) {
      if (disposed) return;
      if (value === owner && files.getStatus().state !== 'blocked') return;
      if (value !== owner) {
        owner = value;
        identityEpoch = `${runId}:identity:${++identitySequence}`;
        diagnostic = undefined;
      }
      const expectedEpoch = identityEpoch;
      try {
        await files.setOwner(value, identityEpoch);
      } catch (error) {
        fail('logger.owner_failed', error, expectedEpoch);
      }
    },
    async flush() {
      if (disposed) return;
      const expectedEpoch = identityEpoch;
      try {
        await files.flush();
      } catch (error) {
        fail('logger.flush_failed', error, expectedEpoch);
      }
    },
    readSummary: () => files.readSummary(),
    clear: () => files.clear(),
    createSnapshot: () => files.createSnapshot(),
    readSnapshot: (snapshot) => files.readSnapshot(snapshot),
    releaseSnapshot: (snapshot) => files.releaseSnapshot(snapshot),
    takeSnapshotFile: (snapshot) => files.takeSnapshotFile(snapshot),
    dispose() {
      if (disposed) return;
      disposed = true;
      loggers.clear();
      if (readLogRuntime() === runtime) setLogRuntime(null);
      for (const release of [
        releaseConsole,
        () => backend.removeTransport(LOG_TRANSPORT_ID),
        () => {
          if (backend.getLogLevel() === installedLevel)
            backend.setLogLevel(originalLevel);
        },
        () => files.dispose(),
      ]) {
        try {
          release();
        } catch (error) {
          fail('logger.dispose_failed', error);
          markLoggingUnavailable('logger.dispose_failed', error);
        }
      }
    },
  };
  try {
    backend.setLogLevel(installedLevel);
    backend.addTransport({ id: LOG_TRANSPORT_ID, log: transportLog });
    setLogRuntime(runtime);
    const consoleOutput =
      options.console ??
      (options.backend
        ? undefined
        : { target: console, transport: defaultBackend.consoleTransport });
    if (consoleOutput)
      releaseConsole = captureConsole(
        consoleOutput,
        environment.development,
        (record) => {
          const payload = record.args.find(
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              pending.has(value as DiagnosticRecord),
          );
          const delivery = payload
            ? pending.get(payload as DiagnosticRecord)
            : undefined;
          return delivery
            ? formatLogLine(delivery.serialized.record)
            : undefined;
        },
        options.console !== undefined,
      );
    return runtime;
  } catch (error) {
    runtime.dispose();
    markLoggingUnavailable(undefined, error);
    throw error;
  }
}
