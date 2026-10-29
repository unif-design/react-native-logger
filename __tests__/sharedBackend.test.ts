import { createLogger, getLogStatus } from '../src';
import { installLogging } from '../src/runtime';
import { createLogFiles } from '../src/files/createLogFiles.web';
import type { LoggingHandle } from '../src';
import { TEST_POLICY } from './policyFixture';

let handle: LoggingHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});

test('无需 Design 后端即可安装，同一运行供多个库记录结构化日志', async () => {
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  handle = installLogging({
    policy: TEST_POLICY,
    createId: () => 'shared-runtime',
    files: createLogFiles({
      directoryName: 'TestLogs',
      createId: () => 'file',
    }),
    environment: {
      appVersion: '1',
      platform: 'test',
      osVersion: '1',
      development: true,
    },
  });
  await handle.setOwner(null);
  createLogger('design').info('mounted');
  createLogger('camera').warn('unavailable', {
    fields: { reason: 'not_ready' },
  });
  expect(jest.mocked(console.info).mock.calls[0]).toHaveLength(1);
  expect(jest.mocked(console.info).mock.calls[0][0]).toMatch(
    / INFO \[sample-app\] \[design\] mounted$/,
  );
  const bytes = getLogStatus().bufferedBytes;
  console.info('raw output');
  expect(getLogStatus().bufferedBytes).toBe(bytes);
  expect(getLogStatus()).toMatchObject({ installed: true, droppedCount: 0 });
  expect(getLogStatus().bufferedBytes).toBeGreaterThan(0);
});
