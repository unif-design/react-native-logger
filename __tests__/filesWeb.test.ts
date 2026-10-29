import { entry } from './filesFixture';

jest.mock('react-native-blob-util', () => {
  throw new Error('Web 日志不得装载原生 SDK');
});

test('Web 入口不加载文件 SDK，保留有界内存且快照明确 unsupported', async () => {
  const { createLogFiles } = require('../src/files/createLogFiles.web');
  const files = createLogFiles({
    ...{ createId: () => 'web-id' },
    directoryName: 'TestLogs',
  });
  const first = entry('startup', 'anonymous', 'info', true);
  files.append(first);
  files.append(entry('unbound-sensitive'));
  expect(files.getStatus()).toMatchObject({
    storageMode: 'memory',
    state: 'unbound',
    bufferedBytes: first.bytes,
    droppedCount: 1,
  });
  await files.setOwner('hash-a', 'epoch-a');
  files.append(entry('current'));
  await expect(files.readSummary()).rejects.toMatchObject({
    code: 'logger.files.unsupported',
  });
  await expect(files.clear()).resolves.toMatchObject({
    status: 'failed',
    code: 'logger.files.unsupported',
  });
  await files.flush();
  expect(files.getStatus()).toMatchObject({
    storageMode: 'memory',
    state: 'ready',
    writable: true,
    bufferedBytes: first.bytes + entry('current').bytes,
  });
  for (let index = 0; index < 10000; index++) {
    files.append(entry(`error-${index}`, 'epoch-a', 'error'));
  }
  expect(files.getStatus().bufferedBytes).toBeLessThanOrEqual(256 * 1024);
  expect(files.getStatus().droppedCount).toBeGreaterThan(1);
  await expect(files.createSnapshot()).rejects.toMatchObject({
    code: 'logger.files.unsupported',
  });
  await expect(
    files.takeSnapshotFile({ id: 'fake', bytes: 0, identityEpoch: 'epoch-a' }),
  ).rejects.toMatchObject({ code: 'logger.files.unsupported' });
  await expect(
    files.releaseSnapshot({
      id: 'fake',
      bytes: 1,
      identityEpoch: 'epoch-a',
    }),
  ).rejects.toMatchObject({ code: 'logger.files.unsupported' });
  await expect(
    files.readSnapshot({ id: 'fake', bytes: 1, identityEpoch: 'epoch-a' }),
  ).rejects.toMatchObject({ code: 'logger.files.unsupported' });
  await files.setOwner('hash-b', 'epoch-b');
  expect(files.getStatus().bufferedBytes).toBe(0);
  files.append(entry('late-a'));
  files.append(entry('new-b', 'epoch-b'));
  expect(files.getStatus().bufferedBytes).toBe(entry('new-b', 'epoch-b').bytes);
  await files.setOwner('hash-b', 'epoch-b');
  expect(files.getStatus().bufferedBytes).toBe(entry('new-b', 'epoch-b').bytes);
  await files.setOwner('hash-b', 'different-epoch');
  expect(files.getStatus().bufferedBytes).toBe(0);
  files.dispose();
  files.append(entry('after', 'epoch-b'));
  expect(files.getStatus()).toMatchObject({
    state: 'disposed',
    writable: false,
    bufferedBytes: 0,
  });
});
