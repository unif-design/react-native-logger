import { captureLogDispatch } from '../backend/logger';
import { getLogSource } from '../normalization/getLogSource';
import {
  cancelLogTasks,
  enqueueLogTask,
  installLogTaskScope,
  isExecutingLogTask,
  readActiveLogTaskScope,
} from './logTasks';
import type { LogTaskScope } from './logTasks';
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
  LogMetadataInput,
  LogSnapshot,
  LoggingOptions,
  LoggingPolicy,
  SerializedLogRecord,
} from '../types';
import type { LogRuntime, LogDelivery } from './types';
import { captureConsole } from './captureConsole';

export function installLogging(options: LoggingOptions): LogRuntime {
  const current = readLogRuntime();
  if (current) return current;
  const {
    files,
    environment,
    consoleTimeZone = 'UTC',
    consoleTimeFormat = 'iso',
  } = options;
  const backend = options.backend ?? defaultBackend;
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  let runId: string;
  let policy: LoggingPolicy;
  let originalLevel: LogLevel;
  try {
    if (consoleTimeZone !== 'UTC' && consoleTimeZone !== 'Asia/Shanghai') {
      throw new TypeError('Invalid console time zone');
    }
    if (consoleTimeFormat !== 'iso' && consoleTimeFormat !== 'datetime') {
      throw new TypeError('Invalid console time format');
    }
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
  let initialStartupEpoch: string | undefined;
  let ownerBinding: Promise<void> = Promise.resolve();
  let bindingEpoch: string | undefined;
  let boundEpoch: string | undefined;
  let identitySequence = 0;
  let sequence = 0;
  let operationSequence = 0;
  let droppedCount = 0;
  let failure: string | null = null;
  let diagnostic: LogFileStatus['lastFailure'];
  let disposed = false;
  let releaseConsole = () => {};
  let releaseTaskScope = () => {};
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
    source: ReturnType<typeof getLogSource> | undefined,
    capture: {
      identityEpoch: string;
      startup: boolean;
      timestamp: number;
      durationAt: number;
    },
  ) {
    const context = metadata.context;
    if (disposed || (level === 'debug' && !environment.development))
      return null;
    if (
      context &&
      (context.runId !== runId ||
        context.identityEpoch !== capture.identityEpoch)
    ) {
      droppedCount += 1;
      return null;
    }
    if (
      capture.startup &&
      !policy.startupScopes.some((value) => value === scope)
    ) {
      droppedCount += 1;
      return null;
    }
    const result = serializeLogRecord(
      {
        ...environment,
        schemaVersion: 1,
        timestamp: new Date(capture.timestamp).toISOString(),
        sequence: ++sequence,
        runId,
        identityEpoch: capture.identityEpoch,
        level,
        scope,
        event,
        ...(context
          ? {
              trigger: context.trigger,
              operationId: context.operationId,
              parentOperationId: context.parentOperationId,
              durationMs: Math.max(0, capture.durationAt - context.startedAt),
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

  function enqueue(serialized: SerializedLogRecord, startup: boolean) {
    files.append({
      line: serialized.line,
      bytes: serialized.bytes,
      identityEpoch: serialized.record.identityEpoch,
      level: serialized.record.level,
      startup,
    });
  }

  function scopeFor(
    epoch = identityEpoch,
    startup = owner === undefined,
  ): LogTaskScope {
    return {
      owner: runtime,
      identityEpoch: epoch,
      startup,
      valid: () =>
        !disposed &&
        readLogRuntime() === runtime &&
        (epoch === identityEpoch || (startup && epoch === initialStartupEpoch)),
      dropped: () => {
        droppedCount++;
      },
    };
  }
  function transportLog(input: SdkLogRecord) {
    const collect = () => {
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
            enqueue(delivery.serialized, delivery.startup);
          }
          return;
        }
        if (
          input.scope.startsWith(APP_LOG_PREFIX) ||
          !['warn', 'error'].includes(input.level)
        )
          return;
        const scope = readActiveLogTaskScope();
        if (!scope || scope.owner !== runtime || scope.startup) {
          droppedCount++;
          return;
        }
        const error = input.args.find((value) => value instanceof Error);
        const serialized = normalize(
          `sdk.${input.scope}`,
          input.level,
          input.level === 'error' ? 'sdk.error' : 'sdk.warning',
          { fields: { ...getFailureDiagnostics(error) }, error },
          undefined,
          {
            identityEpoch: scope.identityEpoch!,
            startup: false,
            timestamp: input.ts,
            durationAt: monotonicNow(),
          },
        );
        if (serialized) enqueue(serialized, false);
      } catch (error) {
        fail('logger.transport_failed', error);
      }
    };
    if (isExecutingLogTask()) collect();
    else enqueueLogTask(collect, scopeFor());
  }

  function scopeError(expectedEpoch: string) {
    return Object.assign(new Error('Logging unavailable'), {
      code: disposed
        ? 'logger.files.disposed'
        : expectedEpoch !== identityEpoch
          ? 'logger.files.identity_changed'
          : 'logger.files.not_ready',
    });
  }
  function management<T>(
    operation: () => T | Promise<T>,
    releaseLate?: (value: T) => void | Promise<void>,
    snapshot?: LogSnapshot,
  ): Promise<T> {
    const expectedEpoch = identityEpoch;
    try {
      if (disposed || (snapshot && snapshot.identityEpoch !== expectedEpoch))
        return Promise.reject(
          Object.assign(new Error('Log snapshot identity changed'), {
            code: disposed
              ? 'logger.files.disposed'
              : 'logger.files.identity_changed',
          }),
        );
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueueLogTask(
      async () => {
        try {
          if (
            disposed ||
            expectedEpoch !== identityEpoch ||
            (owner !== undefined && boundEpoch !== expectedEpoch)
          )
            throw scopeError(expectedEpoch);
          const value = await operation();
          if (disposed || expectedEpoch !== identityEpoch) {
            try {
              await releaseLate?.(value);
            } catch (error) {
              fail('logger.snapshot_release_failed', error, expectedEpoch);
            }
            throw scopeError(expectedEpoch);
          }
          return { value };
        } catch (error) {
          return { error };
        }
      },
      scopeFor(),
      true,
    ).then((result) => {
      if (!result) throw scopeError(expectedEpoch);
      if ('error' in result) throw result.error;
      return result.value;
    });
  }

  const runtime: LogRuntime = {
    emit(
      scope,
      level,
      event,
      metadata?: LogMetadataInput,
      source?: Error,
      suppressConsole = false,
    ) {
      try {
        if (disposed || (level === 'debug' && !environment.development))
          return Promise.resolve(null);
        if (
          owner === undefined &&
          !policy.startupScopes.some((value) => value === scope)
        ) {
          droppedCount++;
          return Promise.resolve(null);
        }
        const captured = {
          identityEpoch,
          startup: owner === undefined,
          timestamp: now(),
          durationAt: monotonicNow(),
        };
        const dispatch =
          backend === defaultBackend ? captureLogDispatch() : undefined;
        return enqueueLogTask(
          () => {
            try {
              const value =
                typeof metadata === 'function' ? metadata() : metadata;
              const serialized = normalize(
                scope,
                level,
                event,
                value,
                source
                  ? getLogSource(source, suppressConsole ? 1 : 2)
                  : undefined,
                captured,
              );
              if (!serialized) return null;
              pending.set(serialized.record, {
                serialized,
                enqueued: false,
                startup: captured.startup,
                suppressConsole,
              });
              if (dispatch)
                dispatch({
                  level,
                  scope: `${APP_LOG_PREFIX}${serialized.record.scope}`,
                  message: serialized.record.event,
                  args: [serialized.record],
                  ts: captured.timestamp,
                });
              else {
                const scopeKey = serialized.record.scope;
                let logger = loggers.get(scopeKey);
                if (!logger) {
                  logger = backend.createLogger(`${APP_LOG_PREFIX}${scopeKey}`);
                  loggers.set(scopeKey, logger);
                }
                logger[level](serialized.record.event, serialized.record);
              }
              return disposed ? null : serialized.line;
            } catch (error) {
              fail('logger.dispatch_failed', error);
              return null;
            }
          },
          scopeFor(captured.identityEpoch, captured.startup),
        );
      } catch {
        fail('logger.dispatch_failed');
        return Promise.resolve(null);
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
    setOwner(value) {
      if (disposed) return Promise.resolve();
      if (
        value === owner &&
        (bindingEpoch === identityEpoch ||
          (boundEpoch === identityEpoch &&
            files.getStatus().state !== 'blocked'))
      )
        return ownerBinding;
      const previousOwner = owner;
      if (previousOwner === undefined) initialStartupEpoch = identityEpoch;
      if (value !== owner) {
        owner = value;
        identityEpoch = `${runId}:identity:${++identitySequence}`;
        diagnostic = undefined;
      }
      const expectedEpoch = identityEpoch;
      bindingEpoch = expectedEpoch;
      ownerBinding = enqueueLogTask(
        async () => {
          try {
            // 旧epoch未处理任务已失效；已落缓冲的旧记录仍写回原分区。
            if (previousOwner !== undefined) await files.flush();
            if (disposed) return;
            await files.setOwner(value, expectedEpoch);
            if (files.getStatus().state === 'ready') boundEpoch = expectedEpoch;
            initialStartupEpoch = undefined;
          } catch (error) {
            fail('logger.owner_failed', error, expectedEpoch);
          }
        },
        scopeFor(expectedEpoch, value === undefined),
        true,
      ).then((result) => {
        if (bindingEpoch === expectedEpoch) bindingEpoch = undefined;
        if (result === null && !disposed && expectedEpoch === identityEpoch)
          fail('logger.owner_failed');
      });
      return ownerBinding;
    },
    flush() {
      const expectedEpoch = identityEpoch;
      return management(() => files.flush()).catch((error) => {
        fail('logger.flush_failed', error, expectedEpoch);
      });
    },
    readSummary: () => management(() => files.readSummary()),
    clear: () => management(() => files.clear()),
    createSnapshot: () => management(() => files.createSnapshot()),
    readSnapshot: (snapshot) =>
      management(() => files.readSnapshot(snapshot), undefined, snapshot),
    releaseSnapshot: (snapshot) =>
      management(() => files.releaseSnapshot(snapshot), undefined, snapshot),
    takeSnapshotFile: (snapshot) =>
      management(
        () => files.takeSnapshotFile(snapshot),
        (file) => file.release(),
        snapshot,
      ),
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelLogTasks(runtime);
      releaseTaskScope();
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
    releaseTaskScope = installLogTaskScope(() => scopeFor());
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
          return delivery?.suppressConsole
            ? null
            : delivery
              ? formatLogLine(
                  delivery.serialized.record,
                  consoleTimeZone,
                  consoleTimeFormat,
                )
              : undefined;
        },
        options.console !== undefined,
        (method, args, source) => {
          runtime.emit(
            'console',
            method === 'log' ? 'info' : method,
            `console.${method}`,
            () => {
              const error = args.find((value) => value instanceof Error);
              return { fields: { ...getFailureDiagnostics(error) }, error };
            },
            source,
            true,
          );
        },
      );
    return runtime;
  } catch (error) {
    runtime.dispose();
    markLoggingUnavailable(undefined, error);
    throw error;
  }
}
