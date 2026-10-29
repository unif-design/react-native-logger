import SHA256 from 'crypto-js/sha256.js';
import {
  LOG_ANONYMOUS_PARTITION,
  LOG_FILE_NAME_PATTERN,
  LOG_OWNER_DIGEST_PATTERN,
  LOG_SNAPSHOT_NAME_PATTERN,
} from './constants';
import type { LogFileNameInfo } from './types';

export function getLogPartition(ownerKey: string | null): string {
  if (ownerKey === null) {
    return LOG_ANONYMOUS_PARTITION;
  }
  return LOG_OWNER_DIGEST_PATTERN.exec(ownerKey)?.[0] === ownerKey
    ? ownerKey
    : SHA256(ownerKey).toString();
}

export function readLogFileName(
  name: string,
  kind: 'log' | 'snapshot',
): LogFileNameInfo | null {
  const current = (
    kind === 'log' ? LOG_FILE_NAME_PATTERN : LOG_SNAPSHOT_NAME_PATTERN
  ).exec(name);
  return current?.[0] === name
    ? { partition: current[1], createdAt: Number(current[2]) }
    : null;
}

export function isLogFileName(name: string): boolean {
  return readLogFileName(name, 'log') !== null;
}

export function isSnapshotFileName(name: string): boolean {
  return readLogFileName(name, 'snapshot') !== null;
}

export function isOwnedFileName(name: string): boolean {
  return isLogFileName(name) || isSnapshotFileName(name);
}

export function createLogFileName(
  kind: 'log' | 'snapshot',
  partition: string,
  timestamp: number,
  id: string,
  sequence: number,
): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'record';
  const safeTime = Number.isFinite(timestamp)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(timestamp)))
    : 0;
  const purpose = kind === 'snapshot' ? 'logs-snapshot' : 'logs';
  return `${partition}-${purpose}-${safeTime}-${String(sequence).padStart(
    8,
    '0',
  )}-${safeId}.jsonl`;
}
