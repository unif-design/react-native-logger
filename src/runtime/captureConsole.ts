import { CONSOLE_METHODS } from '../constants';
import type { ConsoleCaptureOptions, LogLevel } from '../types';
import type { LogRecord as SdkLogRecord } from '../backend/types';
import { enqueueLogTask, isExecutingLogTask } from './logTasks';

export function captureConsole(
  { target, transport }: ConsoleCaptureOptions,
  development: boolean,
  formatRecord: (record: SdkLogRecord) => string | null | undefined,
  capture = true,
  recordConsole: (
    method: LogLevel | 'log',
    args: unknown[],
    source: Error,
  ) => void,
): () => void {
  const restore: Array<() => void> = [];
  const previousTransport = transport.log;
  let active = true;
  let outputting = false;

  const output: typeof transport.log = function (record) {
    if (!active) return;
    const write = () => {
      if (!active) return;
      const before = outputting;
      outputting = true;
      try {
        const formatted = formatRecord(record);
        if (formatted === null) return;
        target[record.level](
          formatted ??
            '[SDK] ' + record.level + '；原始输出已省略，请查看结构化诊断',
        );
      } finally {
        outputting = before;
      }
    };
    if (isExecutingLogTask()) write();
    else enqueueLogTask(write);
  };

  function release() {
    active = false;
    const failures: unknown[] = [];
    for (const undo of restore) {
      try {
        undo();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }
  try {
    transport.log = output;
    restore.push(() => {
      if (transport.log === output) transport.log = previousTransport;
    });
    if (!capture) return release;
    for (const method of CONSOLE_METHODS) {
      const previous = target[method];
      const wrapped = function (this: unknown, ...args: unknown[]) {
        if (!active) return;
        if (outputting) return previous.apply(this, args);
        const source = new Error();
        if (development || method === 'warn' || method === 'error')
          recordConsole(method, args, source);
        enqueueLogTask(() => {
          if (!active) return;
          const before = outputting;
          outputting = true;
          try {
            previous.apply(
              this,
              development
                ? args
                : ['console.' + method + '；原始输出已省略，请查看结构化诊断'],
            );
          } finally {
            outputting = before;
          }
        });
      };
      target[method] = wrapped;
      restore.push(() => {
        if (target[method] === wrapped) target[method] = previous;
      });
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
