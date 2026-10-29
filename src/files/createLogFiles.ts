import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { LOG_FILE_FAILURES } from './constants';
import { createLogFileError } from './createLogFileError';
import { createLogFileStore } from './createLogFileStore';
import { isOwnedFileName, isSnapshotFileName } from './fileNames';
import type {
  LogFileIO,
  LogFileInfo,
  LogFileStore,
  NativeLogFilesOptions,
} from './types';

const nativeRoots = new Map<string, LogFileIO>();

export function createLogFiles(options: NativeLogFilesOptions): LogFileStore {
  const { directoryName } = options;
  if (
    typeof directoryName !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(directoryName)
  ) {
    throw createLogFileError(LOG_FILE_FAILURES.initialize);
  }
  const { fs } = ReactNativeBlobUtil;
  const base = Platform.OS === 'ios' ? fs.dirs.LibraryDir : fs.dirs.DocumentDir;
  const validBase =
    typeof base === 'string' &&
    base.startsWith('/') &&
    base.replace(/\/+$/, '').length > 1 &&
    !base.split('/').some((part) => part === '.' || part === '..') &&
    !base.includes('\0');
  const root = validBase ? `${base.replace(/\/+$/, '')}/${directoryName}` : '';
  const rootKey =
    Platform.OS === 'ios' ? root.replace(/^\/private\/var\//, '/var/') : root;
  const shared = validBase ? nativeRoots.get(rootKey) : undefined;
  if (shared)
    return createLogFileStore({ io: shared, createId: options.createId });

  function path(name: string): string {
    if (!validBase || !isOwnedFileName(name)) {
      throw createLogFileError(LOG_FILE_FAILURES.initialize);
    }
    return `${root}/${name}`;
  }

  const io: LogFileIO = {
    async ensureRoot() {
      if (!validBase) {
        throw createLogFileError(LOG_FILE_FAILURES.initialize);
      }
      try {
        await fs.mkdir(root);
      } catch (error) {
        const stat = await fs.stat(root);
        if (stat.type !== 'directory') {
          throw error;
        }
      }
    },
    async list() {
      if (!validBase) {
        throw createLogFileError(LOG_FILE_FAILURES.initialize);
      }
      const names = await fs.ls(root);
      const files: LogFileInfo[] = [];
      for (const name of names) {
        if (!isOwnedFileName(name)) {
          continue;
        }
        const stat = await fs.stat(path(name));
        if (stat.type !== 'file') {
          continue;
        }
        if (
          !Number.isFinite(stat.size) ||
          stat.size < 0 ||
          !Number.isFinite(stat.lastModified)
        ) {
          throw createLogFileError(LOG_FILE_FAILURES.initialize);
        }
        files.push({ name, bytes: stat.size, modifiedAt: stat.lastModified });
      }
      return files;
    },
    async read(name) {
      const text: unknown = await fs.readFile(path(name), 'utf8');
      if (typeof text !== 'string') {
        throw createLogFileError(LOG_FILE_FAILURES.initialize);
      }
      return text;
    },
    async getFile(name) {
      if (!isSnapshotFileName(name))
        throw createLogFileError(LOG_FILE_FAILURES.invalidSnapshot);
      const location = path(name);
      const stat = await fs.stat(location);
      if (
        stat.type !== 'file' ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0
      ) {
        throw createLogFileError(LOG_FILE_FAILURES.snapshot);
      }
      return {
        uri: `file://${location.split('/').map(encodeURIComponent).join('/')}`,
        bytes: stat.size,
      };
    },
    async write(name, text) {
      await fs.writeFile(path(name), text, 'utf8');
    },
    async append(name, text) {
      await fs.appendFile(path(name), text, 'utf8');
    },
    async remove(name) {
      const target = path(name);
      try {
        await fs.unlink(target);
      } catch (error) {
        // SDK 不区分缺失和权限错误；完整目录读取才能证实目标已不存在。
        const remaining = await fs.ls(root);
        if (!Array.isArray(remaining) || remaining.includes(name)) throw error;
      }
    },
  };
  if (validBase) nativeRoots.set(rootKey, io);
  return createLogFileStore({ io, createId: options.createId });
}
