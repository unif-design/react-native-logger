import { Buffer as mockBuffer } from 'buffer';
import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { createLogFiles } from '../src/files/createLogFiles';
import type { LogFileStore } from '../src/files/types';
import { entry } from './filesFixture';

const mockFiles = new Map<string, string>();
const mockDirectories = new Set<string>();
let mockExtraNames: string[] = [];

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: {
        LibraryDir: '/application/Library',
        DocumentDir: '/application/Documents',
        CacheDir: '/application/Library/Caches',
      },
      mkdir: jest.fn(async (path: string) => {
        if (mockDirectories.has(path)) {
          throw new Error('already exists');
        }
        mockDirectories.add(path);
      }),
      ls: jest.fn(async (root: string) => [
        ...[...mockFiles.keys()]
          .filter((path) => path.startsWith(`${root}/`))
          .map((path) => path.slice(root.length + 1)),
        ...mockExtraNames,
      ]),
      stat: jest.fn(async (path: string) => {
        if (mockDirectories.has(path)) {
          return {
            type: 'directory',
            path,
            filename: path.split('/').pop(),
            size: 0,
            lastModified: 1_750_000_000_000,
          };
        }
        if (!mockFiles.has(path)) {
          throw new Error('missing file');
        }
        return {
          type: 'file',
          path,
          filename: path.split('/').pop(),
          size: mockBuffer.byteLength(mockFiles.get(path)!, 'utf8'),
          lastModified: 1_750_000_000_000,
        };
      }),
      readFile: jest.fn(async (path: string, _encoding: string) => {
        if (!mockFiles.has(path)) {
          throw new Error('missing file');
        }
        return mockFiles.get(path)!;
      }),
      writeFile: jest.fn(
        async (path: string, text: string, _encoding: string) => {
          mockFiles.set(path, text);
        },
      ),
      appendFile: jest.fn(
        async (path: string, text: string, _encoding: string) => {
          mockFiles.set(path, (mockFiles.get(path) ?? '') + text);
          return mockBuffer.byteLength(text, 'utf8');
        },
      ),
      unlink: jest.fn(async (path: string) => {
        mockFiles.delete(path);
      }),
    },
  },
}));

describe('原生日志文件 SDK 适配', () => {
  const stores: LogFileStore[] = [];

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(1_750_000_000_000);
    mockFiles.clear();
    mockDirectories.clear();
    mockExtraNames = [];
  });

  afterEach(() => {
    stores.splice(0).forEach((store) => store.dispose());
    jest.useRealTimers();
  });

  test.each([
    ['ios', '/application/Library/TestLogs'],
    ['android', '/application/Documents/TestLogs'],
  ] as const)(
    '%s 使用独立持久目录和 UTF8 SDK 文件接口',
    async (platform, root) => {
      jest.replaceProperty(Platform, 'OS', platform);
      const store = createLogFiles({
        ...{ createId: () => 'native-id' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      expect(ReactNativeBlobUtil.fs.mkdir).not.toHaveBeenCalled();
      await store.setOwner('hash-a', 'epoch-a');
      store.append(entry('中文'));
      const snapshot = await store.createSnapshot();
      expect(ReactNativeBlobUtil.fs.mkdir).toHaveBeenCalledWith(root);
      expect(ReactNativeBlobUtil.fs.ls).toHaveBeenCalledWith(root);
      expect(ReactNativeBlobUtil.fs.appendFile).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^${root}/[a-f0-9]{64}-logs-[^/]+\\.jsonl$`),
        ),
        entry('中文').line,
        'utf8',
      );
      await expect(store.readSnapshot(snapshot)).resolves.toBe(
        entry('中文').line,
      );
      const source = [...mockFiles.keys()].find(
        (path) => path.includes('-logs-') && !path.includes('-logs-snapshot-'),
      )!;
      await store.releaseSnapshot(snapshot);
      expect(mockFiles.get(source)).toBe(entry('中文').line);
      expect(
        [...mockFiles.keys()].some((path) =>
          path.startsWith('/application/Library/Caches/'),
        ),
      ).toBe(false);
    },
  );

  test('目录已存在时验证目录可用，SDK 仅收到受控文件名', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const root = '/application/Library/TestLogs';
    mockDirectories.add(root);
    mockExtraNames = [
      '../outside.jsonl',
      '/outside',
      'log-1750000000000-../../escape.jsonl',
      'log-1750000000000-newline.jsonl\n',
      'other.txt',
    ];
    const store = createLogFiles({
      ...{ createId: () => '../../unsafe/name' },
      directoryName: 'TestLogs',
    });
    stores.push(store);
    await store.setOwner(null, 'epoch-a');
    store.append(entry('safe'));
    await store.flush();
    expect(store.getStatus()).toMatchObject({ state: 'ready', writable: true });
    expect(ReactNativeBlobUtil.fs.stat).toHaveBeenCalledWith(root);
    expect(
      jest
        .mocked(ReactNativeBlobUtil.fs.stat)
        .mock.calls.every(([path]) => path === root),
    ).toBe(true);
    expect(
      [...mockFiles.keys()].every(
        (path) =>
          path.startsWith(`${root}/`) &&
          !path.slice(root.length + 1).includes('/'),
      ),
    ).toBe(true);
  });

  test.each(['', '/', 'relative/base', undefined])(
    '原生根路径 %s 无效时只阻断初始化，不产生相对路径 IO',
    async (base) => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      jest.replaceProperty(
        ReactNativeBlobUtil.fs.dirs,
        'LibraryDir',
        base as string,
      );
      const store = createLogFiles({
        ...{ createId: () => 'id' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      expect(ReactNativeBlobUtil.fs.mkdir).not.toHaveBeenCalled();
      await store.setOwner('hash-a', 'epoch-a');
      expect(store.getStatus()).toMatchObject({
        state: 'blocked',
        writable: false,
        lastFailureCode: 'logger.files.initialize_failed',
      });
      await expect(store.readSummary()).rejects.toMatchObject({
        code: 'logger.files.summary_failed',
      });
      await expect(store.clear()).resolves.toMatchObject({
        status: 'failed',
        code: 'logger.files.cleanup_failed',
      });
      expect(ReactNativeBlobUtil.fs.mkdir).not.toHaveBeenCalled();
      expect(ReactNativeBlobUtil.fs.ls).not.toHaveBeenCalled();
    },
  );

  test.each(['ios', 'android'] as const)(
    '%s 删除异常后明确不存在才按清理完成处理',
    async (platform) => {
      jest.replaceProperty(Platform, 'OS', platform);
      const store = createLogFiles({
        ...{ createId: () => 'native-id' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      await store.setOwner('hash-a', 'epoch-a');
      store.append(entry('private'));
      await store.flush();
      const summary = await store.readSummary();
      expect(summary).toEqual({ fileCount: 1, bytes: entry('private').bytes });
      jest
        .mocked(ReactNativeBlobUtil.fs.unlink)
        .mockImplementationOnce(async (path) => {
          mockFiles.delete(path);
          throw new Error('already missing');
        });
      await expect(store.clear()).resolves.toEqual({ status: 'success' });
      expect(mockFiles.size).toBe(0);
    },
  );

  test('删除权限失败仍存在时返回部分结果，不以异常冒充已不存在', async () => {
    const store = createLogFiles({
      ...{ createId: () => 'native-id' },
      directoryName: 'TestLogs',
    });
    stores.push(store);
    await store.setOwner('hash-a', 'epoch-a');
    store.append(entry('private'));
    await store.flush();
    jest
      .mocked(ReactNativeBlobUtil.fs.unlink)
      .mockRejectedValueOnce(new Error('permission denied'));
    await expect(store.clear()).resolves.toMatchObject({
      status: 'partial',
      removedFiles: 0,
      remainingFiles: 1,
    });
    expect(mockFiles.size).toBe(1);
  });

  test('删除后无法读取目录时不能确认不存在', async () => {
    const store = createLogFiles({
      ...{ createId: () => 'native-id' },
      directoryName: 'TestLogs',
    });
    stores.push(store);
    await store.setOwner('hash-a', 'epoch-a');
    store.append(entry('private'));
    await store.flush();
    jest
      .mocked(ReactNativeBlobUtil.fs.unlink)
      .mockImplementationOnce(async () => {
        jest
          .mocked(ReactNativeBlobUtil.fs.ls)
          .mockRejectedValueOnce(new Error('directory unreadable'));
        throw new Error('delete uncertain');
      });
    await expect(store.clear()).resolves.toMatchObject({
      status: 'partial',
      removedFiles: 0,
      remainingFiles: 1,
    });
    expect(mockFiles.size).toBe(1);
  });

  test.each(['ios', 'android'] as const)(
    '%s 只查询已有快照元数据并交付可解码的本地 URI',
    async (platform) => {
      jest.replaceProperty(Platform, 'OS', platform);
      jest.replaceProperty(
        ReactNativeBlobUtil.fs.dirs,
        platform === 'ios' ? 'LibraryDir' : 'DocumentDir',
        '/application/中文 %20?#',
      );
      const store = createLogFiles({
        ...{ createId: () => 'native-transfer' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      await store.setOwner('hash-a', 'epoch-a');
      store.append(entry('中文'));
      const snapshot = await store.createSnapshot();
      jest.mocked(ReactNativeBlobUtil.fs.stat).mockClear();
      jest.mocked(ReactNativeBlobUtil.fs.readFile).mockClear();
      jest.mocked(ReactNativeBlobUtil.fs.writeFile).mockClear();
      const file = await store.takeSnapshotFile(snapshot);
      try {
        const path = decodeURIComponent(file.uri.slice('file://'.length));
        expect(path).toMatch(
          /^\/application\/中文 %20\?#\/TestLogs\/[a-f0-9]+-logs-snapshot-/,
        );
        expect(mockFiles.get(path)).toBe(entry('中文').line);
        expect(file.bytes).toBe(entry('中文').bytes);
        expect(ReactNativeBlobUtil.fs.stat).toHaveBeenCalledTimes(1);
        expect(ReactNativeBlobUtil.fs.readFile).not.toHaveBeenCalled();
        expect(ReactNativeBlobUtil.fs.writeFile).not.toHaveBeenCalled();
      } finally {
        await file.release();
      }
    },
  );

  test.each(['ios', 'android'] as const)(
    '%s 同一日志根的新安装复用在用保护，释放旧安装不能触发文件回收',
    async (platform) => {
      jest.replaceProperty(Platform, 'OS', platform);
      const store = createLogFiles({
        ...{ createId: () => 'previous' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      await store.setOwner('hash-a', 'epoch-a');
      const file = await store.takeSnapshotFile(await store.createSnapshot());
      try {
        store.dispose();
        jest.setSystemTime(1_760_000_000_000);
        const next = createLogFiles({
          ...{ createId: () => 'next' },
          directoryName: 'TestLogs',
        });
        stores.push(next);
        await next.setOwner('hash-b', 'epoch-b');
        expect(next.getStatus().state).toBe('ready');
        expect(
          mockFiles.has(decodeURIComponent(file.uri.slice('file://'.length))),
        ).toBe(true);
      } finally {
        await file.release();
      }
      expect(mockFiles.size).toBe(0);
    },
  );

  test.each([NaN, -1, 0.5])(
    '快照实际字节 %s 无效时拒绝，原句柄保持可用',
    async (size) => {
      const store = createLogFiles({
        ...{ createId: () => 'metadata' },
        directoryName: 'TestLogs',
      });
      stores.push(store);
      await store.setOwner('hash-a', 'epoch-a');
      const snapshot = await store.createSnapshot();
      jest
        .mocked(ReactNativeBlobUtil.fs.stat)
        .mockResolvedValueOnce({ type: 'file', size } as never);
      await expect(store.takeSnapshotFile(snapshot)).rejects.toMatchObject({
        code: 'logger.files.snapshot_failed',
      });
      await expect(store.readSnapshot(snapshot)).resolves.toBe('');
      await store.releaseSnapshot(snapshot);
    },
  );

  test('iOS 容器目录别名仍共享已交付文件的全 App 数量预算', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.replaceProperty(
      ReactNativeBlobUtil.fs.dirs,
      'LibraryDir',
      '/private/var/mobile/app/Library',
    );
    const previous = createLogFiles({
      ...{ createId: () => 'alias' },
      directoryName: 'TestLogs',
    });
    stores.push(previous);
    await previous.setOwner('hash-a', 'epoch-a');
    const files = [];
    try {
      for (let count = 0; count < 10; count++) {
        files.push(
          await previous.takeSnapshotFile(await previous.createSnapshot()),
        );
      }
      previous.dispose();
      jest.replaceProperty(
        ReactNativeBlobUtil.fs.dirs,
        'LibraryDir',
        '/var/mobile/app/Library',
      );
      const next = createLogFiles({
        ...{ createId: () => 'next-alias' },
        directoryName: 'TestLogs',
      });
      stores.push(next);
      await next.setOwner('hash-b', 'epoch-b');
      await expect(next.createSnapshot()).rejects.toMatchObject({
        code: 'logger.files.snapshot_limit',
      });
      expect(mockFiles.size).toBe(10);
    } finally {
      await Promise.all(files.map((file) => file.release()));
    }
  });
});

test.each(['', '..', '../outside', '/absolute', 'a/b', 'a\\b', 'x'.repeat(65)])(
  '拒绝非单段日志目录 %s',
  (directoryName) => {
    expect(() =>
      createLogFiles({ directoryName, createId: () => 'id' }),
    ).toThrow();
  },
);
