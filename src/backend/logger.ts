import { enqueueLogTask } from '../runtime/logTasks';
import { consoleTransport } from './transports/console';
import type { LogLevel, LogRecord, LogTransport, Logger } from './types';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const state = {
  level: (typeof __DEV__ !== 'undefined' && __DEV__
    ? 'debug'
    : 'warn') as LogLevel,
  transports: [consoleTransport] as LogTransport[],
};

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  args: unknown[],
): void {
  try {
    if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
    const record: LogRecord = {
      level,
      scope,
      message,
      args,
      ts: Date.now(),
    };
    const dispatch = captureLogDispatch();
    enqueueLogTask(() => dispatch(record));
  } catch {
    /* 现场采集失败同样不能改变SDK调用方。 */
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message: string, ...args: unknown[]) =>
      emit('debug', scope, message, args),
    info: (message: string, ...args: unknown[]) =>
      emit('info', scope, message, args),
    warn: (message: string, ...args: unknown[]) =>
      emit('warn', scope, message, args),
    error: (message: string, ...args: unknown[]) =>
      emit('error', scope, message, args),
  };
}

export function setLogLevel(level: LogLevel): void {
  state.level = level;
}

export function getLogLevel(): LogLevel {
  return state.level;
}

export function addTransport(t: LogTransport): void {
  removeTransport(t.id);
  // push 后立即赋新数组:保证 emit 的 for-of 迭代期间若调用 addTransport,
  // 迭代的旧快照不受影响(重入安全)。
  state.transports = [...state.transports, t];
}

export function removeTransport(id: string): void {
  // filter 返回新数组,不原地变更 —— 保证 emit 的 for-of 迭代期间若调用
  // removeTransport(自移除等场景),迭代的旧快照仍完整走完(重入安全)。
  state.transports = state.transports.filter((t) => t.id !== id);
}

/** 在提交时固定transport函数，异步执行不得改接后来的安装实例。 */
export function captureLogDispatch(): (record: LogRecord) => void {
  const selected: { target: LogTransport; log: LogTransport['log'] }[] = [];
  const level = state.level;
  for (const target of state.transports) {
    try {
      let source: object | null = target;
      const seen = new Set<object>();
      while (source && !seen.has(source)) {
        seen.add(source);
        const descriptor = Object.getOwnPropertyDescriptor(source, 'log');
        if (descriptor) {
          if (typeof descriptor.value === 'function')
            selected.push({ target, log: descriptor.value });
          else if (descriptor.get) {
            const getter = descriptor.get;
            selected.push({
              target,
              log(record) {
                const log: unknown = getter.call(target);
                if (typeof log === 'function') log.call(target, record);
              },
            });
          }
          break;
        }
        source = Object.getPrototypeOf(source);
      }
    } catch {
      /* 不可读transport只丢弃自身输出。 */
    }
  }
  return (record) => {
    if (LEVEL_RANK[record.level] < LEVEL_RANK[level]) return;
    for (const { target, log } of selected) {
      try {
        log.call(target, record);
      } catch {
        /* transport失败不影响其他输出。 */
      }
    }
  };
}
