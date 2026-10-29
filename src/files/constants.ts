export const LOG_ANONYMOUS_PARTITION = 'anonymous';
export const LOG_OWNER_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
export const LOG_FILE_NAME_PATTERN =
  /^(anonymous|[a-f0-9]{64})-logs-(\d{1,16})-[a-zA-Z0-9_-]+\.jsonl$/;
export const LOG_SNAPSHOT_NAME_PATTERN =
  /^(anonymous|[a-f0-9]{64})-logs-snapshot-(\d{1,16})-[a-zA-Z0-9_-]+\.jsonl$/;
export const LOG_LEVEL_PRIORITY = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

export const LOG_FILE_FAILURES = {
  initialize: 'logger.files.initialize_failed',
  cleanup: 'logger.files.cleanup_failed',
  summary: 'logger.files.summary_failed',
  write: 'logger.files.write_failed',
  snapshot: 'logger.files.snapshot_failed',
  snapshotLimit: 'logger.files.snapshot_limit',
  invalidSnapshot: 'logger.files.snapshot_invalid',
  identityChanged: 'logger.files.identity_changed',
  disposed: 'logger.files.disposed',
  unsupported: 'logger.files.unsupported',
  notReady: 'logger.files.not_ready',
} as const;

export const LOG_CLEAR_MESSAGES = {
  failed: '日志清理未完成，请重试。',
  partial: '部分日志未清理，请重试。',
} as const;
