import { CONSOLE_METHODS } from '../constants';
import { createLogger } from '../createLogger';
import { getFailureDiagnostics } from '../getFailureDiagnostics';
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
      if (active)
        return target[record.level](
          '[SDK] ' + record.level + '；原始输出已省略，请查看结构化诊断',
        );
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
        if (!active || backendOutput) return previous.apply(this, args);
        if (capturing)
          return previous.call(
            this,
            'console.' + method + '；原始输出已省略，请查看结构化诊断',
          );
        capturing = true;
        try {
          try {
            if (development || method === 'warn' || method === 'error') {
              log[method === 'log' ? 'info' : method](`console.${method}`, {
                fields: {
                  ...getFailureDiagnostics(
                    args.find((value) => value instanceof Error),
                  ),
                },
                error: args.find((value) => value instanceof Error),
              });
            }
          } catch {
            // 采集失败仍不回写原始参数；输出固定说明，避免泄露用户信息。
          }
          return previous.call(
            this,
            'console.' + method + '；原始输出已省略，请查看结构化诊断',
          );
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
