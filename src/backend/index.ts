export {
  createLogger,
  setLogLevel,
  getLogLevel,
  addTransport,
  removeTransport,
} from './logger';
export type { LogLevel, LogRecord, LogTransport, Logger } from './types';
export { consoleTransport } from './transports/console';
