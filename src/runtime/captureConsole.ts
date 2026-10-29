import { CONSOLE_METHODS } from '../constants';
import { createLogger } from '../createLogger';
import type { ConsoleCaptureOptions } from '../types';
import type { LogRecord as SdkLogRecord } from '../backend/types';

export function captureConsole(
  { target, transport }: ConsoleCaptureOptions,
  development: boolean,
  formatRecord: (record: SdkLogRecord) => string | undefined,
  capture = true,
): () => void {
  const log = createLogger('console');
  const restore: Array<() => void> = [];
  const previousTransport = transport.log;
  let active = true;
  let capturing = false;
  let backendOutput = false;

  const output: typeof transport.log = function (
    this: ConsoleCaptureOptions['transport'],
    record,
  ) {
    if (active && capturing) return;
    const previousOutput = backendOutput;
    backendOutput = true;
    try {
      const formatted = active ? formatRecord(record) : undefined;
      if (formatted !== undefined) return target[record.level](formatted);
      return previousTransport.call(this, record);
    } finally {
      backendOutput = previousOutput;
    }
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
    // 公共 console transport 的实际输出不作为新的来源回收。
    transport.log = output;
    restore.push(() => {
      if (transport.log === output) transport.log = previousTransport;
    });
    if (!capture) return release;
    for (const method of CONSOLE_METHODS) {
      const previous = target[method];
      const wrapped = function (this: unknown, ...args: unknown[]) {
        if (!active || capturing || backendOutput)
          return previous.apply(this, args);
        capturing = true;
        try {
          try {
            if (development || method === 'warn' || method === 'error') {
              log[method === 'log' ? 'info' : method](`console.${method}`, {
                fields: {
                  reason:
                    typeof args[0] === 'object' && args[0] !== null
                      ? undefined
                      : args[0],
                },
                error: args.find((value) => value instanceof Error),
              });
            }
          } catch {
            // 采集失败不能改变原 console 的参数、返回值或异常。
          }
          return previous.apply(this, args);
        } finally {
          capturing = false;
        }
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
