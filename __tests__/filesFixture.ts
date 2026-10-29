import type { LogFileIO, LogFileInfo } from '../src/files/types';
import type { LogLevel, LogWrite } from '../src/types';
import { Buffer } from 'buffer';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createMemoryIO(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const modified = new Map<string, number>();
  const operations: { operation: string; name?: string; text?: string }[] = [];
  const control: {
    before?: (operation: string, name?: string) => Promise<void>;
  } = {};
  const visit = async (operation: string, name?: string, text?: string) => {
    operations.push({ operation, name, text });
    await control.before?.(operation, name);
  };
  const io: LogFileIO = {
    async ensureRoot() {
      await visit('ensureRoot');
    },
    async list() {
      await visit('list');
      return [...files].map(([name, text]): LogFileInfo => ({
        name,
        bytes: Buffer.byteLength(text, 'utf8'),
        modifiedAt: modified.get(name) ?? 1_750_000_000_000,
      }));
    },
    async read(name) {
      await visit('read', name);
      if (!files.has(name)) {
        throw new Error('missing file');
      }
      return files.get(name)!;
    },
    async getFile(name) {
      await visit('getFile', name);
      if (!files.has(name)) throw new Error('missing snapshot file');
      return {
        uri: `file:///virtual/logs/${encodeURIComponent(name)}`,
        bytes: Buffer.byteLength(files.get(name)!, 'utf8'),
      };
    },
    async write(name, text) {
      await visit('write', name, text);
      files.set(name, text);
    },
    async append(name, text) {
      await visit('append', name, text);
      files.set(name, (files.get(name) ?? '') + text);
    },
    async remove(name) {
      await visit('remove', name);
      files.delete(name);
    },
  };
  return {
    io,
    files,
    modified,
    operations,
    control,
    sourceText: () =>
      [...files]
        .filter(
          ([name]) =>
            name.includes('-logs-') &&
            !name.includes('-logs-snapshot-') &&
            name.endsWith('.jsonl'),
        )
        .map(([, text]) => text)
        .join(''),
    sourceNames: () =>
      [...files.keys()].filter(
        (name) =>
          name.includes('-logs-') &&
          !name.includes('-logs-snapshot-') &&
          name.endsWith('.jsonl'),
      ),
    snapshotNames: () =>
      [...files.keys()].filter(
        (name) => name.includes('-logs-snapshot-') && name.endsWith('.jsonl'),
      ),
  };
}

export function entry(
  event: string,
  identityEpoch = 'epoch-a',
  level: LogLevel = 'info',
  startup = false,
): LogWrite {
  const line = `${JSON.stringify({ identityEpoch, event })}\n`;
  return {
    line,
    bytes: Buffer.byteLength(line, 'utf8'),
    identityEpoch,
    level,
    startup,
  };
}

export function partition(ownerKey: string | null) {
  if (ownerKey === null) {
    return 'anonymous';
  }
  if (/^[a-f0-9]{64}$/.test(ownerKey)) {
    return ownerKey;
  }
  const digests: Record<string, string> = {
    'hash-a':
      '400075069c197bbcb0114c66fdcaefa53e224de63bbe58f67f9af54691c996fa',
    'hash-b':
      '580e36de86fe5fde24c0d67de903eacf0531bedc5c7e15020580624bf3fbd2f5',
    'hash-c':
      'f1b639bcb63b3e122acdbf8a2efbe99e45c0491a75767dfaef1d83623bae6b30',
  };
  if (!digests[ownerKey]) {
    throw new Error('Unknown partition fixture');
  }
  return digests[ownerKey];
}

export function sourceName(
  ownerKey: string | null,
  suffix = 'history',
  timestamp = 1_750_000_000_000,
) {
  return `${partition(ownerKey)}-logs-${timestamp}-${suffix}.jsonl`;
}

export function snapshotName(
  ownerKey: string | null,
  suffix = 'history',
  timestamp = 1_750_000_000_000,
) {
  return `${partition(ownerKey)}-logs-snapshot-${timestamp}-${suffix}.jsonl`;
}
