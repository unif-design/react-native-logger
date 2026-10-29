import { createLogger, getLogStatus } from '../src';
import { installLogging } from '../src';
import { createLogFiles } from '../src/files/createLogFiles.web';
import type { LoggingHandle } from '../src';
import { TEST_POLICY } from './policyFixture';

let handle: LoggingHandle | undefined;
afterEach(() => {
  handle?.dispose();
  handle = undefined;
});

test.each([
  ['UTC', '2026-10-29T00:00:00.000Z'],
  ['Asia/Shanghai', '2026-10-29T08:00:00.000+08:00'],
] as const)(
  '默认后端按 %s 展示，同一运行供多个库记录日志',
  async (consoleTimeZone, display) => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    handle = installLogging({
      policy: TEST_POLICY,
      consoleTimeZone,
      now: () => Date.UTC(2026, 9, 29),
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
    expect(
      String(jest.mocked(console.info).mock.calls[0][0]).startsWith(
        `${display} INFO `,
      ),
    ).toBe(true);
    expect(getLogStatus()).toMatchObject({ installed: true, droppedCount: 0 });
    expect(getLogStatus().bufferedBytes).toBeGreaterThan(0);
  },
);
