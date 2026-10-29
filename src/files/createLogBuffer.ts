import sumBy from 'lodash/sumBy.js';
import { LOG_LIMITS } from '../constants';
import { utf8ByteLength } from '../utf8ByteLength';
import { LOG_LEVEL_PRIORITY } from './constants';
import type { LogBuffer, LogFileLimits, QueuedLogWrite } from './types';

export function resolveLogFileLimits(
  overrides?: Partial<LogFileLimits>,
): LogFileLimits {
  const limits = { ...LOG_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof LogFileLimits)[]) {
    const value = limits[key];
    limits[key] =
      Number.isFinite(value) && value >= 1
        ? Math.floor(value)
        : LOG_LIMITS[key];
  }
  return limits;
}

export function createLogBuffer(limits: LogFileLimits): LogBuffer {
  let pending: QueuedLogWrite[] = [];
  let reserved: QueuedLogWrite[] = [];
  let bytes = 0;
  let droppedCount = 0;

  function append(input: QueuedLogWrite): void {
    try {
      const line = input.line;
      const size = utf8ByteLength(line);
      const record: unknown = JSON.parse(line);
      if (
        line.indexOf('\n') !== line.length - 1 ||
        !line.endsWith('\n') ||
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !('identityEpoch' in record) ||
        record.identityEpoch !== input.identityEpoch ||
        !Object.hasOwn(LOG_LEVEL_PRIORITY, input.level) ||
        size >
          Math.min(
            limits.recordBytes,
            limits.fileBytes,
            limits.batchBytes,
            limits.queueBytes,
          )
      ) {
        droppedCount++;
        return;
      }
      const entry = { ...input, bytes: size };
      while (bytes + size > limits.queueBytes) {
        let index = -1;
        let priority = LOG_LEVEL_PRIORITY[entry.level];
        for (let candidate = 0; candidate < pending.length; candidate++) {
          const candidatePriority =
            LOG_LEVEL_PRIORITY[pending[candidate].level];
          if (candidatePriority <= priority) {
            if (index === -1 || candidatePriority < priority) {
              index = candidate;
            }
            priority = candidatePriority;
          }
        }
        if (index === -1) {
          droppedCount++;
          return;
        }
        bytes -= pending[index].bytes;
        pending.splice(index, 1);
        droppedCount++;
      }
      pending.push(entry);
      bytes += size;
    } catch {
      droppedCount++;
    }
  }

  return {
    append,
    drop() {
      droppedCount++;
    },
    clear() {
      droppedCount += pending.length + reserved.length;
      pending = [];
      reserved = [];
      bytes = 0;
    },
    clearPartition(partition) {
      pending = pending.filter((entry) => {
        if (entry.partition !== partition) return true;
        bytes -= entry.bytes;
        return false;
      });
    },
    takeBatch(maxBytes) {
      let count = 0;
      let size = 0;
      while (
        count < pending.length &&
        pending[count].partition === pending[0].partition &&
        size + pending[count].bytes <= maxBytes
      ) {
        size += pending[count++].bytes;
      }
      reserved = pending.splice(0, count);
      return reserved;
    },
    finishBatch(batch, retry = false) {
      if (reserved !== batch) {
        return;
      }
      reserved = [];
      if (retry) {
        pending = [...batch, ...pending];
      } else {
        bytes -= sumBy(batch, (entry) => entry.bytes);
      }
    },
    getBytes: () => bytes,
    getDroppedCount: () => droppedCount,
    hasPending: () => pending.length > 0,
    getPendingPartition: () => pending[0]?.partition,
  };
}
