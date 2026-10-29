import type { LogLevel, LogRecord, LogTransport } from '../types';

function pickConsoleFn(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'debug':
      return console.debug;
    case 'info':
      return console.info;
    case 'warn':
      return console.warn;
    case 'error':
      return console.error;
  }
}

export const consoleTransport: LogTransport = {
  id: 'console',
  log(record: LogRecord) {
    const prefix = `[${record.scope}]`;
    const fn = pickConsoleFn(record.level);
    fn(prefix, record.message, ...record.args);
  },
};
