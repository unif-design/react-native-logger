import { readLogRuntime } from './state';
import type { AppLogger, LogLevel, LogMetadata } from './types';
import { getLogSource } from './normalization/getLogSource';

export function createLogger(scope: string): AppLogger {
  function emit(level: LogLevel, event: string, metadata?: LogMetadata) {
    try {
      const runtime = readLogRuntime();
      if (!runtime) return null;
      const source =
        level === 'warn' || level === 'error'
          ? getLogSource(new Error(), 2)
          : undefined;
      return runtime.emit(scope, level, event, metadata, source);
    } catch {
      // 日志不改变调用方的控制流，诊断通道不能递归记录自身异常。
      return null;
    }
  }
  return {
    debug: (event, metadata) => {
      emit('debug', event, metadata);
    },
    info: (event, metadata) => {
      emit('info', event, metadata);
    },
    warn: (event, metadata) => {
      emit('warn', event, metadata);
    },
    error: (event, metadata) => {
      emit('error', event, metadata);
    },
    captureError: (event, metadata) => emit('error', event, metadata),
  };
}
