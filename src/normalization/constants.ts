export const NORMALIZATION_LIMITS = Object.freeze({
  stringCharacters: 2048,
  stackCharacters: 4096,
  correlationCharacters: 128,
  sourceNameCharacters: 128,
  sourceFrames: 32,
  sourcePosition: 2147483647,
  compactCharacters: 128,
  arrayItems: 32,
  errorDepth: 4,
});

export const REQUIRED_STRING_FIELDS = [
  'timestamp',
  'runId',
  'identityEpoch',
  'appVersion',
  'platform',
  'osVersion',
  'scope',
  'event',
] as const;

export const OPTIONAL_STRING_FIELDS = [
  'installedAppVersion',
  'bundleId',
  'buildNumber',
  'deviceModel',
  'systemName',
  'systemVersion',
  'operationId',
  'parentOperationId',
  'phase',
  'code',
  'serverTraceId',
] as const;

export const CORRELATION_FIELDS = [
  'runId',
  'identityEpoch',
  'operationId',
  'parentOperationId',
  'serverTraceId',
] as const;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LOG_TRIGGERS = [
  'user',
  'startup',
  'background',
  'h5',
  'system',
] as const;
export const LOG_OUTCOMES = [
  'success',
  'failed',
  'unknown',
  'cancelled',
  'superseded',
  'unsupported',
  'requires_action',
] as const;

export const REDACTED_TEXT = '[REDACTED]';
export const TRUNCATED_TEXT = '[truncated]';
export const UNSERIALIZABLE_TEXT = '[unserializable]';
export const UTF16_SURROGATE_UNITS =
  /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;
export const CORRELATION_IDENTIFIER_PATTERN = /^[a-z\d_:-]+$/i;
export const STACK_LOCATION_PATTERN = /^(.*?):(\d{1,10})(?::(\d{1,10}))?$/;
export const STACK_SOURCE_NAME_PATTERN =
  /^[a-z\d_$.-]+\.(?:[cm]?[jt]sx?|(?:js)?bundle|hbc)$/i;
export const STACK_PARENTHESIZED_LOCATION = /\(([^()\r\n]*)\)/g;
export const STACK_FUNCTION_PREFIX = /^\s*(?:at\s+)?[^@\s()]+@/;
export const STACK_AT_PREFIX = /^\s*at\s+/;

export const USER_PATH_PATTERN =
  /(?:\/(?:Users|home)\/|\/(?:private\/)?var\/(?:mobile|folders)\/|\/data\/(?:user(?:_de)?\/\d+|data)\/|\/storage\/emulated\/\d+\/|[a-z]:\\Users\\)[^\s"'<>)]*/gi;
export const FILE_URL_PATTERN = /^file:\/\//i;
export const URL_START_CHARACTER = /[a-z]/i;
export const URL_SCHEME_CHARACTER = /[a-z\d+.-]/i;
export const RELATIVE_PATH_CHARACTER = /[a-z\d_./:@%+-]/i;
export const URL_BODY_CHARACTER_SOURCE = '[^\\s<>"\'`]';
export const WORD_CHARACTER = /\w/;
export const URL_PATTERN = new RegExp(
  String.raw`\b${URL_START_CHARACTER.source}${URL_SCHEME_CHARACTER.source}*:\/\/${URL_BODY_CHARACTER_SOURCE}+`,
  'gi',
);
export const RELATIVE_URL_PARAMETERS = new RegExp(
  String.raw`(\/${RELATIVE_PATH_CHARACTER.source}+)[?#]${URL_BODY_CHARACTER_SOURCE}*`,
  'gi',
);
export const HEADER_SECRET_NAME_SOURCE = String.raw`authorization|(?:set[-_\s]*)?cookie`;
export const SECRET_FIELD_NAME_SOURCE = String.raw`(?:x[-_\s]*)?api[-_\s]*key|access[-_\s]*key(?:[-_\s]*(?:id|secret))?|client[-_\s]*secret|(?:access|refresh|session|auth|security|id)[-_\s]*token|token|jwt|secret|password|passwd|pwd|(?:verification|verify|sms|security|auth)[-_\s]*code|otp|pin|device[-_\s]*(?:id|uuid)|android[-_\s]*id|advertising[-_\s]*id|idfa|idfv|udid|imei|imsi`;
// 诊断字段按完整名称匹配，避免普通字段被敏感词片段误伤。
export const REPORT_SENSITIVE_NAME_SOURCE = String.raw`credential|session|idcard|phone|mobile|bank`;
export const SENSITIVE_DIAGNOSTIC_FIELD_PATTERN = new RegExp(
  `^(?:${HEADER_SECRET_NAME_SOURCE}|${SECRET_FIELD_NAME_SOURCE}|${REPORT_SENSITIVE_NAME_SOURCE})$`,
  'i',
);
export const HEADER_SECRET_PATTERN = new RegExp(
  String.raw`\b(${HEADER_SECRET_NAME_SOURCE})["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,}]+)`,
  'gi',
);
export const AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic)(?:\s+|:\s*)[a-z\d+/_=.~:-]+/gi;
export const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`["']?\b(${SECRET_FIELD_NAME_SOURCE})["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,;&}]+)`,
  'gi',
);
export const DEVICE_LABEL_PATTERN =
  /\b(imei|imsi|udid|idfa|idfv|device[-_\s]*(?:id|uuid)|android[-_\s]*id)\s+[a-z\d:._-]+/gi;
export const JWT_PREFIX = 'eyJ';
export const JWT_CHARACTER = /[a-z\d_-]/i;
export const JWT_PATTERN = new RegExp(
  String.raw`\b${JWT_PREFIX}${JWT_CHARACTER.source}+\.${JWT_CHARACTER.source}+\.${JWT_CHARACTER.source}+\b`,
  'gi',
);
export const PHONE_PATTERN = /(?:\+?86[- ]?)?\b1[3-9]\d[- ]?\d{4}[- ]?\d{4}\b/g;
export const EMAIL_LOCAL_CHARACTER = /[a-z\d.!#$%&'*+/=?^_`{|}~-]/i;
export const EMAIL_PATTERN = new RegExp(
  String.raw`\b${EMAIL_LOCAL_CHARACTER.source}+@[a-z\d](?:[a-z\d.-]*[a-z\d])?\.[a-z]{2,}\b`,
  'gi',
);
export const MAC_PATTERN = /\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b/gi;
export const IMEI_PATTERN = /\b\d{15,17}\b/g;
export const ID_CARD_PATTERN = /\b\d{17}[\dX]\b/gi;
export const UUID_PATTERN =
  /\b[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\b/gi;
