export const LOG_LIMITS = Object.freeze({
  recordBytes: 8 * 1024,
  fileBytes: 1024 * 1024,
  fileCount: 10,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  queueBytes: 256 * 1024,
  batchBytes: 64 * 1024,
  flushIntervalMs: 1000,
});

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export const LOG_TRANSPORT_ID = 'unif-local-diagnostics';
export const APP_LOG_PREFIX = 'unif:';
export const CONSOLE_METHODS = [
  'debug',
  'log',
  'info',
  'warn',
  'error',
] as const;

export const FAILURE_ERROR_TYPES: Readonly<Record<string, string>> = {
  Error: 'unknown',
  AxiosError: 'unknown',
  TypeError: 'type_error',
  RangeError: 'range_error',
  SyntaxError: 'invalid_response',
  AbortError: 'cancelled',
  CanceledError: 'cancelled',
  TimeoutError: 'timeout',
};

export const FAILURE_CODES: Readonly<Record<string, string>> = {
  ERR_NETWORK: 'network_error',
  ERR_BAD_RESPONSE: 'http_status',
  ERR_BAD_REQUEST: 'http_status',
  ECONNABORTED: 'timeout',
  ETIMEDOUT: 'timeout',
  ERR_CANCELED: 'cancelled',
  ABORT_ERR: 'cancelled',
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  EPIPE: 'connection_reset',
  ENETUNREACH: 'network_unreachable',
  EHOSTUNREACH: 'network_unreachable',
  CERT_HAS_EXPIRED: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  ENOSPC: 'storage_full',
  EDQUOT: 'storage_full',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOENT: 'not_found',
  EIO: 'io_error',
  EROFS: 'read_only',
  SQLITE_BUSY: 'storage_busy',
  SQLITE_LOCKED: 'storage_busy',
  SQLITE_FULL: 'storage_full',
  SQLITE_CORRUPT: 'storage_corrupt',
  SQLITE_NOTADB: 'storage_corrupt',
  SQLITE_READONLY: 'read_only',
  SQLITE_CANTOPEN: 'storage_open',
  SQLITE_IOERR: 'io_error',
};
