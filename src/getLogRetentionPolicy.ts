import { LOG_LIMITS } from './constants';
import type { LogRetentionPolicy } from './types';

const policy: LogRetentionPolicy = Object.freeze({
  maxAgeMs: LOG_LIMITS.maxAgeMs,
  fileCount: LOG_LIMITS.fileCount,
  fileBytes: LOG_LIMITS.fileBytes,
});

export function getLogRetentionPolicy(): LogRetentionPolicy {
  return policy;
}
