import { NORMALIZATION_LIMITS } from './constants';

/** 仅返回固定技术短语；匹配到的动态正文、主机、SQL和字段名均不交付。 */
const MESSAGES: readonly [RegExp, string, string][] = [
  [
    /\bUnable to resolve host\b|\bNo address associated with hostname\b|\bUnknownHostException\b/i,
    'Unable to resolve host',
    'dns',
  ],
  [
    /\bConnection refused\b|\bECONNREFUSED\b/i,
    'Connection refused',
    'connection_refused',
  ],
  [
    /\bConnection reset\b|\bECONNRESET\b/i,
    'Connection reset',
    'connection_reset',
  ],
  [
    /\bNetwork is unreachable\b|\bENETUNREACH\b/i,
    'Network is unreachable',
    'network_unreachable',
  ],
  [
    /\bFailed to connect to\b|^Connection attempt failed$/i,
    'Connection attempt failed',
    'connection_failed',
  ],
  [
    /\bCLEARTEXT communication\b[^\r\n]{0,512}\bnot permitted\b|^Cleartext traffic not permitted$/i,
    'Cleartext traffic not permitted',
    'cleartext_not_permitted',
  ],
  [/\bChain validation failed\b/i, 'Chain validation failed', 'tls'],
  [
    /\bSSLHandshakeException\b|\bSSLPeerUnverifiedException\b/i,
    'TLS handshake failed',
    'tls',
  ],
  [
    /\bCertificate (?:has expired|expired)\b/i,
    'Certificate has expired',
    'tls',
  ],
  [
    /\b(?:SocketTimeoutException|connect timed out|read timed out|timeout of \d+ms exceeded)\b/i,
    'Operation timed out',
    'timeout',
  ],
  [/^Operation timed out$/i, 'Operation timed out', 'timeout'],
  [/^TLS handshake failed$/i, 'TLS handshake failed', 'tls'],
  [
    /^Network (?:request failed|Error)$/i,
    'Network request failed',
    'network_error',
  ],
  [
    /\bdatabase is locked\b|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i,
    'database is locked',
    'storage_busy',
  ],
  [
    /\bno space left on device\b|\b(?:ENOSPC|SQLITE_FULL)\b/i,
    'no space left on device',
    'storage_full',
  ],
  [
    /\bdatabase disk image is malformed\b|\bSQLITE_CORRUPT\b|\bSQLITE_NOTADB\b/i,
    'database disk image is malformed',
    'storage_corrupt',
  ],
  [
    /\bno such file or directory\b|\bENOENT\b/i,
    'no such file or directory',
    'not_found',
  ],
  [
    /\bPermission denied\b|\b(?:EACCES|EPERM)\b/i,
    'Permission denied',
    'permission_denied',
  ],
  [
    /\bread-only file system\b|\bEROFS\b|\bSQLITE_READONLY\b/i,
    'read-only file system',
    'read_only',
  ],
  [/\b(?:I\/O error|SQLITE_IOERR|EIO)\b/i, 'I/O error', 'io_error'],
  [
    /\bunable to open database file\b|\bSQLITE_CANTOPEN\b/i,
    'unable to open database file',
    'storage_open',
  ],
  [/\bno such table\b/i, 'no such table', 'invalid_response'],
  [
    /\bUNIQUE constraint failed\b/i,
    'UNIQUE constraint failed',
    'invalid_response',
  ],
  [
    /\bCannot read (?:properties|property) of undefined\b/i,
    'Cannot read properties of undefined',
    'type_error',
  ],
  [
    /\bCannot read (?:properties|property) of null\b/i,
    'Cannot read properties of null',
    'type_error',
  ],
  [
    /^Maximum call stack size exceeded\b/i,
    'Maximum call stack size exceeded',
    'range_error',
  ],
  [/^Unexpected token\b/i, 'Unexpected token', 'invalid_response'],
  [
    /^Unexpected end of JSON input\b/i,
    'Unexpected end of JSON input',
    'invalid_response',
  ],
  [/^JSON Parse error\b/i, 'JSON Parse error', 'invalid_response'],
  [
    /^Invalid (?:initialization vector|key length|authentication tag|cryptographic parameters)\b/i,
    'Invalid cryptographic parameters',
    'invalid_input',
  ],
];

export function readTechnicalErrorMessage(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const text = value.slice(0, NORMALIZATION_LIMITS.stringCharacters);
  const matched = MESSAGES.find(([pattern]) => pattern.test(text));
  return matched
    ? {
        message: matched[1],
        reason: matched[2],
        truncated: value.length > text.length,
      }
    : undefined;
}
