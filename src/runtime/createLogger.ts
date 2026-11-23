import { readLogRuntime } from './state';
import type { AppLogger, LogLevel, LogMetadataInput } from '../types';

export function createLogger(scope: string): AppLogger {
  function emit(level: LogLevel, event: string, metadata?: LogMetadataInput) {
    try {
      const runtime = readLogRuntime();
      if (!runtime) return Promise.resolve(null);
      const source =
        level === 'warn' || level === 'error' ? new Error() : undefined;
      return runtime.emit(scope, level, event, metadata, source);
    } catch {
      // 日志不改变调用方的控制流，诊断通道不能递归记录自身异常。
      return Promise.resolve(null);
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
