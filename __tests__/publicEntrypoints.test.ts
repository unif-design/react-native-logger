import manifest from '../package.json';

it('仅公开根入口、文件入口与包元数据', () => {
  expect(Object.keys(manifest.exports).sort()).toEqual([
    '.',
    './files',
    './package.json',
  ]);
});

it('根入口提供安装、记录与脱敏，加载时不触发原生文件 SDK', () => {
  jest.isolateModules(() => {
    jest.doMock('react-native-blob-util', () => {
      throw new Error('根入口不应加载原生文件 SDK');
    });
    const api = require('../src');
    expect(Object.keys(api).sort()).toEqual([
      'consoleTransport',
      'createLogger',
      'createOperationContext',
      'defaultLogBackend',
      'getFailureDiagnostics',
      'getLogRetentionPolicy',
      'getLogStatus',
      'installLogging',
      'isSensitiveDiagnosticField',
      'markLoggingUnavailable',
      'redactDiagnosticText',
    ]);
    expect(api.getLogStatus().installed).toBe(false);
    expect(
      api.createLogger('consumer').captureError('before_install'),
    ).toBeNull();
    expect(api.isSensitiveDiagnosticField('authorization')).toBe(true);
    expect(api.redactDiagnosticText('Bearer test-secret')).not.toContain(
      'test-secret',
    );
  });
});

it('公开默认后端保留既有可变参数接口，并由默认安装采集一次', async () => {
  const {
    defaultLogBackend,
    consoleTransport,
    installLogging,
    createLogger,
  } = require('../src');
  const backend = require('../src/backend');
  expect(defaultLogBackend).toBe(backend);
  expect(defaultLogBackend.consoleTransport).toBe(consoleTransport);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const append = jest.fn();
  const { createLogFiles } = require('../src/files/createLogFiles.web');
  const files = createLogFiles({
    directoryName: 'SharedLogs',
    createId: () => 'file',
  });
  jest.spyOn(files, 'append').mockImplementation(append);
  const { TEST_POLICY } = require('./policyFixture');
  const handle = installLogging({
    policy: TEST_POLICY,
    createId: () => 'shared-backend',
    files,
    environment: {
      appVersion: '1',
      platform: 'test',
      osVersion: '1',
      development: true,
    },
  });
  try {
    await handle.setOwner(null);
    defaultLogBackend
      .createLogger('design')
      .warn('existing warning', { privateToken: 'secret' });
    createLogger('camera').warn('capture.failed');
    expect(append).toHaveBeenCalledTimes(2);
    expect(JSON.parse(append.mock.calls[0][0].line)).toMatchObject({
      scope: 'sdk.design',
      event: 'sdk.warning',
    });
    expect(JSON.parse(append.mock.calls[1][0].line)).toMatchObject({
      scope: 'camera',
      event: 'capture.failed',
    });
    expect(JSON.stringify(append.mock.calls)).not.toContain('secret');
  } finally {
    handle.dispose();
  }
});
